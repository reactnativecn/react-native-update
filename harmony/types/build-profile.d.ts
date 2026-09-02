// Type stub for the hvigor-generated BuildProfile module (see
// pushy/src/main/ets/BuildFlags.ts). The real file is emitted per build under
// <module>/build/default/generated/profile/<target>/BuildProfile.ets and
// resolved by the ArkTS toolchain; plain tsc only sees this declaration.
declare module 'BuildProfile' {
  export const HAR_VERSION: string;
  export const BUILD_MODE_NAME: string;
  export const DEBUG: boolean;
  export const TARGET_NAME: string;
  export default class BuildProfile {
    static readonly HAR_VERSION: string;
    static readonly BUILD_MODE_NAME: string;
    static readonly DEBUG: boolean;
    static readonly TARGET_NAME: string;
  }
}
