# 原生检测更新设计：让砖机也能被修好

> 状态：设计草案，待评审
> 取代：`REMOTE_RESET_DESIGN.md`（本地启动熔断方案，已放弃，理由见 §1.2）
> 前置：`BUNDLEHASH_DESIGN.md`（设计定稿、待实施）——协议下沉前必须先定稿协议
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

---

## 5. Guardian bundle

### 5.1 关键设计约束：它必须是纯函数，不做 IO

直觉上"独立 bundle 跑检测"意味着要给它一个能联网的 JS 环境——那就得注入 `fetch`、要 Promise、要微任务队列、要线程模型，等于自造一个小 RN。**不要这样做。**

正确的边界是：**guardian 只做决策，IO 全部由原生执行。**

```
原生 ──> guardian.buildCheckRequest(state)      ──> { url, headers, body }
原生 <── (发 HTTP，各端现成客户端)
原生 ──> guardian.decide(state, responseText)   ──> { action, hash, url, type } | { action: 'none' }
原生 <── (下载 + patch_core 应用 + state_core switchVersion，全是现成的)
原生 ──> guardian.onOutcome(state, result)      ──> { nextState }
```

这个边界带来的简化是决定性的：

- **不需要事件循环、不需要 Promise、不需要注入 HTTP** —— 只是同步求值一个小 HBC 再调几个函数
- **隔离性天然成立** —— guardian 与 app bundle 是两个独立的 parse 单元、独立求值；app bundle 的语法错误跟它毫无关系
- 灰度分桶（`isInRollout`）、diff→pdiff→full 选择、`expVersion` 解析、URL 拼接这些**已经是纯函数了**（`src/isInRollout.ts`、`src/resolveCheckResult.ts`），可以几乎原样搬过去

### 5.2 运行时

在后台线程创建一个 `hermes::makeHermesRuntime()`，求值 guardian 的 HBC，调用导出的函数，用完销毁。全同步，毫秒级。

放在 `cpp/` 里与 `patch_core` / `state_core` 同级，三端共享同一份 C++；各端只提供 HTTP 客户端（Android OkHttp、iOS NSURLSession、Harmony `@ohos.net.http` —— 都已在用）和文件路径。

**主要风险**：直接链接 libhermes 的 C++ API 在 RN 各版本间会变，可能出现符号/ABI 兼容问题。Android 的 `librnupdate.so` 是预编译产物（4 个 ABI），链上 Hermes 后与宿主 RN 的 Hermes 版本耦合。**这是 C 相对 B 的主要代价，需要先做一个链接可行性验证再决定**。

备选：不用 Hermes，用一个极小的嵌入式 JS 引擎（QuickJS 约 200KB）。彻底解耦宿主 RN，代价是包体增加与另一套字节码工具链。

### 5.3 分发与覆盖

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

1. **bundleHash 迁移**（`BUNDLEHASH_DESIGN.md`，已定稿）—— 协议下沉的前置，否则返工
2. **纯函数抽取** —— 把 `buildCheckRequest` / `decide` 从 `client.ts` 剥成无 IO 的纯函数，先在 JS 侧原地使用并补测试。这一步 B / C 都需要，且不依赖运行时选型，**可以立刻开始**
3. **运行时选型** —— Hermes 链接可行性验证；失败则退回方案 B（C++ 纯函数）
4. **原生编排** —— 三端 HTTP + 调用纯函数 + 复用现有下载/patch/state
5. **guardian 分发通道**（仅方案 C）—— 打包、下发、§5.4 回滚保护

第 2 步是关键：**它是 B 和 C 的公共前置**，做完之后再决定选型也不迟，而且它本身就能让现有 JS 实现更可测。

## 9. 已写代码的处置

`REMOTE_RESET_DESIGN.md` 那一版的本地熔断已经三端实现完毕（未提交）。按 §1.2 应当整体撤回。可留用的只有：

- `blockedVersions` —— 与本方案无关，可独立保留或一并撤回
- `autoReset` 遥测事件 —— 无 reset 动作后失去意义，撤回

`unconfirmedBoots` / 前台闸门 / `markBootHealthy` / `PROVIDER_REQUIRED` / `CONTENT_APPEARED` 全部撤回。
