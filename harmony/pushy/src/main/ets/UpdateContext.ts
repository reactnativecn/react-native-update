import preferences from '@ohos.data.preferences';
import bundleManager from '@ohos.bundle.bundleManager';
import fileIo from '@ohos.file.fs';
import { DownloadTask } from './DownloadTask';
import common from '@ohos.app.ability.common';
import { DownloadTaskParams } from './DownloadTaskParams';

export class UpdateContext {
  private context: common.UIAbilityContext;
  private rootDir: string;
  private preferences: preferences.Preferences;
  private static DEBUG: boolean = false;
  private static isUsingBundleUrl: boolean = false;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.rootDir = context.filesDir + '/_update';

    try {
      if (!fileIo.accessSync(this.rootDir)) {
        fileIo.mkdirSync(this.rootDir);
      }
    } catch (e) {
      console.error('Failed to create root directory:', e);
    }
    this.initPreferences();
  }

  private initPreferences() {
    try {
      this.preferences = preferences.getPreferencesSync(this.context, {
        name: 'update',
      });
      const packageVersion = this.getPackageVersion();
      const storedVersion = this.preferences.getSync('packageVersion', '');
      if (!storedVersion) {
        this.preferences.putSync('packageVersion', packageVersion);
        this.preferences.flush();
      } else if (storedVersion && packageVersion !== storedVersion) {
        this.cleanUp();
        this.preferences.clear();
        this.preferences.putSync('packageVersion', packageVersion);
        this.preferences.flush();
      }
    } catch (e) {
      console.error('Failed to init preferences:', e);
    }
  }

  public setKv(key: string, value: string): void {
    this.preferences.putSync(key, value);
    this.preferences.flush();
  }

  public getKv(key: string): string {
    return this.preferences.getSync(key, '') as string;
  }

  public isFirstTime(): boolean {
    return this.preferences.getSync('firstTime', false) as boolean;
  }

  public rolledBackVersion(): string {
    return this.preferences.getSync('rolledBackVersion', '') as string;
  }

  public markSuccess(): void {
    this.preferences.putSync('firstTimeOk', true);
    const lastVersion = this.preferences.getSync('lastVersion', '') as string;
    const curVersion = this.preferences.getSync('currentVersion', '') as string;

    if (lastVersion && lastVersion !== curVersion) {
      this.preferences.deleteSync('lastVersion');
      this.preferences.deleteSync(`hash_${lastVersion}`);
    }
    this.preferences.flush();
    this.cleanUp();
  }

  public clearFirstTime(): void {
    this.preferences.putSync('firstTime', false);
    this.preferences.flush();
    this.cleanUp();
  }

  public clearRollbackMark(): void {
    this.preferences.putSync('rolledBackVersion', null);
    this.preferences.flush();
    this.cleanUp();
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
    } catch (e) {
      console.error('Failed to download full update:', e);
      throw e;
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
    params.targetFile = this.rootDir + '/' + fileName;

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
      return await downloadTask.execute(params);
    } catch (e) {
      console.error('Failed to download package patch:', e);
      throw e;
    }
  }

  public switchVersion(hash: string): void {
    try {
      const bundlePath = `${this.rootDir}/${hash}/bundle.harmony.js`;
      if (!fileIo.accessSync(bundlePath)) {
        throw Error(`Bundle version ${hash} not found.`);
      }

      const lastVersion = this.getKv('currentVersion');
      this.setKv('currentVersion', hash);
      if (lastVersion && lastVersion !== hash) {
        this.setKv('lastVersion', lastVersion);
      }

      this.setKv('firstTime', 'true');
      this.setKv('firstTimeOk', 'false');
      this.setKv('rolledBackVersion', '');
    } catch (e) {
      console.error('Failed to switch version:', e);
      throw e;
    }
  }

  public getBundleUrl() {
    UpdateContext.isUsingBundleUrl = true;
    const currentVersion = this.getCurrentVersion();
    if (!currentVersion) {
      return '';
    }
    if (!this.isFirstTime()) {
      if (!this.preferences.getSync('firstTimeOk', true)) {
        return this.rollBack();
      }
    }
    let version = currentVersion;
    while (version) {
      const bundleFile = `${this.rootDir}/${version}/bundle.harmony.js`;
      try {
        if (!fileIo.accessSync(bundleFile)) {
          console.error(`Bundle version ${version} not found.`);
          version = this.rollBack();
          continue;
        }
        return bundleFile;
      } catch (e) {
        console.error('Failed to access bundle file:', e);
        version = this.rollBack();
      }
    }
    return '';
  }

  getPackageVersion(): string {
    let bundleFlags =
      bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION;
    let packageVersion = '';
    try {
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleFlags);
      packageVersion = bundleInfo?.versionName || 'Unknown';
    } catch (error) {
      console.error('获取包信息失败:', error);
    }
    return packageVersion;
  }

  public getCurrentVersion(): string {
    const currentVersion = this.getKv('currentVersion');
    return currentVersion;
  }

  private rollBack(): string {
    const lastVersion = this.preferences.getSync('lastVersion', '') as string;
    const currentVersion = this.preferences.getSync(
      'currentVersion',
      '',
    ) as string;
    if (!lastVersion) {
      this.preferences.deleteSync('currentVersion');
    } else {
      this.preferences.deleteSync('lastVersion');
      this.preferences.putSync('currentVersion', lastVersion);
    }
    this.preferences.putSync('firstTimeOk', true);
    this.preferences.putSync('firstTime', false);
    this.preferences.putSync('rolledBackVersion', currentVersion);
    this.preferences.flush();
    return lastVersion;
  }

  private cleanUp(): void {
    const params = new DownloadTaskParams();
    params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
    params.hash = this.preferences.getSync('currentVersion', '') as string;
    params.originHash = this.preferences.getSync('lastVersion', '') as string;
    params.unzipDirectory = this.rootDir;
    const downloadTask = new DownloadTask(this.context);
    downloadTask.execute(params);
  }

  public getIsUsingBundleUrl(): boolean {
    return UpdateContext.isUsingBundleUrl;
  }
}
