import { by, device, element, waitFor } from 'detox';

// Debug 构建启动冒烟:只验证 app 能进首屏。codegen 生成的 Java spec 里
// 常量校验等检查包在 ReactBuildConfig.DEBUG 内,release e2e 全绿也拦不住
// (如 v10.48.2 修的 "Native Module Flow doesn't declare constants")。
// 首屏渲染前必须过 getConstants,崩了 bundle-label 永远不会出现。
// CI 上 metro 冷启动首次出 dev bundle 可能要几分钟,超时给足。
const BOOT_TIMEOUT = 300000;

describe('debug build boot smoke', () => {
  it('boots to the first screen', async () => {
    await device.launchApp({
      newInstance: true,
      ...(device.getPlatform() === 'android'
        ? { launchArgs: { detoxEnableSynchronization: '0' } }
        : {}),
    });

    await waitFor(element(by.id('bundle-label')))
      .toBeVisible()
      .withTimeout(BOOT_TIMEOUT);
  });
});
