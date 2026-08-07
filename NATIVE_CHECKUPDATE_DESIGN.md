# 原生检测更新设计：让砖机也能被修好

> 状态：实施中——§8 第 2 步（纯函数抽取）已完成（`src/updateFlowCore.ts`，2026-08-07）
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

---

## 5. Guardian bundle

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
| Android | 开放问题：androidx.javascriptengine（系统 WebView 引擎、沙箱进程、异步）/ 链接 Hermes（ABI 耦合宿主 RN）/ QuickJS（~200KB×4 ABI） | **剩余的全部 spike 范围** |

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
3. **运行时选型** —— 源码可移植性已验证（2026-08-07，三裸引擎逐字节一
   致，见 §5.2）；iOS 定为系统 JavaScriptCore、Harmony 定为系统 JSVM-API，
   **剩余 spike 仅 Android**（javascriptengine / Hermes 链接 / QuickJS 三
   选一，全不干净则 Android 单端退回 C++ 实现的混合形态）
4. **原生编排** —— 三端 HTTP + 调用纯函数 + 复用现有下载/patch/state；
   endpoint 执行引擎为顺序回退（§5.1），不移植 hedged race
5. ~~**guardian 分发通道**~~ **已裁决不做**（2026-08-07，见 §5.3）——
   guardian 只带基线、无远程覆盖；砖机救援能力在第 4 步，不受影响

第 2 步曾是关键路径（B 和 C 的公共前置），现已完成——下一个决策点是第 3 步的求值引擎验证，其结论裁决"决策层用 JS 源码求值还是 C++ 重写"（第 4 步两个结果都要做，路线不再分叉）。

## 9. 已写代码的处置

`REMOTE_RESET_DESIGN.md` 那一版的本地熔断已经三端实现完毕（未提交）。按 §1.2 应当整体撤回。可留用的只有：

- `blockedVersions` —— 与本方案无关，可独立保留或一并撤回
- `autoReset` 遥测事件 —— 无 reset 动作后失去意义，撤回

`unconfirmedBoots` / 前台闸门 / `markBootHealthy` / `PROVIDER_REQUIRED` / `CONTENT_APPEARED` 全部撤回。
