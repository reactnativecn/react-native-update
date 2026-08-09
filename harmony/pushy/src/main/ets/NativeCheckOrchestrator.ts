import http from '@ohos.net.http';
import deviceInfo from '@ohos.deviceInfo';
import logger from './Logger';
import NativePatchCore from './NativePatchCore';
import type { UpdateContext } from './UpdateContext';

// 原生冷启动检测(NATIVE_CHECKUPDATE_DESIGN §10):每进程一次,getBundleUrl
// 后延迟数秒运行,完全不依赖 app bundle——坏热更把 JS 砸挂后,下次启动仍能
// 拉到修复版。决策全部来自 cpp/update_flow_core(经 NativePatchCore 的
// NAPI 面),本文件只是 IO 胶水。失败静默且有界:每次启动至多一轮,无重试
// 风暴,不拉黑版本。
// 鸿蒙的 debug 门控由触发点天然承担:dev 走 MetroJSBundleProvider,
// PushyFileJSBundleProvider.getBundleUrl 不会被调用。
const TAG = 'NativeCheck';
const KEY_CONFIG = 'nativeConfig';
// 供 JS 侧复用的原始响应缓存(§10.3),同时记录请求与配置指纹以限定命中范围。
const KEY_RESP_CACHE = 'nativeCheckResp';
const REQUEST_TIMEOUT_MS = 10000;
const START_DELAY_MS = 5000;
const DOWNLOAD_TYPE_DIFF = 'diff';
const DOWNLOAD_TYPE_PDIFF = 'pdiff';

interface NativeConfig {
  appKey?: string;
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

interface DecisionInfo {
  name?: string;
  description?: string;
  metaInfo?: string;
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

export function scheduleNativeCheck(
  context: UpdateContext,
  launchRolledBackVersion: string,
): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  // 结果本来就是"下次启动生效",延迟几秒让开冷启动关键路径(§7 R5)。
  setTimeout(() => {
    runOnce(context, launchRolledBackVersion).catch((e: Object) => {
      // 救援路径自身绝不能把应用拖垮。
      logger.error(TAG, `native check failed: ${e}`);
    });
  }, START_DELAY_MS);
}

async function runOnce(
  context: UpdateContext,
  launchRolledBackVersion: string,
): Promise<void> {
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

  const currentVersion = context.getCurrentVersion();
  // getConstants consumes the persisted rollback marker during startup; use
  // the launch-path snapshot captured before that happens.
  const rolledBackVersion = launchRolledBackVersion;
  const uuid = context.getKv('uuid') ?? '';

  const identity: FlowIdentity = {
    packageVersion: context.getPackageVersion(),
    currentVersion,
    uuid,
  };
  if (rolledBackVersion) {
    identity.rolledBackVersion = rolledBackVersion;
  }

  const cInfo: FlowCInfo = {
    rnu: config.rnu ?? '',
    rn: config.rn ?? '',
    os: `harmony ${deviceInfo.sdkApiVersion}`,
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

  const responseText = await runCheckRequest(config, appKey, body);
  if (!responseText) {
    logger.debug(TAG, 'no endpoint reachable, giving up until next launch');
    return;
  }

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
    persistResponseCache(context, configJson, body, responseText);
    logger.debug(TAG, `nothing to do (${decision.reason ?? ''})`);
    return;
  }
  const hash = decision.hash ?? '';
  if (!hash) {
    return;
  }

  let downloaded = context.hasDownloadedVersion(hash);
  if (!downloaded) {
    downloaded = await performAttempts(
      context,
      decision.attempts ?? [],
      hash,
      currentVersion,
    );
  }
  if (!downloaded) {
    persistResponseCache(context, configJson, body, responseText);
    return;
  }

  // 与 JS 侧下载成功后的 setLocalHashInfo 对齐,持久化版本元信息。
  const info = decision.info;
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
    context.setKv(`hash_${hash}`, JSON.stringify(hashInfo));
  }

  if (decision.activate === true) {
    // 静默策略、或服务端按版本标记的 forceBoot(远程覆盖,救砖指令):激活
    // 到下次启动;否则激活权留给 JS(§6)。
    try {
      context.switchVersion(hash);
      logger.debug(TAG, `downloaded ${hash} and set for next launch`);
    } catch (e) {
      logger.error(TAG, `switchVersion failed: ${e}`);
    }
  } else {
    logger.debug(TAG, `downloaded ${hash}, activation left to JS`);
  }
  // 仅在原生文件/状态工作结束后公开缓存,避免 JS 观察到响应后并发下载。
  persistResponseCache(context, configJson, body, responseText);
}

function persistResponseCache(
  context: UpdateContext,
  configJson: string,
  requestBody: string,
  responseText: string,
): void {
  const cacheEntry: RespCacheEntry = {
    ts: Math.floor(Date.now() / 1000),
    body: responseText,
    request: requestBody,
    config: configJson,
  };
  context.setKv(KEY_RESP_CACHE, JSON.stringify(cacheEntry));
}

function isValidCheckResponse(responseText: string | undefined): boolean {
  if (responseText === undefined) {
    return false;
  }
  try {
    const parsed = JSON.parse(responseText) as Object | null;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch (e) {
    return false;
  }
}

async function httpRequest(
  url: string,
  postBody?: string,
): Promise<string | undefined> {
  const client = http.createHttp();
  try {
    const header: Record<string, string> = { Accept: 'application/json' };
    if (postBody !== undefined) {
      header['Content-Type'] = 'application/json';
    }
    const response = await client.request(url, {
      method: postBody !== undefined
        ? http.RequestMethod.POST
        : http.RequestMethod.GET,
      header,
      extraData: postBody,
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
      expectDataType: http.HttpDataType.STRING,
    });
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
  for (const base of ordered) {
    if (!base) {
      continue;
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
    for (const base of remote) {
      if (typeof base !== 'string' || !base || tried.has(base)) {
        continue;
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

async function performAttempts(
  context: UpdateContext,
  attempts: DecisionAttempt[],
  hash: string,
  originHash: string,
): Promise<boolean> {
  for (const attempt of attempts) {
    const type = attempt.type ?? '';
    if (type === DOWNLOAD_TYPE_DIFF && !originHash) {
      // diff 以当前运行版本为源;没有运行中的热更版本就跳过。
      continue;
    }
    for (const url of attempt.urls ?? []) {
      if (!url) {
        continue;
      }
      try {
        if (type === DOWNLOAD_TYPE_DIFF) {
          await context.downloadPatchFromPpk(url, hash, originHash);
        } else if (type === DOWNLOAD_TYPE_PDIFF) {
          await context.downloadPatchFromPackage(url, hash);
        } else {
          await context.downloadFullUpdate(url, hash);
        }
        return true;
      } catch (e) {
        logger.debug(TAG, `${type} attempt failed: ${e}`);
      }
    }
  }
  return false;
}
