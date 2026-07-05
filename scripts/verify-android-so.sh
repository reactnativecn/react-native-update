#!/usr/bin/env bash
# Thin wrapper kept for backward compatibility; the actual verification lives
# in verify-android-so.js (pure-node ELF .dynsym reader, no binutils needed —
# llvm-nm/nm are absent on some CI images, e.g. the HarmonyOS docker image).
exec node "$(dirname "${BASH_SOURCE[0]}")/verify-android-so.js"
