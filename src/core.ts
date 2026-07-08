import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import i18n from './i18n';
import { UpdateError } from './error';
import { emptyModule, error, log } from './utils';

/* eslint-disable @react-native/no-deep-imports */
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
	throw new UpdateError(
		'Failed to load react-native-update native module, please try to recompile',
		'MODULE_NOT_LOADED',
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
	} catch {
		error(
			i18n.t('error_parse_version_info', { info: currentVersionInfoString }),
		);
	}
}
export const currentVersionInfo = _currentVersionInfo;

export const isFirstTime: boolean = PushyConstants.isFirstTime;
export const isFirstTimeDebug: boolean = isFirstTime && isDebugChannel;
export const rolledBackVersion: string = PushyConstants.rolledBackVersion;
export const isRolledBack: boolean = !!rolledBackVersion;

export const buildTime: string = PushyConstants.buildTime;
// 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道:HBC 变换 +
// 流式容器);旧原生无此常量时为 0(不上报,服务端只发 baseline)
export const supportedDiffVersion: number =
	PushyConstants.supportedDiffVersion || 0;
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
	// If persisting fails the uuid drifts on every launch, which skews gray
	// release bucketing and inflates stats — log it instead of failing silently.
	Promise.resolve(PushyModule.setUuid(uuid)).catch((e: any) => {
		log('setUuid error:', e?.message || e);
	});
}

export const cInfo = {
	rnu: require('../package.json').version,
	rn: RNVersion,
	os: `${Platform.OS} ${Platform.Version}`,
	uuid,
};

log('bootup status', {
	packageVersion,
	currentVersion,
	currentVersionInfo,
	isFirstTime,
	isFirstTimeDebug,
	isDebugChannel,
	cInfo,
});
