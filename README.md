# react-native-update [![npm version](https://badge.fury.io/js/react-native-update.svg)](http://badge.fury.io/js/react-native-update)

[中文文档](./README-CN.md)

`react-native-update` provides over-the-air update capabilities for React Native apps. For full documentation, visit:

- Global service: <https://cresc.dev>

**React Native New Architecture is supported.**

## Quick Start

See the docs:

- English docs: <https://cresc.dev/docs/getting-started>

## Advantages

1. react-native-update provides a dedicated global service with fast and reliable worldwide delivery.
2. **Tiny update packages** generated with bsdiff/hdiff are typically only tens to hundreds of KB, instead of the tens of MB usually required by full-bundle update systems. On top of that, the whole pipeline is **specifically optimized for Hermes bytecode**: since CLI 2.22 the bundle is compiled in Hermes **delta mode** so string IDs stay stable across versions, its debug-info section is stripped, and the diff itself runs through an HBC-aware transform (see the [comparison below](#diff-algorithm-comparison)). The two new compile-time steps are build-side only, so **apps already in the store shrink their patches with nothing more than a rebuild**.
3. The library tracks new React Native stable releases closely, supports Hermes bytecode, and supports the new architecture. Note: Android RN 0.73.0 to 0.76.0 new architecture is unavailable because of upstream issues; versions below 0.73 or above 0.76.1 are supported.
4. When updating across multiple versions, clients only need to download **one update package** instead of applying every intermediate version in sequence.
5. Command-line tools and a web dashboard are both available, making release workflows simple and CI-friendly.
6. The dashboard ships with **built-in analytics** (version distribution, update success rate), **staged (gray) rollouts** by percentage, and **release health monitoring** — no need to build your own data pipeline to keep every release under control.
7. Built-in crash rollback keeps updates safe and reliable, and health monitoring helps you catch and stop a bad release early.
8. Meta information and open APIs make the system more extensible.
9. An **MCP server** lets you connect the update service to Claude Desktop, an IDE or your own agent, ask in plain language why a device never received an update, and investigate alongside GitHub, Sentry or CI. Everything is read-only and scoped per app ([Cresc docs](https://cresc.dev/docs/mcp) / [Pushy docs](https://pushy.reactnative.cn/docs/mcp)).
10. **Native cold-start recovery**: even when an update is broken badly enough that JS never runs (white screen, crash on launch), the device pulls the fixed version on its next launch from the native side — no reinstall, no app-store release (see [Native cold-start check](#native-cold-start-check)).
11. Paid technical support is available.

## Native cold-start check

Since 10.52.1 every cold start runs one background update check a few seconds after launch that **does not depend on the app bundle** — the request, the download, the patch and the version switch all happen natively. It exists for exactly one reason: **when the running update is broken enough that JS never starts, something still has to be able to fetch the fix.** Normal updates remain the JS flow's job; the JS check reuses this result instead of issuing its own request.

What to know:

- **It never blocks startup**: it is delayed by a few seconds, runs off the main thread, and its result takes effect on the *next* launch.
- **Whether it activates depends on your configuration**: only with `updateStrategy` set to `silentAndNow` / `silentAndLater` *and* automatic checks left on (`checkStrategy` not `null`) will the native side mark a downloaded version for the next launch. Otherwise it downloads and leaves activation to JS.
- **Rescue directive**: the dashboard can mark a version "force boot", which activates on the next launch regardless of the strategies above — this is how a fleet stuck on a broken version is recovered. The device-local crash-rollback guard still wins: a version this device already rolled back from is never reinstalled.
- **Crash-moment rescue** (Android & iOS): when the app dies of an uncaught JS error during startup, the SDK briefly holds the dying process (a few seconds, bounded) to finish the check and download — so even a version that crashes a fraction of a second into every launch gets replaced. In that window the downloaded fix is always activated for the next launch, since JS is no longer around to decide. Crash reporters keep working: the SDK chains the previous crash handler and always hands the crash over afterwards. Not covered: native (non-JS) crashes, ANRs, OOM kills, and — on iOS — apps that install a custom `RCTSetFatalHandler` (React Native then no longer raises the exception this rescue intercepts).
- **Resumable downloads**: update downloads survive process death and resume from where they stopped (HTTP Range), so repeated short-lived launches still make monotonic progress; a launch that follows an interrupted round skips the startup delay and resumes immediately. HarmonyOS does not need the crash-moment hold: an uncaught JS error does not kill the process there, so the native check completes normally even when JS dies on launch.
- **It can be turned off**: `disableNativeCheck: true` removes one background request per cold start, at the cost of **giving up the recovery above** — a device bricked by a bad update can no longer heal itself. Choose it only when that request is itself the problem (traffic/battery budgets, privacy manifests, consent-gated networking).

## Diff Algorithm Comparison

Patch size is attacked at three independent points of the release pipeline, and the three stack. Optimizations 1 and 2 are **new in CLI 2.22 and entirely build-side**: they change the bytecode that goes into hdiff, so an app already in the store benefits the moment its next release is built with the new CLI — no SDK upgrade, no re-release. Optimization 3 needs the reverse transform in the client (SDK ≥ 10.48).

| # | Optimization | Where it runs | What it removes | Since |
|---|---|---|---|---|
| 1 | Hermes delta mode (`-base-bytecode`) | hermesc, at compile time | String-table renumbering between versions | **CLI 2.22** |
| 2 | Debug info stripping (`-output-source-map`) | hermesc, at compile time | The bytecode debug-info section — measured at 21% of the HBC | **CLI 2.22** |
| 3 | HBC delta-friendly transform | publisher, before hdiff | Offset-table shift amplification | CLI 2.17 |

### 1. Hermes delta mode (`-base-bytecode`) — new in CLI 2.22

Hermes re-sorts its string table by identifier frequency on **every** compile. Change one line of JS and most string IDs are renumbered, so two bytecode files differ almost everywhere even though the program barely changed — and the diff explodes accordingly.

`bundle` now compiles against an earlier bytecode of the same app (`hermesc -base-bytecode=<base.hbc>`), which pins the existing string IDs in place. What lands in the patch is what actually changed.

Measured on the same app and scenarios as the table further down (patch against the chain root, every patch round-trip verified, every delta build verified equivalent to a plain build):

| Scenario | hdiff | hdiff + HBC transform | **delta mode** + both |
|---|---|---|---|
| One-line text change | 84.6 KB | 62.8 KB | **3.4 KB** (18.5×) |
| Small feature (~60 LOC) | 319.5 KB | 276.2 KB | **50.2 KB** (5.5×) |
| Medium feature (~300 LOC) | 414.6 KB | 381.0 KB | **97.8 KB** (3.9×) |

A one-line fix ships in **3.4 KB** — 455× less than the 1.5 MB full bundle. The two Hermes optimizations are complementary rather than redundant: the transform still removes another 9–36% on top of delta mode, because delta mode stabilizes string IDs while the transform absorbs the offset shifts that remain wherever code is genuinely inserted.

- **On by default** (`--hermesBase auto`). The base comes from the update service (`GET /app/:id/hermesBase`), which returns the **root of the current bytecode chain** — every version of an epoch compiles against the same base, so a device jumping several versions at once still downloads one small patch. When no chain root exists yet the server falls back to the newest legacy version, and then to the newest native package.
- **Verified by content.** The base is checked against its sha256 and kept in a local cache (`.pushy/cache/<sha256>`, 500 MB / 20 files LRU; the limit is `--cacheMaxMb` or `PUSHY_CACHE_MAX_MB`, the location is `PUSHY_CACHE_DIR`, and `pushy cache [clean]` inspects or clears it). Publishing a version — and uploading an APK/IPA/APP — seeds that cache with the bundle just built, so the next release usually needs no download at all.
- **Verified by bytecode.** With `--verifyHermesBase` (default on) the CLI additionally compiles *without* a base and streams both disassemblies through an instruction-by-instruction comparison. On any mismatch, any hermesc failure, any unreachable server, the plain build is used instead. **The mode can never block or corrupt a release.**
- **Requirements.** Only a hermesc carrying the upstream delta-mode fix is used: classic `react-native/sdks/hermesc` / `hermes-engine`, or `hermes-compiler` ≥ 250829098. Anything else, or a base whose HBC version does not match the current compiler, falls back to the plain compile.
- **Manual base.** `--hermesBase <file.hbc|.ppk|.apk|.ipa>` compiles against a local artifact — typically the store build you are patching. `--hermesBase none` turns the mode off.

### 2. Debug info is no longer shipped — new in CLI 2.22

`hermesc` is now always invoked with `-output-source-map`, which makes it strip the debug-info section out of the emitted bytecode — the same thing React Native's own release builds do. On the benchmark app that is a flat **21% off the bytecode itself** (4.32 MB → 3.41 MB), so the full package and every patch derived from it both shrink.

Nothing is lost. The Hermes sourcemap is written next to the bundle in the intermediate directory (`.pushy/intermedia/<platform>/<bundle>.map`) and is never packed into the ppk; keep it if you want to symbolicate `address at …` frames from crash reports later. With `--sourcemap` it is composed with the packager map exactly as before.

### 3. HBC delta-friendly transform

Traditional diff algorithms operate on raw bytes. Hermes bytecode, however, is full of offset tables — a small JS change shifts every subsequent offset, which dramatically amplifies the binary difference. Before running hdiff, we apply a **delta-friendly reversible transform tailored to HBC (Hermes bytecode)**: offset bitfields are delta-encoded so the offset-shift amplification disappears at the source. The layout description table is shipped with each patch, so when Hermes evolves, **clients need zero upgrades** — compatibility is automatic.

The numbers below are measured on real release bundles of a React Native 0.86 app (Hermes HBC v98, ~4.4 MB bytecode); every patch is verified by an actual round-trip before its size is recorded. Full methodology, fixtures, and runnable code: **[hbc-diff-benchmark](https://github.com/sunnylqm/hbc-diff-benchmark)**.

They isolate this third layer: one fixed pair of bundles pushed through five diff pipelines. Optimization 1 changes the bundles themselves, so its gain is not visible in this table — it multiplies with what is shown here rather than being included in it.

**Hermes bytecode (.hbc) — what ships in production Hermes apps:**

| Scenario | Full OTA (gzip) | bsdiff | bsdiff+lzma | hdiff | hdiff + HBC transform |
|---|---|---|---|---|---|
| One-line text change | 1901.5 KB | 93.7 KB | 87.7 KB | 89.0 KB | **63.5 KB** (−28% / −29%) |
| Small feature (~60 LOC) | 1913.9 KB | 411.6 KB | 330.9 KB | 328.0 KB | **285.5 KB** (−14% / −13%) |
| Medium feature (~300 LOC) | 1973.7 KB | 551.6 KB | 430.6 KB | 431.6 KB | **398.4 KB** (−7% / −8%) |

**Plain-text JS bundle — non-Hermes apps (same scenarios, same app):**

| Scenario | Full OTA (gzip) | bsdiff | bsdiff+lzma | hdiff |
|---|---|---|---|---|
| One-line text change | 807.2 KB | 0.3 KB | 0.7 KB | **0.1 KB** |
| Small feature (~60 LOC) | 813.1 KB | 7.4 KB | 7.4 KB | **5.8 KB** |
| Medium feature (~300 LOC) | 837.7 KB | 38.4 KB | 37.4 KB | **28.7 KB** |

Text bundles have no offset tables, so they diff cleanly without any transform — patches are hundreds of bytes to tens of KB, and hdiff still beats bsdiff by ~20–25% on the larger changes. The offset-shift amplification is a Hermes-bytecode-specific problem, which is exactly why the HBC transform exists.

Highlights:

- Incremental updates save **5–30×** bandwidth compared to full-bundle OTA (63.5 KB vs 1.9 MB for a one-line change); with delta mode on top, that one-line change is 3.4 KB.
- The bsdiff+lzma control group (same bsdiff delta, lzma compression) shows the compressor accounts for most of the bsdiff-vs-hdiff gap — the further **7–29%** cut from the HBC-aware transform is **pure algorithmic gain**, largest on the small, frequent updates that dominate real OTA traffic.
- Patch generation with hdiff is **2–4× faster** than bsdiff; the transform itself costs single-digit milliseconds.
- Safety first at every layer: section bounds and bitfield ranges are fully validated before any byte is touched, delta-mode output is checked against a plain compile, and each stage falls back to the previous behaviour on any mismatch.

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

