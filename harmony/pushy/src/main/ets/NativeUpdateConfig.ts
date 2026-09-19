/** Options accepted by PushyFileJSBundleProvider.configure(). */
export interface NativeUpdateConfig {
  appKey: string;
  /** Omitted: Pushy's built-in endpoints. Custom endpoints never inherit discovery URLs. */
  endpoints?: string[];
  queryUrls?: string[];
  /** Default: none. setNeedUpdate selects a downloaded bundle for the NEXT launch. */
  afterDownload?: 'none' | 'setNeedUpdate';
  disabled?: boolean;
  /** Omit to use the installed application's version. */
  packageVersion?: string;
  /** Optional telemetry version strings; not required to check or install an update. */
  rnu?: string;
  rn?: string;
}

interface PersistedNativeUpdateConfig {
  appKey: string;
  endpoints: string[];
  queryUrls: string[];
  afterDownload: string;
  disabled: boolean;
  packageVersion?: string;
  rnu: string;
  rn: string;
}

const DEFAULT_ENDPOINTS: string[] = [
  'https://update.react-native.cn/api',
  'https://update.reactnative.cn/api',
];
const DEFAULT_QUERY_URLS: string[] = [
  'https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json',
  'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json',
];
const CONFIG_KEYS: string[] = [
  'appKey', 'endpoints', 'queryUrls', 'afterDownload', 'disabled',
  'packageVersion', 'rnu', 'rn',
];

function configString(value: string, name: string, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`Invalid native configuration: ${name} must be a string${allowEmpty ? '' : ' and must not be blank'}`);
  }
  return value;
}

function configUrls(values: string[], name: string, base: boolean): string[] {
  if (!Array.isArray(values) || (base && values.length === 0)) {
    throw new Error(`Invalid native configuration: ${name} must be ${base ? 'a non-empty' : 'an'} array`);
  }
  const result: string[] = [];
  for (const value of values) {
    const url = configString(value, name, false).trim();
    // Restrict the authority and scheme, without relying on browser URL globals
    // unavailable in ArkTS. Platform networking performs the final URL parsing.
    if (!/^https?:\/\/(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(:[0-9]+)?([/?#]|$)/.test(url)
        || /\s|\\/.test(url) || (base && /[?#]/.test(url))) {
      throw new Error(`Invalid native configuration: ${name} requires absolute HTTP(S) URLs without credentials${base ? ', queries or fragments' : ''}`);
    }
    const normalized = base ? url.replace(/\/+$/, '') : url;
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

/** Pure validation, before any native state is touched. Does not mutate options. */
export function normalizeNativeUpdateConfig(options: NativeUpdateConfig): string {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid native configuration: expected an object');
  }
  for (const key of Object.keys(options)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new Error(`Invalid native configuration: unknown option ${key}`);
    }
  }
  const appKey = configString(options.appKey, 'appKey', false);
  const customEndpoints = options.endpoints !== undefined;
  const endpoints = configUrls(customEndpoints ? options.endpoints! : DEFAULT_ENDPOINTS, 'endpoints', true);
  const queryUrls = configUrls(
    options.queryUrls !== undefined ? options.queryUrls : (customEndpoints ? [] : DEFAULT_QUERY_URLS),
    'queryUrls', false,
  );
  const afterDownload = options.afterDownload === undefined ? 'none' : options.afterDownload;
  if (afterDownload !== 'none' && afterDownload !== 'setNeedUpdate') {
    throw new Error('Invalid native configuration: afterDownload must be none or setNeedUpdate');
  }
  if (options.disabled !== undefined && typeof options.disabled !== 'boolean') {
    throw new Error('Invalid native configuration: disabled must be a boolean');
  }
  const result: PersistedNativeUpdateConfig = {
    appKey, endpoints, queryUrls, afterDownload, disabled: options.disabled ?? false,
    rnu: options.rnu === undefined ? '' : configString(options.rnu, 'rnu', true),
    rn: options.rn === undefined ? '' : configString(options.rn, 'rn', true),
  };
  if (options.packageVersion !== undefined) {
    result.packageVersion = configString(options.packageVersion, 'packageVersion', false);
  }
  return JSON.stringify(result);
}
