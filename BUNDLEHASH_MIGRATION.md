# bundleHash 迁移执行方案

> 状态：**Phase 0（客户端）、Phase 1（CLI）、Phase 2 核心（服务端）已实现**，均未提交；Phase 2 遗留控制台聚合/digests 下发（见 §4.5），Phase 3 待 Phase 2 稳定
> 依据：`BUNDLEHASH_DESIGN.md`（设计定稿）。本文只讲**怎么落地**，不重复论证为什么。
> 下游：`NATIVE_CHECKUPDATE_DESIGN.md` 的协议下沉必须等本迁移完成，否则协议下沉后再改协议要返工。

---

## 0. 一条贯穿全程的铁律

**客户端哈希的文件，必须与 pdiff 实际打补丁的那个文件字节一致。**

不一致就是最坏结果：服务端确信 pdiff 可用、下发、下载完 hpatch 源校验失败，比现在的启发式还糟。

**所以两侧都不要新写"找 bundle 文件"的逻辑，复用 pdiff 实际的源读取路径**：

| | 客户端哈希的对象 | pdiff 的源读取（哈希必须与之逐字对齐） |
|---|---|---|
| iOS | `[RCTPushy binaryBundleURL]` 返回的文件（`mainBundle` 的 `main.jsbundle`） | 就是 pdiff 的 `fromBundle`（`RCTPushy.mm:727`） |
| Android | **硬编码 `index.android.bundle`**，`context.getAssets().open()` 读 | `DownloadTask.copyBundledAssetToFile("index.android.bundle", …)`（`DownloadTask.java:322`）——pdiff 源本来就是硬编码的，**不走** `getBundleAssetName()` 反射；自定义 bundle 名的用户 pdiff 今天就打不了、CLI 也传不上（`getApkInfo` 的正则同样硬编码），三处一致地退化到 buildTime 启发式 |
| Harmony | rawfile `bundle.harmony.js` | pdiff 的 `getRawFileContent('bundle.harmony.js')`（`DownloadTask.ts:559`） |
| CLI | 解包后的同名条目 | `getIpaInfo` / `getApkInfo` / `getAppInfo` **已经把 bundleFile 拿在手里了** |

最后一行是这次调研最大的好消息，见 §3。

---

## 1. 实施前定稿（原设计 §11 的四个开放问题）

| # | 问题 | 定稿 |
|---|---|---|
| 1 | 字段名 | `bundleHash` / `bundleStatus` / `digests`，维持原议 |
| 2 | `digests` 用 sha256 还是复用 OSS md5 | **sha256**。OSS 的 etag 在分片上传下不是内容 md5，不能直接复用；且 §0 的 sha256 工具本来就要进 C++，复用同一套心智 |
| 3 | 控制台聚合口径 | 按 **(app, packageVersion)**。因为对应的开发者动作就是"把这个包传上来"，按 app 聚合无法定位到具体动作 |
| 4 | `assetsHash` | **不做**。metro 把受管资源的内容 md5 嵌进 bundle，资源变则 bundle 字节必变，需求趋近于零。等真实反馈 |

---

## 2. Phase 0 — 客户端（react-native-update）

### 2.1 sha256 工具进 `cpp/patch_core`——但 Android 用 `MessageDigest`

`cpp/patch_core/digest.{h,cpp}`，流式接口 + `Sha256File`，同时为 §8 的下载校验铺路：

```cpp
namespace pushy::digest {
  class Sha256 { void Update(const uint8_t*, size_t); std::string HexDigest(); };
  std::string Sha256File(const std::string& path);  // iOS 用
}
```

各端消费方式（审查后修订，原稿要求三端全走 C++）：

| 平台 | 实现 | 理由 |
|---|---|---|
| iOS | `pushy::digest`（podspec 已从源码编译 patch_core，加一个文件即可） | 免费共享 |
| Harmony | NAPI 包装 `pushy::digest`（CMakeLists 同样从源码编译） | 免费共享 |
| **Android** | **`java.security.MessageDigest("SHA-256")`** | `librnupdate.so` 是预编译产物，为这一个函数重编 4 ABI 不值；SHA-256 是标准算法，C++ 侧的 NIST 测试向量同时锚定两个实现 |

**收益：Phase 0 完全不需要重编 `.so`**，原方案的 R4（ABI/对齐回归）风险在本阶段消失。digest.cpp 照常加进 `.so` 的构建脚本，下次因其他原因重编时自动带上，Phase 3 的 C++ 侧校验直接可用。

### 2.2 缓存键：设计文档这里是错的

原设计写"缓存键 `(packageVersion, bundle 文件 size, mtime)`"。**Android 和 Harmony 的 bundle 不是磁盘文件**——一个在 APK 的 assets 里，一个在 rawfile 里，都没有独立的 size/mtime 可读。

改为按平台取各自的"安装身份"：

| 平台 | 缓存键 | 读取方式 |
|---|---|---|
| iOS | `(packageVersion, 文件 size, mtime)` | `main.jsbundle` 是真实文件，原设计可用 |
| Android | `(packageVersion, PackageInfo.lastUpdateTime)` | 每次安装/覆盖安装都会变，含同版本重装 |
| Harmony | `(packageVersion, BundleInfo.updateTime)` | 已核对 `BundleInfo.d.ts:390`，字段存在 |

键存 SharedPreferences / NSUserDefaults / preferences，与现有状态同一存储。

### 2.3 读取与计算

- **Android**：`context.getAssets().open("index.android.bundle")` 流式喂给 `MessageDigest`——**与 pdiff 源读取（`copyBundledAssetToFile`）完全同一 API、同一硬编码名**（§0）。资源不存在（debug / 自定义名 / 无嵌入 bundle）→ 返回空串。
- **iOS**：`Sha256File([[RCTPushy binaryBundleURL] path])`；文件不存在 → 空串。
- **Harmony**：`resourceManager.getRawFileContent('bundle.harmony.js')` 拿到 buffer 后经 NAPI 喂给 sha256（与 pdiff 读法完全一致）。

线程：Android `StateSerialRunner`，iOS `_fileQueue`，Harmony taskpool。几 MB 约 10-50ms。

### 2.4 暴露给 JS

**异步 getter，不进 `getConstants`**（AN-6/IO-4 的教训）：

```ts
// NativePushy.ts
getBundleHash(): Promise<string>;   // 计算失败 / debug 构建返回空串
```

### 2.5 JS 接入：预取 + 同步读，checkUpdate 零 await

初稿在 checkUpdate 里做 200ms 超时 race，评审否决——没必要的复杂度。定稿：

```ts
// core.ts 模块加载时 fire-and-forget 预取,settle 后存模块变量
if (typeof PushyModule.getBundleHash === 'function') {
  Promise.resolve(PushyModule.getBundleHash()).then((h) => { bundleHash = String(h || ''); });
}
export const getBundleHash = (): string => bundleHash;

// client.ts checkUpdate 内:同步读,没有就省略
const bundleHash = __DEV__ ? '' : getBundleHash();
```

拿不到就省略字段，服务端自动退回 buildTime 启发式（判定矩阵第 4 行），下一次检查自然带上。代价是每个进程的**第一次** checkUpdate 可能缺字段（原生缓存命中时预取通常几 ms 内 settle，实际很少缺）——一次退化完全可接受。

**顺带消掉一个曾踩过的坑**：初稿的 race `await` 插进了"5s 去重检查 → `lastRespJson` 赋值"的同步窗口，导致并发 checkUpdate 双发请求（JS2-1 测试抓住）。同步读方案下 checkUpdate 完全没有新增 await，这类问题在结构上不可能出现。

### 2.6 `bundleStatus` 消费（字段先行）

服务端上线前不会有这个字段，先把消费侧写好：
- `unknownBundle` → `warn()`（新 i18n key `warn_unknown_bundle`）+ `report({ type: 'bundleMismatch' })` 进 logger
- `afterCheckUpdate` 的 `UpdateCheckState` 透传 `bundleStatus`（result 自带字段，无需额外代码）

**修订原设计 §7 触达第 1 条**：\"`__DEV__` 下 console.warn 联调期拦截\"实际不可达——dev 构建不上报 bundleHash（metro bundle 无嵌入产物），服务端按判定矩阵第 4 行走 buildTime 启发式，永远不会返回 `unknownBundle`。warn 实际只出现在 release 日志里；开发者触达的主渠道是控制台聚合（触达第 3 条）与 CLI 前置拦截（第 4 条），不受影响。

### 2.7 验收

- ✅ C++ sha256 NIST 向量测试（`bun test:patch-core`，26/26）
- ✅ `bun test`（122，含 5 条新 bundleHash/bundleStatus 用例）/ `bun lint`（biome + tsc + harmony tsc）
- ✅ `javac` 对 RN 0.85.2 AAR（main + oldarch）/ `clang -fsyntax-only` 对 e2etest Pods
- ✅ **iOS + Android 模拟器 e2e**（`Example/e2etest/e2e/bundle-hash.test.ts`，已入 detox 套件、随 e2e_ios / e2e_android CI 跑）：release 构建、真机路径全链路，原生算出的值与宿主侧对包内 bundle 算的 sha256 **逐字节一致**——
  - iOS：JS 预取 → `_fileQueue` 懒计算 → C++ digest → NSUserDefaults；宿主 `simctl get_app_container` + `plutil` 直读容器 plist 比对 `sha256(main.jsbundle)`；含缓存命中路径
  - Android：`AssetManager.open` 解压字节 == APK zip 条目字节（bundle 压缩存储，这是 iOS 覆盖不到的独立风险点）、`MessageDigest` == 标准 sha256；宿主 `adb root` 读 `shared_prefs/update.xml` 比对 `unzip -p` 提取值；gradle 构建顺带完成 newarch codegen 对 `getBundleHash` 的真实编译验证
- ⬜ Harmony 真机比对未做：NAPI 直连已过 NIST 向量的 C++ digest，读法与 pdiff 完全同源（`getRawFileContent`），风险最低
- **e2e 踩坑记录**：`simctl spawn defaults read` 看不到 app 容器 defaults（必须 `get_app_container` + `plutil -extract`）；detox jest 环境把全局 `expect` 换成元素断言版（普通值断言用显式比较）；staged 目录为空壳时 gradle autolinking 缓存会记住"无 android 平台"，重 stage 后须清 `android/build/generated/autolinking`；Android release 下 detox `launchApp` 的会话握手在本机 arm64 模拟器挂起——本用例不需要 UI 交互，Android 分支用 `adb shell monkey` 拉起绕开

---

## 3. Phase 1 — CLI（react-native-update-cli）

**成本远低于设计文档的预期。** `getIpaInfo` / `getApkInfo` / `getAppInfo`（`src/utils/index.ts:145/187/230`）为了校验"包里有没有 bundle"，**已经把 bundle 的 Buffer 读出来了**，而且缺失时已经报错。

所以每个函数加一行：

```ts
return { versionName, buildTime, bundleHash: sha256(bundleFile), ...appCredential };
```

再在 `uploadNativePackage`（`src/package.ts:170`）的 `package/create` 请求体里带上 `bundleHash`。

另外两件事：
- AAB **不需要单独处理**：`uploadAab` 是先 `AabParser.extractApk` 转 APK 再委托 `uploadApk`（`package.ts:258`），自动经过 `getApkInfo`
- 上传时若同 `versionName` 已存在**不同** `bundleHash` 的包记录 → 提示"重打包且 JS 有变"（设计 §7 第 4 条）。这需要服务端先提供查询，**可以延后到 Phase 2 之后**，不阻塞

老服务端会忽略未知字段——已验证：`pushy-server` 的 `dto.ts:280` 注释明确"未知字段由 Elysia 默认 normalize 剥离，保留前向兼容"。Phase 1 可以独立发布。

---

## 4. Phase 2 — 服务端（pushy-server）

### 4.1 最容易漏、漏了最严重的一条

**`buildCheckUpdateCacheKey` 必须加 `bundleHash`。**（`code/src/utils/checkUpdateCapabilities.ts:51`）

现在的键是 `[appId, checkUpdateRevision, packageVersion, fromHash, buildTime, cacheBucket, toHash]`。一旦响应内容开始随 `bundleHash` 变化（给不给 pdiff、`bundleStatus` 是什么），不进键就是**跨设备串响应**：一个装了未注册二进制的设备可能拿到另一个设备的"给 pdiff"缓存，直接踩中 §0 那个最坏结果。

基数不会明显上升——`bundleHash` 与 `buildTime` 基本一一对应，Phase 3 删掉 buildTime 后反而回落。

### 4.2 数据与判定

- `packages` 表加 `bundleHash VARCHAR(64)`（`prisma/schema.prisma:60`），`getCachedCheckUpdatePackage` 的 select 加该字段
- 判定矩阵（设计 §6）落在 `handleCheckUpdate.ts` 的 `checkAndGenerateTaskAndCdnUrl` 之前：决定"这次允不允许下发 pdiff"
- `digests` 下发 + `__diff.json` 的 copies 附摘要

### 4.2.1 不实现 `touchesPackageAssets`（推翻原设计 §6）

原设计要求 pdiff 生成时预计算 `touchesPackageAssets`（manifest 是否含"从包内拷非 bundle 文件"），用于门控"bundleHash 命中但 buildTime 不符"这一行。**该标记不应实现**：

查 CLI 的 pdiff 生成（`react-native-update-cli/src/diff.ts:695-710`）：

```js
// If same file.
if (originEntries[entry.fileName] === entry.crc32) {
  copies[entry.fileName] = '';        // 同路径拷贝
  return;
}
const movedFrom = originMap[entry.crc32];
if (movedFrom) {
  copies[entry.fileName] = movedFrom; // 按内容定位拷贝
  return;
}
await addFileFromZipEntry(...);       // 只有新文件才打进 patch 包
```

**ppk 里每一个与二进制包 CRC32 相同的非 bundle 文件都会进 `copies`**。任何带图片/字体的真实应用，该标记恒为 true → "重打包但 JS 未变"这一行永远拿不到 pdiff。

而这一行正是设计 §1 点名的最常见场景、整个方案的头号收益来源。**这个机制会把它自己要解决的主场景关掉。**

它防的场景设计文档自己也判定为 ≈ 不存在：metro 把受管资源的内容 hash 嵌进 bundle，资源变则 bundle 字节必变、bundleHash 不会命中，根本落不到这一行。

**代之以运行时保证**（设计 §8 的 apply 校验，已建好一半）：

1. 该行直接下发 pdiff
2. `copiesCrc`（`diff.ts:645`，目前只记 "moved" 条目，为 APK→AAB 路径变化而设）扩展到**全部** copies 条目
3. 客户端拷贝时校验，不符 → fallback full。代价退化为一次 pdiff 下载，**永不装出坏包**
4. 给该 fallback 加遥测

若遥测显示这一行的 pdiff 失败率显著，再引入**精确**判据（如"copies 含非 metro 资源"），而不是用恒为 true 的粗标记一刀切。

### 4.3 开关与灰度

判定逻辑挂 `dynamicConfig` 开关，默认关。开启后异常可一键退回 buildTime 启发式——**这是 Phase 2 唯一的回退手段，必须先有开关再有逻辑**。

### 4.4 实现状态与两处实施决策

已落地（`pushy-server` 工作区，未提交，`bun test` 841 全绿）：

- `packages.bundleHash VARCHAR(64) NULL`（schema + `migrations/add_package_bundle_hash.sql`）；`package/create` 接收并存储（DTO 带 `^[0-9a-f]{64}$` 校验）
- `checkUpdateBodyJson` 接收 `bundleHash`；`buildCheckUpdateCacheKey` 进键并 bump `cu:v3→v4`；`cu:manifest` 也 bump `v1→v2`（select 加了字段，避免旧缓存形状被误判为"老 CLI 上传"）
- 判定矩阵在 `handleCheckUpdate`，`dynamicConfig.bundleHashJudge.enabled` 门控（默认关）；`unknownBundle` 的 pdiff 扣发复用 artifact 状态机的 `'empty'` 语义（天然做到"不下发、不入队"）
- 测试：矩阵五行 + 开关关死回退 + 缓存键分裂，7 条新用例

实施决策两处（文档此前未明确）：

1. **`unknownBundle` 不再 block**。今天 buildTime 不符是 6 小时 block（`ApiErrorWithOp`）；矩阵命中后同样场景变为"扣 pdiff、照发 full"，终端用户无感知。这是行为放宽，也是设计本意（§7"所有分支自动降级到正确路径"）。
2. **`ignoreBuildTime` 的 app 在开关开启后变严**：此前它无条件发 pdiff，现在内容不符会扣发。正确——内容不符的 pdiff 下载后 hpatch 源校验必败，本来就是白费流量。

### 4.4.1 cresc-server 同步（两态矩阵版）

cresc-server 是独立仓库（结构同构、历史独立，`handleCheckUpdate` 已漂移约 700 行），Phase 2 已手工移植（`bun test` 760 全绿）。关键差异：

- **cresc 没有 buildTime 启发式**（连 `ignoreBuildTime` 都已删除，见其 `drop_apps_ignore_build_time.sql`），今天 pdiff 是**无条件信任**的——正是设计 §1 "过松"失效模式的现役实例：不匹配的二进制会白下载 pdiff、hpatch 源校验失败再回落 full。bundleHash 判定对 cresc 是**第一道真正的门控**
- 矩阵塌缩为**两态**：`matched` / `unknownBundle`（rebuiltSameJs 的定义依赖 buildTime 分歧，无 buildTime 则与 matched 不可区分，也无需区分——客户端对二者都静默）
- 回退语义不同：开关关闭 = 回到"无条件信任 pdiff"（pushy 端是回到 buildTime 启发式）
- 其余同构：`packages.bundleHash` 列 + migration、DTO、`cu:v3→v4`、`cu:manifest:v1→v2`、`'empty'` 语义扣发、`dynamicConfig.bundleHashJudge.enabled` 默认关

注：cresc-server 干净树上有两个**存量** TS 错误（`src/routers/user.ts:916/957`，email 变更通知的 audit extra 字段），与本次改动无关，未处理。

### 4.5 Phase 2 遗留（不阻塞开启开关）

- 控制台 unknownBundle 聚合面板（§7 触达第 3 条，主渠道）——需 admin 侧配合。曾考虑挂在 `classifyCheckUpdateResult` 的 hitType 上，否决：hitType 是"下发了什么产物"维度，混入二进制身份维度不干净，应独立埋点
- `digests` 下发 + `__diff.json` copies 附摘要——与客户端 Phase 3 的消费侧同波次做
- ~~CLI 上传冲突提示~~ **已实现（改判为无需动 CLI）**：`(appId, name)` 唯一约束下重复上传本来就 409，在两台服务器的冲突分支里用 bundleHash 增强语义——内容一致 →"无需重复上传"、内容不同 →"重打包且 JS 有变，请提升原生版本号"、任一侧无 hash → 通用文案不变。查询仅发生在冲突路径。cresc 3 条路由级用例覆盖；pushy 无路由级测试脚手架，靠同构代码 + cresc 用例 + tsc 兜底

另：cresc-server 顺手修了一个与本迁移无关的存量 bug——`/email/confirm` 的 `select` 漏了 `extra`/`name`（`user.ts:888`），导致改邮箱时 OAuth 凭据吊销实际不生效（安全相关）+ 通知邮件用户名恒为兜底文案。

### 4.6 推进门槛

Phase 2 的收益与 Phase 0/1 的覆盖率成正比，但**不需要等覆盖率**：判定矩阵第 4/5 行本来就规定了"没上报 bundleHash → 原样走 buildTime 启发式"。所以 Phase 2 可以在覆盖率很低时就上线，收益随客户端升级自然增长。

真正要看的指标：`unknownBundle` 占比。它高说明教育有效（发现了真问题），持续不降说明 §7 的触达链路没起作用。

---

## 5. Phase 3 — 收尾（客户端）

### 5.1 `SyncBinaryVersion` 迁移有个状态危险，必须处理

设计文档写"`SyncBinaryVersion` 改 `(packageVersion, bundleHash)`"。直接改会出事：

```
现状：sp 里存的是 build_time
改后：代码拿 bundle_hash 去比 sp 里的 build_time
结果：必然不等 → 判定"二进制变了" → 清空全部热更状态
     → 所有设备的热更被抹掉一次，全网回内置包
```

这是一次性的全网退版，比本次要解决的问题严重得多。

**解法**：给持久化状态加一个 schema 版本号，迁移而不是比较。

```
读状态时：
  若 stateSchemaVersion < 2:
      不做 binary 变更判定（这一次跳过）
      把当前 bundleHash 写入，stateSchemaVersion = 2
      保持 currentVersion / firstTime 等原样
  否则：
      正常比较 (packageVersion, bundleHash)
```

即"首次遇到旧格式状态时，认领它而不是否决它"。这是纯函数逻辑，落在 `cpp/patch_core/state_core.cpp`，可以直接单测覆盖。

### 5.2 其余收尾

- 下载产物 `digests` 校验（IO-6 本体）
- apply 时 copies 摘要校验 → 不符即 fallback full，**永不装出坏包**
- 删除 `pushy_build_time` 构建注入：podspec 的 script_phase 写 node_modules（pnpm 下的老问题）、gradle 的 resValue、Harmony 的 meta.json 一并消失

### 5.3 buildTime 的降级顺序

不要一步到位。`bundleHash` 为空时（计算失败、老二进制）仍需要一个身份标识，所以：

1. 先让 `SyncBinaryVersion` 变成 `(packageVersion, bundleHash || buildTime)`
2. 观察一个版本周期，确认 `bundleHash` 为空的比例足够低
3. 再删构建期注入

---

## 6. 分阶段发布与回退

| Phase | 仓库 | 可独立发布 | 回退方式 |
|---|---|---|---|
| 0 | react-native-update | ✅ | 老服务端忽略未知字段，天然无害 |
| 1 | react-native-update-cli | ✅ | 同上 |
| 2 | pushy-server | ✅ | `dynamicConfig` 开关（§4.3） |
| 3 | react-native-update | ❌ 依赖 Phase 2 稳定 | 各项独立回退；§5.1 的 schema 版本号不可回退，需谨慎发布 |

任意新老组合的行为 = 两侧能力交集，最差退化为现状。

---

## 7. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 客户端与 CLI 哈希了不同的文件 | §0：两侧都复用已有的 pdiff 源解析逻辑，不新写；验收里有手工比对 |
| R2 | 服务端缓存串响应 | §4.1，必须先改缓存键再上判定逻辑 |
| R3 | Phase 3 的状态迁移抹掉全网热更 | §5.1 的 schema 版本号；纯函数，单测覆盖 |
| R4 | ~~`librnupdate.so` 重编引入对齐/ABI 回归~~ | **Phase 0 已消除**：Android 改用 MessageDigest，不动 `.so`（§2.1）。Phase 3 重编时 CI 的 `verify-android-so.js` 兜 16KB 对齐 |
| R5 | 自定义 bundle 名 / Expo / use_frameworks 下客户端定位不到文件 | 定位不到就返回空串 → 退回 buildTime 启发式，不比现状差。自定义名三处（客户端哈希 / pdiff 源 / CLI 提取）一致硬编码，退化行为对齐（§0） |
| R6 | 首次安装后第一次 checkUpdate 拿不到哈希 | §2.5 的 200ms 超时 + 省略字段，下次自然带上 |
| R7 | "重打包但 JS 未变"行下发的 pdiff 因包内资源漂移而 apply 失败 | §4.2.1：apply 时校验 + fallback full + 遥测。这是本方案里唯一被下调保护强度的地方，用运行时保证换回主场景的收益 |

---

## 8. 建议的执行顺序

Phase 0 与 Phase 1 无依赖，**可并行**，且 Phase 1 只有几行、应当先合（先让平台开始积累 `bundleHash` 记录，Phase 2 上线时就有数据可判）。

```
Phase 1 (CLI, 数行)  ─┐
                      ├─> Phase 2 (服务端, 带开关) ─> 观察 ─> Phase 3 (收尾)
Phase 0 (客户端)     ─┘
```

**Phase 3 之前不要动 `NATIVE_CHECKUPDATE_DESIGN.md` 的协议下沉**——协议此时还在变。
