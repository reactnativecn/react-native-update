// The subset of RNOH's RNInstance the SDK needs: device events for download
// progress. Typed structurally so the hypium tests can pass a mock.
export interface DeviceEventEmitter {
  emitDeviceEvent(eventName: string, payload: Object): void;
}

export class EventHub {
  private static instance: EventHub;
  // 指向最近一次构造 TurboModule 的 RNInstance:RNOH 重建 RN 实例时会构造
  // 新的 TurboModule 并在此替换,已销毁实例上的 emit 由 RNOH 自行忽略。
  private rnInstance: DeviceEventEmitter | undefined = undefined;

  private constructor() {}

  public static getInstance(): EventHub {
    if (!EventHub.instance) {
      EventHub.instance = new EventHub();
    }
    return EventHub.instance;
  }

  public emit(event: string, data: Object): void {
    if (this.rnInstance) {
      this.rnInstance.emitDeviceEvent(event, data);
    }
  }

  setRNInstance(instance: DeviceEventEmitter | undefined): void {
    this.rnInstance = instance;
  }

  /**
   * TurboModule 销毁时调用:只在仍指向该实例时清除——RNOH 重建 RN 实例时
   * 新 TurboModule 可能先于旧实例的销毁回调构造,不能把新引用一并清掉。
   */
  clearRNInstance(instance: DeviceEventEmitter | undefined): void {
    if (instance !== undefined && this.rnInstance === instance) {
      this.rnInstance = undefined;
    }
  }
}
