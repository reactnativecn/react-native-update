import { logger, promiseAny } from './utils';

let currentEndpoint = 'https://update.react-native.cn/api';
let backupEndpoints: string[] = [
  'https://pushy-koa-qgbgqmcpis.cn-beijing.fcapp.run',
  'https://update.reactnative.cn/api',
];
let backupEndpointsQueryUrls = [
  'https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json',
  'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-pushy@master/endpoints.json',
];

export async function updateBackupEndpoints() {
  if (backupEndpointsQueryUrls) {
    try {
      const resp = await promiseAny(
        backupEndpointsQueryUrls.map((queryUrl) => fetch(queryUrl)),
      );
      const remoteEndpoints = await resp.json();
      if (Array.isArray(remoteEndpoints)) {
        backupEndpoints = Array.from(
          new Set([...backupEndpoints, ...remoteEndpoints]),
        );
        logger('fetch remote endpoints:', remoteEndpoints);
        logger('merged backup endpoints:', backupEndpoints);
      }
    } catch (e: any) {
      logger('fetch remote endpoints failed');
    }
  }
  return backupEndpoints;
}

export function getCheckUrl(APPKEY, endpoint = currentEndpoint) {
  return `${endpoint}/checkUpdate/${APPKEY}`;
}

/**
 * @param {string} main - The main api endpoint
 * @param {string[]} [backups] - The back up endpoints.
 * @param {string} [backupQueryUrl] - An url that return a json file containing an array of endpoint.
 *                                    like: ["https://backup.api/1", "https://backup.api/2"]
 */
export function setCustomEndpoints({
  main,
  backups,
  backupQueryUrls,
}: {
  main: string;
  backups?: string[];
  backupQueryUrls?: string[];
}) {
  currentEndpoint = main;
  if (Array.isArray(backups) && backups.length > 0) {
    backupEndpoints = backups;
  }
  if (Array.isArray(backupQueryUrls) && backupQueryUrls.length > 0) {
    backupEndpointsQueryUrls = backupQueryUrls;
  }
}
