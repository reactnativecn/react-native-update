#!/usr/bin/env bash
#
# Builds android/lib/<abi>/librnupdate.so for all ABIs and verifies the
# exported JNI symbols.
#
# NDK resolution order (CP-8): $ANDROID_NDK_HOME > $ANDROID_NDK_ROOT >
# $ANDROID_HOME/ndk/<pinned> > highest version under $ANDROID_HOME/ndk >
# ndk-build on PATH. Pin can be overridden with RNUPDATE_NDK_VERSION.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Keep in sync with the sdkmanager install in .github/workflows/publish.yml.
PINNED_NDK_VERSION="${RNUPDATE_NDK_VERSION:-28.2.13676358}"

find_ndk_build() {
  local candidates=()
  [ -n "${ANDROID_NDK_HOME:-}" ] && candidates+=("$ANDROID_NDK_HOME")
  [ -n "${ANDROID_NDK_ROOT:-}" ] && candidates+=("$ANDROID_NDK_ROOT")

  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [ -n "$sdk" ] && [ -d "$sdk/ndk" ]; then
    candidates+=("$sdk/ndk/$PINNED_NDK_VERSION")
    local highest
    highest="$(ls "$sdk/ndk" 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$highest" ] && candidates+=("$sdk/ndk/$highest")
  fi

  local candidate
  for candidate in ${candidates[@]+"${candidates[@]}"}; do
    if [ -x "$candidate/ndk-build" ]; then
      echo "$candidate/ndk-build"
      return 0
    fi
  done

  if command -v ndk-build >/dev/null 2>&1; then
    command -v ndk-build
    return 0
  fi
  return 1
}

if ! NDK_BUILD="$(find_ndk_build)"; then
  cat >&2 <<EOF
error: no Android NDK found.
Set ANDROID_NDK_HOME, or install NDK $PINNED_NDK_VERSION via:
  sdkmanager "ndk;$PINNED_NDK_VERSION"
EOF
  exit 1
fi

echo "Using ndk-build: $NDK_BUILD"
"$NDK_BUILD" \
  NDK_PROJECT_PATH="$ROOT_DIR/android" \
  APP_BUILD_SCRIPT="$ROOT_DIR/android/jni/Android.mk" \
  NDK_APPLICATION_MK="$ROOT_DIR/android/jni/Application.mk" \
  NDK_LIBS_OUT="$ROOT_DIR/android/lib"

node "$ROOT_DIR/scripts/verify-android-so.js"
