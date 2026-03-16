import hilog from '@ohos.hilog';

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

  private normalizeArgs(args: string[]): [string, string] {
    if (args.length === 0) {
      return ['', ''];
    }
    if (args.length === 1) {
      return [args[0], ''];
    }
    return [args[0], args.slice(1).join(' ')];
  }

  debug(...args: string[]): void {
    if (this.isDebug) {
      const [tag, message] = this.normalizeArgs(args);
      hilog.debug(this.domain, this.prefix, this.format, tag, message);
    }
  }

  info(...args: string[]): void {
    const [tag, message] = this.normalizeArgs(args);
    hilog.info(this.domain, this.prefix, this.format, tag, message);
  }

  warn(...args: string[]): void {
    const [tag, message] = this.normalizeArgs(args);
    hilog.warn(this.domain, this.prefix, this.format, tag, message);
  }

  error(...args: string[]): void {
    const [tag, message] = this.normalizeArgs(args);
    hilog.error(this.domain, this.prefix, this.format, tag, message);
  }
}

export default new Logger('pushy', 0xff00, false);
