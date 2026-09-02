# 全面审计（2026-09-02，基线 10.55.1 / b15223c）

> 范围：JS/TS 层、Android、iOS、共享 C++ 内核、鸿蒙、CI/发布/打包。
> 上一轮安全加固（6e9ae76，CODE_AUDIT §13）已落地的项不再重复；本文只记录**仍有改进空间**的项。
> 每条都经源码核实，标注文件:行号；严重级别 P1 真实缺陷 / P2 很可能的缺陷或明显风险 / P3 质量与性能 / P4 小项。
> 本地基线：JS 单测 222 通过，biome/tsc 通过，patch-core 29 项 + flow-core 93 向量（含 ASan/UBSan）通过。

## 0. 总览：优先处理的 12 项

| # | 级别 | 层 | 问题 | 位置 |
|---|---|---|---|---|
| 1 | P1 | C++ | `IsSafeRelativePath` 不拒绝 NUL/控制字节，鸿蒙 manifest 路径可逃出 staging 目录 | `cpp/patch_core/patch_core.cpp:638` |
| 2 | P1 | 发布 | 只改 `cpp/` 或 `android/jni/` 时 publish 复用上一版 HAR，鸿蒙带着旧内核发版 | `.github/workflows/publish.yml:48-54` |
| 3 | P1 | 鸿蒙 | `setUuid`/`setNeedUpdate`/`markSuccess` 在 C++ 方法表注册为 SYNC，ArkTS 实现却是 async，拒绝到不了 JS | `harmony/pushy/src/main/cpp/PushyTurboModule.cpp:51-53` |
| 4 | P2 | JS | web 平台所有"常量"是函数：`isRolledBack===true`，每次加载上报一条假 rollback | `src/core.ts:15-37,76-79` |
| 5 | P2 | Android | 状态持久化四个写入方无统一锁，原生轮次的激活可被 JS `markSuccess` 覆盖回滚 | `UpdateContext.java:439,485,654,712` |
| 6 | P2 | Android | 旧架构 `setNeedUpdate/markSuccess/setUuid/setLocalHashInfo` 无 Promise，持久化失败静默 | `android/src/oldarch/.../UpdateModule.java:69-109` |
| 7 | P2 | CI | `patch_core` 测试（处理不可信补丁字节的代码）在 CI 里完全不跑；鸿蒙在 PR 上既不编译也不做类型检查 | `.github/workflows/test.yml` |
| 8 | P2 | C++ | 递归删目录/合并目录无深度上限，深嵌套归档可栈溢出崩溃 | `patch_core.cpp:235-274,453-512` |
| 9 | P2 | JS | 每次 `setOptions` 都重新触发检查、重置 autoMarkSuccess 计时器、重订阅 AppState | `src/provider.tsx:339-398` |
| 10 | P2 | Android | APK 安装路径无完整性校验，`hash` 只是进度键 | `UpdateModuleImpl.java:70-78`、`DownloadTask.java:797` |
| 11 | P2 | iOS | 无 PrivacyInfo.xcprivacy，且 10.53+ 新增了 DiskSpace required-reason API 调用，集成方上传会遇 ITMS-91053 | `ios/RCTPushy/RCTPushy.mm:186-195`、podspec |
| 12 | P2 | iOS | SSZipArchive 会物化归档里的 symlink 条目，可写到沙箱内任意位置；畸形 `__diff.json` 直接崩 app | `RCTPushy.mm:1714-1723,518-552` |

其余按层展开如下。

---

## 1. JS / TS 层（src/）

### P2

**1.1 web 平台常量全是函数，产生假 rollback 上报**
`src/core.ts:15-37,76-79`、`src/utils.ts:46-51`、`src/client.ts:239-246`。
web 上 `PushyModule = emptyModule`（Proxy，任何属性都返回 `noop`），`PushyConstants` 就是同一个 Proxy，所以 `packageVersion / currentVersion / isFirstTime / rolledBackVersion / buildTime / uuid / currentVersionInfo` 全是 `() => {}`。实测（mock `Platform.OS='web'` 导入 core）：`isRolledBack === true`、`isFirstTime` 是函数、`cInfo.uuid` 是函数、`JSON.parse(noop)` 抛错并打印 `error_parse_version_info`。后果：构造函数每次都 `report({type:'rollback'})`，生产 web 每次加载向 `/report/{appKey}` POST 一条 `hash:"() => {}"` 的 rollback；`attachToSentry` 打的 tag 也是函数字符串。
修法：`core.ts` 里 `Platform.OS === 'web'` 时用显式常量对象（空串/false），不要从 Proxy 上取；补一个 web 用例断言 `isRolledBack===false` 且无 telemetry 请求。

**1.2 `setOptions` 触发整套副作用重跑**
`src/provider.tsx:339-398`。主 effect 依赖 `optionsVersion`（每次 `setOptions` 自增），重跑时无条件执行 `checkUpdate()`（`onAppStart/both`）、清掉并重新 arm `markSuccessTimer`、重订阅 AppState。README 里的 `client.setOptions({disableErrorReporting:true})`、`setOptions({logger})`、示例 app 的策略切换，每次都多一次网络检查（客户端去重只覆盖 5s 同指纹），`alwaysAlert` 下会立即再弹一次"发现新版本"；反复改 options 会无限推迟 `markSuccess/healthCheck`。
修法：拆成三个 effect，各自只依赖读到的原始值：AppState 订阅依赖 `[client, options.checkStrategy]`；计时器依赖 `[client, options.autoMarkSuccess, options.autoMarkSuccessDelayMs]`；启动检查只在挂载时跑一次（`useRef` 标记）。补测试：挂载后 `setOptions` 一次，断言 `checkUpdate` 只调用一次。

**1.3 `setOptions({locale})` 被静默忽略**
`src/client.ts:225-227,269-291`。`i18n.setLocale` 只在构造函数里调用；fast-refresh 的"同 client 重建"路径也走 `setOptions`，语言切换永远不生效。
修法：`setOptions` 里 `key==='locale' && value` 时调用 `i18n.setLocale`，加单测。

### P3

**1.4 `getRemoteEndpoints` 取的是第一个"settled"而非第一个"成功"**
`src/client.ts:847-874`、`src/utils.ts:23-42,188-206`。`promiseAny(queryUrls.map(fetchWithTimeout))` 在任一 fetch resolve 时就返回，而 `fetch` 对 404/403/5xx 也 resolve，`enhancedFetch` 不检查 `ok`。Pushy 预设里 gitee 与 jsdelivr 竞速：gitee 秒回 404/反爬 HTML 时 `resp.json()` 抛错，好的 jsdelivr 列表被丢弃——而这正是主端点挂掉时才会走的路径。
修法：每个查询 fetch 先 `if(!r.ok) throw` 再 `r.json()`，让 `promiseAny` 竞速解析后的数组；补一个 non-ok + ok 的用例。

**1.5 原生检查缓存复用绕过了响应 schema 门**
`src/client.ts:980-985`。`readNativeCheckCache` 只判 `typeof result==='object'`，网络路径却强制 `isValidCheckResult`。JS 可热更到旧原生上（10.51–10.53 的原生有 `getNativeCheckCache` 但没有 R2 schema 门），缓存里的 `{"error":...}` 200 会变成"无更新"并触发 `markJsCheckCompleted`。
修法：加一行 `if(!isValidCheckResult(result)) return undefined`。

**1.6 重试循环会重复下载并重新应用已经确定性失败（`PATCH_FAILED`）的策略**
`src/client.ts:1386-1449`、`src/updateFlowCore.ts:258-260`。`isMirrorRetryableCode` 只跳出镜像循环；外层 `attempt`（默认 3 次重试）把整个 `attempts` 再跑一遍，坏 diff 最多下载并打补丁 4 次、每次间隔退避，才轮到 full。
修法：记录已以不可重试码结束的策略集合，后续 attempt 跳过；补测试断言 `downloadPatchFromPpk` 在 `PATCH_FAILED` 后只调用一次。

**1.7 `applyingUpdate` 在 `reloadUpdate` 成功 resolve 后永不复位**
`src/client.ts:1020-1056,1618-1662`。`switchVersion` 在 `applyingUpdate` 为真时静默返回（无日志、返回 undefined）。89c638e 记录过 iOS `reloadUpdate` resolve 但没重启的真实案例；这种情况下后续所有 `switchVersion` 都被无声吞掉。`resetToPackagedBundle` 也不清 `applyingUpdate/apkStatus`。
修法：至少在跳过时打日志、在 `resetToPackagedBundle` 里复位；更好的是 resolve 后 arm 一个几秒的计时器，进程仍活着就复位并上报 `errorSwitchVersion`；返回 boolean 区分"已切换"与"被忽略"。

**1.8 `Linking.openURL(downloadUrl)` 未 catch**
`src/provider.tsx:281,292`。`silentAndNow` 分支和弹窗按钮都直接调用，URL 由服务端控制，无处理器/格式错误时是 unhandled rejection。修法：抽出 `openExpiredDownload(url)`（两处是逐字重复的 apk/openURL 分支），失败走 `setLastError/log`。

**1.9 类型与导出契约**
- `src/index.ts` 没有从 `./type` 导出任何类型：`ClientOptions / CheckResult / ProgressData / EventType / EventData / UpdateEventsLogger / UpdateCheckState / UpdateServerConfig / BeforeReloadContext / UpdateTestPayload / VersionInfo`，用户只能深层 import `react-native-update/src/type`。
- `src/context.ts:26-55` 与 provider 实际塞进去的值不一致：`markSuccess` 实际返回 Promise；`checkUpdate` 隐藏了 `{extra}` 参数；`switchVersion/switchVersionLater/downloadUpdate` 隐藏了可选 `info` 参数；`parseTestQrCode` 实际接受 `string | UpdateTestPayload`；`progress` 不在类型里但 `useUpdate()` 返回它。
修法：`index.ts` 补 `export type {...} from './type'`；context 类型从 provider 的 value 推导。

**1.10 依赖与包体**
- `react-native-url-polyfill` 只为 `provider.tsx:500-504` 两个 `searchParams.get()`，却把 `whatwg-url-without-unicode`（84KB）+ `buffer` polyfill 带进每个 app 的 bundle，是这个 SDK 给宿主增加的最大一块。用 10 行 query 解析替换并删除依赖。
- `src/core.ts:140` `require('../package.json')` 把整个 manifest（scripts、devDependencies）打进 bundle，prepublish 时生成 `version.ts` 即可。
- `nanoid/non-secure` 仅用于 5 行随机 id，可内联。

**1.11 release 下无条件 `console.log`，包含完整检查请求体（含 uuid）与响应**
`src/utils.ts:4-18`、`src/client.ts:656,1157-1160,1176`。`options.debug` 存在但不管日志。修法：`log/info` 以 `__DEV__ || options.debug` 门控（保留 warn/error），或走用户 logger。

**1.12 测试基建让 provider↔client 契约无覆盖**
`src/__tests__/provider.render.test.tsx:28-79` 用手写假 client（没有 `optionsVersion / onOptionsChange / claimProviderMount`），provider 里的 `client.claimProviderMount?.()`、`client.optionsVersion ?? 0` 等 `?.` 纯粹是为了让假 client 活着。因此未覆盖：1.2 的重跑行为、单例 claim、卸载清理（AppState/计时器）、`checkStrategy:'both'`、深链解析、expired+openURL、`dismissErrorAfter` 重排。`setupDownloadMocks` 整体替换 `../utils`，`rankDownloadUrls` 的排序从未真正执行。
修法：用真实 `Pushy`（mock `../core`）渲染 provider 做契约套件；去掉 `?.`；用 `emitAppStateChange` 断言卸载。

### P4

- `src/client.ts:1191-1195`：失败的检查无条件清空 `lastRespJson`，会清掉另一个在途检查的去重槽；只在 `this.lastRespJson === respJsonPromise` 时清。
- `src/client.ts:1460-1471`：`downloadFallback` 的 `code` 取最后一个失败（diff→PATCH_FAILED、pdiff→DOWNLOAD_FAILED、full 成功 ⇒ 记成 DOWNLOAD_FAILED），patch-health 信号丢失；单独跟踪"任一 attempt 以 PATCH_FAILED 结束"。
- 死代码：`EventType` 的 `rejectStoragePermission/errorStoragePermission` 与 `STORAGE_PERMISSION_*` 错误码全仓库无发射点；18 个 locale key 从未引用；`utils.ts:44 emptyObj`；`updateFlowCore.ts:358` 与其测试名仍说 devNoop 是"立即成功"（9ad95fb 已改为返回 undefined）。
- `src/client.ts:1424-1426` catch 里 `e.message` 没有 `?.`，非 Error 拒绝会逃出 catch 并泄漏进度监听。
- `src/client.ts:887-895` 非 2xx 的完整 `resp.text()`（常是 HTML 错误页）直接成为弹窗文案；截断到 ~200 字。
- `src/utils.ts:153` 挂在调用方 signal 上的 abort 监听从不移除；`client.ts:664-667` 没有 logger 时每次 `report()` 都留一个未清理的 10s 计时器。
- `src/client.ts:229-236` appKey 检查只在 ios/android 生效；鸿蒙空 appKey 得到 `/checkUpdate/` 404（HTTP_STATUS）而非 `APPKEY_REQUIRED`，且 `getNativeConfig` 会持久化 `{"disabled":true}`。
- `src/endpoint.ts:149` `'No endpoints configured'` 未走 i18n。
- `src/provider.tsx:308-311` 服务端不带 `name` 时弹窗里留着字面 `{{name}}`。
- NATIVE_CHECK_FOLLOWUPS 第四轮"后续小版本"第 7/8/9 项在代码中仍未变（`!info.expired` 守卫、`?? NATIVE_CONFIG_DISABLED_JSON`、`noArtifact` 上报位置）；"JS 配置同步回退竞态"实际已修，文档可关闭。

---

## 2. Android 层（android/）

### P2

**2.1 状态持久化四个写入方无统一互斥，read-modify-write 会丢激活或丢 markSuccess**
`UpdateContext.java:439`（switchVersion）、`:485`（markSuccess）、`:654`（getBundleUrl 的 resolve-launch 提交）、`:712`（commitNativeCheckResult）。所有状态操作都是 `getStateSnapshot()` → JNI 纯函数 → `applyState(editor)` → `commit()`；只有 `commitNativeCheckResult` 和 `resetToPackagedBundle` 拿 `commitLock`。`switchVersion/markSuccess/clearRollbackMark` 在 `pushy-state-serial` 线程，`restartApp` 在 **UI 线程**（`ReactReloadManager.java:27,32`）跑 switchVersion+getBundleUrl，getConstants 在 JS 线程跑 `consumeFirstLoadMarker/clearRollbackMark`。具体交错：原生轮次在 `commitLock` 下提交 `current=H,firstTime=true`，而 JS `markSuccess`（状态线程，快照里 `current=A`）最后提交 → H 的激活被静默撤销；在 crash-rescue 路径上这就是救砖被丢。
修法：让 `commitLock` 成为所有 snapshot→commit 序列的唯一互斥（含 `switchVersion/markSuccess/clearFirstTime/clearRollbackMark/rollBack`、`getBundleUrl` 内提交、`consumeFirstLoadMarker`），或全部经 `StateSerialRunner`、编排器把提交也 submit 进去。

**2.2 `reloadUpdate/restartApp` 在 UI 线程做整包 SHA-256 + 两次同步 commit**
`UpdateModuleImpl.java:152` → `UiThreadRunner` → `ReactReloadManager.java:27` `switchVersion` → `UpdateContext.java:425` `InstallRecord.verifyForActivation` → `sha256Hex(bundleFile)`；然后 `:32` `getBundleUrl()` 再 `commit()`（`:654`）。这是 JS `switchVersion` 的路径，低端机上多 MB Hermes 包 = 数十到数百 ms 主线程卡顿，且它就是 2.1 里的 UI 线程写入方。
修法：`restartApp` 拆成 (a) 状态串行线程做 switchVersion + getBundleUrl，(b) 只把 `recreateReactContext/reload` post 到 UI 线程。

**2.3 旧架构模块丢弃持久化失败，违反 TS Promise 契约**
`android/src/oldarch/.../UpdateModule.java:69 setNeedUpdate`、`:74 markSuccess`、`:89 setUuid`、`:109 setLocalHashInfo` 没有 `Promise` 参数（newarch 有）；`src/NativePushy.ts` 全部声明为 `Promise<void>`，`src/client.ts:1065` `await PushyModule.setNeedUpdate(...)`。旧架构下 await 立即 resolve，`commit()` 失败只被 `StateSerialRunner` `Log.e`，JS 报告 `switchVersionLater` 成功——6e9ae76 的"持久化失败拒绝 promise"在旧架构 app 上不成立；`switchVersionLater()` 后紧接 `restartApp()` 还会与仍在队列里的 switch 竞争。
修法：oldarch 加带 `Promise` 的重载（旧架构支持尾参 Promise），删掉 `UpdateModuleImpl` 里无 promise 的重载（`:180,204,312,365`）。

**2.4 JNI 构造的结果类没有硬 keep 规则**
`android/proguard.pro:4` `-keepnames class cn.reactnative.modules.update.** { *; }` 等于 `-keep,allowshrinking`。`ArchivePatchPlanResult`、`CopyGroupResult` 从不在 Java 里 `new`（只有 `StateCoreResult` 是），只经 `FindClass + GetMethodID("<init>") + NewObject` 构造（`cpp/patch_core/update_core_android.cpp:274-280,299-304`），字段按名查找。R8 收缩掉无引用的无参构造或字段后，`GetMethodID/GetFieldID` 留下 pending `NoSuchMethodError`，所有 diff/pdiff 安装在混淆 release 包里失败。三个示例 app 都 `enableProguardInReleaseBuilds=false`，仓库自己测不到。同时消费者规则里的 `-keepnames class com.facebook.react.** { *; }` 与 `-keepclassmembers class com.facebook.react.ReactActivity { *; }` 过宽，影响所有宿主 app 的 R8 效果。
修法：显式 `-keep class ...StateCoreResult { <init>(); <fields>; }`（三个结果类同样）+ `-keepclasseswithmembernames class cn.reactnative.modules.update.** { native <methods>; }`；删掉对 `com.facebook.react.**` 的整体 keepnames；用一次 `minifyEnabled true` 的 release 构建验证。

**2.5 清理 keep 集合漏掉正在运行的版本目录（`launchVersion`）**
`UpdateContext.java:778-784` `cleanUp()` 只传 `currentVersion/lastVersion`；C++ `CleanupOldEntries`（`patch_core.cpp:612-627`）删除不在这两个名字里、mtime 超过 3 天的所有非点开头条目。`SwitchVersion`（`state_core.cpp:28-38`）会 `last=current`，两次切换不重启（JS `switchVersionLater(B)` 后原生轮次激活 C）就把运行中的 A 挤出 keep 集合；之后任何时候可调用的 `markSuccess()/clearRollbackMark()` 会删掉 A 的目录，而按需资源（图片/字体）还在从 A 读——正是 `resetToPackagedBundle` 用 `launchVersion` 防的那种故障。
修法：`cleanupOldEntries` 增加第三个 keep 名（或传 `String[]`），始终包含 `launchVersion`。

**2.6 APK 安装路径无完整性校验**
`UpdateModuleImpl.java:70-78` 把 `hash` 传给 `downloadFile` 然后无条件安装 `params.targetFile`；`DownloadTask.java:797` `TASK_TYPE_PLAIN_DOWNLOAD` 什么都不校验；JS 传的 `hash` 是进度键 `'downloadingApk'`（`src/client.ts:1568-1571`）。唯一保护是 `rejectProtocolDowngrade`，对服务端直接下发 `http://` APK（`usesCleartextTraffic=true` 或 targetSdk<28）无效。安装未验证 APK = 代码执行。
修法：要求服务端提供 sha256（或至少拒绝非 https APK），安装前 `sha256Hex(apk)` 校验，`session.commit` 后删除 APK。

### P3

- **2.7** `NativeCheckOrchestrator.java:473` `response.body().string()` 无大小上限（checkUpdate 与远程 queryUrls 列表都走这里），劫持的端点可 OOM 后台线程 → 崩溃 → crash handler 又去 hold 进程。`:475` 吞掉所有异常且无日志。修法：`body.source()` 限 1MiB，超出视为端点失败；加一行异常类名日志。
- **2.8** 冷启动关键路径冗余：`UpdateContext.java:81-108` 构造函数（主线程，`getJSBundleFile/getReactHost` 调用）多次 `getPackageVersion()`（Binder IPC）、`computeBundleHash` 两次；`getConstants`（TurboModule 下 JS 线程同步）做两次独立 `commit()`（`consumeFirstLoadMarker:23`、`clearRollbackMark:29`）+ 一次文件读。缓存 `PackageInfo`，两次提交合成一个 editor。
- **2.9** `ReactReloadManager.java:51,55` 旧架构反射用字面 `mBundleLoader/mJSBundleFile` 无回退；RN 把 `ReactInstanceManager` 转 Kotlin 后两处都失败，外层 catch 走 `currentActivity.recreate()`（`:83`）加载**旧** bundle 却 resolve 成功。改用 `getCompatibleField(...,"bundleLoader")`，注入失败应 reject `RESTART_FAILED`。
- **2.10** `DownloadTask.java:586-590` `promoteStaging` 删除 `unzipDirectory` 再 rename；`hasCompletedPatchDirectory()` 只认 `.pushy-complete`，10.5x 之前安装的当前运行 hash 无 marker，重下同 hash 会在进程中抹掉活目录。`params.hash.equals(launchVersion)` 时拒绝/跳过。
- **2.11** `UpdateModuleImpl.java:34,96,143,170` 的 `options.getString(...)` 不在 try/catch 内（`downloadAndInstallApk/downloadPatchFromPpk` 却包了），缺 key 时在 native-modules 线程抛异常直接崩 app。统一 `readRequiredString(options,key,promise)` reject `INVALID_OPTIONS`。
- **2.12** `NativeCheckOrchestrator.performAttempts:604-655` 阶段超时后 `break` 到下一 attempt 并在同一单线程 executor 上再排一个任务，前一个可能仍在传输；full 阶段又是新的 600s 窗口。超时应 `cancel()` 在途 OkHttp Call，或编排器用独立 executor。
- **2.13** 重复与死代码：两份 `UpdateModule.java` 各 ~120 行几乎相同（只差基类与 promise 签名）；`UpdateContext.clearFirstTime(:506)`、`isFirstTime()(:467)`、`cn...ReactNativeHostHandler` 接口未用；minSdk 21 下的 `LOLLIPOP` 守卫（`ApkInstaller.java:58`、`BundledResourceCopier.java:365`）与不可达的 `UNSUPPORTED_PLATFORM` 分支；`build.gradle:150` `java/expo/modules/pushy` 路径不存在；`:128-132` `compileSdk 31 / targetSdk 27` 回退值过旧；`repositories { maven "$rootDir/../node_modules/react-native/android" }` 对 RN≥0.71 是死路径；`lintOptions/buildToolsVersion` 已废弃；`versionName "1.81.4"` 陈旧；`resolveInstalledExpoMajorVersion` 每次 Gradle 配置都 spawn `node`。

### P4

`UpdateContext.java:83` 无名 executor；`:32` `reactInstanceManager` 在 `sLock` 下写但无同步读（加 `volatile`）；`:123` `e.printStackTrace()`；`UpdatePackage` 用已废弃的 `TurboReactPackage` 与 7 参 `ReactModuleInfo`；`InstallRecord.write` fsync 了文件但 rename 前没 fsync 目录（API 26+ 可 `FileChannel.open(dir).force(true)`）。

### 已核实正常
JNI 契约（签名与 `verify-android-so.js` 符号表一致，字符串/数组全部释放，异常经 `ThrowRuntimeException` 上抛，`update_flow_jni.cpp` 正确避开非 BMP 的 `NewStringUTF`）；`PackageInstallerStatusReceiver` manifest 声明 + `exported=false`；`CrashRescue` 链式调用前任 handler、每进程一次、主线程 3.5s 上限、全部 `catch Throwable`；`SafeZipFile` 的穿越/保留名/限额检查；流全部 try-with-resources；Range/If-Range/416/Content-Range 续传逻辑正确；`ErrorCodes.java ↔ error_codes.h ↔ src/error.ts` 同步；16KB 对齐由脚本强制。

### 单测建议（纯 JUnit，零 Android 依赖）
`UpdateContext.isSafePathComponent`、`DownloadTask.parseContentRange`、`SafeZipFile.isReservedEntryName/inspect()/unzipToPath`（构造内存 zip：穿越、炸弹比、条目数、保留名）、`InstallRecord.build/read/isComplete/verifyForActivation`、`ArchiveLimits.ensureFreeSpace`、`NativeCheckOrchestrator.normalizeEndpointBase` 与 `runCheckRequest` 的次数上限（注入 HTTP 函数）、`BundledResourceCopier.normalizeResPath/extractResourceName/parseDensityQualifier`。

---

## 3. iOS 层（ios/）

NATIVE_CHECK_FOLLOWUPS 中两项已在代码里修复、可关闭："iOS 合流下载的两个语义代价"（`PushyReportDownloadProgress` 进度广播 `RCTPushy.mm:378-391`，异类型请求 deferred `:351-361`）与"启动状态解析抛异常时救援检测永不调度"（`@finally` `:881-886`）。

### P2

**3.1 缺少隐私清单（PrivacyInfo.xcprivacy），且 SDK 新增了磁盘空间这一 required-reason API**
`RCTPushy.mm:186-195`（`NSFileSystemFreeSize`）、`:773-781`（`fileModificationDate`）、`:88-90`（`systemUptime`）、`:446-448`（`NSUserDefaults`）；`podspec:98` 只随包携带 `pushy_build_time.txt`，`ios/` 下无任何 `*.xcprivacy`。
6e9ae76 加入的 `PushyFreeDiskSpaceForPath` 读 `NSFileSystemFreeSize`，属于 `NSPrivacyAccessedAPICategoryDiskSpace`。RN 模板 app 的清单（见 `Example/testHotUpdate/ios/.../PrivacyInfo.xcprivacy`）只声明了 FileTimestamp C617.1、SystemBootTime 35F9.1、UserDefaults CA92.1，所以每个升级过 10.53 的集成方都会静默获得一个未声明的 API 使用，上传时 ITMS-91053（2024-05 起是审核阻断）。其余三类目前靠宿主模板"恰好"覆盖。
修法：`s.resource_bundles = { 'react-native-update_privacy' => 'ios/PrivacyInfo.xcprivacy' }`，声明 DiskSpace `E174.1`、FileTimestamp `C617.1`、SystemBootTime `35F9.1`、UserDefaults `CA92.1`，`NSPrivacyTracking=false`；CHANGELOG 说明。

**3.2 `packageVersion` / `buildTime` 以无前缀 key 存在 `standardUserDefaults` 顶层，撞 key 时每次启动都抹掉热更新**
`RCTPushy.mm:38-39`（`paramPackageVersion=@"packageVersion"`、`paramBuildTime=@"buildTime"`），`:555-556` `stringForKey:` 顶层读取（已核实），`:571-572` 写入，`:817-827` 消费；`state_core.cpp:12-24`。其他 key 都是 `REACTNATIVECN_PUSHY_*`，唯独这两个二进制身份 key 用了宿主 app 与其他 SDK 常用的通用名。宿主若把 `buildTime` 存成 NSNumber，`stringForKey:` 返回 nil → `""` → `SyncBinaryVersion` 判定 `changed` → 清空 `current/last_version` → 已装更新被丢弃并触发 `clearInvalidFiles`；Pushy 再写回字符串、宿主再覆盖，每次启动循环。Android 用私有 SharedPreferences 文件，仅 iOS 有此问题。
修法：改名 `REACTNATIVECN_PUSHY_PACKAGEVERSION/_BUILDTIME`，`PushyStateFromDefaults` 里一次性迁移（读新 key、回退旧 key、首次写入后删旧 key）；长期迁到 `initWithSuiteName:@"cn.reactnative.pushy"`。

**3.3（安全）归档可含 symlink 条目，SSZipArchive 无条件按任意目标物化**
`RCTPushy.mm:1714-1723`（`unzipFileAtPath … preserveAttributes:YES … delegate:guard`），`PushyUnzipGuard :232-259`；SSZipArchive 2.4.3 的 symlink 分支不受 `preserveAttributes` 门控。`_sanitizedPath` 只中和条目名里的 `../`；一个 `assets -> ../../../Documents` 的 symlink 条目再跟一个 `assets/x`，就能写到沙箱内任意位置（Preferences plist、Documents、另一版本目录）；`index.bundlejs` 做成 symlink 会让安装记录 digest 与 bundle 加载指向版本目录之外。Android `SafeZipFile`（java.util.zip）不支持 symlink，仅 iOS 有此缺口。
修法：`zipArchiveShouldUnzipFileAtIndex:` 里拒绝 `((external_fa >> 16) & S_IFMT) == S_IFLNK` 的条目（顺带拒绝 `.pushy-` 前缀名），记录违规使其成为硬 `PATCH_FAILED`；`preserveAttributes:NO`。

**3.4 畸形 `__diff.json` 在 `_fileQueue` 上抛 ObjC 异常直接杀 app，而非 `PATCH_FAILED`**
`RCTPushy.mm:518-552`（`PushyPatchManifestFromJson`，从 `:1449` 的 GCD block 调用）。`copies` 未做类型检查：`for (NSString *to in copies)` + `copies[to]` 遇 NSArray/NSString 值 → unrecognized selector；`from.length` 遇 NSNumber 同样；`deletes` 的值未检查类型就 `[value UTF8String]`。只有 `copiesCrc` 与 `hbcTransform` 有守卫。dispatch block 里未捕获异常是致命的（还会顺带触发 crash-rescue）。Android（`DownloadTask.java:450-475`）用 `optJSONObject/getString`，`JSONException` 在 `:804` 被接住变成补丁失败。
修法：把 manifest 解析搬进 C++（用 `flowjson` 解析成 `PatchManifest` 并返回 `Status`），同时消掉 Java/ObjC 两份解析器（见 3.13）；短期在 `copies`、每个 `from`、`deletes` 及每个 key 上加 `isKindOfClass:`。

**3.5（对等）iOS 的归档大小上限与剩余空间检查在整个 body 落盘之后才执行**
`RCTPushyDownloader.mm:301-410`（`didReceiveResponse` 无 Content-Length 上限、无磁盘检查），`:412-430`（`didReceiveData` 无界追加）；上限在 `RCTPushy.mm:1697-1703` 事后应用。Android `DownloadTask.java:349-353` 流式前比对 Content-Length 与 `MAX_ARCHIVE_BYTES` 并 `ensureFreeSpace`，`:385-388` 有流式字节兜底。`archive_limits.h` 注释说的"Content-Length up front, streamed bytes as backstop"iOS 两样都没实现，恶意服务端可在 `timeoutIntervalForResource`（10 分钟）内把卷写满，续传 partial 还留在盘上。
修法：`didReceiveResponse` 里 `expectedTotal > kMaxArchiveBytes` 即拒绝并 `PushyEnsureFreeSpace(savePath, expectedTotal - baseOffset)`；`didReceiveData` 里 `baseOffset + received > kMaxArchiveBytes` 即失败并 cancel。

**3.6（很可能）`use_frameworks!` 动态链接下 `buildTime` 资源在 framework bundle 里，`[NSBundle mainBundle]` 找不到**
`RCTPushy.mm:1822-1836`；`podspec:98-99`。CocoaPods 对动态 framework 把 `s.resource` 放进 framework bundle。此时 `pathForResource:` 为 nil → `buildTime` 空 → `SyncBinaryVersion` 以 `""` 运行（同 `CFBundleShortVersionString` 的原生重建不再被检测，旧热更新在 App Store 更新后存活），检查请求的 `buildTime` 也为空。89c638e 证明动态 framework 构建在野。本环境无法跑 CocoaPods，请用 `:linkage => :dynamic` 验证；修法很便宜。
修法：`[NSBundle mainBundle]` 找不到时回退 `[NSBundle bundleForClass:[RCTPushy class]]`，两者都失败时打 warning。

### P3

- **3.7** 重载路径：`RCTPushy.mm:1263-1273` 先 `RCTReloadCommandSetBundleURL([[self class] bundleURL])` 跑 `ResolveLaunchState`（消费 `first_time`、置 `keyFirstLoadMarked`、`ignoreRollback=true`）再 `RCTTriggerReloadCommandListeners`。RN 自己会重新解析 URL（`RCTHost.didReceiveReloadCommand` 调 `_bundleURLProvider()`，`RCTBridge.setUp` 重问 `sourceURLForBridge:`），这个设置没有读者。若无监听器触发（bridgeless 下的 `[self.bridge reload]` 回退、无 RCTHost/RCTBridge 的宿主、未来 RN 变更），被消费的首载状态让**下次冷启动**把新版本回滚——正是 89c638e 的症状，仍可经 `#else` 分支到达。`restartApp` 无论如何都 resolve `@true`；Android 会 reject `RESTART_FAILED`。修法：去掉 `RCTReloadCommandSetBundleURL(...)`，`#else` 分支 `#error` 或在 `self.bridge == nil` 时 reject `kRestartFailed`。
- **3.8** 主线程预算档的 crash rescue 可能把 3.5s 花在哈希内嵌 bundle 上：`:2154-2155` 轮次总是调 `PushyBundleHashSync()`，二进制新装后首启缓存未命中时在救援窗口里对多 MB 文件做 SHA-256；且 +5s 的 utility 队列与 JS `getBundleHash`（`_fileQueue`，`:1140`）可能双重哈希。救援期间只用缓存值（miss 发 `""`），非救援期算一次共享。
- **3.9（对等）** iOS 从不发出 `MARK_SUCCESS_FAILED / RESET_FAILED / RESTART_FAILED`：`markSuccess(:1146-1166)`、`resetToPackagedBundle(:1168-1223)` 吞掉所有失败（`CleanupOldEntries` 失败只 `RCTLogWarn` 且在 `resolve(@true)` 之后）。按码聚合的遥测在 iOS 上对这些操作是盲的。用 `@try` 包住并以对应码 reject；reset 的清理同步在 `_fileQueue` 上跑完再 resolve。
- **3.10** 构建时脚本写入 pod 源码目录：`podspec:98-99` `date +%s > "#{podspec_dir}/ios/pushy_build_time.txt"` 在 `before_compile` 执行；`:path` pod（示例、monorepo）每次构建弄脏 checkout，git 源 pod 改写 CocoaPods 缓存；配合 Xcode build cache 时 `buildTime` 取决于哪次运行最后碰了文件，不可复现。`:95` `USER_HEADER_SEARCH_PATHS` 嵌入绝对路径 `#{podspec_dir}/ios`，xcconfig 输出机器相关。已提交的 `ios/pushy_build_time.txt` 是陈旧占位（`1680488830`）。修法：写到 `$(DERIVED_FILE_DIR)` 并声明 `:output_files`，或干脆运行时从 `CFBundleVersion`/`Info.plist` mtime 派生 `buildTime` 删掉脚本；去掉绝对搜索路径。
- **3.11** `podspec:103` `s.dependency 'SSZipArchive'` 无版本约束；`_sanitizedPath` 与 guard 依赖的 delegate 方法只在 ≥2.2 存在，未来 3.x 可静默改契约。改 `'~> 2.4'`。
- **3.12（P4）** `isUsingBundleUrl` Spec 声明但 iOS 未导出（Android/鸿蒙在 `getBundleUrl` 被调用后置 true）；JS 无人读，无害。要么 Spec 标可选，要么 iOS 在 `+bundleURL` 顶部置一个静态标记（两行）。
- **3.13（结构）** 重复：续传 sidecar 后缀 `@".resume"` 硬编码在 `RCTPushy.mm:1707,1729`，重复 `RCTPushyResumeSidecarPath`（`RCTPushyDownloader.mm:13-15`）；`PushyFileSizeAtPath(:178-182)` == `RCTPushyFileSize(Downloader:38-43)`；`runCheckRequest` 同一段 15 行"归一→去重→预算→POST→校验"出现两次（`:2338-2358`、`:2380-2400`）；安装记录校验在 `PushyHasCompletedVersionAtPath(:119-135)` 与 `PushyVerifyInstallForActivation(:139-152)` 各写一遍（Java/ArkTS 又各一份）；`setNeedUpdate/reloadUpdate` 共享主体（`:1092-1117`）。死/误导注释：`:277 //TASK_TYPE_PLAIN_DOWNLOAD=4?`；`:794` `zipExtension default:` 不可达；`:1694-1696` 说 SSZipArchive 拿不到中央目录，其实 `zipArchiveWillUnzipArchiveAtPath:zipInfo:` 给了 `number_entry`（`:225` 已用）；`Downloader:5-8` 仍在解释已被替换的 NSURLSessionDownloadTask 设计。拆分建议：`PushyKeys.h`（`:37-90,437-516`）、`PushyInstallRecord.mm`（`:94-175`）、`PushyArchiveGuard.mm`（`:178-262` + `unzipFileAtPath`）、`PushyDownloadRegistry.mm`（`:292-412`）、`PushyState.mm`（`:414-609`）、`PushyCrashRescue.mm`（`:665-763`）、`RCTPushyOrchestrator.mm`（`:1848-2479`），`RCTPushy.mm` 留模块表面 + 管线约 900 行。
- **3.14（可测试性）** 应下沉到 `cpp/` 的纯决策（已有 `state_core/CleanupOldEntries` 的 harness）：`__diff.json` → `PatchManifest` 解析含类型校验（替代 `PushyPatchManifestFromJson` 与 `DownloadTask.appendManifestEntries`）；安装记录解析/校验 `install_record::Validate(json, hash)` 三端共用；归档限额累加器 `archive_limits::EntryAccumulator::Accept(size, compressed, isSymlink)`；下载注册表 join/defer 规则（`:337-349`）与 `Content-Range` 解析（`Downloader:47-69`，Java 又一份）；crash-rescue 门控（`:706-716`）与检查端点尝试策略（`:2332-2403`）；`PushyIsSafePathComponent(:483-497)` 放到 `IsSafeRelativePath` 旁边。另建 `ios/Tests` XCTest target 由 `xcodebuild test` 跑：`RCTPushyDownloader` 对本地 `NSURLProtocol` stub（416/206/redirect/encoded）与 `unzipFileAtPath` 对夹具 zip（symlink、保留名、比值炸弹）。

### P4（线程，未发现缺陷）
`PushyWithStateLock(:419-428)` 是不可重入的 `os_unfair_lock`，当前无嵌套但无守卫，DEBUG 下加 `os_unfair_lock_assert_not_owner`；`switchVersion` 在锁内哈希整包（`:1620`），包变大时移到锁外再在锁内复验记录；`PushyHttpRequest(:1853-1895)` 让共享 session 跟随 https→http 重定向后才拒绝响应，POST 体（appKey、uuid、版本）已明文发出一次——ATS 默认拦截，仅 `NSAllowsArbitraryLoads` 的 app 受影响，可像 downloader 一样用 delegate session。冷启动成本正常（`+bundleURL` 只做 defaults 读、一次 `stat`、一次小文件读）；无观察者/计时器泄漏；downloader 每条完成路径都 invalidate session；不持久化绝对路径（容器迁移安全）。

---

## 4. 共享 C++ 内核（cpp/）

### P1

**4.1 `IsSafeRelativePath` 不拒绝嵌入 NUL → 鸿蒙上 staging 沙箱逃逸**
`cpp/patch_core/patch_core.cpp:638-652`。只按 `/` 切段并拒绝空段、`.`、`..`，不检查 NUL 或其他控制字节。manifest `to` 为 `"..\0x"` 时 `!= ".."`，通过；下游全部经 `.c_str()`（`CopyFile/JoinPath → fopen/stat/link`）在 NUL 处截断，目标变成 `..`。编译 PoC 验证：`IsSafeRelativePath("..\0x")` 返回 1，`ApplyPatchFromFileSource`（根 `root/v2.staging`）把拷贝目标解析到 `root/`，即存放其他已安装版本目录的父目录。可达性按字符串桥而异：**鸿蒙可达**（`napi_get_value_string_utf8` 返回含原始 `\0` 的 UTF-8，`pushy.cpp:79-86` `GetString` 通过 `resize(written)` 保留它）；iOS 侥幸安全（`[v UTF8String]` 在 NUL 处停止，目标变成 `..` 被拒）；Android 安全（JNI modified UTF-8 把 `\0` 编成 `C0 80`）。manifest 是来自下载归档的攻击者可控输入。
修法：在内核层拒绝任一段里 `< 0x20` 的字节（含 NUL），三端在边界上一并受保护。

### P2

**4.2 `RemovePathRecursively` / `MergeDirectoryRecursively` 递归无深度上限**
`patch_core.cpp:235-274,453-512`。ASan 下 PoC 已把 `RemovePathRecursively` 驱动到栈溢出 abort。独立于 4.1，恶意归档可放几千层嵌套目录（远在 20000 条目上限内），第一次 `CleanupOldEntries`/merge/removal 就栈溢出崩 app。修法：显式深度上限（对齐 flow parser 的 `kMaxDepth`）或用显式工作栈迭代。

**4.3 `patch_core` 测试套件在 CI 完全不跑**
`.github/workflows/test.yml`：`cpp-test` 只构建 HDiffPatch 自带 `unit_test` 并跑 `SANITIZE=1 ./scripts/test-update-flow-core.sh`，从不调用 `./scripts/test-patch-core.sh`。`patch_core.cpp / archive_patch_core.cpp / hbc_transform*.cpp / digest.cpp / state_core.cpp` 及其 29 项测试**零 CI 覆盖**，而这正是消费不可信补丁/归档字节的代码。本地 `SANITIZE=1 ./scripts/test-patch-core.sh` 已通过，直接加一步即可。

**4.4 Android 以 `-fno-exceptions` 编译，但 STL 分配可能抛 → `std::terminate` 穿越 JNI/NAPI/ObjC 边界**
`android/jni/Application.mk:43`。`cpp/` 内无任何 `try/catch`，flow parser 与 `std::string/vector` 按输入大小自由分配。Android 上 `bad_alloc/length_error` 在 `-fno-exceptions` 下直接 terminate（硬崩溃，无 Java 异常、无 promise 拒绝）；鸿蒙 CMake 没设 `-fno-exceptions`，C++ 异常会 unwind 进无处理的 NAPI 回调；iOS 的 `@try/@catch(NSException*)` 抓不到 C++ 异常。结合 4.5 可达。修法：每个 JNI/NAPI/ObjC 入口包 `try/catch(...)` 转成干净错误（这些 TU 去掉 `-fno-exceptions`），或保证分配有界。

### P3

- **4.5** `flowjson::Parse`（`flow_json.cpp:621-624`）无总输入长度/节点数上限（HBC wire parser 有 64KB 上限）。`sizeof(Value)=96`，实测 1MB `[0,0,...]` 膨胀到 ~100MB RSS；Android 编排器 `response.body().string()` 无限长直接喂给它（见 2.7）。加 max-input-bytes 守卫。
- **4.6** `flow_json.cpp:605 strtod` / `:244 "%.17g"` 受 `LC_NUMERIC` 影响：宿主进程 `setlocale` 到逗号小数区域后 `strtod("1.5")` 停在 `.` → 整个合法响应被拒；`%.17g` 会输出 `1,5`。用 `strtod_l/snprintf_l` 固定 C locale 或手写十进制。
- **4.7** Murmur3 在 C++ 里哈希 UTF-8 字节（`update_flow_core.cpp:106-112`），TS 参考实现哈希 `charCodeAt & 0xff`（`updateFlowCore.ts:29-32`）；非 ASCII key 下 `IsInRollout` 分桶不一致。今天 key 是 SDK 生成的 ASCII uuid，属潜在项，但金标向量只测 ASCII。按契约限定 ASCII 并断言，或让 C++ 读解码后码点低字节。
- **4.8** 孤立代理项 `\u` 转义"成功"解析并输出非法 UTF-8（`flow_json.cpp:481-495`），与 `JSON.stringify` 行为不一致，向量未覆盖；且把非法 UTF-8 推进 `napi_create_string_utf8`。跟踪"曾是代理项"状态，拒绝或归一到 U+FFFD。
- **4.9** HBC 变换补丁路径把整个 bundle 读进内存两次（`patch_core.cpp:554-599`：`ReadFileBytes(origin)` → 变换 → 写临时 → hpatch → `ReadFileBytes(temp_patched)` → 变换 → 写），非变换路径是端到端流式。10–50MB 包在低内存设备上是真实开销；考虑 mmap 临时文件原地变换。
- **4.10** LZMA 解码器无字典大小上限：`decompress_plugin_demo.h` `_lzma_open/_lzma2_open` → `LzmaDec_Allocate(props)` 按补丁流里攻击者可控的 `props` 分配；`hpatch.c` 只限旧文件内存加载（8MB），字典可声明到 4GB。对 `dicSize` 加合理上限（如旧包大小的几倍）。
- **4.11** bundle/资产写入在两阶段 rename 前不 fsync（`patch_core.cpp:304-319 WriteFileBytes`、`CopyFile`）。安装记录已由平台层 fsync，但 payload 数据块没有；掉电后可能出现"看起来完整"但 `index.bundlejs` 截断的目录。有 `bundleSha256` 激活复验兜底（变成拒绝激活+回滚），仍建议记录写入前 fsync payload。
- **4.12** 对等性：`updateFlowCore.ts` 的 `buildCheckFingerprint(235-249)` 与 `isMirrorRetryableCode(258-260)` 没有 C++ 移植也不在向量里，各原生编排器各自重实现了等价的重试/去重逻辑——这是对等性框架抓不到的漂移。另 `paths: null` 时 TS `const {paths=[]}` 只默认 `undefined`，`null.map` 抛错；C++ `DecideDownload(update_flow_core.cpp:335-337)` 遍历空 elements 返回 `noArtifact`。补 `paths:null` 与非字符串端点条目的向量。
- **4.13** 两个不可信输入解析器无 fuzz：`flowjson::Parse(const std::string&, bool*)` 与 `pushy::hbc::ParseHbcTransformMeta` 签名干净无副作用，libFuzzer harness 各 ~10 行，可挂到现有 ASan/UBSan 配置。
- **4.14** `patch_core.cpp:285 const long size = ftell(file)` 在 armeabi-v7a/x86 上 32 位；用 `fseeko/ftello` 或 `fstat`。

### P4
- 鸿蒙 NAPI 结果对象对空串字段直接省略（`pushy.cpp:322-331`），Android 显式设 `null`（`update_core_android.cpp:170-177`）；形状不一致。
- 测试脚本用 `-Wall -Wextra` 但无 `-Werror`；`cpp/` 内核在 CI 里没有以 warnings 编译（见 4.3）。
- 已核实正常：`TransformHbcInPlace` 逐字节追踪无 OOB；HBC wire parser 严格有界（64KB、深度 8、字段范围检查）；C++17 三端一致；`-fvisibility=hidden` + `--exclude-libs,ALL`；NDK r28 固定，16KB LOAD 段对齐由脚本强制；NAPI 异步管线在每条失败路径都 settle promise。

---

## 5. 鸿蒙层（harmony/）

### 对 6e9ae76 声明的核实
| 声明 | 结论 |
|---|---|
| "Harmony single flush" | 提交路径成立（`commitNativeCheckResult` 用 `beginFlushBatch/endFlushBatch` 包住，`UpdateContext.ts:206-244,521-548`）。但见 5.4：`flushSync` 缺失时退化为异步 best-effort；batch 内 `switchVersion` 抛错时内存里已 `setKv` 的 hash 信息仍会被 `finally` 落盘，不是"要么全有要么全无"。 |
| 归档限额 | 部分。归档大小上限在前置和流式兜底里都有；条目数/条目大小/总大小在 `zlib.decompressFile` **之后**才量（见 5.9）；`MAX_COMPRESSION_RATIO / RATIO_CHECK_MIN_BYTES`（`ArchiveLimits.ts:10-11`）导出但从未使用。 |
| NAPI 严格响应校验 | 成立（`pushy.cpp:1082-1096` → `IsValidCheckResult`，`NativeCheckOrchestrator.ts:420,458` 逐端点使用）。 |
| FOLLOWUPS 2026-08-13 功能性断裂 | 已修（`PushyTurboModule.cpp:106-111` 注册了全部 10.50+ 方法含 `markJsCheckCompleted`）。仍开放：鸿蒙 e2e 无 native-check 场景；`Logger.ts:52` 仍硬编码 `isDebug=false`。 |

### P1

**5.1 只改 `cpp/` 或 `android/jni/` 时 publish 复用陈旧 HAR**
`.github/workflows/publish.yml:48-54,173-186`。`check_changes` 用 `git diff --name-only $PREV_TAG HEAD | grep -q '^harmony/'` 判定，否则 `publish_without_harmony` 从 npm 上一版取 `pushy.har`。但 HAR 里的 `librnupdate.so` 由 `cpp/patch_core/*`、`cpp/update_flow_core/*`、`android/jni/hpatch.c`、HDiffPatch、lzma 编译（`CMakeLists.txt:31-46`；`build-harmony-har.js:186-250` 正是 staging 这些）。一次只修 state_core / update_flow_core / hpatch 的发版，Android/iOS 拿到修复而鸿蒙带着旧决策逻辑和旧 patcher 出去——正是为 Android 加 `.so` 重建所防的那类静默分叉。
修法：`grep -qE '^(harmony|cpp|android/jni)/|^scripts/build-harmony-har\.js$'`；submodule 指针变化在 `android/jni/` 下同样以路径形式出现。

**5.2 三个 async 方法在 C++ 方法表注册为 SYNC，拒绝到不了 JS**
`PushyTurboModule.cpp:51-53` 用 `PUSHY_SYNC_METHOD` 注册 `setUuid/setNeedUpdate/markSuccess`，ArkTS 实现却是 `async`（`PushyTurboModule.ts:191,246,259`）。同步调用把 ArkTS 返回值（一个 Promise，无自有属性的对象）转成 jsi 值；async 体内的抛错（如 `switchVersion` → "Bundle version X is incomplete." / "bundle digest mismatch."，`UpdateContext.ts:668-678` 的 SR-2 检查）变成 ArkTS 侧 unhandled rejection 而非 JS 异常。JS（`src/client.ts:1063-1072`）于是把 `setNeedUpdate` 当成功，报告切换成功并告诉用户重启后生效——实际什么都没切。运行时验证：`PushyModule.setNeedUpdate({hash:'does-not-exist'})` 应 reject；若 resolve 即确认。
修法：改为 `PUSHY_ASYNC_METHOD`（JS spec 就是 Promise）；加一个不依赖 SDK 的 Node 测试，解析 `NativePushy.ts`、`PushyTurboModule.ts`、`PushyTurboModule.cpp`，断言每个 Spec 方法都在 C++ 表里且 sync/async 种类匹配——该表已经咬过一次（10.51 三个版本冷启动检测全灭）。

### P2

- **5.3** `DownloadTask.ts:788-796` `readTimeout: 60000`。OpenHarmony netstack 把 `readTimeout` 传给 libcurl 的 `CURLOPT_TIMEOUT_MS`（整次传输总时长）而非空闲超时；代码自己按空闲语义设计（另有 60s 不活动看门狗 `:657-681` 与 10 分钟整轮 deadline `:113,566-568`）。若映射如此，超过 60s 的传输全部失败，续传掩盖了它（每次重试多拿 60s 的字节），但 40–50MB 全量包在慢网下 3 次重试仍会失败。修法：`readTimeout = max(1, deadlineUptimeMs - now)`，靠已有看门狗管卡死；两种语义下都正确。
- **5.4** 持久化在 `flushSync` 不可用时是 best-effort 异步（`UpdateContext.ts:223-244`），HAR 兼容 `compatibleSdkVersion 5.0.0(12)` 而 `flushSync` 是 API 14 才有；`reloadUpdate`（`PushyTurboModule.ts:223-234`）在 `switchVersion` 后立即 `restartApp` 杀进程，切换可能丢失、重启到旧 bundle。这也是 SR-5 在鸿蒙不成立的原因（Android 是 `persistEditorOrThrow`）。修法：有 promise 的操作在 `flushSync` 缺失时 `await preferences.flush()` 并让失败拒绝 promise；`commitNativeCheckResult` 里把 switch 校验放到第一个 `putSync` 之前。
- **5.5** 整包/整 bundle SHA-256 在 UI 线程同步执行：`Sha256HexFile` 是普通同步 NAPI（`pushy.cpp:902-916`），从 ArkTS 主线程对下载归档（上限 512MB）调用于 `DownloadTask.ts:976,999,1067`、对最终 bundle `:175`、且每次激活 `verifyInstallForActivation`（`InstallRecord.ts:125` ← `UpdateContext.ts:673`）再来一次。30–50MB 全量包 = 数百 ms 冻结。`applyPatchFromFileSource/cleanupOldEntries` 已因同样原因搬到 `napi_create_async_work`（`pushy.cpp:635-643`）。修法：加 `sha256HexFileAsync`，或在 `transferArchive` 写入队列里边写边算 digest 免去第二遍。
- **5.6** 鸿蒙原生几乎没有稳定错误码：仅 `DownloadTask.ts:328,989,1057` 设 `PATCH_FAILED`，其余抛裸 `Error`（空 hash `PushyTurboModule.ts:55-60` 应为 `INVALID_OPTIONS`、`downloadAndInstallApk:329` 应为 `UNSUPPORTED_PLATFORM`、`reloadUpdate/setNeedUpdate/resetToPackagedBundle` 重包并丢上下文 `:232,255,287`、`getLocalHashInfo` 应为 `INVALID_HASH_INFO`）。且 RNOH 异步桥以纯字符串 reject，`PATCH_FAILED` 标记很可能也丢，JS `toUpdateError(e,'DOWNLOAD_FAILED')` 把每次 pdiff/diff 应用失败在 patch-health 遥测里记成网络失败。修法：加 `ErrorCodes.ts` 镜像并在每个 throw 点附码；若 RNOH 丢 `code`，消息前缀 `[PATCH_FAILED] …` 并在 JS 鸿蒙分支解析。
- **5.7** https→http 降级在鸿蒙未拒绝（SR-1 对等缺口）：`NativeCheckOrchestrator.ts:347-390`、`DownloadTask.ts:788-796` 用 `@ohos.net.http`，它内部跟随重定向且既无开关也不暴露最终 URL。commit message 把 SR-1 限定在 Android/iOS 不算虚报，但设计文档"no https->http downgrade anywhere"对鸿蒙不成立。修法：至少文档要求消费者 `network_config.json` 设 `cleartextTrafficPermitted:false`；配置端点为 https 时拒绝决策里的 `http:` URL；可接受 HMS-only 的话 RCP（`autoRedirect=false` + effective URL）能完全关闭。
- **5.8** 必需 CI 门里没有任何鸿蒙检查：`check-harmony-types.js:52-66` 无 DevEco SDK 时 exit 0（托管 runner 上永远如此），即便跑也只含 `.ts` 不含 `.ets`（`:86`）；`harmony/pushy/src/test` 的 hypium 测试没有任何 workflow 跑；`e2e_harmony.yml` 仅手动且被 `native-gate.yml` 排除；HAR 只在发布时于固定容器里编译。`.ets` 类型错误、坏的 NAPI 导出、10.51 那类方法表断裂都要到发版才看见。修法：`test.yml` 加 `harmony-build` job，用同一容器 digest 跑 `check-harmony-types.js`（`HARMONY_TYPECHECK_REQUIRED=1` 时失败而非跳过）和 `build:harmony-har -- --build-mode release`（`assembleHar` 里的 ArkTS 编译器才是 `.ets` 的真正类型检查）；把纯逻辑测试搬到 Node（5.15）让每个 PR 都跑。

### P3

- **5.9** 归档限额在解压之后才生效（`DownloadTask.ts:337-349`：`ensureFreeSpace(size*2)` → `zlib.decompressFile` → `measureExtractedDirectory`）：20MB 归档 100:1 载荷通过 40MB+64MB 空间检查后先解出 2GB 再被拒。Android 先看中央目录（`SafeZipFile.inspect`）含压缩比。路径穿越依赖平台 zip 读取器拒绝 `..`/绝对名（代码里无断言；manifest `copies/deletes` 路径在 C++ `ValidateManifestImpl` 里验证，所以 `copyFromResource` 的拼接是安全的）。修法：解压前 `zlib.getOriginalSize(archiveFile)`（API 12）超过 `MAX_TOTAL_UNCOMPRESSED_BYTES` 或比值超 `MAX_COMPRESSION_RATIO` 即拒绝。
- **5.10** `cleanUp()`（`UpdateContext.ts:784-798`，`markSuccess/clearFirstTime/clearRollbackMark/syncStateWithBinaryVersion` 调用）绕过串行任务链直接在 libuv worker 跑 `cleanupOldEntries`，而下载可能正在追加 >3 天的续传 partial 或填充 staging（`CleanupOldEntries` 按 mtime）。Android 与下载同一单线程 executor。修法：`enqueueSerialTask(() => NativePatchCore.cleanupOldEntries(...))`。
- **5.11** `forceBootRescue` 标记缺失：`NativeCheckOrchestrator.ts:278-293` 只拷 `name/description/metaInfo`；Android（`NativeCheckOrchestrator.java:380-383`）和 iOS（`RCTPushy.mm:2228`）在 `config.forceBoot` 时写 `forceBootRescue:true`，`src/client.ts:1013-1014` 据此在 `markSuccess` 上报回执。鸿蒙的救砖永远不被记为救砖。
- **5.12** 无可观测性：`Logger.ts:52` 出厂 `isDebug=false`，编排器里程碑除 "skipped" 外全是 `logger.debug`（`NativeCheckOrchestrator.ts:227,250,313-317,547`），Android 是 `Log.i/w`；`UpdateContext.DEBUG(:39)` 硬编码 false 未接 `BuildProfile.DEBUG`。轮次生命周期日志提到 `info/warn`；`DEBUG` 从 `BuildProfile` 派生。
- **5.13** HAR 版本标识陈旧：`harmony/pushy/oh-package.json5:10` `version: '10.35.1'`，`package.json` 是 10.55.1；`check-release-version.js` 不看它。消费者 `oh-package-lock.json5` 和诊断无法区分装的是哪个 HAR。让 `build-harmony-har.js` 在 `assembleHar` 前从 `package.json` 重写版本，并扩展 `check-release-version.js` 断言相等。
- **5.14** `hvigor-plugin.ts:7-31` 在 `apply()`（每次 hvigor 调用含 IDE sync）里跑，硬编码 `entry/` 和 `process.cwd()`，用 `Date.now()` 改写消费者源码树里的 `rawfile/meta.json`（git 噪音；模块名不是 entry 时写错位置）；debug 构建也拿真实时间戳，每次 debug 构建都像新二进制（Android debug 输出 `0`）。改挂到构建任务、从 hvigor 节点上下文取模块路径、debug 输出 `0`。
- **5.15** 测试：已覆盖 `parseManifestToArrays/isSafePathComponent/validateHashInfo/getErrorMessage/DownloadTaskParams`（`EventHub` 的 on/off 测试断言为空，因为 `emit` 不看监听器）。未覆盖的纯逻辑：`parseContentRangeTotal`（专为测试导出）、`buildInstallRecord/isInstallComplete/verifyInstallForActivation`、`readString/readBoolean`、`normalizeEndpointBase`、`buildResponseCacheJson`、flush-batch 深度语义、以及最有价值的：`ArchiveLimits.ts/InstallRecord.ts` 与它们声称"手工镜像"的 C++ 头文件之间的漂移。修法：JS 套件里加一个 Node 测试解析 `archive_limits.h/install_record.h/error_codes.h` 与 ArkTS 镜像并断言常量相等。

### P4
- `EventHub.ts:19-34` `listeners` map 从未被 `emit` 使用；`rnInstance: any` 只在构造新 TurboModule 时替换，已销毁的 RNInstance 仍被引用。
- 死代码/重复：`persistState({clearExisting})`（`UpdateContext.ts:290-292`）无调用且未 await `preferences.clear()`；`downloadFile()`（`:571-583`）无 JS 入口；`VERSION_COMPLETE_FILE_NAME`（`DownloadTask.ts:28`）重复 `INSTALL_RECORD_FILE_NAME`；`removeDirectory(:252-277)` 重实现递归 `fileIo.rmdir`；`transferArchive` ~420 行 15 个闭包捕获的可变局部；`doPatchFromApp*/doPatchFromPpk*` 共享同样的下载→staging→digest→解压→plan 脚手架；`console.*` 与 `logger` 混用。潜在 unhandled rejection：`writeError` 在 `dataEnd` 已触发后才设置（`:863-866`），`dataEndPromise` 链（`:686-712`）无订阅者地 reject。
- `pushy.cpp` 小项：`Sha256HexFile` 参数非字符串时抛两次（`:910-914`）；`FlowIsValidCheckResponse` 在异常 pending 时返回 boolean（`:1090-1095`）；`CMakeLists.txt:75-78` `--gc-sections` 没配 `-ffunction-sections -fdata-sections`（无效），无 `-fvisibility=hidden`。
- `rejectReservedEntries`（`DownloadTask.ts:315-330`）只查顶层精确 `.pushy-complete`，Android 拒绝任意深度 `.pushy-` 前缀。
- `module.json5` 未声明 `requestPermissions`，`ohos.permission.INTERNET` 需消费者声明但仓库无文档。
- `.ts` 源大量使用 ArkTS 禁止的写法（解构 `DownloadTask.ts:63,1146`、`Logger.ts:31`；Set 展开 `:1125-1129`；`any`；交叉类型 `UpdateContext.ts:31-33`；动态属性赋值 `error.code=`）——`tsc --strict` 不会告警，迁移到 `.ets`/严格 ArkTS 时全部暴露。在 5.8 的容器里跑 DevEco `codelinter` 能拿到真实清单。

已核实正常：回滚/first-time 记账与 Android 镜像（含 `ignoreRollback` 与循环守卫）；`resetGeneration` 对在途轮次的围栏；`taskChain` 串行化与开跑时去重；`transferArchive/httpRequest/runWithinDeadline` 的计时器全部清理；服务端控制的路径分量在触盘前已验证；激活时的安装记录 digest 校验存在；不做 crash hold 由"RNOH 未捕获 JS 错误不杀进程"的模拟器实证支撑。

---

## 6. CI / 发布 / 打包 / 仓库卫生

- **6.1（P2）测试覆盖缺口汇总**：`patch_core` 测试不在 CI（4.3）；鸿蒙不编译不类型检查（5.8）；`native-gate` 的 e2e 只在路径过滤命中时才要求，`e2e-harmony` 永远不在门内。
- **6.2（P1，同 5.1）** publish 的 HAR 变更检测只看 `harmony/`。
- **6.3（P3）根 package.json 里的死依赖与死脚本**：`firebase-tools`、`jest`、`ts-jest`、`@types/jest`、`detox`、`pod-install` 在根目录无任何使用（detox/pod-install 由 `Example/e2etest` 自己的 lock 提供；测试跑的是 `bun test`）；`tests:emulator:prepare / tests:emulator:start-ci / tests:packager:jet-ci / tests:ios:pod:install` 脚本和整个 `.github/workflows/scripts/`（firebase emulator、functions、rules）是模板残留，仓库里没有任何 workflow 引用；根 `e2e/starter.test.js` 测的是不存在的 welcome/hello 元素。清掉后 `bun install` 少装 ~30MB，lockfile 与 dependabot 面都小。
- **6.4（P3）仓库里的大二进制**：`Example/harmony_use_pushy/debug.png`（761KB）、`demo.png`（345KB）在 git 历史里；`android/lib/*/librnupdate.so` 每次重建都是 4×~290KB 的新 blob（历史里已有 3 代）。发布已改为 CI 重建（publish.yml），可以考虑不再提交 `.so`（本地开发走 `bun build:so`，或 git LFS）。
- **6.5（P3）README 与公开 API**：`testChannel / healthCheck / autoMarkSuccessDelayMs / resetToPackagedBundle / getUpdateMetadata / attachToSentry / maxRetries / beforeReload / onPackageExpired / overridePackageVersion / dismissErrorAfter / useUpdateProgress / onError` 在两份 README 里均无提及（只有外站文档链接）。至少在 README 里放一张 options 索引表指向文档页。
- **6.6（P4）设计文档**：`NATIVE_CHECKUPDATE_DESIGN.md`（36KB）、`NATIVE_CHECK_FOLLOWUPS.md`（31KB）、`BUNDLEHASH_MIGRATION.md`（25KB）都在仓库根；FOLLOWUPS 里大量已关闭项与原始描述并存。建议移到 `docs/`，FOLLOWUPS 只保留开放项表。
- **6.7（P4）方法表对等性**：本次核对 16 个 Spec 方法在 oldarch/newarch/iOS/鸿蒙 C++/鸿蒙 ArkTS 五处全部注册（好）。但没有自动化守护，鸿蒙已经断过一次；见 5.2 的脚本建议。另 iOS 未导出 Spec 声明的 `isUsingBundleUrl` 常量（Android/鸿蒙有；JS 侧无人使用）——要么 iOS 补上，要么从 Spec 删掉。
- **6.8（P3）安全模型说明**：三端均无 bundle 签名校验（grep 无 signature/ed25519/publicKey），完整性完全依赖 TLS + 服务端下发的 hash；端点列表又可由 gitee/jsdelivr 上的 `endpoints.json` 远程注入（`getRemoteEndpoints` 只要求是字符串，不要求 https）。这是既定信任模型，但两处低成本加固值得做：远程端点列表只接受 `https://`；长期看可加可选的离线签名（app 内置公钥、服务端签 manifest），对自托管/http 部署尤其有价值。

---

## 8. 处理状态（2026-09-02，同分支后续提交）

全部条目已按层落地，提交：`2d21709`（CI/发布/脚本/README/C++ keep 列表）、`604ef60`（JS）、`4efa5f9`（iOS）、`36ddfc2`（Android）、`b56ecd2`（鸿蒙）、`f40d28d`（C++ 内核与 `.so` 重建）。

| 层 | 已完成 | 明确未做 / 需人工跟进 |
|---|---|---|
| JS | §1 全部（含 P4）、6.3、6.8、FOLLOWUPS 7/8/9；单测 222 → 273 | `require('../package.json')` 改生成 `version.ts`（收益小，保留） |
| Android | 2.1–2.13 与 P4 全部；新增 25 项纯 JVM JUnit | 无法在本环境跑 Gradle/R8：`build.gradle` 与 `proguard.pro` 需在一次 `minifyEnabled true` 的 release 构建里确认 diff/pdiff 仍可应用 |
| iOS | 3.1–3.12 与 P4 全部；`PrivacyInfo.xcprivacy` 随 pod 发布 | 3.13 文件拆分、3.14 逻辑下沉 C++ 未做（无 Xcode 无法验证大重构）；两处改动需真机/模拟器回归：defaults key 迁移、`use_frameworks!` 下 `buildTime` 回退 |
| C++ | 4.1–4.14 与 P4 全部；`.so` 已用 NDK 28.2.13676358 重建 | `buildCheckFingerprint` 未移植到 C++（原生各端未复用它） |
| 鸿蒙 | 5.2–5.15 与 P4 全部；`oh-package.json5` 版本对齐 | 5.7 的 RCP 重定向控制（HMS-only）未做；`BuildFlags.ts` 依赖 hvigor 生成的 `BuildProfile` 别名，首次真实编译在 `harmony-build` CI；`transferArchive` 大函数未拆 |
| CI/发布 | 4.3、5.1、5.8、6.1、6.2、6.5、6.7 全部；新增 `check-native-spec-parity.js`、`harmony-build.yml`、`FUZZ=1` 步骤 | 6.4（不再提交 `.so` / 迁 LFS）与 6.6（设计文档搬家）未做，属流程决策；`harmony-build` 首次运行时若容器未暴露 `DEVECO_SDK_HOME`，type-check 步骤会失败并提示 |

发版前提醒：鸿蒙 HAR 由 publish 在容器内重建；Android `.so` 已随本分支提交。iOS 的 `PrivacyInfo.xcprivacy` 与 defaults key 迁移、Android 的 old-arch Promise 签名属于行为变化，发版说明需提及。

## 7. 建议的执行顺序

**第一批（小改动、高收益，可一个 PR）**
1. `IsSafeRelativePath` 拒绝控制字节（4.1）+ 递归深度上限（4.2）+ `flowjson::Parse` 输入上限（4.5）。
2. `publish.yml` 变更检测扩到 `cpp/ android/jni/ scripts/build-harmony-har.js`（5.1）。
3. 鸿蒙三个方法改 ASYNC 注册 + spec/方法表一致性脚本（5.2）。
4. `test.yml` 加 `SANITIZE=1 ./scripts/test-patch-core.sh`（4.3）。
5. `core.ts` web 常量（1.1）；`readNativeCheckCache` 加 schema 门（1.5）；`setOptions` 应用 locale（1.3）；`getRemoteEndpoints` 要求 `ok`（1.4）。
6. iOS：随包发 `PrivacyInfo.xcprivacy`（3.1）；`PushyUnzipGuard` 拒绝 symlink（3.3）；`__diff.json` 解析加类型检查（3.4）；下载前置大小/空间上限（3.5）；SSZipArchive 固定 `~> 2.4`（3.11）。

**第二批（并发与契约）**
7. Android：所有 snapshot→commit 走 `commitLock`，`restartApp` 的 hash/切换搬离 UI 线程（2.1、2.2）；oldarch 补 Promise 签名（2.3）；JNI 结果类硬 keep + 收窄消费者 proguard（2.4）；cleanup keep 集合加 `launchVersion`（2.5）。
8. iOS：无前缀 defaults key 改名并迁移（3.2）；`buildTime` 资源 `bundleForClass:` 回退（3.6）；重载路径去掉预消费状态、失败 reject（3.7）。
9. provider 主 effect 拆分（1.2）+ 用真实 client 的契约测试（1.12）。
10. 鸿蒙：`readTimeout` 绑到剩余 deadline（5.3）、`flush` 真正 await（5.4）、异步 sha256（5.5）、错误码（5.6）。

**第三批（CI 与卫生）**
11. `harmony-build` PR job（5.8）；libFuzzer harness（4.13）；Android 纯 JUnit（§2 末）；manifest/安装记录/限额累加器下沉 C++（3.14）；`RCTPushy.mm` 拆分（3.13）。
12. 删死依赖/死脚本/firebase 残留（6.3）；`react-native-url-polyfill` 替换（1.10）；README options 索引（6.5）；APK 完整性校验（2.6）；构建时脚本改写方式（3.10）。
