# react-native-update [![npm version](https://badge.fury.io/js/react-native-update.svg)](http://badge.fury.io/js/react-native-update)

[English README](./README.md)

本组件是面向 React Native 提供热更新功能的组件，详情请访问我们的官方网站 <https://pushy.reactnative.cn>。

### 区域服务说明

- 中国区服务使用 **Pushy**（<https://pushy.reactnative.cn>），由**武汉青罗网络科技有限公司**运营，服务器位于中国境内，也通过 cloudflare 智能分流，完全支持海外用户高速访问。**使用人民币支付订阅**。
- 全球区服务使用 **Cresc**（<https://cresc.dev>），由 **CHARMLOT PTE. LTD.** 运营，服务器位于新加坡。**使用美元支付订阅**。
- 中国区与全球区服务由不同公司实体独立运营，服务器、数据及控制台系统彼此隔离。如果可以使用网银和支付宝结算，建议使用 Pushy，否则建议使用 Cresc。

**现已支持鸿蒙以及新架构**

### 快速开始

请查看[文档](https://pushy.reactnative.cn/docs/getting-started.html)

### 配置项速查

下表中的每一项都声明在包根导出的 `ClientOptions` 上，完整说明见
<https://pushy.reactnative.cn/docs/api>。运行时修改统一走 `client.setOptions(...)`。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `appKey` | 必填 | 应用在热更新平台上的身份 |
| `server` | Pushy/Cresc 预设 | `main` 检查端点与 `queryUrls` 远程端点发现（仅接受 https） |
| `updateStrategy` | `alertUpdateAndIgnoreError`（开发环境 `alwaysAlert`） | `alwaysAlert` / `alertUpdateAndIgnoreError` / `silentAndNow` / `silentAndLater` / `null` |
| `checkStrategy` | `both` | `onAppStart` / `onAppResume` / `both` / `null`（不自动检查；原生冷启动检测仍会下载但不会自行激活） |
| `autoMarkSuccess` | `true` | 由 Provider 自动标记当前热更版本健康 |
| `autoMarkSuccessDelayMs` | `1000` | 自动标记前的延迟；关键模块加载较晚时应调大 |
| `healthCheck` | – | 自动标记计时器触发时调用，返回 `false` 则保持崩溃保护 |
| `beforeCheckUpdate` / `afterCheckUpdate` | – | 否决一次检查 / 观察检查的最终状态 |
| `beforeDownloadUpdate` / `afterDownloadUpdate` | – | 否决下载 / 否决下载后的激活 |
| `beforeReload` | – | 否决 `switchVersion` / `restartApp` 的重载 |
| `onPackageExpired` | – | 否决"原生包过旧"流程（`downloadUrl`） |
| `maxRetries` | `3` | 下载重试次数（带抖动退避） |
| `overridePackageVersion` | – | 向服务端上报另一个原生包版本 |
| `dismissErrorAfter` | – | N 毫秒后自动清除 `lastError` |
| `locale` | `zh`（Pushy）/ `en`（Cresc） | 弹窗与提示语言 |
| `debug` | `false` | 允许在开发构建中执行更新操作，并开启 SDK 详细日志 |
| `throwError` | `false` | 把流程错误抛给调用方（错误总会到达 `onError`） |
| `disableTelemetry` | `false` | 不向服务端上报生命周期事件（下载/补丁失败、回滚、标记成功） |
| `disableErrorReporting` | `false` | 关闭 JS 错误上报（见下节） |
| `disableNativeCheck` | `false` | 关闭原生冷启动检测（救砖通道） |
| `testChannel` | `true` | 是否响应 `__rnPushyVersionHash` 深链/二维码；生产构建建议设为 `false` |
| `logger` | – | 接收 SDK 全部事件（`type`、`data`）用于自定义日志 |

除 Provider 钩子外，client 还提供 `onError(listener)`、
`captureException(error, context)`、`resetToPackagedBundle({ restart })`、
面向崩溃上报的 `getUpdateMetadata()` / `attachToSentry()` / `attachToCrashlytics()`，
以及供进度条单独订阅、避免整棵树重渲染的 `useUpdateProgress()`。

### JS 错误上报

SDK 可以把未捕获错误和手动捕获的 JavaScript 错误关联到当前实际运行的热更版本。
此能力默认开启、仅做尽力上报，在开发环境或启用 `disableTelemetry` 时不发送；
全局处理器采用链式安装，不会取代 React Native、Sentry 或 Crashlytics 已有的处理器。

```ts
import { Pushy } from 'react-native-update';

const client = new Pushy({ appKey: 'your-app-key' });

try {
  await submitOrder();
} catch (error) {
  client.captureException(error, {
    extra: { screen: 'checkout', retry: 1 },
  });
}

// 运行时显式退出（同时关闭手动 captureException 的传输）：
client.setOptions({ disableErrorReporting: true });
```

也可以在初始化时通过 `new Pushy({ appKey, disableErrorReporting: true })` 直接退出。

只有携带明确版本 hash 的热更版本错误会被上传。上下文字段只接受经过限长的标量值；
不要放入密钥或个人信息。

### 优势

1. 对中国用户使用阿里云高速 CDN 分发，对比其他服务器在国外的热更新服务，分发更稳定，更新成功率极高。海外用户智能分流至 cloudflare，同样提供稳定高速的分发体验。
2. 基于 bsdiff/hdiff 算法创建的**超小更新包**，通常版本迭代后在几十至几百 KB 级别（其他全量热更新服务所需流量通常在几十 MB 级别）。整条链路更是**针对 Hermes 字节码做了专门优化**——单行改动只需下发 **3.4 KB**（详见下方[算法对比](#diff-算法对比)）；最新的优化都发生在构建期，**已上架的应用只需重新构建一次发版即可受益**。
3. 始终跟进 RN 最新正式版本，第一时间提供支持。支持 hermes 字节码格式。支持新架构（注：安卓 0.73.0 ~ 0.76.0 的新架构因官方 bug 不支持，0.73 以下或 0.76.1 以上的新架构可用）。
4. 跨越多个版本进行更新时，只需要下载**一个更新包**，不需要逐版本依次更新。
5. 命令行工具 & 网页双端管理，版本发布过程简单便捷，完全可以集成 CI。
6. 后台自带**数据统计**（版本分布、更新成功率等）、**灰度发布**（按比例逐步放量）与**版本健康度监控**，无需自建数据链路即可掌控每次发布。
7. 支持崩溃回滚，安全可靠，结合健康度监控可及时发现并止损问题版本。
8. meta 信息及开放 API，提供更高扩展性。
9. 提供 **MCP 服务**：把热更新服务接进 Claude Desktop、IDE 或自建 Agent，用自然语言排查"这台设备为什么没收到更新"，并可与 GitHub、Sentry、CI 等工具组合定位问题。全程只读、按应用授权（[Pushy 文档](https://pushy.reactnative.cn/docs/mcp) / [Cresc 文档](https://cresc.dev/docs/mcp)）。
10. **原生冷启动自愈**：即使热更版本坏到 JS 完全跑不起来（白屏、启动即崩），设备也能在下次启动时由原生侧自动拉到修复版——不需要用户重装，也不需要你发新的应用商店版本（详见下方[原生冷启动检测](#原生冷启动检测)）。
11. 提供付费的专人技术支持。

### Diff 算法对比

Hermes 字节码对通用二进制 diff 极不友好，我们在两个环节同时下手，且收益叠加：

- **delta 模式编译**。Hermes **每次**编译都会重排字符串表，JS 改一行就会让大部分字符串 ID 重新编号，两份几乎相同的字节码于是处处不同。`bundle` 会以同一应用更早的一份字节码为基准编译（`hermesc -base-bytecode=…`），把这些 ID 钉死在原位，只有真正的改动才会进入 diff。
- **HBC 感知的可逆变换**。Hermes 字节码中还有大量"偏移量表"，中间插入几个字节就会令其后所有偏移整体位移。我们在 hdiff 之前引入一层 **delta-friendly 可逆变换**，对偏移位域做前项差分，把整体位移退化为单点变化。布局描述表随补丁下发，Hermes 版本演进时**客户端零升级**。

此外字节码在产出时就不含 debug info 段（实测小 **21%**，与 React Native 自身 release 构建一致），全量包和由它派生的每一个补丁都随之变小。

以下数据在真实 RN 0.86 应用的 release 产物上实测（Hermes HBC v98，字节码约 4.4 MB）。每个补丁都先通过完整往返校验再记录体积，每个 delta 模式产物都通过与普通编译的等价性校验。完整的评测方法、测试数据与可复现代码见 **[hbc-diff-benchmark](https://github.com/sunnylqm/hbc-diff-benchmark)**。

**Hermes 字节码（.hbc）——生产环境 Hermes 应用的实际发包格式：**

| 迭代场景 | 全量 OTA（gzip） | bsdiff | **react-native-update** | 对比 bsdiff |
|---|---|---|---|---|
| 单行文案修改 | 1901.5 KB | 93.7 KB | **3.4 KB** | **小 28 倍** |
| 小功能（约 60 行） | 1913.9 KB | 411.6 KB | **50.2 KB** | **小 8.2 倍** |
| 中等功能（约 300 行） | 1973.7 KB | 551.6 KB | **97.8 KB** | **小 5.6 倍** |

**文本 JS bundle——非 Hermes 应用（同一应用、同样三个场景）：**

| 迭代场景 | 全量 OTA（gzip） | bsdiff | **react-native-update** |
|---|---|---|---|
| 单行文案修改 | 807.2 KB | 0.3 KB | **0.1 KB** |
| 小功能（约 60 行） | 813.1 KB | 7.4 KB | **5.8 KB** |
| 中等功能（约 300 行） | 837.7 KB | 38.4 KB | **28.7 KB** |

文本 bundle 既没有偏移量表也没有字符串表重排，diff 天然干净——补丁只有几百字节到几十 KB。上述两项优化所消除的放大效应是 Hermes 字节码特有的问题，这正是它们存在的意义。

要点：

- 单行修复——也是最常见的热更类型——只需下发 **3.4 KB**，比全量 OTA 少 559 倍。
- 生成补丁比 bsdiff 快 **2~4 倍**，变换本身开销仅个位数毫秒。
- 每一环都有安全兜底：改写任何字节前先做全量校验，delta 模式产物要与普通编译结果比对，任一环节不匹配都自动回退到原有行为。

### 原生冷启动检测

自 10.52.1 起，每次冷启动后数秒会在后台线程执行一次**不依赖 app bundle** 的更新检查（下载、打补丁与状态切换全部在原生侧完成）。它的存在只为一件事：**当前热更版本坏到 JS 起不来时，仍有一条能把修复版拉下来的通路**——常规更新流程仍由应用内的 JS 负责，检查结果会被 JS 侧复用，不会重复请求。

- **不阻塞启动**：延迟数秒、跑在后台线程，成果在**下次启动**生效。下载到的版本是否自动激活取决于你的 `updateStrategy` / `checkStrategy`；否则只下载，激活权仍在 JS。
- **崩溃时刻救援**（Android 与 iOS）：应用在启动阶段死于未捕获的 JS 错误时，SDK 会短暂扣住垂死的进程把检查与下载做完——即使版本每次启动零点几秒就崩，也能被换掉。崩溃上报不受影响：SDK 以链式方式保存并在结束后调用原有的崩溃处理器。不覆盖：原生崩溃、ANR、OOM 击杀，以及 iOS 上安装了自定义 `RCTSetFatalHandler` 的应用。
- **救砖指令**：控制台可按版本标记「强制启动」，被标记的版本无视上述策略直接在下次启动生效——这是把已被坏版本卡死的设备捞回来的手段。设备本地的崩溃回滚保护仍然优先，已回滚过的版本不会被再装回去。
- **可以关闭**：`disableNativeCheck: true`。关闭后每次冷启动少一次后台请求，代价是**放弃上述自愈能力**——被坏热更卡死的设备将无法自动恢复。

### 与其他热更新库对比

| 对比维度 | react-native-update | expo-update | react-native-code-push |
|---------|---------------------|-------------|------------------------|
| **价格/成本** | 提供免费额度，多级梯度付费（最低约 66 元/月），流量不单独计费 | 提供免费额度，多级梯度付费（最低约 136 元/月），超出流量额外计费 | ❌ **已停运**（Microsoft App Center 已于 2025 年 3 月 31 日停止服务） |
| **更新包大小** | ⭐⭐⭐⭐⭐ 几十至几百 KB（增量更新） | ⭐⭐⭐ 全量更新（通常几十 MB） | ❌ **已停运** |
| **中国地区访问速度** | ⭐⭐⭐⭐⭐ 阿里云 CDN，速度极快 | ⭐⭐ 国外服务器，可能较慢 | ❌ **已停运** |
| **iOS 支持** | ✅ 支持 | ✅ 支持 | ❌ **已停运** |
| **Android 支持** | ✅ 支持 | ✅ 支持 | ❌ **已停运** |
| **鸿蒙支持** | ✅ 支持 | ❌ 不支持 | ❌ **已停运** |
| **Expo 支持** | ✅ 支持 | ✅ 支持 | ❌ **已停运** |
| **RN 版本支持** | ⭐⭐⭐⭐⭐ 第一时间支持最新版本 | ⭐⭐⭐⭐ 跟随 Expo SDK | ❌ **已停运** |
| **新架构支持** | ✅ 支持 | ✅ 支持 | ❌ **已停运** |
| **Hermes 支持** | ✅ 支持 | ✅ 支持 | ❌ **已停运** |
| **崩溃回滚** | ✅ 自动回滚机制 | ✅ 支持 | ❌ **已停运** |
| **灰度发布** | ✅ 后台自带，按比例逐步放量 | ✅ 支持 | ❌ **已停运** |
| **数据统计** | ✅ 后台自带（版本分布、更新成功率等） | ⚠️ 有限 | ❌ **已停运** |
| **健康度监控** | ✅ 后台自带版本健康度监控 | ❌ 不支持 | ❌ **已停运** |
| **Hermes 专项 diff 优化** | ✅ delta 模式编译 + HBC 结构感知变换，补丁更小 | ❌ 全量更新 | ❌ **已停运** |
| **管理界面** | ✅ 命令行工具 + Web 管理界面 | ✅ Expo Dashboard | ❌ **已停运** |
| **CI/CD 集成** | ✅ 支持 | ✅ 支持 | ❌ **已停运** |
| **API 扩展性** | ✅ Meta 信息 + 开放 API | ⚠️ 有限 | ❌ **已停运** |
| **中文文档/支持** | ⭐⭐⭐⭐⭐ 完整中文文档，中文社区支持 | ⭐⭐ 英文为主 | ❌ **已停运** |
| **技术支持** | ✅ 付费专人技术支持 | ⚠️ 社区支持 | ❌ **已停运** |
| **服务器部署** | ✅ 可托管也可付费私有部署 | ✅ Expo 托管（EAS Update） | ❌ **已停运** |
| **更新策略** | 灵活配置（静默/提示/立即/延迟） | 相对固定 | ❌ **已停运** |
| **流量消耗** | ⭐⭐⭐⭐⭐ 极低（增量更新） | ⭐⭐⭐ 较高（全量更新） | ❌ **已停运** |
| **更新成功率** | ⭐⭐⭐⭐⭐ 极高（国内 CDN 优势） | ⭐⭐⭐ 中等 | ❌ **已停运** |


### 关于我们

本组件由[React Native 中文网](https://reactnative.cn/)独家发布，如有定制需求可以[联系我们](https://reactnative.cn/about.html#content)。

关于此插件发现任何问题，可以前往[Issues](https://github.com/reactnativecn/react-native-update/issues)发帖提问。
