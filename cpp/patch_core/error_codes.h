#ifndef PUSHY_PATCH_CORE_ERROR_CODES_H_
#define PUSHY_PATCH_CORE_ERROR_CODES_H_

// Single source of truth for the stable, machine-readable error codes shared
// by every platform. Native modules reject promises with one of these codes
// so the JS layer (src/error.ts UpdateErrorCode) and user loggers can
// aggregate errors across platforms and locales.
//
// Mirrors that cannot include this header MUST stay in sync by hand:
//   - src/error.ts                      (UpdateErrorCode union, JS layer)
//   - android/.../ErrorCodes.java      (Java constants)
// iOS (RCTPushy.mm) includes this header directly.
//
// Human-readable messages are NOT part of this contract: they may differ per
// platform and locale. Only the codes are stable.

namespace pushy {
namespace error_codes {

// Method options missing or malformed (blank hash/url, wrong types).
constexpr const char* kInvalidOptions = "INVALID_OPTIONS";
// Native download failed (network error, bad HTTP status, truncated body).
constexpr const char* kDownloadFailed = "DOWNLOAD_FAILED";
// Unzip or hdiff patch application failed.
constexpr const char* kPatchFailed = "PATCH_FAILED";
// Local file or state persistence operation failed.
constexpr const char* kFileOperationFailed = "FILE_OPERATION_FAILED";
// switchVersion / setNeedUpdate state transition failed.
constexpr const char* kSwitchVersionFailed = "SWITCH_VERSION_FAILED";
// markSuccess state transition failed.
constexpr const char* kMarkSuccessFailed = "MARK_SUCCESS_FAILED";
// reloadUpdate / restartApp failed.
constexpr const char* kRestartFailed = "RESTART_FAILED";
// resetToPackagedBundle failed (state wipe or cleanup could not run), or the
// installed native module predates the method (JS-layer detection).
constexpr const char* kResetFailed = "RESET_FAILED";
// Stored or provided hash info is not a valid JSON object.
constexpr const char* kInvalidHashInfo = "INVALID_HASH_INFO";
// The method is not supported on this platform (e.g. downloadAndInstallApk
// outside Android).
constexpr const char* kUnsupportedPlatform = "UNSUPPORTED_PLATFORM";

}  // namespace error_codes
}  // namespace pushy

#endif  // PUSHY_PATCH_CORE_ERROR_CODES_H_
