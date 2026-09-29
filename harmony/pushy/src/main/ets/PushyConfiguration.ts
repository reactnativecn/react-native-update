import { POLICY_NEXT_LAUNCH, revealText } from './Texts';

/** Options accepted by PushyFileJSBundleProvider.configure(). */
export interface PushyConfiguration {
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

interface PersistedPushyConfiguration {
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
  revealText('3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5b3d5b9817b592947e5cdefbc8a7e'),
  revealText('3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5f0daac9c644a620ae88ca1ad93'),
];
const DEFAULT_QUERY_URLS: string[] = [
  revealText('3203e0c1bdd1270a253608fcd3fd9362476817f4f0d5a1996342631be3c2a3a9d779552507fdcde8928a6f512f5ce2ccbdc869404d2f1de79daa826d562c0913eec4fa9b7d4426'),
  revealText('3203e0c1bdd1270a213b12b7dca09468462e12f3b0d5bd813d482446f4c6a1be8e79552507fdcda68cd06e5c3710e480a4867048483e55e0c2ab8d7d43030d1ce9c3b183214e2601f2f0d5b782601e2719e8ca'),
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
export function normalizePushyConfiguration(options: PushyConfiguration): string {
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
  if (afterDownload !== 'none' && afterDownload !== POLICY_NEXT_LAUNCH) {
    throw new Error(`Invalid native configuration: afterDownload must be none or ${POLICY_NEXT_LAUNCH}`);
  }
  if (options.disabled !== undefined && typeof options.disabled !== 'boolean') {
    throw new Error('Invalid native configuration: disabled must be a boolean');
  }
  const result: PersistedPushyConfiguration = {
    appKey, endpoints, queryUrls, afterDownload, disabled: options.disabled ?? false,
    rnu: options.rnu === undefined ? '' : configString(options.rnu, 'rnu', true),
    rn: options.rn === undefined ? '' : configString(options.rn, 'rn', true),
  };
  if (options.packageVersion !== undefined) {
    result.packageVersion = configString(options.packageVersion, 'packageVersion', false);
  }
  return JSON.stringify(result);
}
