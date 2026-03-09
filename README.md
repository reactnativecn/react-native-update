# react-native-update [![npm version](https://badge.fury.io/js/react-native-update.svg)](http://badge.fury.io/js/react-native-update)

[中文文档](./README-CN.md)

`react-native-update` provides over-the-air update capabilities for React Native apps. For full documentation, visit:

- China service: <https://pushy.reactnative.cn>
- Global service: <https://cresc.dev>

## Regional Service Notice

- **Pushy** (<https://pushy.reactnative.cn>) is the China service, operated by **Wuhan Qingluo Network Technology Co., Ltd.**, with servers and user data hosted in mainland China.
- **Cresc** (<https://cresc.dev>) is the global service, operated by **CHARMLOT PTE. LTD.**, with servers and user data hosted in Singapore.
- Pushy and Cresc are operated by different legal entities with separate infrastructure, data storage, and admin systems. Developers outside mainland China should use Cresc directly.

**HarmonyOS and React Native New Architecture are supported.**

## Quick Start

See the docs:

- Chinese docs: <https://pushy.reactnative.cn/docs/getting-started.html>
- English docs: <https://cresc.dev/docs/getting-started>

## Advantages

1. For users in China, updates are distributed through Alibaba Cloud CDN for high stability and excellent delivery success. For developers outside mainland China, Cresc provides a dedicated global service with fast and reliable worldwide delivery.
2. **Tiny update packages** generated with bsdiff/hdiff are typically only tens to hundreds of KB, instead of the tens of MB usually required by full-bundle update systems.
3. The library tracks new React Native stable releases closely, supports Hermes bytecode, and supports the new architecture. Note: Android RN 0.73.0 to 0.76.0 new architecture is unavailable because of upstream issues; versions below 0.73 or above 0.76.1 are supported.
4. When updating across multiple versions, clients only need to download **one update package** instead of applying every intermediate version in sequence.
5. Command-line tools and a web dashboard are both available, making release workflows simple and CI-friendly.
6. Built-in crash rollback keeps updates safe and reliable.
7. Meta information and open APIs make the system more extensible.
8. Paid technical support is available.

## Comparison With Other OTA Libraries

| Category | react-native-update | expo-update | react-native-code-push |
|---------|---------------------|-------------|------------------------|
| **Price / Cost** | Free tier with multiple paid plans (starting at about CNY 66/month), bandwidth included | Free tier with multiple paid plans (starting at about CNY 136/month), extra bandwidth charges apply | ❌ **Discontinued** (Microsoft App Center shut down on March 31, 2025) |
| **Package Size** | ⭐⭐⭐⭐⭐ Tens to hundreds of KB (incremental) | ⭐⭐⭐ Full bundle updates (usually tens of MB) | ❌ **Discontinued** |
| **China Access Speed** | ⭐⭐⭐⭐⭐ Alibaba Cloud CDN, very fast | ⭐⭐ Overseas servers, may be slower | ❌ **Discontinued** |
| **iOS Support** | ✅ Supported | ✅ Supported | ❌ **Discontinued** |
| **Android Support** | ✅ Supported | ✅ Supported | ❌ **Discontinued** |
| **HarmonyOS Support** | ✅ Supported | ❌ Not supported | ❌ **Discontinued** |
| **Expo Support** | ✅ Supported | ✅ Supported | ❌ **Discontinued** |
| **RN Version Support** | ⭐⭐⭐⭐⭐ Fast support for latest stable RN versions | ⭐⭐⭐⭐ Follows Expo SDK cadence | ❌ **Discontinued** |
| **New Architecture** | ✅ Supported | ✅ Supported | ❌ **Discontinued** |
| **Hermes Support** | ✅ Supported | ✅ Supported | ❌ **Discontinued** |
| **Crash Rollback** | ✅ Automatic rollback | ✅ Supported | ❌ **Discontinued** |
| **Management UI** | ✅ CLI + Web dashboard | ✅ Expo Dashboard | ❌ **Discontinued** |
| **CI/CD Integration** | ✅ Supported | ✅ Supported | ❌ **Discontinued** |
| **API Extensibility** | ✅ Meta info + Open API | ⚠️ Limited | ❌ **Discontinued** |
| **Chinese Docs / Support** | ⭐⭐⭐⭐⭐ Complete Chinese docs and community support | ⭐⭐ Mostly English | ❌ **Discontinued** |
| **Technical Support** | ✅ Paid dedicated support | ⚠️ Community support | ❌ **Discontinued** |
| **Server Deployment** | ✅ Hosted service or paid private deployment | ✅ Hosted by Expo (EAS Update) | ❌ **Discontinued** |
| **Update Strategy** | Flexible configuration (silent / prompted / immediate / delayed) | More fixed workflow | ❌ **Discontinued** |
| **Bandwidth Usage** | ⭐⭐⭐⭐⭐ Very low (incremental) | ⭐⭐⭐ Higher (full bundle) | ❌ **Discontinued** |
| **Update Success Rate** | ⭐⭐⭐⭐⭐ Excellent, especially in China | ⭐⭐⭐ Moderate | ❌ **Discontinued** |

## Local Development

```bash
git clone git@github.com:reactnativecn/react-native-update.git
cd react-native-pushy/Example/testHotUpdate
yarn
yarn start
```

The local library is linked with `yarn link`, so you can modify the source files directly and debug with the `testHotUpdate` example project.

## About

This package is published by [React Native Chinese](https://reactnative.cn/). For custom integration or service inquiries, see [Contact Us](https://reactnative.cn/about.html#content).

If you find any issues, please open a thread in [Issues](https://github.com/reactnativecn/react-native-update/issues).
