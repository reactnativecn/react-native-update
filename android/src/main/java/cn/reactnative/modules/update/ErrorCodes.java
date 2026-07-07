package cn.reactnative.modules.update;

/**
 * Stable, machine-readable error codes used as the promise rejection code so
 * the JS layer and user loggers can aggregate errors across platforms.
 *
 * MUST stay in sync with cpp/patch_core/error_codes.h (the single source of
 * truth) and src/error.ts (UpdateErrorCode). Messages are free-form; only the
 * codes are part of the contract.
 */
final class ErrorCodes {
    static final String INVALID_OPTIONS = "INVALID_OPTIONS";
    static final String DOWNLOAD_FAILED = "DOWNLOAD_FAILED";
    static final String PATCH_FAILED = "PATCH_FAILED";
    static final String FILE_OPERATION_FAILED = "FILE_OPERATION_FAILED";
    static final String SWITCH_VERSION_FAILED = "SWITCH_VERSION_FAILED";
    static final String MARK_SUCCESS_FAILED = "MARK_SUCCESS_FAILED";
    static final String RESTART_FAILED = "RESTART_FAILED";
    static final String INVALID_HASH_INFO = "INVALID_HASH_INFO";
    static final String UNSUPPORTED_PLATFORM = "UNSUPPORTED_PLATFORM";

    private ErrorCodes() {
    }
}
