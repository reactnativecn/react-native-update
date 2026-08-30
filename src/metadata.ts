import {
  buildTime,
  cInfo,
  currentBundleSha256,
  currentVersion,
  currentVersionInfo,
  getBundleHash,
  isFirstTime,
  isRolledBack,
  packageVersion,
  rolledBackVersion,
} from './core';

/**
 * Everything a crash report needs to be mapped back to the exact JS bundle
 * that was running: attach it as tags/context in Sentry, Crashlytics, Bugly…
 * The `currentVersion` hash (empty = the binary's embedded bundle) is the
 * key that selects the matching source map on the update platform.
 */
export interface UpdateMetadata {
  /** react-native-update SDK version. */
  sdkVersion: string;
  /** Native binary version the update decision is keyed on. */
  packageVersion: string;
  /** Build time of the native binary (empty in debug). */
  buildTime: string;
  /** Hash of the running hot-update version; '' when the embedded bundle runs. */
  currentVersion: string;
  /** Publisher-facing name/description/metaInfo of the running version. */
  versionName: string;
  versionDescription: string;
  metaInfo: string;
  /** SHA-256 of the embedded bundle; '' until computed / unavailable. */
  bundleHash: string;
  /**
   * SHA-256 of the running hot-update bundle from its install record
   * (matches the `bundleSha256` the CLI archives with the source map); ''
   * for the embedded bundle or a legacy install.
   */
  bundleSha256: string;
  /** First launch of `currentVersion` (crash protection still armed). */
  isFirstTime: boolean;
  /** This launch is the result of a rollback; `rolledBackVersion` names the culprit. */
  isRolledBack: boolean;
  rolledBackVersion: string;
  /**
   * How the running version got activated when not by the JS flow:
   * 'forceBoot' — the server's per-version override applied by the native
   * cold-start check; 'crashRescue' — activated by the crash-time rescue.
   */
  rescueSource: 'forceBoot' | 'crashRescue' | null;
  /** Stable per-install client id (gray-release bucketing key). */
  uuid: string;
  os: string;
}

export function getUpdateMetadata(): UpdateMetadata {
  const info = currentVersionInfo || {};
  return {
    sdkVersion: cInfo.rnu,
    packageVersion,
    buildTime,
    currentVersion: currentVersion || '',
    versionName: typeof info.name === 'string' ? info.name : '',
    versionDescription:
      typeof info.description === 'string' ? info.description : '',
    metaInfo: typeof info.metaInfo === 'string' ? info.metaInfo : '',
    bundleHash: getBundleHash(),
    bundleSha256: currentBundleSha256 || '',
    isFirstTime,
    isRolledBack,
    rolledBackVersion: rolledBackVersion || '',
    rescueSource: info.forceBootRescue
      ? 'forceBoot'
      : info.crashRescue
        ? 'crashRescue'
        : null,
    uuid: cInfo.uuid,
    os: cInfo.os,
  };
}

/**
 * The duck-typed surface of a crash reporter. Sentry exposes setTag/setContext,
 * Firebase Crashlytics setAttributes/setAttribute; any object with one of
 * those works.
 */
export interface CrashReporterLike {
  setTag?: (key: string, value: string) => unknown;
  setContext?: (
    name: string,
    context: Record<string, unknown> | null
  ) => unknown;
  setAttributes?: (attributes: Record<string, string>) => unknown;
  setAttribute?: (key: string, value: string) => unknown;
}

/** Flat string tags (`pushy.currentVersion` …) for the running update. */
export function updateMetadataTags(
  metadata: UpdateMetadata = getUpdateMetadata(),
  prefix = 'pushy.'
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    tags[`${prefix}${key}`] =
      value === null || value === undefined ? '' : String(value);
  }
  return tags;
}

/**
 * Attach the running update's metadata to a crash reporter so every event can
 * be mapped to the exact bundle (and source map) it came from. Call once after
 * the reporter is initialised; safe to call again (e.g. after markSuccess).
 * Every reporter method is optional and failures are swallowed — a reporting
 * hiccup must never break the app.
 */
export function attachUpdateMetadata(
  reporter: CrashReporterLike,
  options: { prefix?: string; contextName?: string | null } = {}
): UpdateMetadata {
  const metadata = getUpdateMetadata();
  const tags = updateMetadataTags(metadata, options.prefix ?? 'pushy.');
  const swallow = (fn: () => unknown) => {
    try {
      const result = fn();
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // never let a reporter failure propagate
    }
  };
  if (typeof reporter.setTag === 'function') {
    for (const [key, value] of Object.entries(tags)) {
      swallow(() => reporter.setTag?.(key, value));
    }
  } else if (typeof reporter.setAttributes === 'function') {
    swallow(() => reporter.setAttributes?.(tags));
  } else if (typeof reporter.setAttribute === 'function') {
    for (const [key, value] of Object.entries(tags)) {
      swallow(() => reporter.setAttribute?.(key, value));
    }
  }
  if (
    options.contextName !== null &&
    typeof reporter.setContext === 'function'
  ) {
    swallow(() =>
      reporter.setContext?.(options.contextName ?? 'pushy', { ...metadata })
    );
  }
  return metadata;
}

/** `attachUpdateMetadata` for `@sentry/react-native` (tags + a `pushy` context). */
export function attachToSentry(sentry: CrashReporterLike): UpdateMetadata {
  return attachUpdateMetadata(sentry, { contextName: 'pushy' });
}

/** `attachUpdateMetadata` for `@react-native-firebase/crashlytics` (custom keys). */
export function attachToCrashlytics(
  crashlytics: CrashReporterLike
): UpdateMetadata {
  return attachUpdateMetadata(crashlytics, { contextName: null });
}
