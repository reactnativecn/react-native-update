import BuildProfile from 'BuildProfile';

// hvigor 为每个模块生成 BuildProfile(DevEco 5.0+:build/.../BuildProfile.ets,
// 以模块名 'BuildProfile' 引用):DEBUG 反映的是本 HAR 自身的构建模式。发布的
// HAR 由 CI 以 release 构建,所以正式包里恒为 false;本地 debug 构建的 HAR 与
// Android 的 debug 库行为对齐(markSuccess 空转、不算内嵌 bundle 摘要)。
//
// 守卫:老工具链/测试宿主里 BuildProfile 形状不符时返回 undefined,调用方
// 回退到宿主给的标志(UpdateContext.getInstance 的参数)。
interface BuildProfileLike {
  DEBUG?: boolean;
}

export function readBuildProfileDebug(): boolean | undefined {
  try {
    const profile = BuildProfile as unknown as BuildProfileLike | undefined;
    return profile && typeof profile.DEBUG === 'boolean'
      ? profile.DEBUG
      : undefined;
  } catch (e) {
    return undefined;
  }
}
