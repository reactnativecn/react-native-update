# bundleHash 迁移执行方案

> 状态：**Phase 0/1/2 已全部上线，Phase 3 未开始（§5）**
> - 客户端 `react-native-update@10.49.0`（bundleHash 上报，da48a685）、
>   `10.50.0`（三端 copiesCrc 校验 + `downloadFallback` 遥测，29da9b7a）；
>   CLI `react-native-update-cli@2.20.3`（注册 bundleHash）、`2.21.2`（全量 copiesCrc）
> - 服务端：pushy / cresc 两端 `packages.bundleHash` 列已迁移并部署（2026-07-29）；
>   `bundleHashJudge.enabled` 已于 2026-08-03 双端开启（redis `config_dynamic`，回退=写回 false）
> - 仍开放：§5.1 `SyncBinaryVersion` 迁移、§5.2 `digests` 下发与校验
>
> 依据：原设计稿 `BUNDLEHASH_DESIGN.md`（未入库）。本文只讲**怎么落地**，并记录落地时
> 推翻原设计的几处（§2.2 缓存键、§4.1 服务端缓存键、§4.2.1 `touchesPackageAssets`）。
> Phase 0–2 的逐步实施记录（服务端改动明细、cresc 两态矩阵移植、e2e 踩坑）已收敛，见
> `git show 4ca8972e:docs/BUNDLEHASH_MIGRATION.md`。

---

## 0. 一条贯穿全程的铁律

**客户端哈希的文件，必须与 pdiff 实际打补丁的那个文件字节一致。**

不一致就是最坏结果：服务端确信 pdiff 可用、下发、下载完 hpatch 源校验失败，比现在的启发式还糟。

**所以两侧都不要新写"找 bundle 文件"的逻辑，复用 pdiff 实际的源读取路径**：

| | 客户端哈希的对象 | pdiff 的源读取（哈希必须与之逐字对齐） |
|---|---|---|
| iOS | `[RCTPushy binaryBundleURL]` 返回的文件（`mainBundle` 的 `main.jsbundle`） | 就是 pdiff 的 `fromBundle` |
| Android | **硬编码 `index.android.bundle`**，`context.getAssets().open()` 读 | `DownloadTask.copyBundledAssetToFile("index.android.bundle", …)`——pdiff 源本来就是硬编码的，**不走** `getBundleAssetName()` 反射；自定义 bundle 名的用户 pdiff 打不了、CLI 也传不上（`getApkInfo` 的正则同样硬编码），三处一致地退化到 buildTime 启发式 |
| Harmony | rawfile `bundle.harmony.js` | pdiff 的 `getRawFileContent('bundle.harmony.js')` |
| CLI | 解包后的同名条目 | `getIpaInfo` / `getApkInfo` / `getAppInfo` 已经把 bundleFile 拿在手里 |

---

## 1. 实施前定稿（原设计的四个开放问题）

| # | 问题 | 定稿 |
|---|---|---|
| 1 | 字段名 | `bundleHash` / `bundleStatus` / `digests` |
| 2 | `digests` 用 sha256 还是复用 OSS md5 | **sha256**（OSS etag 在分片上传下不是内容 md5） |
| 3 | 控制台聚合口径 | 按 **(app, packageVersion)** |
| 4 | `assetsHash` | **不做**（metro 把受管资源内容 md5 嵌进 bundle，资源变则 bundle 字节必变） |

---

## 2. Phase 0 — 客户端（已发布，10.49.0）

- **sha256**：`cpp/patch_core/digest.{h,cpp}`（流式 + `Sha256File`，NIST 向量测试锚定）；
  iOS 直接用、Harmony 经 NAPI；**Android 用 `MessageDigest("SHA-256")`**，免得为一个
  函数重编 `.so`。
- **缓存键（推翻原设计）**：Android/Harmony 的 bundle 不是磁盘文件，没有 size/mtime，
  改为各端"安装身份"：iOS `(packageVersion, size, mtime)`、Android
  `(packageVersion, PackageInfo.lastUpdateTime)`、Harmony `(packageVersion, BundleInfo.updateTime)`。
- **读取**：与 pdiff 源读取同一 API、同一硬编码名（§0）；找不到 → 空串。线程：Android
  `StateSerialRunner`、iOS `_fileQueue`、Harmony taskpool。
- **JS 接入**：异步 `getBundleHash()`（不进 `getConstants`），模块加载时预取、
  checkUpdate 同步读，没有就省略字段（服务端退回 buildTime 启发式）。checkUpdate 不新增
  await——初稿的 200ms race 曾在"5s 去重 → `lastRespJson` 赋值"窗口里造成并发双发。
- **`bundleStatus`**：`unknownBundle` → `warn()` + `report({ type: 'bundleMismatch' })`。
  dev 构建不上报 bundleHash，所以不会在 `__DEV__` 下出现。

### 2.7 验收

- C++ sha256 NIST 向量（`bun test:patch-core`）、JS 单测、lint 全过。
- **iOS + Android 模拟器 e2e**：`Example/e2etest/e2e/bundle-hash.test.ts`（随 e2e_ios /
  e2e_android CI 跑），release 构建下原生算出的值与宿主侧对包内 bundle 算的 sha256
  **逐字节一致**（iOS 直读容器 plist；Android 比对 `unzip -p` 提取值，顺带覆盖 bundle
  压缩存储这一独立风险点）。
- ⬜ Harmony 真机比对未做：NAPI 直连已过 NIST 向量的 C++ digest，读法与 pdiff 同源，风险最低。

---

## 3. Phase 1 — CLI（已发布，2.20.3）

`getIpaInfo` / `getApkInfo` / `getAppInfo` 已读出 bundle Buffer，各加一行
`bundleHash: sha256(bundleFile)`，随 `package/create` 上报；AAB 先转 APK 自动覆盖。
老服务端剥离未知字段，可独立发布。

---

## 4. Phase 2 — 服务端（已上线，判定开关已开）

### 4.1 缓存键必须含 bundleHash

响应内容随 `bundleHash` 变化（给不给 pdiff、`bundleStatus`），不进
`buildCheckUpdateCacheKey` 就是**跨设备串响应**，直接踩中 §0 的最坏结果。已进键
（`cu:v3→v4`，`cu:manifest:v1→v2`）。

### 4.2 判定

`packages.bundleHash` + 判定矩阵（`handleCheckUpdate`，`dynamicConfig.bundleHashJudge.enabled`
门控）。`unknownBundle` 不再 block：扣 pdiff、照发 full。cresc 无 buildTime 启发式，
矩阵塌缩为 `matched` / `unknownBundle` 两态，对 cresc 是第一道真正的 pdiff 门控。

### 4.2.1 不实现 `touchesPackageAssets`（推翻原设计）

原设计要求 pdiff 生成时预计算 `touchesPackageAssets`（manifest 是否含"从包内拷非 bundle
文件"），用于门控"bundleHash 命中但 buildTime 不符"这一行。**不实现**：CLI 的 pdiff 生成把
每一个与二进制包 CRC32 相同的非 bundle 文件都放进 `copies`，任何带图片/字体的应用该标记
恒为 true，"重打包但 JS 未变"——方案头号收益场景——永远拿不到 pdiff。它防的场景（资源变
而 bundle 不变）因 metro 把资源 hash 嵌进 bundle 而≈不存在。

**代之以运行时保证（已全部落地）**：

1. 该行直接下发 pdiff；
2. `copiesCrc` 扩展到**全部** copies 条目（CLI 2.21.2）；
3. 客户端拷贝前校验，不符 → 整次 pdiff 失败、JS 策略链落 full，**永不装出坏包**：
   Android `BundledResourceCopier`、iOS/共享 C++ `CopyOperation.expected_crc`
   （`ApplyPatchFromFileSource`，`digest::Crc32File`）、Harmony 经 NAPI `crc32`。
   例外：Android 密度分包安装里，其他密度本来就不在设备上，不算漂移，目标文件用该资源
   已安装的变体填充；已安装密度或路径存在但内容不符的条目仍然失败；
4. 遥测：本地事件 `downloadFallback`（增量失败但后续策略救回），失败码为 PATCH_FAILED 时
   映射服务端 `patch_fail`（为此 Android `PatchFailedException`、Harmony patch 阶段补齐了
   稳定码）。

存量 pdiff 只有 moved 条目的 CRC，客户端只校验有声明的条目，随版本滚动自然收敛。若遥测
显示这一行的 pdiff 失败率显著，再引入**精确**判据，而不是恒为 true 的粗标记。

### 4.3 开关与回退

判定逻辑挂 `dynamicConfig` 开关——Phase 2 唯一的回退手段。关闭 = pushy 回到 buildTime
启发式、cresc 回到无条件信任 pdiff。

### 4.5 Phase 2 遗留

- ~~控制台 unknownBundle 聚合~~ 已实现：请求侧合并进原生包面板（报了 bundleHash 记
  `packageVersion_bundleHash`，否则 `packageVersion_buildTime`）。
- ~~CLI 上传冲突提示~~ 已实现（服务端 409 分支用 bundleHash 区分"内容一致/JS 有变"）。
- `digests` 下发 + `__diff.json` copies 附摘要——与客户端 §5.2 同波次做。

推进指标：`unknownBundle` 占比。持续不降说明触达链路没起作用。

---

## 5. Phase 3 — 收尾（客户端）

> **定位修订（2026-08-03）：buildTime 不删，永久保留作 fallback。**
> 理由：服务端分支与客户端双上报的保留成本≈0，而删除的伤害面（bundleHash
> 空串设备失去二进制身份 → 重打包检测失明 / 双缺请求拿不到 full）明确存在
> 且只能靠空串率数据压低，收益（构建注入清理、协议更干净）不急迫。注入的
> pnpm 老毛病若再发作，修注入本身而不是删身份。
> Phase 3 因此收缩为一件事：**§5.1 的 SyncBinaryVersion 迁移**——改为
> `bundleHash || buildTime`（bundleHash 优先、buildTime 兜底，schema 认领式
> 迁移照做）。不做它，rebuiltSameJs 的收益只兑现一半：服务端已不 block、照发
> pdiff，但客户端 buildTime 一变仍清状态回内置包再白下载一遍；hash 优先后
> 同 JS 重打包做到真正无感。§5.2 的 digests/copies 摘要照旧待做；§5.3 的
> 降级序列与"删构建注入"**取消**。
>
> 现状（2026-10）：未开始——`cpp/patch_core/state_core.cpp` 的 `SyncBinaryVersion`
> 仍按 `(packageVersion, buildTime)` 比较。

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
      正常比较 (packageVersion, bundleHash || buildTime)
```

即"首次遇到旧格式状态时，认领它而不是否决它"。这是纯函数逻辑，落在 `cpp/patch_core/state_core.cpp`，可以直接单测覆盖。schema 版本号不可回退，需谨慎发布。

### 5.2 其余收尾

- 下载产物 `digests` 校验（IO-6 本体）
- apply 时 copies 摘要校验 → 不符即 fallback full，**永不装出坏包**
- ~~删除 `pushy_build_time` 构建注入~~ 取消（见上方定位修订）

### 5.3 ~~buildTime 的降级顺序~~

取消（见上方定位修订）。

---

## 6. 风险（仍相关的）

| # | 风险 | 处置 |
|---|---|---|
| R1 | 客户端与 CLI 哈希了不同的文件 | §0：两侧都复用已有的 pdiff 源解析逻辑；e2e 逐字节比对（§2.7） |
| R2 | 服务端缓存串响应 | §4.1，缓存键已含 bundleHash |
| R3 | Phase 3 的状态迁移抹掉全网热更 | §5.1 的 schema 版本号；纯函数，单测覆盖 |
| R5 | 自定义 bundle 名 / Expo / use_frameworks 下客户端定位不到文件 | 返回空串 → 退回 buildTime 启发式，不比现状差；三处一致硬编码（§0） |
| R7 | "重打包但 JS 未变"行下发的 pdiff 因包内资源漂移而 apply 失败 | §4.2.1：apply 时校验 + fallback full + 遥测 |
