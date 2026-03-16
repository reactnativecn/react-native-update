import preferences from '@ohos.data.preferences';
import bundleManager from '@ohos.bundle.bundleManager';
import fileIo from '@ohos.file.fs';
import common from '@ohos.app.ability.common';
import { util } from '@kit.ArkTS';
import { DownloadTask } from './DownloadTask';
import { DownloadTaskParams } from './DownloadTaskParams';

type LaunchMarks = {
  isFirstTime: boolean;
  rolledBackVersion: string;
};

export class UpdateContext {
  private static instances: Map<string, UpdateContext> = new Map();
  private static isUsingBundleUrl: boolean = false;
  private static ignoreRollbackInCurrentProcess: boolean = false;

  static getInstance(context: common.UIAbilityContext): UpdateContext {
    const key = context.filesDir;
    const cached = UpdateContext.instances.get(key);
    if (cached) {
      return cached;
    }

    const instance = new UpdateContext(context);
    UpdateContext.instances.set(key, instance);
    return instance;
  }

  private context: common.UIAbilityContext;
  private rootDir: string;
  private preferences: preferences.Preferences;

  private constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.rootDir = `${context.filesDir}/_update`;
    this.ensureRootDir();
    this.initPreferences();
  }

  private ensureRootDir(): void {
    try {
      if (!fileIo.accessSync(this.rootDir)) {
        fileIo.mkdirSync(this.rootDir);
      }
    } catch (error) {
      console.error('Failed to create root directory:', error);
    }
  }

  private initPreferences(): void {
    try {
      this.preferences = preferences.getPreferencesSync(this.context, {
        name: 'update',
      });

      const packageVersion = this.getPackageVersion();
      const buildTime = this.getBuildTime();
      const storedPackageVersion = this.getStringPreference('packageVersion');
      const storedBuildTime = this.getStringPreference('buildTime');
      const packageVersionChanged =
        !!storedPackageVersion && packageVersion !== storedPackageVersion;
      const buildTimeChanged =
        !!storedBuildTime && buildTime !== storedBuildTime;

      if (packageVersionChanged || buildTimeChanged) {
        this.scheduleCleanUp();
        this.preferences.clear();
        UpdateContext.ignoreRollbackInCurrentProcess = false;
      }

      let shouldFlush = packageVersionChanged || buildTimeChanged;
      if (this.getStringPreference('packageVersion') !== packageVersion) {
        this.preferences.putSync('packageVersion', packageVersion);
        shouldFlush = true;
      }
      if (this.getStringPreference('buildTime') !== buildTime) {
        this.preferences.putSync('buildTime', buildTime);
        shouldFlush = true;
      }

      if (shouldFlush) {
        this.preferences.flush();
      }
    } catch (error) {
      console.error('Failed to init preferences:', error);
    }
  }

  private getStringPreference(key: string, fallback: string = ''): string {
    const value = this.preferences.getSync(key, fallback);
    if (typeof value === 'string') {
      return value;
    }
    if (value === null || value === undefined) {
      return fallback;
    }
    return String(value);
  }

  private getBooleanPreference(
    key: string,
    fallback: boolean = false,
  ): boolean {
    const value = this.preferences.getSync(key, fallback);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false' || normalized === '') {
        return false;
      }
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    return fallback;
  }

  private scheduleCleanUp(): void {
    void this.cleanUp().catch(error => {
      console.error('Failed to clean up updates:', error);
    });
  }

  public getRootDir(): string {
    return this.rootDir;
  }

  public setKv(key: string, value: string): void {
    this.preferences.putSync(key, value);
    this.preferences.flush();
  }

  public getKv(key: string): string {
    return this.getStringPreference(key);
  }

  public isFirstTime(): boolean {
    return this.getBooleanPreference('firstTime', false);
  }

  public rolledBackVersion(): string {
    return this.getStringPreference('rolledBackVersion');
  }

  public consumeLaunchMarks(): LaunchMarks {
    const marks = {
      isFirstTime: this.getBooleanPreference('firstTimeMarked', false),
      rolledBackVersion: this.rolledBackVersion(),
    };

    if (marks.isFirstTime) {
      this.preferences.deleteSync('firstTimeMarked');
    }
    if (marks.rolledBackVersion) {
      this.preferences.deleteSync('rolledBackVersion');
    }
    if (marks.isFirstTime || marks.rolledBackVersion) {
      this.preferences.flush();
      this.scheduleCleanUp();
    }

    return marks;
  }

  public markSuccess(): void {
    this.preferences.putSync('firstTimeOk', true);
    const lastVersion = this.getStringPreference('lastVersion');
    const currentVersion = this.getStringPreference('currentVersion');

    if (lastVersion && lastVersion !== currentVersion) {
      this.preferences.deleteSync('lastVersion');
      this.preferences.deleteSync(`hash_${lastVersion}`);
    }

    this.preferences.flush();
    this.scheduleCleanUp();
  }

  public clearFirstTime(): void {
    this.preferences.putSync('firstTime', false);
    this.preferences.deleteSync('firstTimeMarked');
    this.preferences.flush();
    this.scheduleCleanUp();
  }

  public clearRollbackMark(): void {
    this.preferences.deleteSync('rolledBackVersion');
    this.preferences.flush();
    this.scheduleCleanUp();
  }

  public async downloadFullUpdate(url: string, hash: string): Promise<void> {
    try {
      const params = new DownloadTaskParams();
      params.type = DownloadTaskParams.TASK_TYPE_PATCH_FULL;
      params.url = url;
      params.hash = hash;
      params.targetFile = `${this.rootDir}/${hash}.ppk`;
      params.unzipDirectory = `${this.rootDir}/${hash}`;
      const downloadTask = new DownloadTask(this.context);
      await downloadTask.execute(params);
    } catch (error) {
      console.error('Failed to download full update:', error);
      throw error;
    }
  }

  public async downloadFile(
    url: string,
    hash: string,
    fileName: string,
  ): Promise<void> {
    const params = new DownloadTaskParams();
    params.type = DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD;
    params.url = url;
    params.hash = hash;
    params.targetFile = `${this.rootDir}/${fileName}`;

    const downloadTask = new DownloadTask(this.context);
    await downloadTask.execute(params);
  }

  public async downloadPatchFromPpk(
    url: string,
    hash: string,
    originHash: string,
  ): Promise<void> {
    const params = new DownloadTaskParams();
    params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
    params.url = url;
    params.hash = hash;
    params.originHash = originHash;
    params.targetFile = `${this.rootDir}/${originHash}_${hash}.ppk.patch`;
    params.unzipDirectory = `${this.rootDir}/${hash}`;
    params.originDirectory = `${this.rootDir}/${params.originHash}`;

    const downloadTask = new DownloadTask(this.context);
    await downloadTask.execute(params);
  }

  public async downloadPatchFromPackage(
    url: string,
    hash: string,
  ): Promise<void> {
    try {
      const params = new DownloadTaskParams();
      params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP;
      params.url = url;
      params.hash = hash;
      params.targetFile = `${this.rootDir}/${hash}.app.patch`;
      params.unzipDirectory = `${this.rootDir}/${hash}`;

      const downloadTask = new DownloadTask(this.context);
      await downloadTask.execute(params);
    } catch (error) {
      console.error('Failed to download package patch:', error);
      throw error;
    }
  }

  public switchVersion(hash: string): void {
    try {
      const bundlePath = `${this.rootDir}/${hash}/bundle.harmony.js`;
      if (!fileIo.accessSync(bundlePath)) {
        throw Error(`Bundle version ${hash} not found.`);
      }

      const lastVersion = this.getCurrentVersion();
      this.preferences.putSync('currentVersion', hash);
      if (lastVersion && lastVersion !== hash) {
        this.preferences.putSync('lastVersion', lastVersion);
      } else {
        this.preferences.deleteSync('lastVersion');
      }
      this.preferences.putSync('firstTime', true);
      this.preferences.putSync('firstTimeOk', false);
      this.preferences.deleteSync('firstTimeMarked');
      this.preferences.deleteSync('rolledBackVersion');
      this.preferences.flush();
      UpdateContext.ignoreRollbackInCurrentProcess = false;
    } catch (error) {
      console.error('Failed to switch version:', error);
      throw error;
    }
  }

  public getBundleUrl(): string {
    UpdateContext.isUsingBundleUrl = true;
    let version = this.getCurrentVersion();
    if (!version) {
      return '';
    }

    const isFirstTime = this.isFirstTime();
    const isFirstTimeOk = this.getBooleanPreference('firstTimeOk', true);
    if (
      !UpdateContext.ignoreRollbackInCurrentProcess &&
      !isFirstTime &&
      !isFirstTimeOk
    ) {
      version = this.rollBack();
    } else if (isFirstTime && !UpdateContext.ignoreRollbackInCurrentProcess) {
      UpdateContext.ignoreRollbackInCurrentProcess = true;
      this.preferences.putSync('firstTime', false);
      this.preferences.putSync('firstTimeMarked', true);
      this.preferences.flush();
    }

    while (version) {
      const bundleFile = `${this.rootDir}/${version}/bundle.harmony.js`;
      try {
        if (!fileIo.accessSync(bundleFile)) {
          console.error(`Bundle version ${version} not found.`);
          version = this.rollBack();
          continue;
        }
        return bundleFile;
      } catch (error) {
        console.error('Failed to access bundle file:', error);
        version = this.rollBack();
      }
    }

    return '';
  }

  public getPackageVersion(): string {
    let packageVersion = '';
    try {
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION,
      );
      packageVersion = bundleInfo?.versionName || 'Unknown';
    } catch (error) {
      console.error('Failed to get bundle info:', error);
    }
    return packageVersion;
  }

  public getBuildTime(): string {
    try {
      const content =
        this.context.resourceManager.getRawFileContentSync('meta.json');
      const metaData = JSON.parse(
        new util.TextDecoder().decodeToString(content),
      ) as {
        pushy_build_time?: string | number;
      };
      if (metaData.pushy_build_time !== undefined) {
        return String(metaData.pushy_build_time);
      }
    } catch {}
    return '';
  }

  public getCurrentVersion(): string {
    return this.getStringPreference('currentVersion');
  }

  private rollBack(): string {
    const lastVersion = this.getStringPreference('lastVersion');
    const currentVersion = this.getCurrentVersion();

    if (!lastVersion) {
      this.preferences.deleteSync('currentVersion');
    } else {
      this.preferences.deleteSync('lastVersion');
      this.preferences.putSync('currentVersion', lastVersion);
    }
    this.preferences.putSync('firstTimeOk', true);
    this.preferences.putSync('firstTime', false);
    this.preferences.deleteSync('firstTimeMarked');
    this.preferences.putSync('rolledBackVersion', currentVersion);
    this.preferences.flush();
    return lastVersion;
  }

  public async cleanUp(): Promise<void> {
    const params = new DownloadTaskParams();
    params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
    params.hash = this.getCurrentVersion();
    params.originHash = this.getStringPreference('lastVersion');
    params.unzipDirectory = this.rootDir;
    const downloadTask = new DownloadTask(this.context);
    await downloadTask.execute(params);
  }

  public getIsUsingBundleUrl(): boolean {
    return UpdateContext.isUsingBundleUrl;
  }
}
