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
2. **Tiny update packages** generated with bsdiff/hdiff are typically only tens to hundreds of KB, instead of the tens of MB usually required by full-bundle update systems. On top of that, the diff algorithm is **specifically optimized for Hermes bytecode** (see the [comparison below](#diff-algorithm-comparison)), shrinking patches even further.
3. The library tracks new React Native stable releases closely, supports Hermes bytecode, and supports the new architecture. Note: Android RN 0.73.0 to 0.76.0 new architecture is unavailable because of upstream issues; versions below 0.73 or above 0.76.1 are supported.
4. When updating across multiple versions, clients only need to download **one update package** instead of applying every intermediate version in sequence.
5. Command-line tools and a web dashboard are both available, making release workflows simple and CI-friendly.
6. The dashboard ships with **built-in analytics** (version distribution, update success rate), **staged (gray) rollouts** by percentage, and **release health monitoring** — no need to build your own data pipeline to keep every release under control.
7. Built-in crash rollback keeps updates safe and reliable, and health monitoring helps you catch and stop a bad release early.
8. Meta information and open APIs make the system more extensible.
9. Paid technical support is available.

## Diff Algorithm Comparison

Traditional diff algorithms operate on raw bytes. Hermes bytecode, however, is full of offset tables — a small JS change shifts every subsequent offset, which dramatically amplifies the binary difference. Before running hdiff, we apply a **delta-friendly reversible transform tailored to HBC (Hermes bytecode)**: offset bitfields are delta-encoded so the offset-shift amplification disappears at the source. The layout description table is shipped with each patch, so when Hermes evolves, **clients need zero upgrades** — compatibility is automatic.

The numbers below are measured on real release bundles of a React Native 0.86 app (Hermes HBC v98, ~4.4 MB bytecode); every patch is verified by an actual round-trip before its size is recorded. Full methodology, fixtures, and runnable code: **[hbc-diff-benchmark](https://github.com/sunnylqm/hbc-diff-benchmark)**.

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

- Incremental updates save **5–30×** bandwidth compared to full-bundle OTA (63.5 KB vs 1.9 MB for a one-line change).
- The bsdiff+lzma control group (same bsdiff delta, lzma compression) shows the compressor accounts for most of the bsdiff-vs-hdiff gap — the further **7–29%** cut from the HBC-aware transform is **pure algorithmic gain**, largest on the small, frequent updates that dominate real OTA traffic.
- Patch generation with hdiff is **2–4× faster** than bsdiff; the transform itself costs single-digit milliseconds.
- Safety first: section bounds and bitfield ranges are fully validated before any byte is touched, and the pipeline automatically falls back to plain hdiff on any mismatch.

## Comparison With Other OTA Libraries

| Category | react-native-update | expo-update | react-native-code-push |
|---------|---------------------|-------------|------------------------|
| **Price / Cost** | Free tier with multiple paid plans, bandwidth included | Free tier with multiple paid plans, extra bandwidth charges apply | ❌ **Discontinued** (Microsoft App Center shut down on March 31, 2025) |
| **Package Size** | ⭐⭐⭐⭐⭐ Tens to hundreds of KB (incremental) | ⭐⭐⭐ Full bundle updates (usually tens of MB) | ❌ **Discontinued** |
| **Hermes-specific diff** | ✅ HBC-aware transform, smallest patches | ❌ Full bundle | ❌ **Discontinued** |
| **Staged (gray) rollout** | ✅ Built-in, percentage-based | ✅ Supported | ❌ **Discontinued** |
| **Analytics** | ✅ Built-in (version distribution, success rate) | ⚠️ Limited | ❌ **Discontinued** |
| **Release health monitoring** | ✅ Built-in | ❌ Not available | ❌ **Discontinued** |
| **Technical Support** | ✅ Paid dedicated support | ⚠️ Community support | ❌ **Discontinued** |
| **Server Deployment** | ✅ Hosted service or paid private deployment | ✅ Hosted by Expo (EAS Update) | ❌ **Discontinued** |
| **Bandwidth Usage** | ⭐⭐⭐⭐⭐ Very low (incremental) | ⭐⭐⭐ Higher (full bundle) | ❌ **Discontinued** |

