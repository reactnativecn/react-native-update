# HarmonyOS e2e

基于 `hdc + uitest` 的轻量驱动（`../harness/harmony-driver.ts`），不依赖 Detox。
被测 App 是 `Example/harmony_use_pushy`（RN 0.72——RNOH 尚不支持 e2etest 的 RN
版本），以 `e2e/entry.base.ts` 为入口构建，UI 与 e2etest 的 `src/index.tsx`
对齐（testID：`bundle-label` / `check-update` / `current-hash` 等）。

定位方式：RNOH 会把 RN 的 `testID` 透传为 ArkUI 节点 `id`（`uitest dumpLayout`
可见）；断言用可见文本（ArkUI 的 `checked`/`selected` 属性不反映 RN 状态）。

## 运行

```bash
# 全套（会先跑 prepare 重新生成 v1/v2/diff 产物并起本地服务器）
npm run test:e2e:harmony

# 跳过产物生成（产物已就绪时迭代更快）
RNU_E2E_SKIP_PREPARE=true npm run test:e2e:harmony
```

套件：`local-update.test.ts`（完整更新流：BINARY_BASE → v1 全量 → v2 ppk 差量 →
重启持久化 → upToDate）；`smoke.test.ts`（驱动自检）。

## 前置条件

1. **模拟器/真机**在 `hdc list targets` 中可见。命令行启动模拟器：

   ```bash
   nohup /Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator \
     -hvd api20 -path ~/.Huawei/Emulator/deployed -imageRoot ~/Library/Huawei/Sdk &
   ```

   必须显式传 `-imageRoot`（实例 config.ini 的 sdkPath 可能指向失效路径）；
   启动即退且日志报 hdc 超时时，先 kill 残留的旧 hdc server。

2. **基座 hap** 已安装（bundle 默认 `com.charmlot.testpushy`，可用
   `RNU_HARMONY_BUNDLE_NAME` 覆盖）。一条命令完成（本地 har → 换包 →
   刷新 oh_modules → 产物 → 基座 bundle → 出签名包 → 安装）：

   ```bash
   # 仓库根目录；SKIP_HAR=true 跳过 har 重建，SKIP_INSTALL=true 只构建不安装
   npm run build:harmony-e2e
   ```

   脚本：`scripts/build-harmony-e2e.sh`，各步骤的顺序约束和原因见脚本头注释。

3. **签名**：`build-profile.json5` 引用 `~/.ohos/config` 下的自动签名材料。
   调试 profile 与 bundleName 绑定——改 bundleName 后必须在 DevEco 重新自动
   签名，否则 SignHap 报 00303074。

## 已知坑（都踩过）

- `pushy bundle --platform harmony` 会把工程的 `rawfile/bundle.harmony.js`
  当中间产物**覆写**——产物准备必须在基座 bundle 之前跑。
- ohpm 对 `file:` har 依赖有内容哈希缓存，har 重建后 hvigor 不会自动刷新
  `oh_modules`（会一直用旧 har）——删 `oh_modules` + `entry/oh_modules` 后
  `ohpm install --all`。
- 换签名证书后 `hdc install -r` 报 9568332 sign info inconsistent，必须先
  `hdc uninstall`。
- hdc 的 rport 映射在连接重握手后**静默丢失**；driver 的 `rport()` 幂等，
  测试 beforeAll 每次重建。重复建立时 hdc 输出 `[Fail]TCP Port listen failed`
  =已存在，非错误。
- `uitest uiInput click` 成功输出 `No Error`。
- npm 版 10.39.1 的 `joinUrls` 会给已含 scheme 的 paths 再拼 `https://`，
  连不上本地 http 服务器（报 Couldn't resolve host name）——必须用本地
  react-native-update（仓库代码已修复）。

## CI

workflow 已写好：`.github/workflows/e2e_harmony.yml`（仅 `workflow_dispatch`
触发，**尚未启用**——需要先注册一台自托管 runner，labels:
`self-hosted, macOS, harmony`，机器准备事项见 workflow 头注释）。

GitHub 托管 runner 跑不了：Linux 无鸿蒙模拟器；macOS/Windows 托管 runner
无嵌套虚拟化（模拟器在 Windows 上还明确拒绝 VM 环境）；模拟器镜像需华为
账号在 DevEco 内下载，临时环境无法自动供给。
