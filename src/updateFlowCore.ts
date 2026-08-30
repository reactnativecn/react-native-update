import type { CheckResult } from './type';

// 更新流程的纯决策层:无 IO、不依赖 react-native、无模块级状态,所有输入均由
// 参数传入(仅允许 type-only import)。这一层必须保持可在裸 JS 引擎中求值——
// 它就是未来 guardian bundle 的编译单元(NATIVE_CHECKUPDATE_DESIGN §5),
// IO(HTTP/下载/落盘)由调用方(现在是 client.ts,将来是原生编排)执行。

/* eslint-disable no-fallthrough */
/* eslint-disable no-bitwise */
export function murmurhash3_32_gc(key: string, seed = 0) {
  let remainder: number,
    bytes: number,
    h1: number,
    h1b: number,
    c1: number,
    c2: number,
    k1: number,
    i: number;

  remainder = key.length & 3; // key.length % 4
  bytes = key.length - remainder;
  h1 = seed;
  c1 = 0xcc9e2d51;
  c2 = 0x1b873593;
  i = 0;

  while (i < bytes) {
    k1 =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(++i) & 0xff) << 8) |
      ((key.charCodeAt(++i) & 0xff) << 16) |
      ((key.charCodeAt(++i) & 0xff) << 24);
    ++i;

    k1 =
      ((k1 & 0xffff) * c1 + ((((k1 >>> 16) * c1) & 0xffff) << 16)) & 0xffffffff;
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 =
      ((k1 & 0xffff) * c2 + ((((k1 >>> 16) * c2) & 0xffff) << 16)) & 0xffffffff;

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1b =
      ((h1 & 0xffff) * 5 + ((((h1 >>> 16) * 5) & 0xffff) << 16)) & 0xffffffff;
    h1 = (h1b & 0xffff) + 0x6b64 + ((((h1b >>> 16) + 0xe654) & 0xffff) << 16);
  }

  k1 = 0;

  switch (remainder) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: MurmurHash fallthrough
    case 3:
      k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: MurmurHash fallthrough
    case 2:
      k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
    case 1:
      k1 ^= key.charCodeAt(i) & 0xff;

      k1 =
        ((k1 & 0xffff) * c1 + ((((k1 >>> 16) * c1) & 0xffff) << 16)) &
        0xffffffff;
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 =
        ((k1 & 0xffff) * c2 + ((((k1 >>> 16) * c2) & 0xffff) << 16)) &
        0xffffffff;
      h1 ^= k1;
  }

  h1 ^= key.length;

  h1 ^= h1 >>> 16;
  h1 =
    ((h1 & 0xffff) * 0x85ebca6b +
      ((((h1 >>> 16) * 0x85ebca6b) & 0xffff) << 16)) &
    0xffffffff;
  h1 ^= h1 >>> 13;
  h1 =
    ((h1 & 0xffff) * 0xc2b2ae35 +
      ((((h1 >>> 16) * 0xc2b2ae35) & 0xffff) << 16)) &
    0xffffffff;
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

export function isInRollout(rollout: number, uuid: string) {
  return murmurhash3_32_gc(uuid) % 100 < rollout;
}

export function joinUrls(paths: string[], fileName?: string) {
  if (fileName) {
    return paths.map((path) => {
      const normalizedPath = path.replace(/\/+$/, '');
      // Keep explicit http(s) URLs for local/self-hosted update sources.
      const baseUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedPath)
        ? normalizedPath
        : `https://${normalizedPath}`;
      return `${baseUrl}/${fileName}`;
    });
  }
}

export const dedupeEndpoints = (
  endpoints: Array<string | null | undefined>
): string[] => {
  const result: string[] = [];
  const visited = new Set<string>();

  for (const endpoint of endpoints) {
    if (!endpoint || visited.has(endpoint)) {
      continue;
    }
    visited.add(endpoint);
    result.push(endpoint);
  }

  return result;
};

/**
 * The endpoint plan: dedupe, then move the sampled pick to the front (load
 * spreading), keeping the rest in configured order as the fallback sequence.
 * `randomSample` ∈ [0, 1) is injected by the caller — this layer cannot draw
 * randomness itself.
 */
export function orderEndpointCandidates(
  endpoints: Array<string | null | undefined>,
  randomSample = 0
): string[] {
  const deduped = dedupeEndpoints(endpoints);
  if (deduped.length < 2) {
    return deduped;
  }
  const first = Math.max(
    0,
    Math.min(
      Number.isFinite(randomSample)
        ? Math.floor(randomSample * deduped.length)
        : 0,
      deduped.length - 1
    )
  );
  return [
    deduped[first],
    ...deduped.slice(0, first),
    ...deduped.slice(first + 1),
  ];
}

export interface CheckRequestInput {
  /** Effective native package version (overridePackageVersion already applied). */
  packageVersion: string;
  /** Hash of the currently running JS version ('' when on the packaged bundle). */
  currentVersion?: string;
  buildTime: string;
  cInfo: Record<string, string>;
  supportedDiffVersion?: number;
  /** '' or undefined while unknown — the field is then omitted. */
  bundleHash?: string;
  isDev?: boolean;
  extra?: Record<string, any>;
}

export function buildCheckRequestBody({
  packageVersion,
  currentVersion,
  buildTime,
  cInfo,
  supportedDiffVersion,
  bundleHash,
  isDev,
  extra,
}: CheckRequestInput): Record<string, any> {
  // Caller extras are spread FIRST so they can add fields (channel, custom
  // filters, the debug-channel toHash) but never override the SDK identity
  // fields the server keys its decision on: a stray `packageVersion` or
  // `hash` in extra would otherwise make the server hand out a package for
  // the wrong binary.
  const body: Record<string, any> = {
    ...extra,
    packageVersion,
    hash: currentVersion,
    buildTime,
    cInfo,
  };
  // 可消费的 diff 轨道版本(2 = hdiffv2 轨道),服务端据此门控下发
  if (supportedDiffVersion) {
    body.diffV = supportedDiffVersion;
  } else {
    delete body.diffV;
  }
  if (bundleHash) {
    body.bundleHash = bundleHash;
  } else {
    delete body.bundleHash;
  }
  if (isDev) {
    delete body.buildTime;
  }
  // Transitional dual form: the legacy root-level spread above is what
  // servers before 2026-08-30 read; the nested copy is what new servers read
  // first (extra.toHash wins there) and lets caller keys stop sharing the
  // SDK's namespace once the root spread is retired.
  if (extra) {
    // Match JSON.stringify semantics: undefined values do not exist on the
    // wire, so they must not create a nested copy either (the native check
    // cache compares serialized requests).
    const defined: Record<string, any> = {};
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        defined[key] = value;
      }
    }
    if (Object.keys(defined).length > 0) {
      body.extra = defined;
    }
  }
  return body;
}

export interface CheckFingerprintInput {
  appKey?: string;
  endpoints?: string[];
  queryUrls?: string[];
  uuid?: string;
  /** The exact serialized request body (identity fields + extra). */
  body: string;
}

/**
 * Identity of one update check. Two checks may share an in-flight response
 * only when every input that could change the server's answer is identical.
 */
export function buildCheckFingerprint({
  appKey,
  endpoints,
  queryUrls,
  uuid,
  body,
}: CheckFingerprintInput): string {
  return JSON.stringify([
    appKey ?? '',
    endpoints ?? [],
    queryUrls ?? [],
    uuid ?? '',
    body,
  ]);
}

/**
 * Whether a failed download attempt is worth retrying on another mirror of
 * the same artifact. Transport failures (DNS, connect, timeout, truncated
 * body, 5xx) and corrupt bytes are; a patch that downloaded fine but could
 * not be applied is not — every mirror serves the same bytes, so the next
 * strategy is the only way forward.
 */
export function isMirrorRetryableCode(code?: string): boolean {
  return code !== 'PATCH_FAILED';
}

/**
 * Schema gate for a checkUpdate response (mirrors C++ IsValidCheckResult): a
 * JSON object carrying at least one verdict field of the expected type —
 * `upToDate` / `update` / `expired` (boolean) or `paused` (string). A 200
 * with `{"error": ...}`, an array or an HTML page that happened to parse is
 * a failed endpoint, not a verdict, and must not stop the endpoint fallback.
 */
export function isValidCheckResult(value: unknown): value is CheckResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const root = value as Record<string, unknown>;
  return (
    typeof root.upToDate === 'boolean' ||
    typeof root.update === 'boolean' ||
    typeof root.expired === 'boolean' ||
    typeof root.paused === 'string'
  );
}

export interface UpdateIdentity {
  packageVersion: string;
  currentVersion?: string;
  /** Stable client uuid — the gray-release bucketing key. */
  uuid: string;
}

export function resolveCheckResult(
  rootInfo: CheckResult,
  identity: UpdateIdentity,
  log: (...args: any[]) => void = () => {}
): CheckResult {
  const { expVersion, ...rootResult } = rootInfo;
  const rollout = expVersion?.config?.rollout?.[identity.packageVersion];
  if (rootResult.update && expVersion && typeof rollout === 'number') {
    if (isInRollout(rollout, identity.uuid)) {
      log(`${expVersion.name} in ${rollout}% rollout, continue`);
      if (
        typeof expVersion.hash === 'string' &&
        expVersion.hash.length > 0 &&
        expVersion.hash === identity.currentVersion
      ) {
        return { upToDate: true };
      }
      const info: CheckResult = {
        update: true,
        ...expVersion,
      };
      if (rootResult.paths) {
        info.paths = rootResult.paths;
      }
      return info;
    }
    log(`${expVersion.name} not in ${rollout}% rollout, ignored`);
  }
  if (
    rootResult.update &&
    typeof rootResult.hash === 'string' &&
    rootResult.hash.length > 0 &&
    rootResult.hash === identity.currentVersion
  ) {
    return { upToDate: true };
  }
  return rootResult;
}

/**
 * Whether the native orchestrator should activate a downloaded version for
 * the next launch: either the client opted in via its silent strategies
 * (afterDownload === 'setNeedUpdate'), or the server marked this version
 * `config.forceBoot` — the per-version remote override that closes the
 * brick-rescue gap for alert-strategy apps (a bricked device never runs JS,
 * so activation cannot wait for it). Native-only: the JS side's interactive
 * strategies are not consulted and not affected. The device-local
 * rolledBackVersion guard in decideDownload still wins over forceBoot, and
 * the activated version keeps the first_time crash-protection rollback.
 */
export function shouldActivateAfterDownload(
  info: CheckResult,
  afterDownload?: string
): boolean {
  return afterDownload === 'setNeedUpdate' || !!info?.config?.forceBoot;
}

export type DownloadStrategyType = 'diff' | 'pdiff' | 'full';

export interface DownloadAttempt {
  type: DownloadStrategyType;
  /** Candidate URLs (paths × file name); the executor probes and picks one. */
  urls: string[];
}

export interface DownloadPlan {
  hash: string;
  /** Ordered attempts: incremental first, full as the last resort. */
  attempts: DownloadAttempt[];
  /** Dev-only: nothing to fetch — treat as an immediate no-op success. */
  devNoop: boolean;
}

export type DownloadDecision =
  | {
      action: 'none';
      reason: 'noUpdate' | 'alreadyCurrent' | 'rolledBack' | 'noArtifact';
    }
  | ({ action: 'download' } & DownloadPlan);

export function decideDownload(
  info: CheckResult,
  identity: { currentVersion?: string; rolledBackVersion?: string },
  isDev = false
): DownloadDecision {
  const { hash, diff, pdiff, full, paths = [] } = info;
  if (!info.update || !hash) {
    return { action: 'none', reason: 'noUpdate' };
  }
  if (hash === identity.currentVersion) {
    return { action: 'none', reason: 'alreadyCurrent' };
  }
  if (identity.rolledBackVersion && hash === identity.rolledBackVersion) {
    return { action: 'none', reason: 'rolledBack' };
  }
  const attempts: DownloadAttempt[] = [];
  // Incremental artifacts only exist against release builds; dev goes
  // straight to full (or the no-op below when there is none).
  if (!isDev) {
    const diffUrls = joinUrls(paths, diff);
    if (diffUrls?.length) {
      attempts.push({ type: 'diff', urls: diffUrls });
    }
    const pdiffUrls = joinUrls(paths, pdiff);
    if (pdiffUrls?.length) {
      attempts.push({ type: 'pdiff', urls: pdiffUrls });
    }
  }
  const fullUrls = joinUrls(paths, full);
  if (fullUrls?.length) {
    attempts.push({ type: 'full', urls: fullUrls });
  }
  const devNoop = !!isDev && !fullUrls?.length;
  if (!attempts.length && !devNoop) {
    return { action: 'none', reason: 'noArtifact' };
  }
  return {
    action: 'download',
    hash,
    attempts,
    devNoop,
  };
}
