import { DeviceEventEmitter, Platform } from 'react-native';
import type { Pushy } from './client';
import type { Reporter } from './clientReporter';
import type { ProcessState } from './clientState';
import {
  currentVersion,
  PushyModule,
  pushyNativeEventEmitter,
  rolledBackVersion,
  setLocalHashInfo,
} from './core';
import { readErrorCode, UpdateError } from './error';
import type { CheckResult, ProgressData } from './type';
import {
  type DownloadPlan,
  type DownloadStrategyType,
  decideDownload,
  isMirrorRetryableCode,
} from './updateFlowCore';
import { computeProgress, log, testUrls, warn } from './utils';

/**
 * What downloading needs from the client. Its public members are called
 * through the client, so a caller that replaces one on the instance sees
 * every use.
 */
export type DownloadHost = Pick<
  Pushy,
  'options' | 't' | 'report' | 'reportInvalidUpdateOnce' | 'throwIfEnabled'
>;

/**
 * Downloads: the per-device plan from decideDownload executed over the
 * native downloaders, with mirror ranking, retries and progress fan-out;
 * plus the Android full-package (APK) path.
 */
export class Downloader {
  constructor(
    private readonly host: DownloadHost,
    private readonly reporter: Reporter,
    private readonly state: ProcessState
  ) {}

  downloadUpdate = async (
    updateInfo: CheckResult,
    onDownloadProgress?: (data: ProgressData) => void
  ) => {
    const { options } = this.host;
    if (
      options.beforeDownloadUpdate &&
      (await options.beforeDownloadUpdate(updateInfo)) === false
    ) {
      log('beforeDownloadUpdate returned false, skipping download');
      return;
    }
    const decision = decideDownload(
      updateInfo,
      { currentVersion, rolledBackVersion },
      __DEV__
    );
    if (decision.action === 'none') {
      if (decision.reason === 'alreadyCurrent') {
        log(`current hash ${currentVersion}, ignored`);
      } else if (decision.reason === 'rolledBack') {
        log(`rolledback hash ${rolledBackVersion}, ignored`);
      } else if (decision.reason === 'noArtifact') {
        // A server response that advertises an update but provides no usable
        // artifact is a bad release signal, not an ordinary no-update result.
        // Keep the user flow silent and report at most once per bad release in
        // this process: repeated checks must not inflate download_fail health.
        this.host.reportInvalidUpdateOnce('noArtifact', updateInfo.hash || '');
      }
      return;
    }
    const { hash } = decision;
    if (this.state.shared.downloadedHash === hash) {
      log(
        `duplicated downloaded hash ${this.state.shared.downloadedHash}, ignored`
      );
      return this.state.shared.downloadedHash;
    }
    // Deduplicate concurrent downloads of the same hash regardless of whether a
    // progress callback was passed: all callers await the single in-flight
    // promise instead of triggering parallel native downloads.
    const existingTask = this.state.shared.downloadingTasks[hash];
    if (existingTask) {
      log(`download for hash ${hash} already in progress, reusing it`);
      // The second caller's progress callback must still fire.
      if (onDownloadProgress) {
        this.state.shared.progressCallbacks[hash]?.add(onDownloadProgress);
      }
      return existingTask;
    }
    const task = this.performDownload(updateInfo, decision, onDownloadProgress);
    this.state.shared.downloadingTasks[hash] = task;
    try {
      return await task;
    } finally {
      delete this.state.shared.downloadingTasks[hash];
    }
  };

  /**
   * Orders candidate mirrors for one artifact: the HEAD probe's winner first
   * (its post-redirect URL), then the remaining mirrors in configured order.
   * Empty when there is nothing to try.
   */
  private rankDownloadUrls = async (urls?: string[]): Promise<string[]> => {
    if (!urls?.length) {
      return [];
    }
    const winner = await testUrls(urls);
    const ordered: string[] = [];
    const push = (url?: string | null) => {
      if (url && !ordered.includes(url)) {
        ordered.push(url);
      }
    };
    push(winner);
    for (const url of urls) {
      push(url);
    }
    return ordered;
  };

  private performDownload = async (
    updateInfo: CheckResult,
    plan: DownloadPlan,
    onDownloadProgress?: (data: ProgressData) => void
  ) => {
    const { host } = this;
    const { name, description = '', metaInfo } = updateInfo;
    const { hash, attempts, devNoop } = plan;
    if (devNoop) {
      // Dev without a full package URL: nothing can be fetched, let alone
      // installed. Say so and deliver nothing — faking a success here used to
      // hand the caller a hash whose switchVersion the native side (rightly)
      // rejects with SWITCH_VERSION_FAILED.
      log(this.host.t('dev_incremental_update_disabled'));
      return;
    }
    const patchStartTime = Date.now();
    // One native listener per hash dispatching to a callback set, so
    // concurrent callers deduped onto this task can each observe progress
    // (they register via downloadUpdate).
    const progressCallbacks = new Set<(data: ProgressData) => void>();
    if (onDownloadProgress) {
      progressCallbacks.add(onDownloadProgress);
    }
    this.state.shared.progressCallbacks[hash] = progressCallbacks;
    const dispatchProgress = (data: ProgressData) => {
      if (progressCallbacks.size === 0) {
        return;
      }
      const payload = {
        ...data,
        progress: computeProgress(data.received, data.total),
      };
      progressCallbacks.forEach((callback) => {
        // One subscriber throwing must not starve the others or abort the
        // download: business callbacks are isolated, the error is logged.
        try {
          callback(payload);
        } catch (e) {
          warn('onDownloadProgress callback threw', e);
        }
      });
    };
    // RN >= 0.87 types native event listeners as `(...args: readonly Object[])`,
    // which a `(data: ProgressData) => void` callback is not assignable to. Take
    // the raw event and narrow it here so this compiles on every RN version.
    const onNativeProgress = (event: unknown) => {
      const progressData = event as ProgressData;
      if (progressData.hash === hash) {
        dispatchProgress(progressData);
      }
    };
    // @ts-expect-error harmony not in existing platforms
    const isHarmony = Platform.OS === 'harmony';
    // Two separate calls: on RN 0.88 the two emitters' addListener signatures
    // no longer unify, so calling it on the union type does not compile.
    const progressSubscription = isHarmony
      ? DeviceEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          onNativeProgress
        )
      : pushyNativeEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          onNativeProgress
        );
    const maxRetries = Math.max(
      0,
      Math.floor(this.host.options.maxRetries ?? 3)
    );
    let succeeded = '';
    let lastError: UpdateError | undefined;
    const errorMessages: string[] = [];
    // A strategy whose bytes arrived but could not be applied fails the same
    // way on every retry (same artifact, same base): remember it — with its
    // message, so the final report still names it — and skip it on later
    // attempts instead of downloading and patching it again.
    const exhaustedStrategies = new Map<DownloadStrategyType, string>();

    // The ordered attempts come from decideDownload (the pure decision layer);
    // this side only executes them: probe candidate URLs, run the matching
    // native download, fall through to the next attempt on failure.
    const runners: Record<
      DownloadStrategyType,
      (url: string) => Promise<void>
    > = {
      diff: (url) =>
        PushyModule.downloadPatchFromPpk({
          updateUrl: url,
          hash,
          originHash: currentVersion,
        }),
      pdiff: (url) =>
        PushyModule.downloadPatchFromPackage({
          updateUrl: url,
          hash,
        }),
      full: (url) =>
        PushyModule.downloadFullUpdate({
          updateUrl: url,
          hash,
        }),
    };
    // Mirror ranking per strategy, kept across retry attempts: the HEAD probe
    // runs once per strategy per download instead of once per attempt. A
    // winner that failed its download is demoted to the back for the next
    // attempt (every mirror is tried on every attempt anyway).
    const rankedUrls = new Map<DownloadStrategyType, string[]>();
    const errorKeys = {
      diff: 'error_diff_failed',
      pdiff: 'error_pdiff_failed',
      full: 'error_full_patch_failed',
    } as const;

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          // Exponential backoff with jitter: a bad CDN edge otherwise gets
          // every client back at the same 1/2/4s marks.
          const backoffMs = Math.round(
            Math.min(1000 * 2 ** (attempt - 1), 10000) *
              (0.75 + Math.random() * 0.5)
          );
          log(`retry attempt ${attempt}/${maxRetries}, waiting ${backoffMs}ms`);
          await new Promise<void>((r) => setTimeout(() => r(), backoffMs));
          errorMessages.length = 0;
          errorMessages.push(...exhaustedStrategies.values());
          lastError = undefined;
          succeeded = '';
        }
        host.report({
          type: 'downloading',
          data: {
            newVersion: hash,
            attempt,
          },
        });
        for (const { type, urls } of attempts) {
          if (succeeded) {
            break;
          }
          if (exhaustedStrategies.has(type)) {
            continue;
          }
          // The HEAD probe only ranks mirrors; it is not proof that a mirror can
          // serve the whole artifact (CDNs answer HEAD and GET differently, and
          // a transfer can die mid-stream). Every mirror of the same artifact
          // gets a real download attempt before the strategy is abandoned —
          // the native cold-start path already behaves this way.
          let orderedUrls = rankedUrls.get(type);
          if (!orderedUrls) {
            orderedUrls = await this.rankDownloadUrls(urls);
            rankedUrls.set(type, orderedUrls);
          }
          for (const url of orderedUrls) {
            log(`downloading ${type} from ${url}`);
            try {
              await runners[type](url);
              succeeded = type;
              break;
            } catch (e: unknown) {
              // The native rejection's stable code (e.g. PATCH_FAILED vs
              // DOWNLOAD_FAILED — telemetry classifies on it) may sit on the
              // `code` property or, from bridges that cannot set it, as a
              // `[CODE] ` message prefix. Either way it survives into the
              // i18n-wrapped error together with the original as cause.
              const { code, message } = readErrorCode(e);
              if (url === orderedUrls[0] && orderedUrls.length > 1) {
                rankedUrls.set(type, [...orderedUrls.slice(1), url]);
              }
              const errorMessage = this.host.t(errorKeys[type], {
                message: message || String(e ?? ''),
              });
              errorMessages.push(errorMessage);
              lastError = new UpdateError(
                errorMessage,
                code ?? 'DOWNLOAD_FAILED',
                {
                  cause: e,
                }
              );
              log(errorMessage);
              if (!isMirrorRetryableCode(lastError.code)) {
                // The bytes arrived but could not be applied (patch/manifest
                // mismatch): every mirror serves the same artifact, so move
                // on to the next strategy instead of re-downloading it.
                exhaustedStrategies.set(type, errorMessage);
                break;
              }
            }
          }
        }
        if (
          succeeded ||
          attempts.every(({ type }) => exhaustedStrategies.has(type))
        ) {
          // Nothing left that a retry could change.
          break;
        }
      }
    } finally {
      progressSubscription.remove();
      delete this.state.shared.progressCallbacks[hash];
    }
    // Only a patch-stage failure exhausts a strategy (isMirrorRetryableCode),
    // and an exhausted strategy is never retried: these are exactly the patch
    // failures, each once.
    const patchErrorMessages = [...exhaustedStrategies.values()];
    const patchFailed = patchErrorMessages.length > 0;
    if (succeeded && errorMessages.length > 0) {
      // An earlier strategy failed and a later one rescued the download
      // (e.g. pdiff copiesCrc mismatch on a rebuilt binary → full). Surface
      // the degradation: it is invisible to the end user but tells the
      // platform that incremental delivery is failing for this binary.
      host.report({
        type: 'downloadFallback',
        // The patch-health signal (any strategy, in any attempt, failing at
        // the patch stage) wins over whatever transport failure happened to
        // come last (diff PATCH_FAILED, then pdiff network error, then full
        // succeeded is still a patch_fail server-side).
        code: patchFailed ? 'PATCH_FAILED' : lastError?.code,
        data: {
          newVersion: hash,
          succeeded,
        },
        // Only the patch failures: a mirror's timeout alongside them would
        // otherwise be read as the cause server-side.
        message: (patchFailed ? patchErrorMessages : errorMessages).join(';'),
      });
    }
    if (!succeeded) {
      // Every attempt runs at least one download (a plan always has an
      // artifact URL, devNoop returned above), so a failure left lastError.
      throw this.reporter.fail(lastError, 'DOWNLOAD_FAILED', 'errorUpdate', {
        message: errorMessages.join(';'),
        data: { newVersion: hash },
      });
    }
    const data: Record<string, any> = {
      newVersion: hash,
      diff: succeeded,
      duration: Date.now() - patchStartTime,
    };
    if (errorMessages.length > 0) {
      data.error = errorMessages.join(';');
    }
    host.report({
      type: 'downloadSuccess',
      data,
    });
    log(`downloaded ${succeeded} hash:`, hash);
    const hashInfo: Record<string, any> = {
      name,
      description,
      metaInfo,
    };
    if (this.state.shared.toHash === hash) {
      hashInfo.debugChannel = true;
    }
    // The version is "downloaded" only once its metadata is persisted: a
    // lost hash-info write would leave the next launch with a nameless
    // version and a switchVersion that the native side may refuse.
    try {
      await setLocalHashInfo(hash, hashInfo);
    } catch (e: any) {
      throw this.reporter.fail(e, 'FILE_OPERATION_FAILED', 'errorUpdate', {
        data: { newVersion: hash },
      });
    }
    this.state.shared.downloadedHash = hash;
    return hash;
  };

  downloadAndInstallApk = async (
    url: string,
    onDownloadProgress?: (data: ProgressData) => void
  ) => {
    const { host } = this;
    if (Platform.OS !== 'android') {
      return;
    }
    if (this.state.shared.apkStatus === 'downloading') {
      return;
    }
    if (this.state.shared.apkStatus === 'downloaded') {
      const err = new UpdateError(
        this.host.t('error_apk_pending_install'),
        'APK_INSTALL_PENDING'
      );
      this.reporter.emitError(err, 'errorInstallApk');
      host.throwIfEnabled(err);
      return;
    }
    this.state.shared.apkStatus = 'downloading';
    host.report({ type: 'downloadingApk' });
    const progressKey = 'downloadingApk';
    const progressSubscription = onDownloadProgress
      ? pushyNativeEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          (event: unknown) => {
            const progressData = event as ProgressData;
            if (progressData.hash === progressKey) {
              onDownloadProgress(progressData);
            }
          }
        )
      : undefined;
    try {
      await PushyModule.downloadAndInstallApk({
        url,
        target: 'update.apk',
        hash: progressKey,
      });
      this.state.shared.apkStatus = 'downloaded';
    } catch (e) {
      this.state.shared.apkStatus = null;
      // Keep the native error (message/stack) instead of discarding it.
      host.throwIfEnabled(
        this.reporter.fail(
          e,
          'APK_DOWNLOAD_FAILED',
          'errorDownloadAndInstallApk',
          {
            fallbackMessage: this.host.t('error_apk_download_failed'),
          }
        )
      );
    } finally {
      progressSubscription?.remove();
    }
  };
}
