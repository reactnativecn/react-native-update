package cn.reactnative.modules.update;

import androidx.annotation.Nullable;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

public class UpdateModuleImpl {

    public static final String NAME = "Pushy";

    private UpdateModuleImpl() {
    }

    private static boolean isValidHashInfo(@Nullable String json) {
        if (json == null) {
            return false;
        }
        try {
            return new JSONTokener(json).nextValue() instanceof JSONObject;
        } catch (JSONException e) {
            return false;
        }
    }

    public static void downloadFullUpdate(
        UpdateContext updateContext,
        final ReadableMap options,
        final Promise promise
    ) {
        String url = options.getString("updateUrl");
        String hash = options.getString("hash");
        updateContext.downloadFullUpdate(url, hash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(downloadErrorCode(error), error);
            }
        });
    }

    // Post-download failures (unzip / hdiff / resource copy, incl. copiesCrc
    // verification) reject as PATCH_FAILED so JS-side telemetry can separate
    // patch health from network health. DownloadTask wraps them.
    private static String downloadErrorCode(Throwable error) {
        return error instanceof PatchFailedException
            ? ErrorCodes.PATCH_FAILED
            : ErrorCodes.DOWNLOAD_FAILED;
    }

    public static void downloadAndInstallApk(
        final ReactApplicationContext reactContext,
        UpdateContext updateContext,
        final ReadableMap options,
        final Promise promise
    ) {
        final String url = options.getString("url");
        String hash = options.getString("hash");
        String target = options.getString("target");
        if (!ApkInstaller.ensureInstallPermission(reactContext, promise)) {
            return;
        }
        updateContext.downloadFile(url, hash, target, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                ApkInstaller.install(reactContext, params.targetFile, url, promise);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(ErrorCodes.DOWNLOAD_FAILED, error);
            }
        });
    }

    public static void downloadPatchFromPackage(
        UpdateContext updateContext,
        final ReadableMap options,
        final Promise promise
    ) {
        String url = options.getString("updateUrl");
        String hash = options.getString("hash");
        updateContext.downloadPatchFromApk(url, hash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(downloadErrorCode(error), error);
            }
        });
    }

    public static void downloadPatchFromPpk(
        UpdateContext updateContext,
        final ReadableMap options,
        final Promise promise
    ) {
        try {
            String url = options.getString("updateUrl");
            String hash = options.getString("hash");
            String originHash = options.getString("originHash");

            updateContext.downloadPatchFromPpk(url, hash, originHash, new UpdateContext.DownloadFileListener() {
                @Override
                public void onDownloadCompleted(DownloadTaskParams params) {
                    promise.resolve(null);
                }

                @Override
                public void onDownloadFailed(Throwable error) {
                    promise.reject(downloadErrorCode(error), error);
                }
            });
        } catch (Exception e) {
            promise.reject(ErrorCodes.INVALID_OPTIONS, "downloadPatchFromPpk failed: " + e.getMessage(), e);
        }
    }

    public static void reloadUpdate(
        final UpdateContext updateContext,
        final ReactApplicationContext reactContext,
        final ReadableMap options,
        final Promise promise
    ) {
        restartApp(updateContext, reactContext, options.getString("hash"), promise);
    }

    public static void restartApp(
        final UpdateContext updateContext,
        final ReactApplicationContext reactContext,
        @Nullable final String hash,
        final Promise promise
    ) {
        UiThreadRunner.run(promise, ErrorCodes.RESTART_FAILED, "restartApp", new UiThreadRunner.Operation() {
            @Override
            public void run() throws Throwable {
                ReactReloadManager.restartApp(updateContext, reactContext, hash);
                promise.resolve(true);
            }
        });
    }

    private static void setNeedUpdateInternal(UpdateContext updateContext, String hash) {
        updateContext.switchVersion(hash);
    }

    public static void setNeedUpdate(
        final UpdateContext updateContext,
        final ReadableMap options,
        final Promise promise
    ) {
        final String hash = options.getString("hash");
        StateSerialRunner.run(promise, ErrorCodes.SWITCH_VERSION_FAILED, "switchVersionLater", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                setNeedUpdateInternal(updateContext, hash);
                promise.resolve(true);
            }
        });
    }

    public static void setNeedUpdate(final UpdateContext updateContext, final ReadableMap options) {
        final String hash = options.getString("hash");
        StateSerialRunner.run(null, ErrorCodes.SWITCH_VERSION_FAILED, "switchVersionLater", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                setNeedUpdateInternal(updateContext, hash);
            }
        });
    }

    private static void markSuccessInternal(UpdateContext updateContext) {
        updateContext.markSuccess();
    }

    public static void markSuccess(final UpdateContext updateContext, final Promise promise) {
        StateSerialRunner.run(promise, ErrorCodes.MARK_SUCCESS_FAILED, "markSuccess", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                markSuccessInternal(updateContext);
                promise.resolve(true);
            }
        });
    }

    public static void markSuccess(final UpdateContext updateContext) {
        StateSerialRunner.run(null, ErrorCodes.MARK_SUCCESS_FAILED, "markSuccess", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                markSuccessInternal(updateContext);
            }
        });
    }

    public static void getBundleHash(final UpdateContext updateContext, final Promise promise) {
        // Threading lives in UpdateContext (download executor); resolve is
        // thread-safe. Never rejects — empty string means "unknown".
        updateContext.getBundleHash(new UpdateContext.BundleHashListener() {
            @Override
            public void onBundleHash(String hash) {
                promise.resolve(hash);
            }
        });
    }

    public static void resetToPackagedBundle(
        final UpdateContext updateContext,
        final Promise promise
    ) {
        StateSerialRunner.run(promise, ErrorCodes.RESET_FAILED, "resetToPackagedBundle", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                updateContext.resetToPackagedBundle();
                promise.resolve(true);
            }
        });
    }

    /**
     * Raw response cached by the native cold-start check, for the JS side to
     * reuse instead of re-checking (§10.3). Empty string when absent; never
     * rejects.
     */
    public static void getNativeCheckCache(
        final UpdateContext updateContext,
        final Promise promise
    ) {
        String cached = updateContext.getKv(NativeCheckOrchestrator.KEY_RESP_CACHE);
        promise.resolve(cached == null ? "" : cached);
    }

    private static void setUuidInternal(UpdateContext updateContext, String uuid) {
        updateContext.setKv("uuid", uuid);
    }

    /**
     * Provisioning for the native cold-start update check
     * (NATIVE_CHECKUPDATE_DESIGN §10.1): the raw JSON persists as-is and is
     * parsed on read by the orchestrator; absent config = check disabled.
     * Validated at write time — a corrupt config would otherwise silently
     * disable the native check forever with no signal.
     */
    public static void syncNativeConfig(
        final UpdateContext updateContext,
        final String config,
        final Promise promise
    ) {
        if (config == null || config.isEmpty()) {
            promise.reject(ErrorCodes.INVALID_OPTIONS, "config must be a JSON object string");
            return;
        }
        try {
            new JSONObject(config);
        } catch (JSONException e) {
            promise.reject(ErrorCodes.INVALID_OPTIONS, "config must be a JSON object string", e);
            return;
        }
        StateSerialRunner.run(promise, ErrorCodes.FILE_OPERATION_FAILED, "syncNativeConfig", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                updateContext.setKv(NativeCheckOrchestrator.KEY_CONFIG, config);
                promise.resolve(true);
            }
        });
    }

    public static void setUuid(
        final UpdateContext updateContext,
        final String uuid,
        final Promise promise
    ) {
        StateSerialRunner.run(promise, ErrorCodes.FILE_OPERATION_FAILED, "setUuid", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                setUuidInternal(updateContext, uuid);
                promise.resolve(true);
            }
        });
    }

    public static void setUuid(final UpdateContext updateContext, final String uuid) {
        StateSerialRunner.run(null, ErrorCodes.FILE_OPERATION_FAILED, "setUuid", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                setUuidInternal(updateContext, uuid);
            }
        });
    }

    private static void setLocalHashInfoInternal(
        UpdateContext updateContext,
        String hash,
        String info
    ) {
        if (!isValidHashInfo(info)) {
            throw new IllegalArgumentException("invalid json string");
        }
        updateContext.setKv("hash_" + hash, info);
    }

    public static void setLocalHashInfo(
        final UpdateContext updateContext,
        final String hash,
        final String info,
        final Promise promise
    ) {
        StateSerialRunner.run(promise, ErrorCodes.INVALID_HASH_INFO, "setLocalHashInfo", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                setLocalHashInfoInternal(updateContext, hash, info);
                promise.resolve(true);
            }
        });
    }

    public static void setLocalHashInfo(
        final UpdateContext updateContext,
        final String hash,
        final String info
    ) {
        StateSerialRunner.run(null, ErrorCodes.INVALID_HASH_INFO, "setLocalHashInfo", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                setLocalHashInfoInternal(updateContext, hash, info);
            }
        });
    }

    public static void getLocalHashInfo(
        UpdateContext updateContext,
        final String hash,
        final Promise promise
    ) {
        String value = updateContext.getKv("hash_" + hash);
        if (!isValidHashInfo(value)) {
            promise.reject(ErrorCodes.INVALID_HASH_INFO, "getLocalHashInfo failed: invalid json string");
            return;
        }

        promise.resolve(value);
    }
}
