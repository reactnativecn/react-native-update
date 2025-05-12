type EventCallback = (data: any) => void;

export class EventHub {
  private static instance: EventHub;
  private listeners: Map<string, Set<EventCallback>>;
  private rnInstance: any;

  private constructor() {
    this.listeners = new Map();
  }

  public static getInstance(): EventHub {
    if (!EventHub.instance) {
      EventHub.instance = new EventHub();
    }
    return EventHub.instance;
  }

  public on(event: string, callback: EventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(callback);
  }

  public off(event: string, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  public emit(event: string, data: any): void {
    if (this.rnInstance) {
      this.rnInstance.emitDeviceEvent(event, data);
    }
  }

  setRNInstance(instance: any) {
    this.rnInstance = instance;
  }
}