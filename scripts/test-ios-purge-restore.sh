#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TEST_DIR="$ROOT_DIR/scripts/tests/ios-purge-restore"
BUILD_DIR="$ROOT_DIR/.tmp/ios-purge-restore-tests"

python3 -m unittest discover -s "$TEST_DIR" -p test_extract.py
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Native purge-restore tests require macOS Foundation and Xcode command-line tools." >&2
  exit 1
fi

SANITIZE_FLAGS=""
if [ "${SANITIZE:-0}" = "1" ]; then
  SANITIZE_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer -g"
fi

build() {
  variant="$1"
  destination="$BUILD_DIR/$variant"
  mkdir -p "$destination"
  if [ "$variant" = baseline ]; then
    python3 "$TEST_DIR/extract.py" "$ROOT_DIR/ios/RCTPushy/RCTPushy.mm" "$destination"
  else
    python3 "$TEST_DIR/extract.py" "$ROOT_DIR/ios/RCTPushy/RCTPushy.mm" "$destination" --mutation "$variant"
  fi
  # Compile the real production bodies and state_core; only their external I/O
  # collaborators live in the test host. No RN, CocoaPods, simulator or network.
  xcrun clang++ -std=c++17 -fobjc-arc -fblocks -Wall -Wextra -Werror \
    -Wno-unused-parameter $SANITIZE_FLAGS \
    -I"$ROOT_DIR" -I"$destination" \
    "$TEST_DIR/purge_restore_test.mm" "$ROOT_DIR/cpp/patch_core/state_core.cpp" \
    -framework Foundation -o "$destination/purge_restore_test"
}

build baseline
"$BUILD_DIR/baseline/purge_restore_test" "$@"

# Negative controls execute only generated test copies. Every original bug must
# fail its named assertion, not merely fail to compile or time out.
if [ "${VERIFY_REGRESSIONS:-0}" = "1" ]; then
  for pair in late-activation:late_commit skip-reresolve:commit_before_signal ignore-reset:reset_wins; do
    variant="${pair%:*}"
    testcase="${pair#*:}"
    build "$variant"
    logfile="$BUILD_DIR/$variant/result.log"
    if "$BUILD_DIR/$variant/purge_restore_test" "$testcase" >"$logfile" 2>&1; then
      echo "ERROR: $testcase did not detect $variant" >&2
      exit 1
    fi
    case "$variant" in
      late-activation) expected="late round may persist its response but must not activate" ;;
      skip-reresolve) expected="must re-resolve B even when done signal is late" ;;
      ignore-reset) expected="stale generation must reject ALL commit writes" ;;
    esac
    if ! grep -F "[FAIL] $testcase: $expected" "$logfile"; then
      cat "$logfile" >&2
      echo "ERROR: $variant failed for an unexpected reason" >&2
      exit 1
    fi
    echo "[PASS] negative control: $variant is detected by $testcase"
  done
fi
