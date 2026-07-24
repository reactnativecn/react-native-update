/**
 * Stable, machine-readable error codes. Unlike messages (which are localized
 * and vary across platforms), codes are safe to aggregate on in a logger.
 *
 * The native-originated codes (second group) are defined in
 * cpp/patch_core/error_codes.h — the single source of truth shared by the
 * Android/iOS/Harmony modules — and flow through promise rejections onto the
 * `code` property, which toUpdateError() preserves.
 */
export type UpdateErrorCode =
  // JS-layer codes
  | 'MODULE_NOT_LOADED'
  | 'APPKEY_REQUIRED'
  | 'NO_ENDPOINTS'
  | 'HTTP_STATUS'
  | 'CHECK_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'SWITCH_VERSION_FAILED'
  | 'MARK_SUCCESS_FAILED'
  | 'APK_INSTALL_PENDING'
  | 'STORAGE_PERMISSION_REJECTED'
  | 'STORAGE_PERMISSION_ERROR'
  | 'APK_DOWNLOAD_FAILED'
  // A throw from a user-provided hook (e.g. beforeReload) — not an update
  // pipeline failure, and excluded from server-side patch-health telemetry.
  | 'USER_HOOK_ERROR'
  // Native codes (see cpp/patch_core/error_codes.h)
  | 'INVALID_OPTIONS'
  | 'PATCH_FAILED'
  | 'FILE_OPERATION_FAILED'
  | 'RESTART_FAILED'
  | 'RESET_FAILED'
  | 'INVALID_HASH_INFO'
  | 'UNSUPPORTED_PLATFORM';

const KNOWN_CODES = new Set<string>([
  'MODULE_NOT_LOADED',
  'APPKEY_REQUIRED',
  'NO_ENDPOINTS',
  'HTTP_STATUS',
  'CHECK_FAILED',
  'DOWNLOAD_FAILED',
  'SWITCH_VERSION_FAILED',
  'MARK_SUCCESS_FAILED',
  'APK_INSTALL_PENDING',
  'STORAGE_PERMISSION_REJECTED',
  'STORAGE_PERMISSION_ERROR',
  'APK_DOWNLOAD_FAILED',
  'USER_HOOK_ERROR',
  'INVALID_OPTIONS',
  'PATCH_FAILED',
  'FILE_OPERATION_FAILED',
  'RESTART_FAILED',
  'RESET_FAILED',
  'INVALID_HASH_INFO',
  'UNSUPPORTED_PLATFORM',
]);

/**
 * Narrow an arbitrary `code` property (axios' ERR_NETWORK, Node's
 * ECONNREFUSED, RN's default EUNSPECIFIED, ...) to our stable set; anything
 * else is treated as absent so it never leaks into telemetry aggregation.
 */
export const asUpdateErrorCode = (
  code: unknown
): UpdateErrorCode | undefined =>
  typeof code === 'string' && KNOWN_CODES.has(code)
    ? (code as UpdateErrorCode)
    : undefined;

export class UpdateError extends Error {
  code: UpdateErrorCode;
  cause?: unknown;
  extra?: Record<string, string | number>;

  constructor(
    message: string,
    code: UpdateErrorCode,
    options?: { cause?: unknown; extra?: Record<string, string | number> }
  ) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
    this.cause = options?.cause;
    this.extra = options?.extra;
  }
}

/**
 * Attach a code to an unknown thrown value. An existing Error keeps its
 * identity (message, stack, and any known code already assigned upstream) so
 * callers comparing the caught error to the original still match; non-Error
 * values are wrapped. A foreign `code` (axios/system errors) is overwritten
 * with ours; a frozen/sealed Error that rejects the assignment is wrapped
 * instead (identity is lost only in that edge case).
 */
export const toUpdateError = (
  e: unknown,
  code: UpdateErrorCode
): UpdateError => {
  if (e instanceof Error) {
    const err = e as UpdateError;
    if (!asUpdateErrorCode(err.code)) {
      try {
        err.code = code;
      } catch {}
      if (err.code !== code) {
        return new UpdateError(err.message, code, { cause: err });
      }
    }
    return err;
  }
  return new UpdateError(String(e ?? code), code);
};
