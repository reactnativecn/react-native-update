import http from '@ohos.net.http';
import deviceInfo from '@ohos.deviceInfo';
import logger from './Logger';
import NativePatchCore from './NativePatchCore';
import type { UpdateContext } from './UpdateContext';
import { isSafePathComponent } from './PathUtils';
import { monotonicNowMs } from './MonotonicClock';
import {
  ERROR_DOWNLOAD_FAILED,
  createUpdateError,
  getErrorMessage,
} from './ErrorCodes';

// 原生冷启动检测(NATIVE_CHECKUPDATE_DESIGN §10):每进程一次,getBundleUrl
// 后延迟数秒运行,完全不依赖 app bundle——坏热更把 JS 砸挂后,下次启动仍能
// 拉到修复版。决策全部来自 cpp/update_flow_core(经 NativePatchCore 的
// NAPI 面),本文件只是 IO 胶水。失败静默且有界:每次启动至多一轮,无重试
// 风暴,不拉黑版本。
// 鸿蒙的 debug 门控由触发点天然承担:dev 走 MetroJSBundleProvider,
// PushyFileJSBundleProvider.getBundleUrl 不会被调用。
const TAG = 'NativeCheck';
export const KEY_CONFIG = 'nativeConfig';
// 供 JS 侧复用的原始响应缓存(§10.3),同时记录请求与配置指纹以限定命中范围。
export const KEY_RESP_CACHE = 'nativeCheckResp';
// 轮次开始落盘、结束清除(§11.4)。下次启动读到残留 = 上个进程死于轮中
// (砖机的签名),该次启动跳过 5s 延迟立即续传。鸿蒙本版不做 crash-hold
// (errorManager 的同步回调驱动不了 ArkTS 异步网络 IO),续传 + 零延迟
// 标记是收敛砖机的全部机制。
export const KEY_ROUND_INCOMPLETE = 'nativeCheckIncomplete';
const REQUEST_TIMEOUT_MS = 10000;
const REQUEST_CALL_TIMEOUT_MS = 15000;
const MAX_CHECK_HTTP_ATTEMPTS = 8;
const START_DELAY_MS = 5000;
const DOWNLOAD_PHASE_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_TYPE_DIFF = 'diff';
const DOWNLOAD_TYPE_PDIFF = 'pdiff';

interface NativeConfig {
  appKey?: string;
  packageVersion?: string;
  endpoints?: string[];
  queryUrls?: string[];
  afterDownload?: string;
  rnu?: string;
  rn?: string;
  disabled?: boolean;
}

interface FlowIdentity {
  packageVersion: string;
  currentVersion?: string;
  uuid: string;
  rolledBackVersion?: string;
}

interface FlowCInfo {
  rnu: string;
  rn: string;
  os: string;
  uuid: string;
}

interface FlowCheckInput {
  packageVersion: string;
  currentVersion?: string;
  buildTime: string;
  cInfo: FlowCInfo;
  supportedDiffVersion: number;
  bundleHash: string;
}

interface DecisionAttempt {
  type?: string;
  urls?: string[];
}

interface DecisionInfoConfig {
  forceBoot?: boolean;
}

interface DecisionInfo {
  name?: string;
  description?: string;
  metaInfo?: string;
  // 服务端按版本下发的配置(forceBoot = 救砖指令)。
  config?: DecisionInfoConfig;
  // 写进 hash 信息:这个版本是被救援通道送进来的,JS 在 markSuccess 时据此
  // 上报 forceBootRescue 回执(与 Android/iOS 一致)。
  forceBootRescue?: boolean;
}

interface Decision {
  action?: string;
  reason?: string;
  hash?: string;
  attempts?: DecisionAttempt[];
  activate?: boolean;
  info?: DecisionInfo;
}

interface RespCacheEntry {
  ts: number;
  body: string;
  request: string;
  config: string;
}

let scheduled = false;
// JS 在本进程内已拿到有效检查响应时对应的配置 JSON(markJsCheckCompleted)。
// 进程级:下次启动无信号,冷启动轮次照常运行。
let jsCompletedConfig: string | undefined;

export function markJsCheckCompleted(config: string): void {
  jsCompletedConfig = config;
}

// JS 已用与原生完全相同的配置拿到有效响应(§10.3):延迟轮次就是一次重复请求。
// 只有计划内的轮次会问这个问题——JS 没起来、启动即崩、检查失败时都不会有信号。
function isJsCheckCompleted(context: UpdateContext): boolean {
  return (
    jsCompletedConfig !== undefined &&
    jsCompletedConfig === context.getKv(KEY_CONFIG)
  );
}

export function scheduleNativeCheck(
  context: UpdateContext,
  launchRolledBackVersion: string,
): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  // 结果本来就是"下次启动生效",延迟几秒让开冷启动关键路径(§7 R5)——
  // 除非上个进程死于轮中(残留标记),那时每一秒启动时间都要用来续传。
  const delayMs = context.getKv(KEY_ROUND_INCOMPLETE) ? 0 : START_DELAY_MS;
  setTimeout(() => {
    if (isJsCheckCompleted(context)) {
      logger.info(
        TAG,
        'native check skipped: JS check completed in this process',
      );
      return;
    }
    runOnce(context, launchRolledBackVersion).catch((e: Object) => {
      // 救援路径自身绝不能把应用拖垮。
      logger.error(TAG, `native check failed: ${getErrorMessage(e)}`);
    });
  }, delayMs);
}

async function runOnce(
  context: UpdateContext,
  launchRolledBackVersion: string,
): Promise<void> {
  // 在任何 IO 之前采样:resetToPackagedBundle 会递增它,本轮运行期间发生的
  // reset 必须赢过本轮的决策。
  const resetGeneration = context.getResetGeneration();
  const configJson = context.getKv(KEY_CONFIG);
  if (!configJson) {
    // 无落盘配置(老接入/首启):静默不跑——这就是灰度开关。
    return;
  }
  let config: NativeConfig;
  try {
    config = JSON.parse(configJson) as NativeConfig;
  } catch (e) {
    return;
  }
  if (config.disabled) {
    return;
  }
  const appKey = config.appKey ?? '';
  if (!appKey) {
    return;
  }
  // 从这里起本轮开始做真实工作:留下面包屑,死于轮中时下次启动零延迟续传。
  logger.info(
    TAG,
    `round started (resume=${!!context.getKv(KEY_ROUND_INCOMPLETE)})`,
  );
  // 面包屑只是"下次零延迟"的优化:落盘失败不能阻止救援轮次本身。
  try {
    await context.setKv(KEY_ROUND_INCOMPLETE, '1');
  } catch (e) {
    logger.warn(TAG, `cannot persist round marker: ${getErrorMessage(e)}`);
  }
  try {
    await runConfiguredRound(
      context,
      launchRolledBackVersion,
      resetGeneration,
      configJson,
      config,
      appKey,
    );
  } finally {
    try {
      await context.removeKv(KEY_ROUND_INCOMPLETE);
    } catch (e) {
      // 残留标记只意味着下次启动少等 5 秒。
      logger.warn(TAG, `cannot clear round marker: ${getErrorMessage(e)}`);
    }
  }
}

// 配置端点全为 https 时,网络下发的端点列表/制品 URL 一律拒绝明文 http:
// @ohos.net.http 内部跟随重定向且不暴露最终 URL,这是鸿蒙侧唯一能做的
// https→http 降级防线(SR-1);其余依赖宿主 network_config.json 的
// cleartextTrafficPermitted:false(见 harmony/pushy/src/README.md)。
function isHttpsOnly(config: NativeConfig): boolean {
  const endpoints = config.endpoints ?? [];
  return (
    endpoints.length > 0 &&
    endpoints.every(endpoint => isHttpsUrl(endpoint))
  );
}

function isHttpsUrl(url: string): boolean {
  return typeof url === 'string' && url.toLowerCase().startsWith('https://');
}

function isCleartextUrl(url: string): boolean {
  return typeof url === 'string' && url.toLowerCase().startsWith('http://');
}

async function runConfiguredRound(
  context: UpdateContext,
  launchRolledBackVersion: string,
  resetGeneration: number,
  configJson: string,
  config: NativeConfig,
  appKey: string,
): Promise<void> {
  const currentVersion = context.getCurrentVersion();
  // getConstants consumes the persisted rollback marker during startup; use
  // the launch-path snapshot captured before that happens.
  const rolledBackVersion = launchRolledBackVersion;
  const uuid = context.getKv('uuid') ?? '';
  const packageVersion = config.packageVersion || context.getPackageVersion();

  const identity: FlowIdentity = {
    packageVersion,
    currentVersion,
    uuid,
  };
  if (rolledBackVersion) {
    identity.rolledBackVersion = rolledBackVersion;
  }

  const cInfo: FlowCInfo = {
    rnu: config.rnu ?? '',
    rn: config.rn ?? '',
    // RNOH's Platform.Version is osFullName; use the same value so JS can
    // reuse the response cache produced by this native request.
    os: `harmony ${deviceInfo.osFullName}`,
    uuid,
  };

  const input: FlowCheckInput = {
    packageVersion: identity.packageVersion,
    currentVersion,
    buildTime: context.getBuildTime(),
    cInfo,
    supportedDiffVersion: NativePatchCore.getSupportedDiffVersion(),
    bundleHash: await context.getBundleHash(),
  };
  const body = NativePatchCore.buildCheckRequestBody(JSON.stringify(input));
  if (!body) {
    return;
  }

  const httpsOnly = isHttpsOnly(config);
  const responseText = await runCheckRequest(config, appKey, body, httpsOnly);
  if (!responseText) {
    logger.warn(TAG, 'no endpoint reachable, giving up until next launch');
    return;
  }
  // Anchor cache freshness to response arrival, before download/patch work.
  const responseAtSeconds = Math.floor(Date.now() / 1000);

  const decisionJson = NativePatchCore.handleCheckResponse(
    responseText,
    JSON.stringify(identity),
    config.afterDownload ?? '',
  );
  if (!decisionJson) {
    return;
  }
  const decision = JSON.parse(decisionJson) as Decision;
  if (decision.action !== 'download') {
    await context.commitNativeCheckResult(
      resetGeneration,
      '',
      '',
      false,
      buildResponseCacheJson(configJson, body, responseText, responseAtSeconds),
    );
    logger.info(TAG, `nothing to do (${decision.reason ?? ''})`);
    return;
  }
  const hash = decision.hash ?? '';
  if (!isSafePathComponent(hash)) {
    logger.warn(TAG, 'decision carries an unsafe hash, ignoring');
    return;
  }

  let downloaded = context.hasDownloadedVersion(hash);
  if (downloaded) {
    logger.info(TAG, `${hash} already installed, skipping download`);
  } else {
    logger.info(TAG, `downloading ${hash}`);
    downloaded = await performAttempts(
      context,
      decision.attempts ?? [],
      hash,
      currentVersion,
      httpsOnly,
    );
  }
  if (!downloaded) {
    logger.warn(TAG, `all download attempts for ${hash} failed`);
    await context.commitNativeCheckResult(
      resetGeneration,
      '',
      '',
      false,
      buildResponseCacheJson(configJson, body, responseText, responseAtSeconds),
    );
    return;
  }

  // 与 JS 侧下载成功后的 setLocalHashInfo 对齐,持久化版本元信息。
  const info = decision.info;
  let hashInfoJson = '';
  if (info) {
    const hashInfo: DecisionInfo = {};
    if (typeof info.name === 'string') {
      hashInfo.name = info.name;
    }
    if (typeof info.description === 'string') {
      hashInfo.description = info.description;
    }
    if (typeof info.metaInfo === 'string') {
      hashInfo.metaInfo = info.metaInfo;
    }
    // forceBoot 激活就是救砖路径:记进持久化元信息,这个版本活到 markSuccess
    // 时 JS 上报 forceBootRescue。只认服务端下发的指令——静默策略的激活是
    // 普通投递(Android/iOS 同一规则)。
    if (info.config && info.config.forceBoot) {
      hashInfo.forceBootRescue = true;
    }
    hashInfoJson = JSON.stringify(hashInfo);
  }

  // 版本元信息、激活与响应缓存一次性原子提交(见 commitNativeCheckResult);
  // 缓存只在原生文件/状态工作结束后公开,避免 JS 观察到响应后并发下载。
  // 静默策略、或服务端按版本标记的 forceBoot(远程覆盖,救砖指令)才激活。
  const activate = decision.activate === true;
  let committed = false;
  try {
    committed = await context.commitNativeCheckResult(
      resetGeneration,
      hash,
      hashInfoJson,
      activate,
      buildResponseCacheJson(configJson, body, responseText, responseAtSeconds),
    );
  } catch (e) {
    logger.error(TAG, `commit failed: ${getErrorMessage(e)}`);
    return;
  }
  if (!committed) {
    logger.warn(TAG, 'reset during round, dropping result');
  } else if (activate) {
    logger.info(TAG, `downloaded ${hash} and set for next launch`);
  } else {
    logger.info(TAG, `downloaded ${hash}, activation left to JS`);
  }
}

function buildResponseCacheJson(
  configJson: string,
  requestBody: string,
  responseText: string,
  responseAtSeconds: number,
): string {
  const cacheEntry: RespCacheEntry = {
    ts: responseAtSeconds,
    body: responseText,
    request: requestBody,
    config: configJson,
  };
  return JSON.stringify(cacheEntry);
}

function isValidCheckResponse(responseText: string | undefined): boolean {
  if (responseText === undefined) {
    return false;
  }
  try {
    return NativePatchCore.isValidCheckResponse(responseText);
  } catch (e) {
    return false;
  }
}

async function httpRequest(
  url: string,
  postBody?: string,
): Promise<string | undefined> {
  const client = http.createHttp();
  let callTimer: number | null = null;
  try {
    const header: Record<string, string> = { Accept: 'application/json' };
    if (postBody !== undefined) {
      header['Content-Type'] = 'application/json';
    }
    const requestPromise = client.request(url, {
      method: postBody !== undefined
        ? http.RequestMethod.POST
        : http.RequestMethod.GET,
      header,
      extraData: postBody,
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
      expectDataType: http.HttpDataType.STRING,
    });
    const timeoutPromise = new Promise<http.HttpResponse>((_, reject) => {
      callTimer = setTimeout(() => {
        reject(Error(`HTTP request exceeded ${REQUEST_CALL_TIMEOUT_MS}ms`));
      }, REQUEST_CALL_TIMEOUT_MS);
    });
    const response = await Promise.race([requestPromise, timeoutPromise]);
    if (
      response.responseCode >= 200 &&
      response.responseCode < 300 &&
      typeof response.result === 'string'
    ) {
      return response.result;
    }
    return undefined;
  } catch (e) {
    return undefined;
  } finally {
    if (callTimer !== null) {
      clearTimeout(callTimer);
    }
    client.destroy();
  }
}

// 顺序回退(§5.1):按纯层给出的候选序逐个请求,单请求超时;整轮失败后经
// queryUrls 发现远程候选(排除已试过的)再来一轮。刻意不做 hedged race——
// 该路径对延迟不敏感。
async function runCheckRequest(
  config: NativeConfig,
  appKey: string,
  body: string,
  httpsOnly: boolean,
): Promise<string | undefined> {
  const orderedJson = NativePatchCore.orderEndpointCandidates(
    JSON.stringify(config.endpoints ?? []),
    Math.random(),
  );
  if (!orderedJson) {
    return undefined;
  }
  const ordered = JSON.parse(orderedJson) as string[];
  const tried = new Set<string>();
  let httpAttempts = 0;
  for (const rawBase of ordered) {
    const base = normalizeEndpointBase(rawBase);
    if (!base || tried.has(base)) {
      continue;
    }
    if (httpAttempts++ >= MAX_CHECK_HTTP_ATTEMPTS) {
      return undefined;
    }
    tried.add(base);
    const response = await httpRequest(`${base}/checkUpdate/${appKey}`, body);
    if (isValidCheckResponse(response)) {
      return response;
    }
  }
  for (const listUrl of config.queryUrls ?? []) {
    if (!listUrl) {
      continue;
    }
    if (httpAttempts++ >= MAX_CHECK_HTTP_ATTEMPTS) {
      return undefined;
    }
    const listText = await httpRequest(listUrl);
    if (listText === undefined) {
      continue;
    }
    let remote: string[];
    try {
      const parsed = JSON.parse(listText) as Object;
      if (!Array.isArray(parsed)) {
        continue;
      }
      remote = parsed as string[];
    } catch (e) {
      continue;
    }
    for (const rawBase of remote) {
      if (typeof rawBase !== 'string') {
        continue;
      }
      const base = normalizeEndpointBase(rawBase);
      if (!base || tried.has(base)) {
        continue;
      }
      if (httpsOnly && !isHttpsUrl(base)) {
        // 远程注入的端点不得把 https 配置降级成明文。
        logger.warn(TAG, `ignoring non-https remote endpoint ${base}`);
        continue;
      }
      if (httpAttempts++ >= MAX_CHECK_HTTP_ATTEMPTS) {
        return undefined;
      }
      tried.add(base);
      const response = await httpRequest(`${base}/checkUpdate/${appKey}`, body);
      if (isValidCheckResponse(response)) {
        return response;
      }
    }
    // 拉到一份可解析的远程列表就够了。
    break;
  }
  return undefined;
}

function normalizeEndpointBase(base: string): string {
  return base.replace(/\/+$/, '');
}

async function runWithinDeadline(
  start: () => Promise<void>,
  deadlineUptimeMs: number,
): Promise<void> {
  const remainingMs = deadlineUptimeMs - monotonicNowMs();
  if (remainingMs <= 0) {
    throw createUpdateError(
      ERROR_DOWNLOAD_FAILED,
      'Download phase deadline expired before start',
    );
  }
  let deadlineTimer = 0;
  const deadlinePromise = new Promise<void>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(
        createUpdateError(
          ERROR_DOWNLOAD_FAILED,
          'Download phase deadline exceeded',
        ),
      );
    }, remainingMs);
  });
  try {
    // This bounds queueing, HTTP, decompression and native hpatch work from
    // the orchestrator's perspective. The serialized task may still finish
    // later, but it can no longer prevent the response cache from settling.
    await Promise.race([start(), deadlinePromise]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function performAttempts(
  context: UpdateContext,
  attempts: DecisionAttempt[],
  hash: string,
  originHash: string,
  httpsOnly: boolean,
): Promise<boolean> {
  const incrementalDeadline = monotonicNowMs() + DOWNLOAD_PHASE_TIMEOUT_MS;
  let fullDeadline = 0;
  for (const attempt of attempts) {
    const type = attempt.type ?? '';
    if (type === DOWNLOAD_TYPE_DIFF && !originHash) {
      // diff 以当前运行版本为源;没有运行中的热更版本就跳过。
      continue;
    }
    const isFullAttempt =
      type !== DOWNLOAD_TYPE_DIFF && type !== DOWNLOAD_TYPE_PDIFF;
    if (isFullAttempt && fullDeadline === 0) {
      // Preserve a full 10min rescue budget even when diff/pdiff exhausted
      // their own phase window.
      fullDeadline = monotonicNowMs() + DOWNLOAD_PHASE_TIMEOUT_MS;
    }
    const deadline = isFullAttempt ? fullDeadline : incrementalDeadline;
    for (const url of attempt.urls ?? []) {
      if (!url) {
        continue;
      }
      if (httpsOnly && isCleartextUrl(url)) {
        // 决策里的明文制品 URL 不得把 https 配置降级(SR-1)。
        logger.warn(TAG, `ignoring cleartext ${type} url ${url}`);
        continue;
      }
      if (monotonicNowMs() >= deadline) {
        if (isFullAttempt) {
          return false;
        }
        break;
      }
      try {
        if (type === DOWNLOAD_TYPE_DIFF) {
          await runWithinDeadline(
            () => context.downloadPatchFromPpk(url, hash, originHash, deadline),
            deadline,
          );
        } else if (type === DOWNLOAD_TYPE_PDIFF) {
          await runWithinDeadline(
            () => context.downloadPatchFromPackage(url, hash, deadline),
            deadline,
          );
        } else {
          await runWithinDeadline(
            () => context.downloadFullUpdate(url, hash, deadline),
            deadline,
          );
        }
        return true;
      } catch (e) {
        logger.warn(TAG, `${type} attempt failed: ${getErrorMessage(e)}`);
      }
    }
  }
  return false;
}
