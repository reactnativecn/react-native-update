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
  // Native codes (see cpp/patch_core/error_codes.h)
  | 'INVALID_OPTIONS'
  | 'PATCH_FAILED'
  | 'FILE_OPERATION_FAILED'
  | 'RESTART_FAILED'
  | 'INVALID_HASH_INFO'
  | 'UNSUPPORTED_PLATFORM';

export class UpdateError extends Error {
  code: UpdateErrorCode;
  cause?: unknown;
  extra?: Record<string, string | number>;

  constructor(
    message: string,
    code: UpdateErrorCode,
    options?: { cause?: unknown; extra?: Record<string, string | number> },
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
 * identity (message, stack, and any code already assigned upstream) so callers
 * comparing the caught error to the original still match; non-Error values are
 * wrapped.
 */
export const toUpdateError = (
  e: unknown,
  code: UpdateErrorCode,
): UpdateError => {
  if (e instanceof Error) {
    const err = e as UpdateError;
    if (!err.code) {
      err.code = code;
    }
    return err;
  }
  return new UpdateError(String(e ?? code), code);
};
