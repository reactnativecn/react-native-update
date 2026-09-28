# Native host API naming migration

The bridge-free host APIs use bundle-preparation terminology. This is a
source-level breaking rename, not a change to download, activation, rollback,
or crash-rescue behavior. No deprecated native alias is retained.

| Previous API | Replacement |
| --- | --- |
| Android `PushyNativeUpdate` | `PushyRuntime` |
| Android `PushyNativeUpdate.checkAndUpdate(context, callback)` | `PushyRuntime.prepareBundle(context, callback)` |
| Objective-C `checkAndUpdateWithCompletion:` | `prepareBundleWithCompletion:` |
| Swift `checkAndUpdate(completion:)` | `prepareBundle(completion:)` |
| Harmony `PushyFileJSBundleProvider.checkAndUpdate()` | `PushyFileJSBundleProvider.prepareBundle()` |
| Android/Harmony `NativeUpdateResult` | `BundlePreparationResult` |
| Harmony `NativeUpdateConfig` | `PushyConfiguration` |
| iOS `RCTPushyNativeUpdateCompletion` | `RCTPushyBundlePreparationCompletion` |

`configure` keeps its name. The Android package, iOS module and Harmony package
identities are unchanged. Update native imports, type annotations and call sites
together, including imports from Harmony's package entry point.

## Lifecycle and compatibility

Persist configuration before normal launch bundle resolution when provisioning
without JavaScript. Wait for configuration to finish before continuing startup.
Call `prepareBundle` only **after the host's real launch bundle resolution**, and
reuse the initialized Harmony provider. Do not resolve the bundle a second time
just to call this API: resolution consumes first-load and rollback markers.

The call starts, joins or reuses the process's existing native round. It does not
reload the running React Native instance or display UI. A successful selection is
for the **next launch**; preparation can also download without selecting a bundle,
according to the existing `afterDownload` policy. Callback threading, cancellation,
request deduplication, configuration invalidation and rescue behavior are unchanged.

Result fields (`status`, `reason`, `hash`, `activated`) and existing status strings,
including `noUpdate`, remain unchanged. This avoids changing the data contract as
part of an identifier rename.

This change is limited to the bridge-free host API. The public JavaScript SDK,
TurboModule/legacy bridge method names, server paths such as `/checkUpdate`,
configuration values such as `setNeedUpdate`, and persisted keys are unchanged.
It is not a removal of every occurrence of `update` from the package or binary.

Rebuild and redistribute the native application to consume these native API names;
a JavaScript-only delivery cannot rename an installed native class or selector.
For Apple platforms, rerun `pod install` as part of the normal native upgrade.
For Harmony, rebuild/use the matching HAR instead of an older prebuilt artifact.
Do not restore old native aliases during migration. Historical release notes retain
the API names that existed in the versions they document.

## 中文迁移说明

原生宿主入口统一为 `prepareBundle`，Android 对外类改为 `PushyRuntime`，
结果类型改为 `BundlePreparationResult`，Harmony 配置类型改为
`PushyConfiguration`。iOS/Swift 的方法与完成回调类型同步改名，不保留旧名别名。

这是原生源码接口的破坏性重命名，不改变下载、下次启动选包、回滚或救援行为。
配置完成后，先走宿主正常的 bundle 解析流程，再调用 `prepareBundle`；
不要为调用接口再次解析 bundle，也不要新建另一个 Harmony provider。
`activated` 仍表示已为下次启动选定，而不是当前实例已经重载。

JS SDK、JS 原生桥接接口、服务端路径、配置值、结果字段/状态值和持久化键不变。
需要重新构建并分发原生安装包，不能只通过 JS 热更新完成原生接口改名；
Apple 平台按正常升级流程重新运行 `pod install`，Harmony 使用重新构建的 HAR。
