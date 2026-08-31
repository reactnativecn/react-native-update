# react-native-update [![npm version](https://badge.fury.io/js/react-native-update.svg)](http://badge.fury.io/js/react-native-update)

[中文文档](./README-CN.md)

`react-native-update` provides over-the-air update capabilities for React Native apps. For full documentation, visit:

- Global service: <https://cresc.dev>

**React Native New Architecture is supported.**

## Quick Start

See the docs:

- English docs: <https://cresc.dev/docs/getting-started>

## JS error reporting

The SDK reports uncaught and manually captured JavaScript errors against the
currently running OTA release. Reporting is enabled by default, best-effort,
disabled in development and when `disableTelemetry` is enabled, and never
replaces an existing React Native, Sentry or Crashlytics global handler.

```ts
import { Cresc } from 'react-native-update';

const client = new Cresc({ appKey: 'your-app-key' });

try {
  await submitOrder();
} catch (error) {
  client.captureException(error, {
    extra: { screen: 'checkout', retry: 1 },
  });
}

// Explicit runtime opt-out (also disables manual captureException transport):
client.setOptions({ disableErrorReporting: true });
```

You can also opt out at construction with
`new Cresc({ appKey, disableErrorReporting: true })`.

Only errors from an OTA version with a known version hash are uploaded. Context
is deliberately restricted to bounded scalar values; do not include secrets or
personal information.

## Advantages

1. react-native-update provides a dedicated global service with fast and reliable worldwide delivery.
2. **Tiny update packages** generated with bsdiff/hdiff are typically only tens to hundreds of KB, instead of the tens of MB usually required by full-bundle update systems. The whole pipeline is **specifically optimized for Hermes bytecode** — a one-line change ships in **3.4 KB** (see the [comparison below](#diff-algorithm-comparison)), and because the newest optimizations happen at build time, **apps already in the store benefit from nothing more than a rebuild**.
3. The library tracks new React Native stable releases closely, supports Hermes bytecode, and supports the new architecture. Note: Android RN 0.73.0 to 0.76.0 new architecture is unavailable because of upstream issues; versions below 0.73 or above 0.76.1 are supported.
4. When updating across multiple versions, clients only need to download **one update package** instead of applying every intermediate version in sequence.
5. Command-line tools and a web dashboard are both available, making release workflows simple and CI-friendly.
6. The dashboard ships with **built-in analytics** (version distribution, update success rate), **staged (gray) rollouts** by percentage, and **release health monitoring** — no need to build your own data pipeline to keep every release under control.
7. Built-in crash rollback keeps updates safe and reliable, and health monitoring helps you catch and stop a bad release early.
8. Meta information and open APIs make the system more extensible.
9. An **MCP server** lets you connect the update service to Claude Desktop, an IDE or your own agent, ask in plain language why a device never received an update, and investigate alongside GitHub, Sentry or CI. Everything is read-only and scoped per app ([Cresc docs](https://cresc.dev/docs/mcp) / [Pushy docs](https://pushy.reactnative.cn/docs/mcp)).
10. **Native cold-start recovery**: even when an update is broken badly enough that JS never runs (white screen, crash on launch), the device pulls the fixed version on its next launch from the native side — no reinstall, no app-store release (see [Native cold-start check](#native-cold-start-check)).
11. Paid technical support is available.

## Diff Algorithm Comparison

Hermes bytecode is hostile to generic binary diffing, and we attack that at two points that stack:

- **Delta-mode compilation.** Hermes re-sorts its string table on **every** compile, so a one-line JS edit renumbers most string IDs and two nearly identical bytecode files end up differing almost everywhere. `bundle` compiles against an earlier bytecode of the same app (`hermesc -base-bytecode=…`), pinning those IDs so that only real changes ever reach the diff.
- **An HBC-aware transform.** Hermes bytecode is also full of offset tables, where inserting a few bytes shifts every subsequent offset. Before running hdiff we apply a **delta-friendly reversible transform** that delta-encodes those offset bitfields, so a global shift collapses into a single-point change. The layout description ships with each patch, so **clients need zero upgrades** as Hermes evolves.

The bytecode is also emitted without its debug-info section — a flat **21%** smaller, the same thing React Native's own release builds do — which shrinks the full package and every patch derived from it.

The numbers below are measured on real release bundles of a React Native 0.86 app (Hermes HBC v98, ~4.4 MB bytecode). Every patch is verified by an actual round-trip before its size is recorded, and every delta-mode build is verified equivalent to a plain compile. Full methodology, fixtures, and runnable code: **[hbc-diff-benchmark](https://github.com/sunnylqm/hbc-diff-benchmark)**.

**Hermes bytecode (.hbc) — what ships in production Hermes apps:**

| Scenario | Full OTA (gzip) | bsdiff | **react-native-update** | vs bsdiff |
|---|---|---|---|---|
| One-line text change | 1901.5 KB | 93.7 KB | **3.4 KB** | **28× smaller** |
| Small feature (~60 LOC) | 1913.9 KB | 411.6 KB | **50.2 KB** | **8.2× smaller** |
| Medium feature (~300 LOC) | 1973.7 KB | 551.6 KB | **97.8 KB** | **5.6× smaller** |

**Plain-text JS bundle — non-Hermes apps (same scenarios, same app):**

| Scenario | Full OTA (gzip) | bsdiff | **react-native-update** |
|---|---|---|---|
| One-line text change | 807.2 KB | 0.3 KB | **0.1 KB** |
| Small feature (~60 LOC) | 813.1 KB | 7.4 KB | **5.8 KB** |
| Medium feature (~300 LOC) | 837.7 KB | 38.4 KB | **28.7 KB** |

Text bundles have no offset tables and no string-table churn, so they diff cleanly on their own — patches are hundreds of bytes to tens of KB. The amplification the two optimizations above remove is a Hermes-bytecode-specific problem, which is exactly why they exist.

Highlights:

- A one-line fix — by far the most common hot update — ships in **3.4 KB**, 559× less than a full-bundle OTA.
- Patch generation is **2–4× faster** than bsdiff; the transform itself costs single-digit milliseconds.
- Every stage fails safe: bounds are validated before any byte is touched, delta-mode output is checked against a plain compile, and any mismatch falls back to the previous behaviour.

## Native cold-start check

Since 10.52.1 every cold start runs one background update check that **does not depend on the app bundle** — the request, the download, the patch and the version switch all happen natively. It exists for exactly one reason: **when the running update is broken enough that JS never starts, something still has to be able to fetch the fix.** Normal updates remain the JS flow's job, and the JS check reuses this result instead of issuing its own request.

- **It never blocks startup**: delayed by a few seconds, off the main thread, effective on the *next* launch. Whether the downloaded version is activated automatically depends on your `updateStrategy` / `checkStrategy`; otherwise it is downloaded and JS decides.
- **Crash-moment rescue** (Android & iOS): if the app dies of an uncaught JS error during startup, the SDK briefly holds the dying process to finish the check and download — so even a version that crashes a fraction of a second into every launch gets replaced. Crash reporters keep working: the previous handler is chained and always called afterwards. Not covered: native crashes, ANRs, OOM kills, and iOS apps that install a custom `RCTSetFatalHandler`.
- **Rescue directive**: marking a version "force boot" in the dashboard activates it on the next launch regardless of the strategies above — this is how a fleet stuck on a broken version is recovered. The device-local crash-rollback guard still wins: a version this device already rolled back from is never reinstalled.
- **It can be turned off**: `disableNativeCheck: true` removes one background request per cold start, at the cost of **giving up the recovery above** — a device bricked by a bad update can no longer heal itself.

## Comparison With Other OTA Libraries

| Category | react-native-update | expo-update | react-native-code-push |
|---------|---------------------|-------------|------------------------|
| **Price / Cost** | Free tier with multiple paid plans, bandwidth included | Free tier with multiple paid plans, extra bandwidth charges apply | ❌ **Discontinued** (Microsoft App Center shut down on March 31, 2025) |
| **Package Size** | ⭐⭐⭐⭐⭐ Tens to hundreds of KB (incremental) | ⭐⭐⭐ Full bundle updates (usually tens of MB) | ❌ **Discontinued** |
| **Hermes-specific diff** | ✅ Delta-mode compile + HBC-aware transform, smallest patches | ❌ Full bundle | ❌ **Discontinued** |
| **Staged (gray) rollout** | ✅ Built-in, percentage-based | ✅ Supported | ❌ **Discontinued** |
| **Analytics** | ✅ Built-in (version distribution, success rate) | ⚠️ Limited | ❌ **Discontinued** |
| **Release health monitoring** | ✅ Built-in | ❌ Not available | ❌ **Discontinued** |
| **Technical Support** | ✅ Paid dedicated support | ⚠️ Community support | ❌ **Discontinued** |
| **Server Deployment** | ✅ Hosted service or paid private deployment | ✅ Hosted by Expo (EAS Update) | ❌ **Discontinued** |
| **Bandwidth Usage** | ⭐⭐⭐⭐⭐ Very low (incremental) | ⭐⭐⭐ Higher (full bundle) | ❌ **Discontinued** |
