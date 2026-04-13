# e2etest

`e2etest` 是专门给 Detox 用的 React Native example，不承担手工演示职责。

验证链路固定为：

- 本地 `react-native-update-cli` 生成全量包、`diff` 和 Android `pdiff`
- 本地 Bun server 提供 `checkUpdate` 接口和静态产物
- App 侧 `Pushy` client 直接指向本地 endpoint
- `checkUpdate + silentAndNow` 触发自动下载和切包

常用命令：

```sh
bun install
detox build --configuration ios.sim.release
E2E_PLATFORM=ios detox test --configuration ios.sim.release
```

```sh
bun install
detox build --configuration android.emu.release
E2E_PLATFORM=android detox test --configuration android.emu.release --headless --record-logs all
```

架构需要跟 AVD 保持一致：Apple Silicon 本地的 `api34` AVD 和 ARM CI
comparison job 用 `arm64-v8a`；GitHub `ubuntu-latest` x64 job 用
`x86_64` emulator 和 `DETOX_ANDROID_ARCHS=x86_64`。
