#!/bin/sh
set -eu

# Intentional one-command CDPATH assignment.
# shellcheck disable=SC1007
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/update-flow-core-tests"

mkdir -p "$BUILD_DIR"

# Opt-in sanitizers, same convention as test-patch-core.sh:
# SANITIZE=1 npm run test:flow-core
SANITIZE_FLAGS=""
if [ "${SANITIZE:-0}" = "1" ]; then
  SANITIZE_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer -g"
  echo "Building update flow core tests with AddressSanitizer + UBSan"
fi

# SANITIZE_FLAGS must split into compiler arguments.
# shellcheck disable=SC2086
c++ \
  -std=c++17 \
  -Wall \
  -Wextra \
  $SANITIZE_FLAGS \
  "$ROOT_DIR/cpp/update_flow_core/flow_json.cpp" \
  "$ROOT_DIR/cpp/update_flow_core/update_flow_core.cpp" \
  "$ROOT_DIR/cpp/update_flow_core/tests/update_flow_core_test.cpp" \
  -o "$BUILD_DIR/update_flow_core_test"

"$BUILD_DIR/update_flow_core_test" \
  "$ROOT_DIR/cpp/update_flow_core/tests/flow_vectors.json"
