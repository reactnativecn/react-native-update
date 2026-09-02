# react-native-update — HarmonyOS module (`pushy`)

Integration notes for the HAR that ships in the `react-native-update` npm
package (`harmony/pushy.har`). The general setup lives in the project README;
this file covers what the host app must declare itself.

## Permissions

The HAR does not declare `requestPermissions`: downloads and update checks run
inside the host app's process, so the **host** must request the network
permission in its entry `module.json5`:

```json5
{
  "module": {
    "requestPermissions": [
      { "name": "ohos.permission.INTERNET" }
    ]
  }
}
```

Without it every check and download fails with a network error.

## No https → http downgrade (`cleartextTrafficPermitted`)

`@ohos.net.http` follows redirects internally and exposes neither a switch nor
the final URL, so unlike Android/iOS the module cannot itself refuse an
`https → http` redirect. What it does: when the configured endpoints are all
`https://`, any `http://` endpoint injected through the remote endpoint list
and any `http://` artifact URL in a check decision are ignored.

To close the redirect gap, keep cleartext traffic disabled for the app in
`entry/src/main/resources/base/profile/network_config.json` (and reference it
from `module.json5` via `"metadata": [{ "name": "network_config", "resource": "$profile:network_config" }]`):

```json
{
  "network-security-config": {
    "base-config": {
      "cleartextTrafficPermitted": false
    }
  }
}
```

## Build-time metadata (`hvigor-plugin`)

Apply the plugin from the **module** hvigorfile (`entry/hvigorfile.ts`):

```ts
import { hapTasks } from '@ohos/hvigor-ohos-plugin';
import { reactNativeUpdatePlugin } from 'pushy/hvigor-plugin';

export default {
  system: hapTasks,
  plugins: [reactNativeUpdatePlugin()],
};
```

It writes `src/main/resources/rawfile/meta.json` (`pushy_build_time`,
`versionName`) into that module during `assemble*` builds only, before
resources are compiled. Debug builds get `pushy_build_time: "0"` like Android,
so a debug rebuild does not look like a new binary. Add the generated file to
`.gitignore`.

## Versioning

`oh-package.json5` `version` mirrors the npm package version;
`scripts/build-harmony-har.js` rewrites it before `assembleHar` and
`scripts/check-release-version.js` asserts the committed value matches.

This file is packaged with the npm module (`harmony/pushy/src/`) so it is
available next to the sources in `node_modules/react-native-update`.
