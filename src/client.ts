import { CheckResult, ClientOptions, ProgressData, EventType } from './type';
import {
  assertDev,
  assertWeb,
  emptyObj,
  joinUrls,
  log,
  noop,
  promiseAny,
  testUrls,
} from './utils';
import {
  EmitterSubscription,
  Platform,
  DeviceEventEmitter,
} from 'react-native';
import { PermissionsAndroid } from './permissions';
import {
  PushyModule,
  buildTime,
  cInfo,
  pushyNativeEventEmitter,
  currentVersion,
  packageVersion,
  rolledBackVersion,
  setLocalHashInfo,
  isFirstTime,
  isRolledBack,
  getCurrentVersionInfo,
} from './core';

const SERVER_PRESETS = {
  // cn
  Pushy: {
    main: 'https://update.react-native.cn/api',
    backups: ['https://update.reactnative.cn/api'],
    queryUrls: [
      'https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json',
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json',
    ],
  },
  // i18n
  Cresc: {
    main: 'https://api.cresc.dev',
    backups: ['https://api.cresc.app'],
    queryUrls: [
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints_cresc.json',
    ],
  },
};

assertWeb();

const defaultClientOptions: ClientOptions = {
  appKey: '',
  autoMarkSuccess: true,
  updateStrategy: __DEV__ ? 'alwaysAlert' : 'alertUpdateAndIgnoreError',
  checkStrategy: 'both',
  logger: noop,
  debug: false,
  throwError: false,
};

// for China users
export class Pushy {
  options = defaultClientOptions;
  clientType: 'Pushy' | 'Cresc' = 'Pushy';
  lastChecking?: number;
  lastRespJson?: Promise<any>;

  static progressHandlers: Record<string, EmitterSubscription> = {};
  static downloadedHash?: string;

  static apkStatus: 'downloading' | 'downloaded' | null = null;

  static marked = false;
  static applyingUpdate = false;
  version = cInfo.rnu;
  loggerPromise = (() => {
    let resolve: (value?: unknown) => void = () => {};
    const promise = new Promise(res => {
      resolve = res;
    });
    return {
      promise,
      resolve,
    };
  })();

  constructor(options: ClientOptions, clientType?: 'Pushy' | 'Cresc') {
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      if (!options.appKey) {
        throw new Error('appKey is required');
      }
    }
    this.clientType = clientType || 'Pushy';
    this.options.server = SERVER_PRESETS[this.clientType];
    this.setOptions(options);
    if (isRolledBack) {
      this.report({
        type: 'rollback',
        data: {
          rolledBackVersion,
        },
      });
    }
  }

  setOptions = (options: Partial<ClientOptions>) => {
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        (this.options as any)[key] = value;
        if (key === 'logger') {
          this.loggerPromise.resolve();
        }
      }
    }
  };

  report = async ({
    type,
    message = '',
    data = {},
  }: {
    type: EventType;
    message?: string;
    data?: Record<string, string | number>;
  }) => {
    log(type + ' ' + message);
    await this.loggerPromise.promise;
    const { logger = noop, appKey } = this.options;
    const info = await getCurrentVersionInfo();
    logger({
      type,
      data: {
        appKey,
        currentVersion,
        cInfo,
        packageVersion,
        buildTime,
        message,
        ...info,
        ...data,
      },
    });
  };
  throwIfEnabled = (e: Error) => {
    if (this.options.throwError) {
      throw e;
    }
  };
  getCheckUrl = (endpoint: string = this.options.server!.main) => {
    return `${endpoint}/checkUpdate/${this.options.appKey}`;
  };
  static assertHash = (hash: string) => {
    if (!this.downloadedHash) {
      return;
    }
    if (hash !== this.downloadedHash) {
      log(`use downloaded hash ${Pushy.downloadedHash} first`);
      return;
    }
    return true;
  };
  assertDebug = () => {
    if (__DEV__ && !this.options.debug) {
      console.info(
        'You are currently in the development environment and have not enabled debug mode. The hot update check will not be performed. If you need to debug hot updates in the development environment, please set debug to true in the client.',
      );
      return false;
    }
    return true;
  };
  markSuccess = () => {
    if (Pushy.marked || __DEV__ || !isFirstTime) {
      return;
    }
    Pushy.marked = true;
    PushyModule.markSuccess();
    this.report({ type: 'markSuccess' });
  };
  switchVersion = async (hash: string) => {
    if (!assertDev('switchVersion()')) {
      return;
    }
    if (Pushy.assertHash(hash) && !Pushy.applyingUpdate) {
      log('switchVersion: ' + hash);
      Pushy.applyingUpdate = true;
      return PushyModule.reloadUpdate({ hash });
    }
  };

  switchVersionLater = async (hash: string) => {
    if (!assertDev('switchVersionLater()')) {
      return;
    }
    if (Pushy.assertHash(hash)) {
      log('switchVersionLater: ' + hash);
      return PushyModule.setNeedUpdate({ hash });
    }
  };
  checkUpdate = async (extra?: Record<string, any>) => {
    if (!this.assertDebug()) {
      return;
    }
    if (!assertWeb()) {
      return;
    }
    if (
      this.options.beforeCheckUpdate &&
      (await this.options.beforeCheckUpdate()) === false
    ) {
      log('beforeCheckUpdate returned false, skipping check');
      return;
    }
    const now = Date.now();
    if (
      this.lastRespJson &&
      this.lastChecking &&
      now - this.lastChecking < 1000 * 5
    ) {
      return await this.lastRespJson;
    }
    this.lastChecking = now;
    const fetchBody = {
      packageVersion,
      hash: currentVersion,
      buildTime,
      cInfo,
      ...extra,
    };
    if (__DEV__) {
      // @ts-ignore
      delete fetchBody.buildTime;
    }
    const stringifyBody = JSON.stringify(fetchBody);
    // harmony fetch body is not string
    let body: any = fetchBody;
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      body = stringifyBody;
    }
    const fetchPayload = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body,
    };
    let resp;
    try {
      this.report({
        type: 'checking',
        message: this.options.appKey + ': ' + stringifyBody,
      });
      resp = await fetch(this.getCheckUrl(), fetchPayload);
    } catch (e: any) {
      this.report({
        type: 'errorChecking',
        message: `Can not connect to update server: ${e.message}. Trying backup endpoints.`,
      });
      const backupEndpoints = await this.getBackupEndpoints();
      if (backupEndpoints) {
        try {
          resp = await promiseAny(
            backupEndpoints.map(endpoint =>
              fetch(this.getCheckUrl(endpoint), fetchPayload),
            ),
          );
        } catch (err: any) {
          this.throwIfEnabled(new Error('errorCheckingUseBackup'));
        }
      } else {
        this.throwIfEnabled(new Error('errorCheckingGetBackup'));
      }
    }
    if (!resp) {
      this.report({
        type: 'errorChecking',
        message: 'Can not connect to update server. Please check your network.',
      });
      this.throwIfEnabled(new Error('errorChecking'));
      return this.lastRespJson ? await this.lastRespJson : emptyObj;
    }
    this.lastRespJson = resp.json();

    const result: CheckResult = await this.lastRespJson;

    log('checking result:', result);

    if (resp.status !== 200) {
      this.report({
        type: 'errorChecking',
        message: result.message,
      });
      this.throwIfEnabled(new Error(result.message));
    }

    return result;
  };
  getBackupEndpoints = async () => {
    const { server } = this.options;
    if (!server) {
      return [];
    }
    if (server.queryUrls) {
      try {
        const resp = await promiseAny(
          server.queryUrls.map(queryUrl => fetch(queryUrl)),
        );
        const remoteEndpoints = await resp.json();
        log('fetch endpoints:', remoteEndpoints);
        if (Array.isArray(remoteEndpoints)) {
          server.backups = Array.from(
            new Set([...(server.backups || []), ...remoteEndpoints]),
          );
        }
      } catch (e: any) {
        log('failed to fetch endpoints from: ', server.queryUrls);
      }
    }
    return server.backups;
  };
  downloadUpdate = async (
    info: CheckResult,
    onDownloadProgress?: (data: ProgressData) => void,
  ) => {
    const {
      hash,
      diff,
      pdiff,
      full,
      paths = [],
      name,
      description = '',
      metaInfo,
    } = info;
    if (
      this.options.beforeDownloadUpdate &&
      (await this.options.beforeDownloadUpdate(info)) === false
    ) {
      log('beforeDownloadUpdate returned false, skipping download');
      return;
    }
    if (!info.update || !hash) {
      return;
    }
    if (rolledBackVersion === hash) {
      log(`rolledback hash ${rolledBackVersion}, ignored`);
      return;
    }
    if (Pushy.downloadedHash === hash) {
      log(`duplicated downloaded hash ${Pushy.downloadedHash}, ignored`);
      return Pushy.downloadedHash;
    }
    if (Pushy.progressHandlers[hash]) {
      return;
    }
    const patchStartTime = Date.now();
    if (onDownloadProgress) {
      // @ts-expect-error harmony not in existing platforms
      if (Platform.OS === 'harmony') {
        Pushy.progressHandlers[hash] = DeviceEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          progressData => {
            if (progressData.hash === hash) {
              onDownloadProgress(progressData);
            }
          },
        );
      } else {
        Pushy.progressHandlers[hash] = pushyNativeEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          progressData => {
            if (progressData.hash === hash) {
              onDownloadProgress(progressData);
            }
          },
        );
      }
    }
    let succeeded = '';
    this.report({ type: 'downloading' });
    let lastError: any;
    let errorMessages: string[] = [];
    const diffUrl = await testUrls(joinUrls(paths, diff));
    if (diffUrl) {
      log('downloading diff');
      try {
        await PushyModule.downloadPatchFromPpk({
          updateUrl: diffUrl,
          hash,
          originHash: currentVersion,
        });
        succeeded = 'diff';
      } catch (e: any) {
        const errorMessage = `diff error: ${e.message}`;
        errorMessages.push(errorMessage);
        lastError = new Error(errorMessage);
        if (__DEV__) {
          succeeded = 'diff';
        } else {
          log(errorMessage);
        }
      }
    }
    const pdiffUrl = await testUrls(joinUrls(paths, pdiff));
    if (!succeeded && pdiffUrl) {
      log('downloading pdiff');
      try {
        await PushyModule.downloadPatchFromPackage({
          updateUrl: pdiffUrl,
          hash,
        });
        succeeded = 'pdiff';
      } catch (e: any) {
        const errorMessage = `pdiff error: ${e.message}`;
        errorMessages.push(errorMessage);
        lastError = new Error(errorMessage);
        if (__DEV__) {
          succeeded = 'pdiff';
        } else {
          log(errorMessage);
        }
      }
    }
    const fullUrl = await testUrls(joinUrls(paths, full));
    if (!succeeded && fullUrl) {
      log('downloading full patch');
      try {
        await PushyModule.downloadFullUpdate({
          updateUrl: fullUrl,
          hash,
        });
        succeeded = 'full';
      } catch (e: any) {
        const errorMessage = `full patch error: ${e.message}`;
        errorMessages.push(errorMessage);
        lastError = new Error(errorMessage);
        if (__DEV__) {
          succeeded = 'full';
        } else {
          log(errorMessage);
        }
      }
    }
    if (Pushy.progressHandlers[hash]) {
      Pushy.progressHandlers[hash].remove();
      delete Pushy.progressHandlers[hash];
    }
    if (__DEV__) {
      return hash;
    }
    if (!succeeded) {
      this.report({
        type: 'errorUpdate',
        data: { newVersion: hash },
        message: errorMessages.join(';'),
      });
      if (lastError) {
        throw lastError;
      }
      return;
    } else {
      const duration = Date.now() - patchStartTime;
      const data: Record<string, any> = {
        newVersion: hash,
        diff: succeeded,
        duration,
      };
      if (errorMessages.length > 0) {
        data.error = errorMessages.join(';');
      }
      this.report({
        type: 'downloadSuccess',
        data,
      });
    }
    log(`downloaded ${succeeded} hash:`, hash);
    setLocalHashInfo(hash, {
      name,
      description,
      metaInfo,
    });
    Pushy.downloadedHash = hash;
    return hash;
  };
  downloadAndInstallApk = async (
    url: string,
    onDownloadProgress?: (data: ProgressData) => void,
  ) => {
    if (Platform.OS !== 'android') {
      return;
    }
    if (Pushy.apkStatus === 'downloading') {
      return;
    }
    if (Pushy.apkStatus === 'downloaded') {
      this.report({ type: 'errorInstallApk' });
      this.throwIfEnabled(new Error('errorInstallApk'));
      return;
    }
    if (Platform.Version <= 23) {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          this.report({ type: 'rejectStoragePermission' });
          this.throwIfEnabled(new Error('rejectStoragePermission'));
          return;
        }
      } catch (e: any) {
        this.report({ type: 'errorStoragePermission' });
        this.throwIfEnabled(e);
        return;
      }
    }
    Pushy.apkStatus = 'downloading';
    this.report({ type: 'downloadingApk' });
    const progressKey = 'downloadingApk';
    if (onDownloadProgress) {
      if (Pushy.progressHandlers[progressKey]) {
        Pushy.progressHandlers[progressKey].remove();
      }
      Pushy.progressHandlers[progressKey] = pushyNativeEventEmitter.addListener(
        'RCTPushyDownloadProgress',
        (progressData: ProgressData) => {
          if (progressData.hash === progressKey) {
            onDownloadProgress(progressData);
          }
        },
      );
    }
    await PushyModule.downloadAndInstallApk({
      url,
      target: 'update.apk',
      hash: progressKey,
    }).catch(() => {
      Pushy.apkStatus = null;
      this.report({ type: 'errorDownloadAndInstallApk' });
      this.throwIfEnabled(new Error('errorDownloadAndInstallApk'));
    });
    Pushy.apkStatus = 'downloaded';
    if (Pushy.progressHandlers[progressKey]) {
      Pushy.progressHandlers[progressKey].remove();
      delete Pushy.progressHandlers[progressKey];
    }
  };
  restartApp = async () => {
    return PushyModule.restartApp();
  };
}

// for international users
export class Cresc extends Pushy {
  constructor(options: ClientOptions) {
    super(options, 'Cresc');
  }
}
