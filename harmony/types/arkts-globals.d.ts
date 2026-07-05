// Minimal ambient declarations for ArkTS runtime globals used by the pushy
// sources. In real builds these are injected by ets-loader (see the SDK's
// api/@internal/full/global.d.ts, which is module-scoped and thus not usable
// directly as an ambient lib for plain tsc).
declare class console {
  static debug(message: string, ...arguments: any[]): void;
  static log(message: string, ...arguments: any[]): void;
  static info(message: string, ...arguments: any[]): void;
  static warn(message: string, ...arguments: any[]): void;
  static error(message: string, ...arguments: any[]): void;
}

declare function setTimeout(
  handler: Function | string,
  delay?: number,
  ...arguments: any[]
): number;
declare function clearTimeout(timeoutID?: number): void;
declare function setInterval(
  handler: Function | string,
  delay: number,
  ...arguments: any[]
): number;
declare function clearInterval(intervalID?: number): void;
