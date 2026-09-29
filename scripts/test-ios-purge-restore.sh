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

# This is an orchestration test, not a stricter product warning gate. Keep
# warnings visible without promoting all of them to errors. Unknown Objective-C
# selectors are the one intentional error: they indicate an incomplete test seam.
WARNING_FLAGS="-Wall -Wextra -Wno-unused-parameter -Werror=objc-method-access"

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
  xcrun clang++ -std=c++17 -fobjc-arc -fblocks $WARNING_FLAGS $SANITIZE_FLAGS \
    -I"$ROOT_DIR" -I"$destination" \
    "$TEST_DIR/purge_restore_test.mm" "$ROOT_DIR/cpp/patch_core/state_core.cpp" \
    "$ROOT_DIR/ios/RCTPushy/RCTPushyConfiguration.mm" \
    -framework Foundation -o "$destination/purge_restore_test"
}

build baseline
"$BUILD_DIR/baseline/purge_restore_test" "$@"

# Negative controls execute only generated test copies. Every original bug must
# fail its named assertion, not merely fail to compile or time out.
if [ "${VERIFY_REGRESSIONS:-0}" = "1" ]; then
  # Compile the same translation unit with narrowly selected contract probes.
  # Unsupported selectors must fail for that selector, while a benign warning
  # must compile. No probe modifies product code or the generated baseline.
  compile_probe() {
    xcrun clang++ -std=c++17 -fobjc-arc -fblocks $WARNING_FLAGS \
      -I"$ROOT_DIR" -I"$BUILD_DIR/baseline" -fsyntax-only -D"$1" \
      "$TEST_DIR/purge_restore_test.mm"
  }
  logfile="$BUILD_DIR/baseline/warning-probe.log"
  if ! compile_probe TEST_HARMLESS_WARNING_PROBE >"$logfile" 2>&1; then
    cat "$logfile" >&2
    exit 1
  fi
  grep -F 'warning: PUSHY_TEST_HARMLESS_WARNING' "$logfile"
  echo "[PASS] ordinary compiler warnings are non-fatal"

  for access in read write; do
    case "$access" in
      read) probe=TEST_DEFAULTS_READ_PROBE; selector='boolForKey:' ;;
      write) probe=TEST_DEFAULTS_WRITE_PROBE; selector='setBool:forKey:' ;;
    esac
    logfile="$BUILD_DIR/baseline/defaults-$access-compile.log"
    if compile_probe "$probe" >"$logfile" 2>&1; then
      echo "ERROR: unsupported defaults $access unexpectedly compiled" >&2
      exit 1
    fi
    if ! grep -F 'error:' "$logfile" | grep -F "no visible @interface for 'TestDefaults'" | grep -F "'$selector'"; then
      cat "$logfile" >&2
      echo "ERROR: defaults $access failed compilation for an unexpected reason" >&2
      exit 1
    fi
    testcase="unsupported_defaults_$access"
    logfile="$BUILD_DIR/baseline/defaults-$access-runtime.log"
    if "$BUILD_DIR/baseline/purge_restore_test" "$testcase" >"$logfile" 2>&1; then
      echo "ERROR: unsupported defaults $access unexpectedly succeeded" >&2
      exit 1
    fi
    if ! grep -Fx "[FAIL] $testcase: unsupported TestDefaults selector: $selector" "$logfile"; then
      cat "$logfile" >&2
      echo "ERROR: defaults $access failed at runtime for an unexpected reason" >&2
      exit 1
    fi
    echo "[PASS] unsupported defaults $access rejected at compile time and runtime"
  done

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
