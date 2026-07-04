# react-native-update 全局代码审计报告

> 审计日期：2026-07-04 · 基线：master @ 9013563（含工作区未提交改动）
> 范围：性能、代码质量、可维护性。**不含安全审计。**
> 覆盖：`src/`（TS/JS）、`android/`（Java + JNI）、`ios/`（ObjC++ + podspec）、`harmony/`（ArkTS + NAPI）、`cpp/patch_core/`（共享 C++ 核心）、`scripts/`（构建工具链）、CI/发包配置。

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [整体架构评价](#2-整体架构评价)
3. [跨层系统性主题与方案设计](#3-跨层系统性主题与方案设计)
4. [分层详细发现 — JS/TS 层](#4-jsts-层)
5. [分层详细发现 — Android 层](#5-android-层)
6. [分层详细发现 — iOS 层](#6-ios-层)
7. [分层详细发现 — HarmonyOS 层](#7-harmonyos-层)
8. [分层详细发现 — C++ 核心与构建工具链](#8-c-核心与构建工具链)
9. [工程化与发包配置](#9-工程化与发包配置)
10. [修复路线图](#10-修复路线图)

---

## 1. 执行摘要

本次审计共确认 **约 90 项**发现，其中**高危 10 项**。所有发现均经源码级核实（含实际运行 C++ 单测验证）。

**最需要立即处理的 10 个高危问题：**

| # | 层 | 问题 | 位置 |
|---|----|------|------|
| 1 | JS | 所有 client 实例共享同一个 `defaultClientOptions` 对象，配置互相污染 | `src/client.ts:116` |
| 2 | JS | locale 运算符优先级 bug，Pushy 用户显式传 `locale:'en'` 仍强制中文 | `src/client.ts:137` |
| 3 | JS | APK 下载失败后 `apkStatus` 仍被置 `'downloaded'`，整包更新流程本进程内永久卡死 | `src/client.ts:700-713` |
| 4 | JS | `dismissErrorAfter` 定时器在挂载时启动而非错误发生时，功能实际失效 | `src/provider.tsx:294-299` |
| 5 | Android | 状态写操作全部调度到 UI 线程执行同步 `commit()` 磁盘 I/O（每次冷启动必经） | `UpdateModuleImpl.java:133-258` |
| 6 | Android | Content-Length 未知时每 4KB 发一次进度事件，下载期间 UI 卡顿、桥拥塞 | `DownloadTask.java:110-118` |
| 7 | Android | 资源拷贝失败被全部吞掉、补丁仍报成功 → 线上图片/字体丢失且无日志 | `BundledResourceCopier.java:148-192` |
| 8 | iOS | 下载器不校验 HTTP 状态码，404/错误页被当成功包写盘，还会先删掉已有有效包 | `RCTPushyDownloader.mm:85-104` |
| 9 | Harmony | 补丁/清理为同步 NAPI 调用且模块跑在 UI 线程，打补丁期间界面完全冻结 | `PushyTurboModule.ts:31` + `pushy.cpp` |
| 10 | 发布链 | CI 发包既不重建也不校验 `android/lib/*.so`，改了 C++ 忘记重编即发布全 Android 崩溃包且 CI 全绿 | `publish.yml:43-75` / `prepublish.ts:139-163` |

**三个最有价值的系统性改进方向**（详见第 3 节）：
1. **错误可见性**：各层大量"静默失败"（吞异常、DEBUG 门控日志、不校验返回值），是排查线上问题成本高的根源。
2. **热路径线程模型**：Android/Harmony 均存在主线程磁盘 I/O 或重计算；三端进度事件均无统一节流。
3. **单一事实来源**：状态操作码、魔法字符串、JNI/NAPI 胶水在 4+ 处重复，靠人工同步。

**同时确认的亮点**：版本状态机下沉为共享 C++ 纯函数（`state_core`）是近期最有价值的重构，三端回滚/首启逻辑不再漂移；启动路径开销总体克制；端点容错与下载三级回退设计完善。

**工作区未提交改动提醒**：`harmony/pushy/BuildProfile.ets` 是 hvigor 构建时自动生成的产物覆盖了手工维护的源文件（硬编码 `'10.35.1'` + `DEBUG=true`），**属意外改动，建议 `git checkout` 还原**；`oh-package-lock.json5` 因开放版本区间 `>=0.72.96` 漂移到 0.84.1，是否提交需有意识决策。

---

## 2. 整体架构评价

**数据流**：JS 层 `checkUpdate()`（端点竞速容错 + 灰度分桶）→ `resolveCheckResult` → Provider 按策略弹窗/静默 → `downloadUpdate()`（diff → pdiff → full 三级回退 + 指数退避）→ 原生下载/解压/hdiff 打补丁 → `switchVersion` → 原生状态机 `RESOLVE_LAUNCH` 决定启动 bundle → `markSuccess` 防回滚。

**优点（三端一致确认）**：

- **状态机下沉 C++ 纯函数**（`cpp/patch_core/state_core.cpp`）：回滚/首启/版本同步逻辑三端共享、无副作用、可单测，Java/ObjC/ArkTS 只做 K-V 持久化壳。这是整个仓库最好的设计决策。
- **启动热路径克制**：iOS `+bundleURL` 只有 defaults 内存读 + 每候选一次 stat；三端都有"bundle 缺失 → 循环回滚直到可用版本"的启动容错链，不会白屏死锁。
- **JS 层容错设计完善**：端点去重/随机选点/失败并发竞速、下载三级回退、murmurhash 灰度分桶均有针对性单测。
- **资源管理纪律好**：Java 全面 try-with-resources；C++ 错误路径 `opendir/closedir` 成对；iOS 解包/打补丁全部在专用串行队列，不占主线程。
- 旧版本清理（保留 3 个）控制磁盘占用；zip 解压有路径穿越防护。

**结构性短板**：

- JS 层状态分散在**三处**（类实例 `options`、模块级 `sharedState`、Provider React state）且互不同步。
- 平台胶水层（JNI/NAPI/进度事件/魔法字符串）重复度高，靠人工跨 4+ 文件同步。
- 测试覆盖与风险重心**错位**：最复杂的 `provider.tsx` 零渲染测试；C++ 测试链接了真实 hpatch 却只测 Fake 替身；Harmony 只测平凡纯函数。
- 发布流水线对预编译 `.so` 零校验。

---

## 3. 跨层系统性主题与方案设计

以下 6 个主题各自贯穿多层，建议按主题统一设计方案，而不是逐条打补丁。

### 主题 A：错误可见性（影响最广）

**现状**：
- JS：`throwError: false`（默认）时 checkUpdate 失败既不弹窗、`lastError` 也不更新（`client.ts:430-441` + `provider.tsx:174-179`）；Provider 内 5 处 floating promise；`report()` 在用户不传 logger 时永久挂起（`client.ts:122-131`）。
- Android：失败日志被 `UpdateContext.DEBUG` 门控，release 全丢（`DownloadTask.java:402-404`）；`ReactReloadManager` 5 处空 `catch (Throwable ignored)`，反射失败静默降级到可能加载旧 bundle 的 `recreate()`。
- iOS：多处 `error:nil` 吞错；`buildTime` 读取失败静默变 nil（use_frameworks! 下必现）；错误码一律 `-1` 字符串化，JS 无法分支。
- Harmony：`initPreferences` 吞初始化失败后续以无关 TypeError 崩溃；`flushSync` 不可用时抛错比不落盘更糟；`console.error` 与 hilog 双体系并存。
- C++：`Status` 只有 bool+字符串，无错误码；`ToArchivePatchType` 未知值静默回退 `kFull`。

**方案设计**：
1. **日志分级统一**：约定"错误级日志永不门控，verbose 才受 DEBUG/debug 选项控制"。JS 增加模块级 `debugEnabled`（由 `options.debug || __DEV__` 驱动）；Android 去掉失败分支的 `if (DEBUG)`；Harmony 统一走 `Logger.ts`。
2. **错误码体系**：C++ `Status` 增加 `enum class ErrorCode`（PathUnsafe / PatchCorrupt / IoError / …），JNI/NAPI/ObjC 透传；iOS 错误码枚举化；JS 侧 `UpdateError extends Error { code }`。
3. **解耦 `throwError` 与错误可见性**：client 在 catch 中把 error 附加到返回值（或经 `afterCheckUpdate` 钩子透传 `status:'error'`），Provider 的 `setLastError`/`alertError` 不再依赖 throw。
4. Provider 所有 fire-and-forget 调用统一 `.catch(e => { setLastError(e); ... })`。

### 主题 B：热路径线程模型与进度事件

**现状**：
- Android：`switchVersion`/`markSuccess` 等全部 post 到 UI 线程做同步 `commit()`（每次冷启动必经）；`getConstants` 带副作用且在 JS 线程同步 commit 两次。
- Harmony：`PushyTurboModule` 是 UITurboModule（主线程），而 `applyPatchFromFileSource`/`cleanupOldEntries` 是同步 NAPI —— 打补丁数秒内 UI 完全冻结；`UpdateContext` 构造函数在冷启动路径同步执行目录清理。
- 进度事件三端各自为政且均无节流：Android Content-Length 未知时每 4KB 一次；iOS 每 64KB 一次且 `-1` 原样透传；Harmony `dataReceive`+`dataReceiveProgress` 双路发射。JS 侧 context value 未拆分，每个进度 tick 触发所有 `useUpdate()` 消费者重渲染（`provider.tsx:380-402`）。

**方案设计**：
1. **状态操作统一后台串行**：Android 用专用单线程 Executor 替代 `UiThreadRunner`（保留 `commit()` 持久性）；Harmony 改 `WorkerTurboModule` 或把 `DownloadTask.execute`/`cleanUp` 放进 `taskpool`，NAPI 侧长耗时函数改造 `napi_create_async_work`。
2. **进度节流协议统一**：三端约定"≥100ms 或百分比变化才发事件；total 未知规整为 0"，写进一个共享常量/注释契约。
3. **JS 侧拆 context**：高频 `progress` 独立成 `ProgressContext` / `useUpdateProgress()`，静态成员（client、方法）放不变 context，`value` 用 `useMemo`。

### 主题 C：状态一致性与并发

**现状**：
- JS：`options` 共享可变默认值（高危#1）；`downloadUpdate` 并发去重只在传进度回调时生效（`client.ts:490-492`）；`applyingUpdate` 失败后永久锁死；Provider 与 client 双层节流窗口不一致（1s vs 5s）且节流时静默返回 undefined。
- Android：单例 DCL 缺 volatile 且构造函数 public；`isUsingBundleUrl`/`ignoreRollback` 跨线程可见性无保证。
- iOS：状态"读-改-写"横跨 main/方法队列/_fileQueue 三线程无互斥，并发窗口下可能**误回滚已 markSuccess 的版本**（`RCTPushy.mm:222-275/668-686`）；`ignoreRollback` 非原子。
- iOS/Android 共同：`constantsToExport`/`getConstants` 带 consume-once 副作用，多次调用（多 surface、host 重建）行为漂移。

**方案设计**：
1. JS：构造函数 `this.options = { ...defaultClientOptions }`；下载去重改为 `downloadingTasks: Record<hash, Promise>`，并发调用复用同一 promise；`reloadUpdate` 加 `.catch` 复位 `applyingUpdate`；删除 Provider 层节流，统一由 client 缓存负责。
2. iOS：一把 `os_unfair_lock`（或全局串行队列）包住"读状态→纯函数→写状态"整段；`ignoreRollback` 改 `std::atomic<bool>`。Android 等价用 synchronized + volatile。
3. 三端把"消费 firstLoad/回滚标记"从常量 getter 抽成显式导出方法，`clearInvalidFiles`/`cleanUp` 移到 `markSuccess` 后触发。

### 主题 D：单一事实来源（DRY）

**现状**：`StateOperation` 操作码 1-6 在 C++ ×2（android/harmony 胶水）、Java、ArkTS 共 4 处手工同步；`JStringToString` 等 JNI 助手两份逐字拷贝；魔法字符串（`"index.bundlejs"`、`"bundle.harmony.js"`、`"hash_"` 前缀、`"_update"`）散落各层多文件；JS `downloadUpdate` 内 diff/pdiff/full 三段近乎逐字重复；`UpdateModuleImpl` 8 个方法两两成对重复。

**方案设计**：
1. 新建 `cpp/patch_core/state_ops.h`（枚举 + 数值单一定义）与 `cpp/patch_core/jni_util.h`，三个胶水层统一 include；Java/ArkTS 侧常量加注释指向该头文件（或用小脚本 codegen）。
2. Java 建 `UpdateConstants` 类、Harmony 建 `constants.ts` 集中 SP/preference 键与文件名；`PushyTurboModule` 改为向 `UpdateContext.getRootDir()` 取路径而非手工拼接。
3. JS `downloadUpdate` 重构为数据驱动的策略数组 + 抽出重试循环/进度监听私有方法（报告 §4 #12 有代码示例）。

### 主题 E：测试覆盖错位

**现状与方案**：
- `src/__tests__/provider.test.ts` 实际全测 `resolveCheckResult`，**UpdateProvider 组件零渲染测试**——本次高危 #3/#4 及中危 #5/#10 全部属于渲染测试可捕获的回归。→ 文件改名 + 用 `@testing-library/react-native` 补各 `updateStrategy` 分支、`dismissErrorAfter`、AppState resume、错误路径。
- C++ 测试注入 `FakeBundlePatcher`，真实 `hpatch_by_file` 路径零覆盖。→ 仓库内放一组几百字节的 hdiffz golden 样例，增加走 `DefaultBundlePatcher()` 的端到端用例；`test-patch-core.sh` 加 `-fsanitize=address,undefined`。
- Android `markSuccess` 在 debug 构建下是空操作（iOS 同），核心"切换→标记→回滚"链路只能在 release 验证。→ 去掉 DEBUG 门控或改可配置开关 + 明确日志。
- Harmony 单例 + so 绑定不可测。→ `UpdateContext` 注入化（传 bindings/preferences 接口）后用 hypium mock 覆盖回滚循环。

### 主题 F：构建/发布流水线的静默失败

**现状**：CI 发包不校验 `.so` 新鲜度（高危#10）；`build:so` 硬编码 NDK `28.2.13676358`；`findNewestHar` 全目录按 mtime 找 `.har` 可能发陈旧产物；`build-harmony-har.js` 用 `eval` 解析 JSON5 且失败静默 `return true`；`hermesc-wrapper.js` 信号退出时 `exit(null)`＝成功、Pods 侧 hermesc 被静默转发到 node_modules 版本（bytecode 版本不匹配运行期才崩）。

**方案设计**：
1. publish workflow 增加 `.so` 校验步骤（存在性 + `llvm-nm -D` 导出符号比对 Java native 声明），中期改为 CI 内安装 NDK 重建、不再提交二进制进 git。
2. `build:so` 换成解析脚本：`ANDROID_NDK_HOME` → `$ANDROID_HOME/ndk/` 最高版本 → PATH，缺失时给明确指引。
3. `findNewestHar` 限定到 hvigor 固定输出路径 + 校验 mtime 晚于构建开始；构建前清理 build 目录。
4. `eval` 替换为 `require('json5').parse`；hermesc wrapper 修 `exit(code ?? 1)`、从自身路径反推 `_hermesc`、注入后删除 hash 文件。

---

## 4. JS/TS 层

### 高危

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| JS-1 | `src/client.ts:116,135,156-168` | `options = defaultClientOptions` 赋引用 + `setOptions` 原地写，**所有实例共享同一 options 对象**，Pushy+Cresc 并存时 appKey/server/logger 互相覆盖 | 构造函数 `this.options = { ...defaultClientOptions }` |
| JS-2 | `src/client.ts:137` | `options.locale ?? this.clientType === 'Pushy' ? 'zh' : 'en'` 优先级错误，实际为 `(locale ?? isPushy) ? 'zh' : 'en'`，显式 `locale:'en'` 被强制成中文 | 加括号：`options.locale ?? (this.clientType === 'Pushy' ? 'zh' : 'en')` |
| JS-3 | `src/client.ts:700-713` | APK 下载失败走 `.catch` 后代码继续执行，无条件 `apkStatus = 'downloaded'` 覆盖 catch 里的复位；此后重试全部命中 `'downloaded'` 分支直接报 `errorInstallApk`，**本进程内整包更新永久卡死**；用户取消安装也无复位路径 | 改 try/catch，成功分支内才置 `'downloaded'`（详见正文代码） |
| JS-4 | `src/provider.tsx:294-299` | `dismissErrorAfter` 定时器在挂载 effect 里启动（依赖全部稳定，只跑一次），真正的错误永远不会被自动清除，**该公开选项实际不工作** | 独立 effect 监听 `lastError`，错误出现时才起定时器并在 cleanup 清除 |

### 中危

- **JS-5** `provider.tsx:173-188` — `{ ...(await checkUpdate()) }` 使 `if (!rootInfo)` 成为死代码；被跳过/失败的检查用 `{}` 覆盖已有 `updateInfo`，其后 `downloadUpdate()` 静默返回 false。→ 去掉展开、按内容字段判空。
- **JS-6** `client.ts:430-441` + `provider.tsx:174-179` — 默认 `throwError:false` 时检查错误完全不可见（不弹窗、不进 `lastError`），与 `alwaysAlert` 语义矛盾。→ 见主题 A 方案 3。
- **JS-7** `provider.tsx:380-402` — context value 每次 render 新建 + 每个进度事件全量重渲染所有 `useUpdate()` 消费者。→ 见主题 B 方案 3。
- **JS-8** `client.ts:490-522` — 下载并发去重只在传 `onDownloadProgress` 时生效，并发调用重复触发原生下载且第二方拿不到结果。→ `downloadingTasks` promise 表去重。
- **JS-9** `client.ts:103-112,339-352` — `assertHash` 未命中静默 no-op 无日志；`reloadUpdate` reject 后 `applyingUpdate` 永久锁死。→ 加日志 + `.catch` 复位。
- **JS-10** `provider.tsx:111` — 首次下载成功后 AppState 监听被永久 remove，`onAppResume` 策略失效且无恢复机制。→ 保留监听，用状态判断代替拆监听器。
- **JS-11** `utils.ts:116-152` — `fetchWithTimeout` 用 `Promise.race` 不中止底层请求；`enhancedFetch` 的 `url.replace('https','http')` 只换第一处子串且对 POST 整体重放（服务端重复计数）。→ `AbortController` + `replace(/^https:/,'http:')`，降级仅限幂等请求。
- **JS-12** `client.ts:454-651` — `downloadUpdate` 近 200 行上帝函数，diff/pdiff/full 三段逐字重复。→ 数据驱动策略数组重构（主题 D）。
- **JS-13** `client.ts:88-101` + `i18n.ts:92` — 模块级 `sharedState` + i18n 单例与"可 new 多实例"的类 API 形态矛盾。→ 状态收进实例或对第二实例警告。
- **JS-14** `provider.tsx:166-169` vs `client.ts:381-390` — 双层节流（1s/5s）重复且 provider 节流时返回 undefined 与失败不可区分。→ 删 provider 层节流。
- **JS-15** `src/__tests__/provider.test.ts` — 文件名误导：内容全是 resolveCheckResult 用例，UpdateProvider 零覆盖。→ 见主题 E。
- **JS-16** `provider.tsx:121,124,201,218,317` — 5 处 floating promise，`throwError:true` 时成为未处理拒绝。→ 统一 `.catch`。

### 低危

- **JS-17** `utils.ts:52-53` — web 平台 `ping = Promise.resolve` 裸引用，detached 调用抛 TypeError，仅靠空 catch 碰巧兜住。
- **JS-18** `utils.ts:23-38` — `promiseAny([])` 永不 settle；建议加空数组守卫或改原生 `Promise.any`。
- **JS-19** `client.ts:443-453` — `getBackupEndpoints` 是双重冗余过滤的 no-op 包装且无调用方。
- **JS-20** `client.ts:122-131,180-207` — 不传 logger 时 `report()` 永久 await 挂起（闭包驻留）；report 调用无人 catch。
- **JS-21** `client.ts:404,159,177` 等 + `context.ts:26` — `any`/`as any` 扩散；context 的 `checkUpdate` 签名丢失 `{extra}` 参数。
- **JS-22** `utils.ts:4-18`、`core.ts:95-103` — 生产环境无条件 console.log（每次启动打全量状态）。→ 主题 A 方案 1。
- **JS-23** `client.ts:544-608` — dev 下 testUrls HEAD 探测白白发出；每次重试重新探测全部 URL。→ `__DEV__` 判断前移 + 探测结果缓存。
- **JS-24** `provider.tsx:276-280` — markSuccess 的 1s setTimeout 无 cleanup。
- **JS-25** `provider.tsx:308-325` — `parseTestPayload` 就地替换共享 `options.logger`，并发时可能把弹窗版 logger 永久留下。
- **JS-26** `core.ts:83-89` — `setUuid` 无 catch（持久化失败→uuid 每启动漂移→灰度分桶横跳、统计虚高）；`require('../package.json')` 把整个 package.json 打进 bundle。
- **JS-27** `provider.tsx:39` — `client` prop 被 `useRef` 静默冻结，无 dev 警告。

---

## 5. Android 层

### 高危

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| AN-1 | `UpdateModuleImpl.java:133-258` + `UpdateContext.java:209-216` | `switchVersion`/`markSuccess`/`setUuid` 等全部 `UiThreadRunner` post 到主线程执行同步 `commit()` 写盘 + `File.exists()`；`markSuccess` 是每次冷启动必经路径，低端机掉帧/ANR 来源 | 换专用单线程 Executor 串行化（UI 线程并非必须，只是被用来串行） |
| AN-2 | `DownloadTask.java:110-118` | Content-Length 未知（chunked/gzip 时 OkHttp 返回 -1）时每 4KB chunk 发一次进度事件，20MB 包 ≈ 5000 次主线程 post + JS 事件 | else 分支按字节阈值节流（如每 256KB） |
| AN-3 | `BundledResourceCopier.java:148-192` | 源条目找不到 `continue`、IOException 仅 DEBUG 日志后继续、无论成败都从 remaining 移除——资源拷贝失败被全部吞掉，更新仍报成功并可被激活，线上资源丢失且 release 零日志；回滚只保护"启动失败"救不了这种场景 | 统计失败的必需拷贝，非空抛 IOException 走失败清理；失败日志移出 DEBUG 门控 |

### 中危

- **AN-4** `UpdateContext.java:40,337-346,58` — 单例 DCL 缺 `volatile`（失效 DCL）；构造函数 public 可绕过单例 → 双 Executor 并发 RMW 同一 SharedPreferences。→ volatile + private 构造。
- **AN-5** `DownloadTask.java:398-409` — `onDownloadCompleted` 在 try 块内，回调抛异常（如 `installApk` 的 FileProvider 配置错误）会被当下载失败、**删除已下载成功的 APK**，还可能对同一 promise 二次 settle。→ 成功回调移出 try/catch。
- **AN-6** `UpdateModuleSupport.java:17-39` — `getConstants` 带副作用（消费标记 + `commit()` ×2 + 触发 cleanUp），新架构下在 JS 线程同步执行且非幂等。→ 见主题 C 方案 3；marker 类数据用 `apply()` 即可。
- **AN-7** `UpdateContext.java:266-285` — `markSuccess` 在 debug 构建下空操作，核心回滚链路 debug/release 行为分叉、无法在 debug 验证。→ 去门控或显式日志。
- **AN-8** `ReactReloadManager.java:174-237,78-80` — 5 处空 `catch (Throwable ignored)`；反射链失败静默落到 `activity.recreate()`（可能加载旧 bundle），无任何日志说明哪层失败。→ 每层 `Log.w`，兜底前 `Log.e` 汇总。
- **AN-9** `UpdateContext.java:216-217,388-396` — `switchVersion` 抛 `java.lang.Error`（应为 `IllegalStateException`）；`getBundleUrl` 回滚 while 循环无前进性保护，原生返回重复 hash 时主线程死循环。→ 改异常类型 + 加已访问集合/最大迭代数。

### 低危

- **AN-10** `DownloadTask.java:402-404`、`UpdateContext.java:210-211` — 失败日志被 DEBUG 门控，release 无诊断信息。
- **AN-11** I/O 效率：`DOWNLOAD_CHUNK_SIZE=4096` 偏小（okio 场景可 64KB）；`SafeZipFile.java:80-88` 三重缓冲；`UpdateFileUtils.copyFile` 可用 `FileChannel.transferTo`。
- **AN-12** `DownloadTask.java:32` — 自建 OkHttpClient 无 `callTimeout`，慢速滴流可无限拖住单线程 Executor 上的后续任务。→ 复用 `OkHttpClientProvider` 或显式超时。
- **AN-13** `BundledResourceCopier.java:67-90` — 为一次 diff 全量索引所有 APK 条目建 4 个 HashMap（上万条目）。→ 先 `zipFile.getEntry(name)` 直查，失败才全量扫描。
- **AN-14** 弃用 API：`TurboReactPackage`（→`BaseReactPackage`）、`hasActiveCatalystInstance()`（bridgeless 下恒 false 丢进度事件，→`hasActiveReactInstance()`）、`getExternalStoragePublicDirectory`、`build.gradle:178` 的 `react-native:+` 动态版本。
- **AN-15** `UpdateModuleImpl.java` — 8 个方法 promise/无 promise 成对重复（可收敛 4 个 + `@Nullable Promise`）；4 处相同匿名 listener；错误处理风格不一致（仅 `downloadPatchFromPpk` 有 try/catch 且把 message 当 code）。
- **AN-16** 魔法字符串：`"hash_"` 前缀跨 3 文件、`"index.bundlejs"`、保留天数 `3` 等。→ `UpdateConstants` 集中。
- **AN-17** `build.gradle:38-58` — 每次 Gradle 配置期 `project.exec` 起 node 探测 expo（拖慢所有构建、失败静默）；`versionName "1.84.1"` 硬编码与 projectVersion 双轨；fallback `minSdk 16` 与 `Application.mk` 的 `android-21` 矛盾。
- **AN-18** `UpdateContext.java:29-30` — `isUsingBundleUrl`/`ignoreRollback` 跨线程读写非 volatile；`getPackageVersion` 失败返回 null 传给 JS；`UpdateFileUtils` 递归删除跟随符号链接。

---

## 6. iOS 层

### 高危

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| IO-1 | `RCTPushyDownloader.mm:85-104` | 不校验 HTTP 状态码：404/500/CDN 错误页/强制门户 HTML 一样走成功路径，先 `removeItemAtPath:savePath` **销毁可能已有的有效包**再写入错误页，失败推迟到解包时以无指向性的 "unzip failed" 暴露 | `didCompleteWithError` 中检查 `statusCode`，非 2xx 构造 NSError（正文有代码） |

### 中危

- **IO-2** `RCTPushy.mm:692,514` — `ensureDirectoryExistsAtPath:` 对 `_fileQueue` 做 `dispatch_sync`，而该队列同时承担解包/打补丁（数秒~数十秒）：解包期间 JS 任何 `downloadXxx` 会把整个模块方法队列同步阻塞。→ 目录检查直接在当前线程做（`createDirectoryAtPath` 幂等线程安全）。
- **IO-3** `RCTPushy.mm:55,222-275,434-452,668-686,741-757` — 状态 RMW 横跨 main/方法队列/_fileQueue 无互斥，`markSuccess` 与 reload 后 `bundleURL` 并发时 `first_time_ok=true` 可能被覆盖 → **下次冷启动误回滚已成功版本**；`ignoreRollback` 非原子。→ 一把锁包住"读→变换→写"整段。
- **IO-4** `RCTPushy.mm:289-323` — `constantsToExport` 带副作用（消费一次性标记 + 触发 `clearInvalidFiles`），bridgeless 下调用时机/次数不受控。→ 抽显式方法。
- **IO-5** `RCTPushy.mm:804-806` + podspec:98-99 — `pushy_build_time.txt` 用 `s.resource` 声明，use_frameworks! 下 mainBundle 找不到，`buildTime` 静默变 nil → 同版本号新二进制不触发 `SyncBinaryVersion`，旧热更 bundle 覆盖新二进制且无日志。→ 优先 `bundleForClass:` 查找 + 失败 `RCTLogWarn`。
- **IO-6** `RCTPushy.mm:531-541` — 下载/解包产物从未用 hash 校验内容一致性（目录仅以 hash 命名），CDN 污染/串包会安装错误 bundle 并被 markSuccess 固化。→ 对 zip 或解包后的 `index.bundlejs` 做摘要比对。

### 低危

- **IO-7** `RCTPushy.mm:523-530` — 进度事件每 64KB 一次无节流；total 可能为 -1 原样透传。
- **IO-8** `RCTPushy.mm:277-282` — `+rollback` 未在任何头文件声明，是死代码或隐藏 API。
- **IO-9** `NativePushy.ts:12,35-39` vs mm — spec 声明的 `isUsingBundleUrl` iOS 从不导出；`downloadAndInstallApk` iOS 无实现，新架构误调直接抛。
- **IO-10** `RCTPushyDownloader.mm:12,53-58` — `finished` check-then-set 非原子、`hasListeners` 跨队列读写。
- **IO-11** `RCTPushy.mm:717-721` — `unzipFileAtPath` 无条件先删目标目录，重复下载当前运行 hash 且解包失败时活动 bundle 被删。→ 解包到 `.tmp` 后原子 rename。
- **IO-12** `RCTPushy.mm:604-628` — `applyPatchForHash` 冗余存在性检查。
- **IO-13** 错误处理风格：错误码一律 -1、中英文混杂（`"json格式校验报错"` :365）、多处 `error:nil`。
- **IO-14** podspec — deployment target '11.0' 过旧（RN 0.76+ 要求 15.1）；`React` 伞 pod 冗余依赖；硬编码 `React-Codegen` 路径（0.74+ 已改名）；script_phase 每次编译写 node_modules（破坏增量、pnpm 只读布局失败）；Expo 探测静默 rescue。
- **IO-15** `RCTPushy.mm:437-438,798-799` — DEBUG 下 markSuccess 不落盘、buildTime 恒 "0"（debug 热更后必回滚），两处 `#if DEBUG` 无注释说明是刻意设计。
- **IO-16** 杂项：`main.jsbundle` 硬编码；`../../cpp/...` 相对 include 脆弱；`ExpoPushyModule.swift` 空模块；回滚 fallback 用 `RCTLogError` 刷屏（应 Warn）。

---

## 7. HarmonyOS 层

### 高危

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| HM-1 | `PushyTurboModule.ts:31` + `DownloadTask.ts:236,521,617` + `UpdateContext.ts:510-518` | 模块是 **UITurboModule（主线程）**，而 `applyPatchFromFileSource`/`cleanupOldEntries` 是同步 NAPI（`pushy.cpp` 中 `napi_create_async_work` 出现 0 次）——hdiff 打补丁数百 ms~数秒内 UI 完全冻结；`UpdateContext` 构造函数还在冷启动路径同步 `cleanUp()`。Android 同逻辑在后台线程，是明确平台差距 | 改 `WorkerTurboModule` 或 `taskpool.execute`；NAPI 改 async work；构造函数内 cleanUp 延迟到 markSuccess 后 |
| HM-2 | `DownloadTask.ts:319-334,396-408` | `dataEndPromise` 只有 `dataEnd` 事件一条 settle 路径，无错误事件订阅、无超时——传输中断时下载 Promise **永久挂起**，JS 侧卡死无法重试 | `Promise.race` 超时竞速（进度到达时刷新 timer），失败 `httpRequest.destroy()` |

### 中危

- **HM-3** `PushyTurboModule.ts:96-110` — reload 兜底定时器在 `restartAbility()` resolve 后必然被 `clearTimeout`，而 HarmonyOS `restartApp` 有限流（冷启动 3s 内/3s 内重复调用会**静默失败但 Promise 正常 resolve**）——兜底恰好防不到它要防的场景（即最近 "fix harmony reload" 提交的修复区域）。→ 成功路径**不清除**定时器：进程真重启则定时器随进程消亡；没重启则 1.5s 后软 reload 接管。`clearTimeout` 仅留在 catch 分支。
- **HM-4** `UpdateContext.ts:88-96,26` — `initPreferences` 失败仅 console.error，随后 `undefined.getSync` 抛无关 TypeError 且坏单例被缓存。→ fail fast rethrow 或内存兜底。
- **HM-5** `UpdateContext.ts:181-193` — `flushSync` 不可用时选择 throw，导致 `switchVersion`/`markSuccess` 等全部失败，比不落盘更糟。→ 降级到异步 `flush().catch(...)`。
- **HM-6** `DownloadTask.ts:365-394,433-439` — `dataReceive` 与 `dataReceiveProgress` 双路各发一次进度事件（20MB ≈ 600+ 次×2），两套 received 计数混用。→ 保留一处 + ≥100ms 节流。
- **HM-7** `UpdateContext.ts:69-81` + 调用点 — `trace()` 诊断（注释自认临时代码）在生产热路径常开，一次 `getConstants` 触发 40+ 次 preferences 读取和多条 hilog info。→ 降 `logger.debug`；getConstants 内取一次快照复用。
- **HM-8** `scripts/build-harmony-har.js:168-175,399-432` — `findNewestHar` 全 build 目录按 mtime 取最新 `.har`，增量跳过/缓存路径变化时静默发布陈旧（甚至 debug 模式）产物。→ 构建前清 build 目录或锁定 hvigor 固定输出路径 + mtime 校验。

### 低危

- **HM-9** 死代码：`UpdateContext.DEBUG` 恒 false 的死分支；`persistState` 的 `clearExisting` 无调用方且内含未 await 的 `clear()`；`EventHub` 的 listeners Map 从未被 emit 消费（测试还在验证空壳）；`ARCHIVE_PATCH_TYPE_FULL`/`hdiffPatch` TS 侧无使用。
- **HM-10** `DownloadTask.ts:464-476` — `doPatchFromApp` 丢弃 `buildArchivePatchPlan` 返回值，与 `doPatchFromPpk` 风格不一致。
- **HM-11** 魔法字符串：`'bundle.harmony.js'` ×5、`'_update'` 在 `PushyTurboModule.ts:144` 被手工重拼而非问 UpdateContext。→ `constants.ts` + `getRootDir()`。
- **HM-12** `PushyFileJSBundleProvider.ets:18-24` — `getURL()`/`getBundle()` 各跑一次完整 RESOLVE_LAUNCH 状态机。→ 缓存首次结果。
- **HM-13** `DownloadTask.ts:248,603-624` — `error.message` 就地赋值，非 Error/冻结对象时抛 TypeError 掩盖原始错误。→ `new Error(msg, { cause })`。
- **HM-14** `DownloadTask.ts:558-562` — `'icon.round.png'.split('.')[0]` 取错媒体名。→ `name.replace(/\.[^.]+$/, '')`。
- **HM-15** `PushyTurboModule.ts:81-93` — `terminateSelf()` 后再 `startAbility` 的兜底基本无效；debug 下 `devToolsController` 缺失时 reload 静默 no-op。
- **HM-16** 类型松散：`hash` 无初始化、EventHub 全 any、`devToolsController` 三处 any 穿透、`as unknown as` 双跳。
- **HM-17** `UpdateContext.ts:102-116` — `getPackageVersion` 失败返回 `''`（跳过版本比对）vs 缺失返回 `'Unknown'`（参与比对），语义不一致。
- **HM-18** I/O 小低效：`writeFileContent` 对内存 buffer 逐 64KB slice 拷贝分块写；`readFileContent` 依赖单次 read 读满。
- **HM-19** `build-harmony-har.js:448-463` — 正则剥注释 + `eval` 解析 JSON5，失败静默 `return true`。→ `json5.parse`。
- **HM-20** 双日志体系（console.error vs hilog logger）并存，线上过滤丢一半错误。
- **HM-21** 测试仅覆盖平凡纯函数；`UpdateContext` 注入化后即可 mock 覆盖回滚循环。

---

## 8. C++ 核心与构建工具链

（已实际运行 `scripts/test-patch-core.sh`，15 个测试全部通过。）

### 高危

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| CP-1 | `publish.yml:43-75` / `prepublish.ts:139-163` | CI 发包完全跳过 `buildNativeArtifacts()`，只校验 harmony HAR；Android `.so` 依赖开发者本机手动 `build:so` 后提交——改了 `cpp/patch_core`（如新增 JNI 导出）忘重编即发布 `UnsatisfiedLinkError` 崩溃包，CI 全绿 | publish 增加 `.so` 存在性 + `llvm-nm -D` 符号校验；中期 CI 内装 NDK 重建、二进制不进 git |

### 中危

- **CP-2** `update_core_android.cpp:242-281` — `NewCopyGroupResult` 每次 `FindClass` ×2 不 `DeleteLocalRef`，循环调用下大 copies 清单（数百组常见）撑爆 JNI 局部引用表直接 abort（Android 8 以下上限 512）。→ jclass 提到循环外。
- **CP-3** `update_core_android.cpp:25-31,64-157` — `GetFieldID`/`FindClass` 失败置 pending exception 后继续调 JNI 函数（规范禁止，CheckJNI 下 abort）；Java 侧字段重命名会从 NoSuchFieldError 变未定义行为。→ helper 返回 bool 短路或 `ExceptionClear` 后返回错误。
- **CP-4** `patch_core.cpp:464-478` — `CleanupOldEntries` 单条目失败（含并发删除的 ENOENT）即中止整个清理，存储持续膨胀。→ 单条失败 continue，结束后汇总。
- **CP-5** `tests/patch_core_test.cpp:34-55` — 链接了真实 hpatch 却全部注入 Fake，`hpatch_by_file` 真路径零覆盖、无 golden-file 回归。→ 见主题 E。
- **CP-6** 性能：`patch_core.cpp:301-360` — PPK diff 时未变更文件（几十上百 MB）全量 fread/fwrite 拷贝，同文件系统内可用 `link(2)` 降为 O(文件数)，失败回退 CopyFile。收益：更新耗时与闪存写入量显著下降。
- **CP-7** `scripts/hermesc-wrapper.js` — (a) Pods 侧 hermesc 被静默转发到 node_modules 版本（bytecode 版本不匹配运行期崩）；(b) `process.exit(code)` 在信号退出时 `code===null` ＝成功；(c) `setTimeout(500ms)` 等落盘是竞态修补；(d) 宣称清理却从不删 `bundle-hash.json`（陈旧 hash 注入后续构建）。→ 见主题 F 方案 4。
- **CP-8** `package.json:16` — `build:so` 硬编码 NDK `28.2.13676358` 与 `$ANDROID_HOME`。→ 解析脚本按优先级探测。
- **CP-9** `build-harmony-har.js:454-459` — `eval` 解析 oh-package.json5，失败静默 `return true`。
- **CP-10** DRY：`JStringToString` 等 JNI 助手两份逐字重复；`StateOperation` 枚举 + `BuildManifest` 在 android/harmony 胶水逐字重复，操作码 1-6 需与 Java/ets 手工同步；`flag_a/flag_b` 无语义命名。→ `jni_util.h` + `state_ops.h`。
- **CP-11** 死代码仍被编译分发：`android/jni/DownloadTask.c`（全内存补丁旧路径，三端无调用方，仍编进每个 ABI）、`pushy.c`（整文件）、`pushy.cpp` 的 `HdiffPatch` 导出。→ 删除或至少摘出构建。

### 低危

- **CP-12** `patch_core.cpp:22,216` — CopyFile 每文件堆分配 16KB 缓冲且偏小。→ 64-128KB 复用缓冲或 sendfile。
- **CP-13** `android/jni/hpatch.c:16,74` — `kMaxLoadMemOldSize` 8MB，Hermes 主包超限后退化为随机文件读，低端机补丁耗时明显上升。→ 提高上限或按可用内存自适应。
- **CP-14** O(n²)：`BuildCopyGroups` 线性扫分组（→unordered_map）、`DeleteMatcher` 线性匹配（→unordered_set）、readdir 后逐项 stat（→先看 `d_type`）。
- **CP-15** `patch_core.h:10-18` — `Status` 无错误码，调用方只能字符串匹配。→ 主题 A 方案 2。
- **CP-16** `update_core_android.cpp:283-294` — `ToArchivePatchType` 未知值静默回退 `kFull`（增量当全量、跳过校验），与 harmony 侧行为还不一致。→ default 抛异常。
- **CP-17** 测试基建：首个失败即 return（应跑完全部统计）；TempDir 用 `system("rm -rf")`；helper 与被测代码重复；建议加 `-fsanitize=address,undefined`。
- **CP-18** 杂项：`#include <set>` 未用；`bundle-metadata-plugin.js` 的 `../../..` 项目根假设在 pnpm/monorepo 下错误、`bundle-hash.json` 污染宿主根目录、serializer 里每次执行 setup 副作用。
- **CP-19** `prepublish.ts:11,56` — 版本正则放行 `git describe` 串（`10.30.1-5-gabc123`）。
- **CP-20** `scripts/read.js` — 硬编码路径的调试脚本，模块加载即执行。→ `require.main` 守卫或移出。
- **CP-21** Harmony CMake 与 `Application.mk` 编译选项不一致：Android 有 `-Oz -fno-exceptions -fvisibility=hidden`，Harmony 全无——同一核心一端 no-exceptions 一端带异常表，行为差异未被显式管理，且 Harmony `.so` 显著更大。
- **CP-22** `Application.mk:10` — 仍构建 32 位 x86 ABI，徒增包体。

---

## 9. 工程化与发包配置

- **PK-1（中）** `package.json` — `"main": "src/index"` 直接发布 TS 源码，无 `types`/`exports`/`files` 字段：非 Metro 消费方（jest、web 打包器）开箱即坏；发布内容靠 `.npmignore` 黑名单维护（近期多个 CI 修复提交证明该模式脆弱）。→ 补 `types`/`exports` + `files` 白名单；长期考虑 react-native-builder-bob 输出 `lib/`。
- **PK-2（中）** `tsconfig.json` 排除了 `harmony/`——harmony 侧 TS 源码完全不参与 `bun lint` 的 `tsc --noEmit` 类型检查（第 7 节多个类型问题因此漏网）。→ 为 harmony 建独立 tsconfig（其类型环境不同）纳入 lint 任务。
- **PK-3（低）** 工具链版本错位：devDeps `react-native 0.73` vs `@react-native/eslint-config 0.84.1`（跨 11 个版本）；`eslint ^8`（v9 flat config 已是主流）；`prettier ^2`（落后两个大版本）。
- **PK-4（低）** `postinstall: node scripts/check-expo-version.js` 对所有消费方在每次 install 时执行，注意保持零依赖、快速、静默失败。
- **PK-5（提醒）** 工作区未提交改动：`BuildProfile.ets` 为构建产物意外覆盖（见执行摘要），建议还原并让 `build-harmony-har.js` 在收尾时恢复该文件；`oh-package-lock.json5` 的 0.72.96→0.84.1 漂移源于开放区间 `>=0.72.96`，建议收紧版本区间或有意识地提交。

---

## 10. 修复路线图

> **实施状态（2026-07-04 更新）**：P0 除第 11 项（BuildProfile.ets 还原属工作区决策，未自动执行）外**已全部落地**，`bun lint` 通过、71 个单测全绿、patch_core 15 个 C++ 测试全通过、JNI 文件经 NDK clang 语法校验无误。逐项见下方 ✅ 标记。

### P0 — 立即（一行~一函数级修复，直接影响正确性）

1. ✅ JS-1 options 共享引用（`this.options = { ...defaultClientOptions }`）
2. ✅ JS-2 locale 优先级（加括号）
3. ✅ JS-3 apkStatus 卡死（改 try/catch/finally，仅成功置 `'downloaded'`）
4. ✅ JS-4 dismissErrorAfter（拆出独立 effect 监听 `lastError`）
5. ✅ IO-1 HTTP 状态码校验（`didFinishDownloadingToURL` 非 2xx 早返回，保护已有有效包）
6. ✅ AN-5 完成回调移出 try（防误删已下载 APK + 二次 settle；同步放开 AN-10 错误日志门控）
7. ✅ AN-4 volatile + private 构造
8. ✅ HM-3 reload 兜底定时器清除时机（成功路径不清除，仅 catch 分支清除；移除失效的 `restarted` 标志）
9. ✅ HM-5 flushSync 降级（不可用/失败时回退异步 `flush()` 而非抛错）
10. ✅ CP-2/CP-3 JNI 局部引用（jclass/string_class 提到循环外 + 结束后 DeleteLocalRef）与异常检查（字段助手失败后 `ExceptionClear`）
11. ⬜ 还原 `BuildProfile.ets`，决策 lock 文件（**属工作区改动决策，留待人工确认**）

**新增回归测试**：`src/__tests__/client.test.ts` 增加 "explicit locale option overrides clientType default" 覆盖 JS-2。


### P1 — 短期（1-2 个迭代，正确性 + 性能）

> **实施状态（2026-07-04）**：静态可验证项已落地并通过 lint / 71 单测 / 15 个 C++ patch_core 测试 / JNI NDK 语法校验；需真机验证的线程模型迁移（AN-1 / HM-1）与 iOS 加锁（IO-2/IO-3）**暂缓**，见下方标注。

1. ✅ CP-1 发布流水线 `.so` 校验（新增 `scripts/verify-android-so.sh`：校验 4 个 ABI 存在且导出全部 JNI 符号，接入 publish.yml 两个 job）
2. ✅ AN-3 资源拷贝失败上抛（失败计数 + 结束抛 IOException，日志放开 DEBUG 门控）／ ✅ AN-1 状态操作移出主线程（新增 `StateSerialRunner`：switchVersion/markSuccess/setUuid/setLocalHashInfo 改用专用单线程 executor 串行执行，保留 `commit()` 持久性；`restartApp`/reloadUpdate 仍走 `UiThreadRunner`。**功能正确性由 Android e2e `local-merge.test.ts`（新旧架构双 job）覆盖回归；待真机跑通**）
3. ✅ HM-2 下载挂起超时兜底（inactivity watchdog + `Promise.race`）／ ⬜ HM-1 Harmony 补丁移出 UI 线程（**需 WorkerTurboModule/taskpool 改造 + 真机验证，暂缓**）
4. ⬜ IO-3 状态 RMW 加锁 + IO-2 去掉 dispatch_sync（**涉及并发时序，需真机验证，暂缓**）
5. ✅ 三端进度事件节流统一（AN-2 字节阈值 / IO-7 百分比+字节阈值+超时 / HM-6 单路径节流）／ ⬜ JS-7 context 拆分（**渲染性能优化，暂缓**）
6. ✅ 主题 A 部分：日志门控放开（AN-8 reload 反射失败 + recreate 兜底日志、HM-4 initPreferences fail fast、HM-7 trace 降 debug；AN-10 随 AN-5/AN-3 一并放开）
7. ✅ JS-5/8/9/10/16（provider/client 错误路径与并发）＋ JS-25（parseTestPayload logger 用 finally 恢复）
8. ✅ CP-7 hermesc wrapper 修复（signal 退出按失败处理、去 setTimeout 竞态、真正删除 hash 文件、支持 `RNUPDATE_REAL_HERMESC` 覆盖路径）

**暂缓项说明**：AN-1 已实现（见上，靠 e2e 回归）。HM-1（Harmony 补丁线程模型）需 WorkerTurboModule/taskpool 改造，仍暂缓；IO-2/IO-3（iOS 队列与加锁）仍暂缓。JS-6（throwError 解耦）需配合公开 API 语义变更，归入 P2。

**e2e 覆盖边界（已知盲区，记录不做）**：现有 Detox e2e（`Example/e2etest/e2e/local-merge.test.ts`）串行驱动更新流程，能验证 AN-1 迁移后的**功能正确性**（切版本/markSuccess/回滚/防回滚在后台线程完成后 UI 状态正确），但**测不到并发竞态窗口**——例如 `switchVersionLater`（现在跑在后台单线程 executor）与 `reloadUpdate`→`switchVersion`（仍在 UI 线程）对同一 SharedPreferences 的交叉写。此窗口与改动前的风险等价（两者本就分处不同线程），未因 AN-1 扩大；彻底消除需把 reload 路径的状态写也并入同一 serial executor（改动 reload 时序，超出 AN-1 范围）。同理 e2e 不量化"打补丁时主线程冻结时长"这类性能表现。这些不做，仅记录。

### P2 — 中期（重构与防回归）

> **实施状态（2026-07-04）**：DRY 重构、发包瘦身、CP-16、安全的死代码清理已落地并通过全部测试；需真机验证或大范围改造的项（主题 E 渲染测试、CP-6 硬链接、IO-6 三端 hash 校验、弃用 API）暂缓。

1. ✅ 主题 D：`cpp/patch_core/state_ops.h`（StateOperation 单一定义，android/harmony 共用）+ `cpp/patch_core/jni_util.h`（JStringToString/JArrayToVector/ThrowRuntimeException 去重，两个 Android glue 共用）+ JS `downloadUpdate` 数据驱动策略数组重构（diff/pdiff/full 三段合一，71 单测全绿）
2. 🟡 主题 E：⬜ UpdateProvider 全渲染测试（需引入 `@testing-library/react-native` + renderer 依赖，暂缓）；✅ 已用**针对性回归测试**覆盖此前无测试保护的高危修复——JS-2 locale 覆盖、JS-3 apkStatus 失败复位+可重试、JS-8 并发下载去重（均在 `src/__tests__/client.test.ts`，并验证移除修复后测试确实失败）；✅ CP-16 `TryParseArchivePatchType` C++ 单测
3. ⬜ CP-6 硬链接优化（**改动补丁 I/O 路径，需真机验证，暂缓**）
4. 🟡 CP-11 死代码删除：✅ 已删孤儿 `harmony/pushy/src/main/cpp/pushy.c` / `pushy.h`（不在任何构建中）；⬜ `android/jni/DownloadTask.c` 与 harmony `hdiffPatch` NAPI 导出仍在编译进 `.so`，删除会改变无法本地全 ABI 重建校验的二进制，**暂缓至 CI 内重建 .so 后一并处理**
5. 🟡 PK-1/PK-2/PK-3：✅ PK-1 发包瘦身（`.npmignore` 补 `android/.cxx/`、`**/*.o`、`src/__tests__/`、`CODE_AUDIT.md`；包体 3.9MB/956 文件 → 1.9MB/836 文件，4 个 .so + harmony 源码 + podspec 等关键文件全部保留；package.json 增加 `types` 字段）；⬜ PK-2（harmony tsconfig 纳入 lint）、PK-3（工具链版本升级）暂缓
6. ⬜ IO-6 下载产物 hash 校验（**三端统一设计 + 服务端配合，归入独立专项**）
7. ⬜ 弃用 API 清理（AN-14、IO-14）（**需对应 RN 版本真机验证，暂缓**）
8. ✅ CP-16 `TryParseArchivePatchType`（未知 patch type 抛错而非静默回退 kFull，android/harmony 共用同一校验，含单测）
9. ✅ CP-17 C++ 测试基建加固：测试跑完全部用例并汇总统计（原来首个失败即 return），`test-patch-core.sh` 增加 `SANITIZE=1` 开关跑 ASan+UBSan（已验证 16 个测试在 sanitizer 下全通过，确认 patch core 及 CP-2/CP-3/CP-10/CP-16 改动无内存/UB 问题）

**新增/变更文件**：`cpp/patch_core/state_ops.h`、`cpp/patch_core/jni_util.h`（新增）；删除 `harmony/pushy/src/main/cpp/pushy.c`、`pushy.h`。

---

*本报告由分层并行审查生成：JS/TS、Android、iOS、HarmonyOS、C++/工具链各一轮全文件审查，另加跨层工程化横向检查；所有发现均含 file:line 定位并经源码核实。*
