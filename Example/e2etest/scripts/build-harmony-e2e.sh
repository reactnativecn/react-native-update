#!/usr/bin/env bash
# Build & install the HarmonyOS e2e base app, encoding the required order:
#   local har -> swap local react-native-update -> refresh oh_modules
#   -> prepare update artifacts -> base bundle -> assembleHap -> install.
#
# The order matters: `pushy bundle --platform harmony` (run by the prepare
# step) overwrites the project's rawfile/bundle.harmony.js, so the base bundle
# must be generated AFTER artifacts. See e2e/harmony/README.md for details.
#
# Env overrides:
#   DEVECO_HOME              DevEco Studio Contents dir
#   RNU_HARMONY_BUNDLE_NAME  bundle name of the e2e app
#   RNU_CLI_ROOT             react-native-update-cli checkout (else sibling dir)
#   SKIP_HAR=true            skip rebuilding pushy.har + oh_modules refresh
#   SKIP_INSTALL=true        build only, do not touch a device
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2ETEST_ROOT="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$E2ETEST_ROOT/../.." && pwd)"
HARMONY_APP="$REPO_ROOT/Example/harmony_use_pushy"
HARMONY_PROJECT="$HARMONY_APP/harmony"

DEVECO_HOME="${DEVECO_HOME:-/Applications/DevEco-Studio.app/Contents}"
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$DEVECO_HOME/sdk}"
HVIGORW_JS="$DEVECO_HOME/tools/hvigor/bin/hvigorw.js"
OHPM="$DEVECO_HOME/tools/ohpm/bin/ohpm"
BUNDLE_NAME="${RNU_HARMONY_BUNDLE_NAME:-com.charmlot.testpushy}"
HAP_PATH="$HARMONY_PROJECT/entry/build/default/outputs/default/entry-default-signed.hap"

command -v hdc >/dev/null || {
  echo "hdc not found on PATH (add <sdk>/toolchains)" >&2
  exit 1
}
[ -f "$HVIGORW_JS" ] || {
  echo "hvigorw not found: $HVIGORW_JS (set DEVECO_HOME)" >&2
  exit 1
}

if [ "${SKIP_HAR:-false}" != "true" ]; then
  echo "==> Building local pushy.har"
  (cd "$REPO_ROOT" && npm run build:harmony-har)

  echo "==> Syncing local react-native-update into harmony_use_pushy"
  rsync -a --delete \
    --exclude node_modules --exclude Example --exclude .git \
    --exclude e2e --exclude .pushy \
    "$REPO_ROOT/" "$HARMONY_APP/node_modules/react-native-update/"

  echo "==> Refreshing oh_modules (ohpm caches file: hars by content hash)"
  rm -rf "$HARMONY_PROJECT/oh_modules" "$HARMONY_PROJECT/entry/oh_modules"
  (cd "$HARMONY_PROJECT" && "$OHPM" install --all)
fi

echo "==> Preparing local update artifacts (v1/v2 ppk + diff)"
(cd "$E2ETEST_ROOT" && E2E_PLATFORM=harmony node scripts/run-prepare-local-update-artifacts.js)

echo "==> Bundling e2e base entry into rawfile (must follow artifact prep)"
(cd "$HARMONY_APP" && npx react-native bundle-harmony --dev false --entry-file e2e/entry.base.ts)

echo "==> Assembling signed hap"
(cd "$HARMONY_PROJECT" && node "$HVIGORW_JS" \
  --mode module -p module=entry@default -p product=default \
  assembleHap --no-daemon)
[ -f "$HAP_PATH" ] || {
  echo "signed hap not found: $HAP_PATH" >&2
  exit 1
}

if [ "${SKIP_INSTALL:-false}" != "true" ]; then
  echo "==> Installing $BUNDLE_NAME"
  hdc list targets | grep -qv '^\[Empty\]$' || {
    echo "no HarmonyOS device/emulator connected" >&2
    exit 1
  }
  # A cert change makes `hdc install -r` fail with 9568332; always reinstall.
  hdc uninstall "$BUNDLE_NAME" >/dev/null 2>&1 || true
  INSTALL_OUTPUT="$(hdc install "$HAP_PATH")"
  echo "$INSTALL_OUTPUT"
  echo "$INSTALL_OUTPUT" | grep -q "successfully" || exit 1
fi

echo "==> Done. Run: cd Example/e2etest && RNU_E2E_SKIP_PREPARE=true npm run test:e2e:harmony"
