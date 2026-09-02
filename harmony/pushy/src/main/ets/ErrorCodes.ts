// ArkTS mirror of cpp/patch_core/error_codes.h — keep in sync by hand
// (harmony/pushy/src/test/check-constant-parity.js asserts the values match).
// 与 Android/iOS 共用的稳定错误码:JS 层(src/error.ts)按 code 聚合遥测,
// 消息文案各平台可不同,只有码是契约。
//
// RNOH 的异步桥以纯字符串 reject,Error 上的 `code` 属性到 JS 侧很可能已丢。
// 因此每个错误的消息都以 `[CODE] ` 前缀开头,JS 鸿蒙分支据此解析回 code。
// 本文件不依赖任何其他模块,任何文件都可安全引用它而不会形成 import 环。

export const ERROR_INVALID_OPTIONS = 'INVALID_OPTIONS';
export const ERROR_DOWNLOAD_FAILED = 'DOWNLOAD_FAILED';
export const ERROR_PATCH_FAILED = 'PATCH_FAILED';
export const ERROR_FILE_OPERATION_FAILED = 'FILE_OPERATION_FAILED';
export const ERROR_SWITCH_VERSION_FAILED = 'SWITCH_VERSION_FAILED';
export const ERROR_MARK_SUCCESS_FAILED = 'MARK_SUCCESS_FAILED';
export const ERROR_RESTART_FAILED = 'RESTART_FAILED';
export const ERROR_RESET_FAILED = 'RESET_FAILED';
export const ERROR_INVALID_HASH_INFO = 'INVALID_HASH_INFO';
export const ERROR_UNSUPPORTED_PLATFORM = 'UNSUPPORTED_PLATFORM';
export const ERROR_APK_INSTALL_PERMISSION_REQUIRED =
  'APK_INSTALL_PERMISSION_REQUIRED';
export const ERROR_APK_INSTALL_FAILED = 'APK_INSTALL_FAILED';

/**
 * 带稳定错误码的 Error:`code` 是属性,消息同时带 `[CODE] ` 前缀(桥丢属性时
 * JS 仍能解析)。始终经 createUpdateError / toUpdateError 构造。
 */
export class UpdateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'UpdateError';
    this.code = code;
  }
}

/** 任意抛出值的可读消息(Error 取 message,其余 String())。 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as Record<string, unknown>).message);
  }
  return String(error);
}

export function createUpdateError(code: string, message: string): UpdateError {
  return new UpdateError(code, message);
}

/**
 * 给未带码的错误补上 `code`:已是 UpdateError 的原样返回(保留其更精确的码
 * 与前缀,绝不叠两层前缀),其余按 defaultCode 重包并保留原消息。
 */
export function toUpdateError(error: unknown, defaultCode: string): UpdateError {
  if (error instanceof UpdateError) {
    return error;
  }
  return new UpdateError(defaultCode, getErrorMessage(error));
}

/** 从 `[CODE] message` 形式的消息里解析错误码;无前缀返回空串。 */
export function parseErrorCodePrefix(message: string): string {
  if (typeof message !== 'string' || !message.startsWith('[')) {
    return '';
  }
  const end = message.indexOf('] ');
  if (end <= 1) {
    return '';
  }
  const code = message.substring(1, end);
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : '';
}
