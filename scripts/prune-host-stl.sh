#!/bin/sh
set -eu

TARGET_DIR="${1:-android/lib}"

find "$TARGET_DIR" -type f -name 'libc++_shared.so' -delete
