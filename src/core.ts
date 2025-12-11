import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { emptyModule, log } from './utils';
const {
  version: v,
} = require('react-native/Libraries/Core/ReactNativeVersion');
const RNVersion = `${v.major}.${v.minor}.${v.patch}`;
const isTurboModuleEnabled =
  // https://github.com/facebook/react-native/pull/48362
  (global as any).__turboModuleProxy || (global as any).RN$Bridgeless;

export const PushyModule =
  Platform.OS === 'web'
    ? emptyModule
    : isTurboModuleEnabled
    ? require('./NativePushy').default
    : NativeModules.Pushy;

export const UpdateModule = PushyModule;

if (!PushyModule) {
  throw Error(
    'Failed to load react-native-update native module, please try to recompile',
  );
}

const PushyConstants = isTurboModuleEnabled
  ? PushyModule.getConstants()
  : PushyModule;

export const downloadRootDir: string = PushyConstants.downloadRootDir;
export const packageVersion: string = PushyConstants.packageVersion;
export const currentVersion: string = PushyConstants.currentVersion;

export function setLocalHashInfo(hash: string, info: Record<string, any>) {
  PushyModule.setLocalHashInfo(hash, JSON.stringify(info));
}

const currentVersionInfoString: string = PushyConstants.currentVersionInfo;
let _currentVersionInfo: Record<string, any> = {};
let isDebugChannel = false;
if (currentVersionInfoString) {
  try {
    _currentVersionInfo = JSON.parse(currentVersionInfoString);
    if (_currentVersionInfo.debugChannel) {
      isDebugChannel = true;
      delete _currentVersionInfo.debugChannel;
      setLocalHashInfo(currentVersion, _currentVersionInfo);
    }
  } catch (error) {
    console.error(
      'Failed to parse currentVersionInfo:',
      currentVersionInfoString,
    );
  }
}
export const currentVersionInfo = _currentVersionInfo;

export const isFirstTime: boolean = PushyConstants.isFirstTime;
export const isFirstTimeDebug: boolean = isFirstTime && isDebugChannel;
export const rolledBackVersion: string = PushyConstants.rolledBackVersion;
export const isRolledBack: boolean = !!rolledBackVersion;

export const buildTime: string = PushyConstants.buildTime;
let uuid = PushyConstants.uuid;


async function getLocalHashInfo(hash: string) {
  return JSON.parse(await PushyModule.getLocalHashInfo(hash));
}

// @deprecated use currentVersionInfo instead
export async function getCurrentVersionInfo(): Promise<{
  name?: string;
  description?: string;
  metaInfo?: string;
}> {
  return currentVersion ? (await getLocalHashInfo(currentVersion)) || {} : {};
}

export const pushyNativeEventEmitter = new NativeEventEmitter(PushyModule);

if (!uuid) {
  uuid = require('nanoid/non-secure').nanoid();
  PushyModule.setUuid(uuid);
}

log('uuid: ' + uuid);

export const cInfo = {
  rnu: require('../package.json').version,
  rn: RNVersion,
  os: Platform.OS + ' ' + Platform.Version,
  uuid,
};
