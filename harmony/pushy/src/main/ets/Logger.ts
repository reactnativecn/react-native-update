import hilog from '@ohos.hilog';
import { readBuildProfileDebug } from './BuildFlags';

class Logger {
  private domain: number;
  private prefix: string;
  private format: string = '%{public}s,%{public}s';
  private isDebug: boolean;

  constructor(
    prefix: string = 'MyApp',
    domain: number = 0xff00,
    isDebug = false,
  ) {
    this.prefix = prefix;
    this.domain = domain;
    this.isDebug = isDebug;
  }

  // debug 级别默认跟随本 HAR 的构建模式(BuildProfile.DEBUG,见 BuildFlags);
  // 宿主处于 RN 调试模式(RNOH isDebugModeEnabled)时由 TurboModule 在启动时
  // 打开,方便接入调试。info/warn/error 永远输出。
  setDebug(enabled: boolean): void {
    this.isDebug = enabled;
  }

  private tagOf(args: string[]): string {
    return args.length > 0 ? args[0] : '';
  }

  private messageOf(args: string[]): string {
    return args.length > 1 ? args.slice(1).join(' ') : '';
  }

  debug(...args: string[]): void {
    if (this.isDebug) {
      hilog.debug(
        this.domain,
        this.prefix,
        this.format,
        this.tagOf(args),
        this.messageOf(args),
      );
    }
  }

  info(...args: string[]): void {
    hilog.info(
      this.domain,
      this.prefix,
      this.format,
      this.tagOf(args),
      this.messageOf(args),
    );
  }

  warn(...args: string[]): void {
    hilog.warn(
      this.domain,
      this.prefix,
      this.format,
      this.tagOf(args),
      this.messageOf(args),
    );
  }

  error(...args: string[]): void {
    hilog.error(
      this.domain,
      this.prefix,
      this.format,
      this.tagOf(args),
      this.messageOf(args),
    );
  }
}

export default new Logger('pushy', 0xff00, readBuildProfileDebug() ?? false);
