# 原生检测更新设计：让砖机也能被修好

> 状态：**实现完成（2026-08-07，e34f390..24f3adf）**——三端编排全部落地：
> 标定层 syncNativeConfig、iOS RCTPushyOrchestrator、Android
> NativeCheckOrchestrator（librnupdate.so 已重编 4 ABI 并过符号/对齐校验）、
> Harmony NativeCheckOrchestrator.ts + NAPI，§10.3 的 JS 响应缓存复用
> （getNativeCheckCache，2 分钟 TTL）也已闭环。剩余：e2e 用例（沿用
> Example/e2etest 基建，验证"坏 bundle 下原生仍拉到修复版"端到端场景）、
> README/CHANGELOG、发版。
> 取代：`REMOTE_RESET_DESIGN.md`（本地启动熔断方案，已放弃，理由见 §1.2）
> 前置：bundleHash 迁移 Phase 0/1/2 已上线且 buildTime 永久保留作 fallback 已定稿
> （2026-08-03）——checkUpdate 的 wire protocol 已稳定，协议前置解除
> 关联：[[native-update-reset-design]] 的 Phase 3

---

## 1. 背景

### 1.1 要解决的问题不变

`markSuccess` 之后设备陷入不可启动状态时，现有安全网（`first_time / first_time_ok`）已经拆除：`last_version` 被清空、目录被删。JS 跑不起来 → checkUpdate 发不出去 → 收不到任何补救。

### 1.2 为什么放弃本地熔断

上一版方案是"原生数连续未确认启动次数，达标就回退到内置包"。实施过程中连续挖出两个会**误 reset 好版本**的路径：

1. **后台启动被计数** —— FCM 后台消息 / HeadlessJS / 静默推送都会创建 RN 实例并走到 `getBundleUrl`，但不挂 React 树，确认信号在结构上不可能到达
2. **多 root component** —— 启动了不含 `UpdateProvider` 的那个入口；而且是静默的（该入口若未构造 `Pushy`，连契约错误都报不出来）

两个洞的共同根因：**把"应用启动了"当成了"应用渲染了 UI"**，而 RN 的启动形态远比这多。既然两轮枚举都没穷尽，就不能假设第三轮能穷尽。

更关键的是补救手段本身就弱：回退到内置包意味着丢掉全部热更、把用户打回可能很老的代码。

**而原生检测提供的补救严格更好**：滚到修好的版本。开发者甚至不需要发新版——在控制台把 package 重新绑回上一个正常版本即可，效果一样。

### 1.3 放弃后的残留

原生检测要联网。以下三种情况没有补救：离线设备、开发者尚未察觉的窗口期、服务端/CDN 故障。

**接受**。这三种下唯一可能的动作是"回退到内置包"，而它的误伤面已经证明比收益大。

---

## 2. 目标与非目标

**目标**
- 热更版本坏到 JS 完全跑不起来时，**下次启动**仍能拉到修复版并装上
- 正常启动**不增加**任何网络往返（是搬迁 checkUpdate，不是新增）
- 正常启动**不阻塞**
- 检测逻辑三端一致，不写三遍

**非目标**
- 阻塞式启动更新（为救千分之一的设备惩罚全部用户）
- 离线自愈
- 保留任何形式的本地熔断

---

## 3. 总体时序

```
冷启动
  1. 原生解析状态 → 决定加载哪个版本（现有逻辑不变）
  2. 原生在后台线程发起 checkUpdate → 下载 → 应用 patch → setNeedUpdate
     （全程不阻塞，本次启动照常加载现有版本）
  3. 原生加载 app bundle
  ...
下次冷启动
  1. 第 2 步的成果在这里生效
```

**修复延迟一次启动。** 砖机场景下这完全够用——用户本来就会再点一次图标。换来的是零启动开销。

关键性质：第 2 步**完全不依赖 app bundle**。app bundle 有语法错误、求值即崩、触发原生崩溃，都不影响它。

---

## 4. 核心决策：检测逻辑放在哪

三个候选：

| 方案 | 三端一致 | 可远程更新 | 复杂度 / 风险 |
|---|---|---|---|
| A. 原生各写一遍 | ❌ 写三遍、漂移 | ❌ | 低但重复 |
| B. C++ 纯函数（`update_flow_core`） | ✅ | ❌ | 中；与 `patch_core`/`state_core` 同构，无新技术风险 |
| C. **Guardian bundle（JS 纯函数 + Hermes）** | ✅ | ✅ | 中高；见 §5 |

A 直接淘汰。B 是 [[native-update-reset-design]] 里 Phase 3 的原计划。C 是本文重点评估的新选项。

**B 与 C 的差别只有一个：检测逻辑本身出 bug 时，能不能不发新 binary 就修好。**

补充两点评审结论（2026-08-06）：其一，B 并不消灭 TS 实现——app JS 侧的交互
流程仍要用同一套决策逻辑，所以 B 实际是 **TS + C++ 双实现长期同步**（每次协
议演进都要重编预编译 `.so`），而 C 是同一份 TS 源两处复用，这是 C 相对 B 的
另一日常优势。其二，C 的独占收益比上表暗示的窄：只要 JS 侧 `checkUpdate` 保
留为全功能回退（§6 是复用结果、不是拆除），原生检测逻辑出 bug 的最坏情形是
正常设备仍被 JS 路径救起、只有砖机在窗口期救不了——即退回现状，而非"全网
瘫"。真正集中风险的是原生**编排**代码（R2），而那部分 B / C 完全相同，
guardian 救不了它。

> **最终裁决（2026-08-07）：选 B，三端统一 C++，金标向量作为双实现的强制契
> 约（已实现）。** 推理链：引擎方案的全部价值 = 单一事实来源；Android 宿主
> Hermes 被符号侦察排除、javascriptengine 因可用性是运行时属性只能当可选优
> 化——一个必定可用的 C++ 实现无论如何要存在；一旦如此，混合形态（iOS/
> Harmony 求值 + Android C++）要养两套机制，统一 C++ 的改动次数相同却删掉了
> 求值器机制整个类别；QuickJS 统一保单源要付 200KB×4 + 三端引擎集成，只换
> 来"少改一处代码"，而那处改动有向量护栏，是机械劳动。
> "单源"要保的性质是**语义唯一且被机械强制**，由金标向量提供：
> `src/updateFlowCore.ts` 是参照实现（oracle），
> `scripts/generate-flow-vectors.ts` 产出
> `cpp/update_flow_core/tests/flow_vectors.json`（金标向量集），
> `src/__tests__/flowVectors.test.ts` 钉住 TS 与向量文件一致，
> `scripts/test-update-flow-core.sh`（CI cpp-test job，带 ASan/UBSan）钉住
> C++ 移植与向量一致。**纪律：语义改动先落 TS → 重新生成向量 → 移植 C++，
> 两侧不绿不发版。** C++ 侧的 `flow_json` 按 JS 语义实现（插入序对象、
> undefined ≠ null、JS truthiness / 严格相等），移植才能逐字节对齐。

---

## 5. Guardian bundle（已否决路线，留档防止重新发明；裁决见 §4）

### 5.1 关键设计约束：它必须是纯函数，不做 IO

直觉上"独立 bundle 跑检测"意味着要给它一个能联网的 JS 环境——那就得注入 `fetch`、要 Promise、要微任务队列、要线程模型，等于自造一个小 RN。**不要这样做。**

正确的边界是：**guardian 只做决策，IO 全部由原生执行。**

```
原生 ──> guardian.buildCheckRequest(state)      ──> { endpoints, queryUrls, path, headers, body, timeoutMs }
原生 <── (按 endpoints 顺序逐个请求，单个超时即换下一个；
          首个失败后拉 queryUrls 合并远程候选、排除已失败的，继续顺序尝试)
原生 ──> guardian.decide(state, responseText)   ──> { action, hash, url, type } | { action: 'none' }
原生 <── (下载 + patch_core 应用 + state_core switchVersion，全是现成的)
原生 ──> guardian.onOutcome(state, result)      ──> { nextState }
```

**endpoint 计划是声明式的**（初稿此处只画了"一问一答"，漏掉了 JS 侧真实存在的
多 endpoint 回退与远程 endpoint 发现）：候选排序（随机首选分摊负载 + 配置序回
退 + 失败排除）是纯策略，由 `orderEndpointCandidates` 给出，随机数由原生作为
输入注入（guardian 不可自取随机）。**原生侧刻意不实现 JS 交互路径的 hedged
race**（`src/endpoint.ts` 的 250ms 错峰竞速）：原生检测跑在冷启动后台、结果下
次启动才生效，延迟不敏感（§7 R5 本来就要求延迟数秒），顺序回退 + 单请求超时
就够了——换来的是三端各自的执行引擎退化为一个 for 循环，无定时器、无 abort
协调。两条路径共享同一份候选排序策略，只在并发形态上分叉。

这个边界带来的简化是决定性的：

- **不需要事件循环、不需要 Promise、不需要注入 HTTP** —— 只是同步求值一段小 JS 再调几个函数
- **隔离性天然成立** —— guardian 与 app bundle 是两个独立的 parse 单元、独立求值；app bundle 的语法错误跟它毫无关系
- 灰度分桶、diff→pdiff→full 选择、`expVersion` 解析、URL 拼接、请求体构造、
  endpoint 排序**已全部抽为纯函数并在 JS 侧原地使用**（`src/updateFlowCore.ts`：
  `buildCheckRequestBody` / `resolveCheckResult` / `decideDownload` /
  `isInRollout` / `joinUrls` / `orderEndpointCandidates`，import 闭包为纯，
  可在裸引擎中求值），guardian 直接复用同一份源码

### 5.2 运行时

在后台线程创建一个 JS 运行时，求值 guardian 源码，调用导出的函数，用完销毁。全同步，毫秒级。

**已定稿（2026-08-06）：guardian 以纯文本 JS 源码分发与求值，不用 HBC。**
Hermes 字节码格式不跨版本稳定——若分发 HBC，服务端覆盖包必须按宿主 Hermes
版本分桶，基线包也与构建期 hermesc 版本绑死，复杂度远超收益。源码求值走的
是慢速路径，但 guardian 每次冷启动只求值一次、代码量千行级，毫秒级完全可接
受。代价：宿主 libhermes 若编译时裁掉了源码编译器则不可用——这归入下面的链
接可行性验证。

**源码可移植性已验证（2026-08-07）**：`src/updateFlowCore.ts` 经
`bun build --format=cjs` 打成 6.4KB 单文件纯文本 JS（零依赖、零 require），
在三个裸引擎下对同一驱动脚本的输出**逐字节一致**且全部正确——macOS 系统
`jsc`（与 iOS JavaScriptCore 同源）、Hermes VM（RN 0.73 配套版本，源码直接
求值无需 HBC）、Node V8。函数调用边界（JSON 进出）即 §5.1 的三步接口，工作
正常。进一步用 ObjC 写了最小原生宿主实测通过：`JSContext` 求值源码 →
`callWithArguments` 调 `decideDownload` → 拿回决策 JSON——40 行代码、仅链
系统 Foundation + JavaScriptCore 两个框架，就是 iOS 编排器的最终形态。语法下限：产物含 `?.`/`??`/对象展开 → Hermes ≥0.7（RN 0.64+）、iOS
JSC ≥13.4；如需更老目标，guardian 构建加 es2015 降级即可。

**纯文本定稿的推论——三端不必用同一个引擎**：源码是共享物，引擎只是求值
器，选型可以按端就地取材：

| 端 | 引擎 | 风险 |
|---|---|---|
| iOS | 系统 JavaScriptCore 框架 | **零**——系统框架，零链接、零包体、零版本耦合，上面已实测同源引擎 |
| Harmony | 系统 JSVM-API（V8，API 11+，RNOH 本就要求 5.0+） | 低——系统能力，待落地时确认 API 细节 |
| Android | 开放问题：androidx.javascriptengine（系统 WebView 引擎、沙箱进程、异步）/ QuickJS（~200KB×4 ABI）/ ~~链接宿主 Hermes~~ | **剩余的全部 spike 范围**（Hermes 路线已被侦察排除，见下） |

**Android 链接宿主 Hermes 已排除（2026-08-07 对 hermes-android
250829098.0.10 / RN 0.85 预编译产物的符号侦察）**：prefab 里虽然带了
`hermes_abi/hermes_abi.h`（稳定 C ABI 头），但其入口 `get_hermes_abi_vtable`
**并未从 `libhermesvm.so` 导出**——只导出了 C++ 的
`facebook::hermes::makeHermesRuntime(RuntimeConfig const&)`，而走 C++ 路线
要求调用方与宿主版本的 `RuntimeConfig` 布局、libc++ ABI 精确匹配，且 JSI 符
号导出为零（消费方须自行编译与宿主一致版本的 jsi.cpp）。对跨 RN 版本分发的
预编译 `librnupdate.so`，这是不可控的版本矩阵；老 RN 的 `libhermes.so` 连库
名和导出面都不同。若未来官方开始导出稳定 C ABI，此路线可复活。当前 Android
实际候选就两个：javascriptengine（零包体、依赖 WebView provider、沙箱进程异
步——对冷启动后台任务可接受，需真机验证）与 QuickJS（确定可行、包体代价）。

原生编排层（HTTP、下载、状态）仍放 `cpp/` 与 `patch_core` / `state_core` 同级三端共享；求值器作为注入接口由各端实现，与 HTTP 客户端同一地位。

**剩余风险收窄为 Android 单点**：直接链接 libhermes 的 C++ API 在 RN 各版本间会变，且 `librnupdate.so` 是预编译产物（4 个 ABI）。若三个 Android 候选都不干净，**仅 Android 一端退回方案 B（决策逻辑 C++ 重写）也是可接受的混合形态**——三端源码一致性只在 iOS/Harmony 保持，Android 以 updateFlowCore 为参照实现并靠共享测试向量对齐。

### 5.3 分发与覆盖

> **裁决（2026-08-07）：远程覆盖通道不做，guardian 只带随 binary 打包的基线。**
> 覆盖通道买的保险是"决策纯函数出 bug 时不发 binary 就能修"，但决策层是全
> 链路最可测的部分（纯函数、单测、与 JS 侧同一份源码），且已有两条兜底：
> JS 侧 checkUpdate 全功能回退（决策 bug 最坏退回现状，不是新增灾难）、服
> 务端塑造响应/重绑版本本身就是一条远程修复通道（决策层消费的是服务端数
> 据）。代价却是全系统最敏感的安全面——启动最早期执行、有权决定装什么版本
> 的服务端下发代码——加上 §5.4/§5.5 的全部工程量，而覆盖机制自身是原生代
> 码，它出 bug 同样无法远程修。保费高于风险敞口。
> 未来若决策层 bug 真在现场咬人，优先评估**搭现有热更通道便车**（ppk 附带
> guardian.js，复用既有 hash 校验与下发权限），不自建通道。§5.4/§5.5 保留
> 作为那时的设计输入；"救砖"能力来自 §8 第 4 步的原生编排，不受本裁决影响。

| | 来源 | 作用 |
|---|---|---|
| 基线 | 随 binary 打包（asset / rawfile） | 永远存在，已随发版验证过 |
| 覆盖 | 服务端下发（独立 hash，独立通道） | 修 guardian 自身的 bug |

覆盖包的下载复用现有下载器；存放路径与热更版本目录隔离。

### 5.4 Guardian 自身的回滚保护

服务端下发的 guardian 跑在所有东西之前，它坏了就是真的砖。所以需要一层它自己的首次运行保护——**而这次这层保护是可靠的，因为 guardian 的成功判据是明确的**：

```
新 guardian 首次使用：
  置 guardianFirstRun = true 并落盘
  求值 + 调用 decide()
  正常返回 → 清除标记，采纳
  抛异常 / 求值失败 / 进程崩溃 → 下次启动看到标记仍在 → 弃用，回落基线 guardian
```

这不是本地熔断那种"猜应用是否健康"——是"这个纯函数调用有没有正常返回"，二值、无歧义、不存在误判空间。这正是本地熔断做不到而这里能做到的原因：**判据从"应用是否可用"（不可判定）变成了"函数是否返回"（可判定）**。

### 5.5 安全

服务端可下发一段在启动最早期执行、且有权决定装什么版本的代码。这不是新增的风险类别——现有热更通道本来就能推送任意 JS——但 guardian 通道必须享有**同等**的保护（HTTPS、hash 校验、下发权限与审计）。不能因为它"小"就走简化路径。

---

## 6. 与 app JS 的分工

app 侧的 `client.ts` / `UpdateProvider` 仍然负责**交互**：更新提示、下载进度、`beforeReload` 等钩子、遥测。

检测本身不要跑两遍。收敛方式：

- guardian 完成一次检查后把结果（含 `checkUpdate` 原始响应与时间戳）落盘
- JS 侧 `checkUpdate` 先读这份结果，在有效期内直接复用，不再发请求
- 需要用户确认的策略（`alertUpdateAndIgnoreError` 等）下，guardian 只**下载**不 `switchVersion`，把激活留给 JS

`updateStrategy: 'silentAndLater'` 语义下则 guardian 可以直接走完全程。

---

## 7. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | Hermes C++ API / ABI 与宿主 RN 版本耦合 | **先做链接可行性验证再定 B/C**；备选 QuickJS |
| R2 | 更新链路整个搬到每次冷启动的原生路径，风险集中——那里出 bug 砖的是所有设备，JS 插不上手 | guardian 可远程更新正是对这条的缓解（这是选 C 的核心理由）；配 §5.4 的回滚保护 |
| R3 | 协议若在下沉后再变要返工 | 前置 bundleHash 迁移，见 §8 |
| R4 | guardian 与 app JS 双重检查造成流量翻倍 | §6 的结果复用 |
| R5 | 后台线程在启动早期发请求，与冷启动争带宽 | 延迟若干秒再发；本来就是"下次启动生效"，不急 |
| R6 | 服务端下发 guardian 的权限被滥用 | §5.5 |

---

## 8. 分期

1. ~~**bundleHash 迁移**~~ **已解除**（2026-08-03）—— Phase 0/1/2 已上线、
   判定开关双端开启、buildTime 永久保留作 fallback 定稿，checkUpdate 的
   wire protocol 已稳定；剩余的 Phase 3（SyncBinaryVersion 迁移）是客户端
   本地状态变更，不动协议，与本方案只需在落地顺序上错开（都动原生启动路
   径与状态 schema），不再构成前置
2. ~~**纯函数抽取**~~ **已完成**（2026-08-07）—— `src/updateFlowCore.ts`：
   `buildCheckRequestBody` / `resolveCheckResult` / `decideDownload` /
   `isInRollout` / `joinUrls` / `orderEndpointCandidates`，无 IO、无
   react-native 依赖、无模块级状态（身份/随机数均参数注入），import 闭包
   为纯；client.ts / provider.tsx / endpoint.ts 已原地改用，单测覆盖
3. ~~**运行时选型**~~ **已关闭：改判方案 B**（2026-08-07，裁决与推理链见
   §4）。`cpp/update_flow_core` 已实现（flow_json + 七个决策函数的 1:1 移
   植），金标向量集在本机与 CI（ASan/UBSan）全过
4. **原生编排** —— 三端 HTTP + 调用 `update_flow_core` + 复用现有下载/
   patch/state；endpoint 执行引擎为顺序回退（§5.1），不移植 hedged race。
   Android 侧 `update_flow_core` 进 `librnupdate.so`（协议演进从此绑定
   `.so` 重编，走 build-android-so.sh + CI + verify-android-so.js 的 16KB
   对齐断言）
5. ~~**guardian 分发通道**~~ **已裁决不做**（2026-08-07，见 §5.3）——随
   §4 改判 B，整个 guardian 路线关闭；砖机救援能力在第 4 步，不受影响

剩余工作只有第 4 步：原生编排。决策层已就位（TS 参照 + C++ 移植 + 向量契约），编排层是纯 IO 胶水。

## 9. 已写代码的处置

`REMOTE_RESET_DESIGN.md` 那一版的本地熔断已经三端实现完毕（未提交）。按 §1.2 应当整体撤回。可留用的只有：

- `blockedVersions` —— 与本方案无关，可独立保留或一并撤回
- `autoReset` 遥测事件 —— 无 reset 动作后失去意义，撤回

`unconfirmedBoots` / 前台闸门 / `markBootHealthy` / `PROVIDER_REQUIRED` / `CONTENT_APPEARED` 全部撤回。

---

## 10. 原生编排设计（§8 第 4 步）

### 10.1 标定（provisioning）——设计到此才暴露的缺口

appKey、server endpoints、更新策略今天只活在 JS 的 `ClientOptions` 里，而原
生检测跑在冷启动、任何 JS 之前。解决：**JS 是唯一配置源，原生只消费落盘副
本。** 每次 `setOptions`（含构造）后 JS 调新的原生方法 `syncNativeConfig`，
持久化：

```text
{ appKey, packageVersion, endpoints: server.main, queryUrls,
  afterDownload: 'none' | 'setNeedUpdate',
  disabled?: boolean, rnu, rn }
```

- `afterDownload` 由 updateStrategy 折算：`silentAndLater` / `silentAndNow`
  → `setNeedUpdate`（原生的作用面本来就是"下次启动"）；alert 类策略 → 只下
  载不激活，弹窗与确认永远归 JS（§6）
- **无配置 → 原生静默不跑**。首次安装首启、或从未升级到新 JS 的老接入，天
  然回到现状，零行为变化——这就是灰度开关，不需要另设开关
- 刻意不做 Info.plist / AndroidManifest 注入：配置双源必然漂移
- 砖机场景自洽：设备能被坏热更砖掉，说明它至少健康跑过一次 JS，配置早已落盘

### 10.2 流程

冷启动 + 延迟 5s（R5），后台线程，每次冷启动至多一轮：

```text
读 config（无则退出）+ 原生 state（currentVersion / rolledBackVersion /
  packageVersion / buildTime / uuid / supportedDiffVersion / bundleHash 缓存）
→ BuildCheckRequestBody（bundleHash 同步读缓存，缺省省略字段）
→ OrderEndpointCandidates(endpoints, 原生随机数)
→ 顺序请求，单个超时 10s、整轮 HTTP 最多 8 次；全失败 → 拉 queryUrls
  （任一成功即用）合并新候选，排除已失败的，再顺序一轮；仍失败 → 本轮放弃
→ HandleCheckResponse(响应原文, identity, isDev=false)（已实现，含 info 透出）
→ action=download：按 attempts 顺序走现有下载器（diff→pdiff→full，
  testUrls 语义由原生逐个尝试实现）；成功 → setLocalHashInfo(info 的
  name/description/metaInfo) → 按 afterDownload 决定是否 setNeedUpdate
→ 原生处理完成后，将响应原文 + 时间戳 + 请求/配置指纹落盘（§10.3）
```

### 10.3 与 JS 的去重（§6 的落地形态）

首版**原生只写缓存**：响应原文 + 时间戳 + 请求/配置指纹落到固定文件。紧
随其后的 JS 小改动：`checkUpdate` 先读该缓存，时间戳新鲜（暂定 2 分钟）
则直接复用不发请求。改造前的过渡期是双检查——多一次网络请求，服务端有
缓存，无害。

### 10.4 失败策略

- 整轮静默失败：无重试风暴、无退避状态机，下次冷启动天然重试
- 下载/patch 失败不拉黑版本、不计数（本地熔断的教训：多记会毁好版本）；
  每次启动至多重试一轮，行为有界
- 不引入任何新的回退/降级路径；apk 过期（expired）响应原生不处理，留给 JS UI

### 10.5 安全面

与 JS 路径同一协议、同一 HTTPS endpoints、同一下载器 hash 校验，无新增
面。`flow_json` 解析网络数据已做深度上限 + 畸形输入回归（ASan/UBSan）。

### 10.6 分平台落地顺序

iOS（NSURLSession，下载/patch/state 全现成，纯增量）→ Android（OkHttp +
librnupdate.so 进 update_flow_core，绑一次 .so 重编）→ Harmony。e2e 用例
沿用 Example/e2etest 既有基建，验证"坏 bundle 下原生仍能拉到修复版"的端到
端场景。

### 10.7 forceBoot——策略的按版本远程覆盖（救砖的最后一环，2026-08-08 实现）

§10.1 的 `afterDownload` 折算暴露了一个洞：alert 类策略（默认策略）下原生只
下载不激活，而砖机的 JS 永远不会跑——修复版躺在磁盘上永不生效，救援在它存
在的理由上失效。

解法是把激活决策做成**客户端默认 + 服务端按版本覆盖**：版本 `config` 增加
`forceBoot: true`（控制台按版本勾选，语义是"强制以该版本启动"，不是 UX 层
面的"静默"）。激活谓词收敛为纯层的 `shouldActivateAfterDownload(info,
afterDownload)`：本地 silent 策略 或 响应标记 forceBoot 即激活。
`HandleCheckResponse` 增参 `afterDownload` 并在 download 决策中直接给出
`activate` 布尔——三端编排器各自只读这一个字段，零判断逻辑。

刻意的语义边界：
- **仅作用于原生**。JS 侧交互策略不感知不受影响——健康设备该弹窗还弹窗,
  用户点"取消"只是"这次不切",下次冷启动仍会进入标记版本（原生分不出砖机
  与健康设备,这正是显式标记版本想要的触达）。
- **本机 `rolledBack` 黑名单赢过 forceBoot**（守卫在谓词之前）:本机有崩溃
  证据的版本不会被重装,开发者应重绑到别的版本。
- **first_time 崩溃保护对强制版本依然生效**:强制启动的版本若也是坏的,
  下次启动照常回滚,不存在"强制进入坏版本且无法回头"。

**服务端存储位置的裁决（2026-08-09,推翻初稿）:forceBoot 存 `bindings.config`,
不存 `versions.config`。** 两个 config 的意图沿革必须记清,防止再犯:

- **`versions.config` 属旧灰度设计,已弃用且在被主动清洗**。旧设计把
  rollout 存在版本上（`config.rollout[packageVersion]`）;新设计把 rollout
  搬到 `bindings.rollout` 列,客户端协议里的 `config.rollout` 形状由服务端
  **从绑定数据合成**。绑定事务里的 `removePackageRolloutConfig` 每次重绑都
  会从 versions.config 清掉对应的 legacy rollout 键——决策层对
  versions.config 刻意不读,响应里的 config 一律合成,这是现行铁律。
- **初稿曾把 forceBoot 放进 versions.config 并让绑定路径透传它,已否决**:
  透传会把未被清洗的 legacy rollout 连带泄漏回响应、让双 config 源复活、
  与清洗机制逆行。相应改动在四个仓库均已回退。
- **`bindings.config` 是新设计预留的"这次投放"配置位**（upsert API 全线
  打通、快照本就 select 它）,forceBoot 正是投放属性:救砖 = 把包重绑到正
  常版本这一动作。存绑定还带来正确的生命周期——重绑即替换绑定,救援结束
  后标记自动消失,不会像挂在版本上那样永久残留;粒度也收敛到单个
  packageVersion。
- **客户端协议不变**:客户端仍读响应里 `info.config.forceBoot`,它从哪合成
  客户端不感知。

已实施（四仓库,本地提交待推送）:pushy-server / cresc-server 决策层从
`binding.config.forceBoot` 合成进下发 config（灰度与全量两分支）,绑定列表
接口补 select config;pushy-admin / cresc-admin 发布菜单加"全量+强制启动
（救砖）",已绑定行显示⚡标记 + 切换项（重发同绑定翻转标记）。
