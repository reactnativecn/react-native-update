// Minimal type stub for the RNOH surface consumed by the pushy sources.
// The vendored RNOH sources in oh_modules do not type-check under plain tsc
// (they rely on ets-loader-injected globals and looser syntax rules), so the
// harmony type check declares just the symbols we actually use. Keep this in
// sync with @rnoh/react-native-openharmony/ts when new symbols are imported.
declare module '@rnoh/react-native-openharmony/ts' {
  import type common from '@ohos.app.ability.common';

  export interface RNInstance {
    emitDeviceEvent(eventName: string, payload: unknown): void;
  }

  export interface UITurboModuleContext {
    uiAbilityContext: common.UIAbilityContext;
    rnInstance: RNInstance;
    isDebugModeEnabled: boolean;
  }

  export class UITurboModule {
    protected ctx: UITurboModuleContext;
    constructor(ctx: UITurboModuleContext);
  }

  export abstract class RNPackage {
    getUITurboModuleFactoryByNameMap(): Map<
      string,
      (ctx: UITurboModuleContext) => UITurboModule | null
    >;
  }
}
