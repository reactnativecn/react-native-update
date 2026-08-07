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
  const first = Math.min(
    Math.floor(randomSample * deduped.length),
    deduped.length - 1
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
  const body: Record<string, any> = {
    packageVersion,
    hash: currentVersion,
    buildTime,
    cInfo,
    // 可消费的 diff 轨道版本(2 = hdiffv2 轨道),服务端据此门控下发
    ...(supportedDiffVersion ? { diffV: supportedDiffVersion } : {}),
    ...(bundleHash ? { bundleHash } : {}),
    ...extra,
  };
  if (isDev) {
    delete body.buildTime;
  }
  return body;
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
      if (expVersion.hash === identity.currentVersion) {
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
  if (rootResult.update && rootResult.hash === identity.currentVersion) {
    return { upToDate: true };
  }
  return rootResult;
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
  | { action: 'none'; reason: 'noUpdate' | 'alreadyCurrent' | 'rolledBack' }
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
  return {
    action: 'download',
    hash,
    attempts,
    devNoop: !!isDev && !fullUrls?.length,
  };
}
