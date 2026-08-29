#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/safe-zip-file-test"
trap 'rm -rf "$BUILD_DIR"' EXIT

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

javac -d "$BUILD_DIR"   "$ROOT_DIR/android/src/main/java/cn/reactnative/modules/update/SafeZipFile.java"   "$ROOT_DIR/android/src/test/java/cn/reactnative/modules/update/SafeZipFileTest.java"

java -cp "$BUILD_DIR" cn.reactnative.modules.update.SafeZipFileTest
