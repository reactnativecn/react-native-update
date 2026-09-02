package cn.reactnative.modules.update;

import android.util.Log;
import androidx.annotation.Nullable;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Everything the "Pushy" native module does, independent of the bridge it is
 * registered with. The old-architecture and new-architecture UpdateModule
 * classes are thin wrappers that only carry their annotations / spec
 * overrides and forward here, so the two cannot drift apart.
 */
public class UpdateModuleImpl {

    public static final String NAME = "Pushy";

    private final ReactApplicationContext reactContext;
    private final UpdateContext updateContext;

    public UpdateModuleImpl(ReactApplicationContext reactContext) {
        this(reactContext, UpdateContext.getInstance(reactContext));
    }

    public UpdateModuleImpl(ReactApplicationContext reactContext, UpdateContext updateContext) {
        this.reactContext = reactContext;
        this.updateContext = updateContext;
        UpdateEventEmitter.register(reactContext);
    }

    public Map<String, Object> getConstants() {
        final Map<String, Object> constants = new HashMap<String, Object>();
        constants.put("downloadRootDir", updateContext.getRootDir());
        constants.put("packageVersion", updateContext.getPackageVersion());

        String currentVersion = updateContext.getCurrentVersion();
        constants.put("currentVersion", currentVersion);
        constants.put("currentVersionInfo", updateContext.getKv("hash_" + currentVersion));
        constants.put("currentBundleSha256", updateContext.currentBundleSha256(currentVersion));
        constants.put("buildTime", updateContext.getBuildTime());
        constants.put("isUsingBundleUrl", updateContext.getIsUsingBundleUrl());

        // Both one-shot markers are consumed in a single commit: under
        // TurboModules this runs synchronously on the JS thread.
        UpdateContext.LaunchMarkers markers = updateContext.consumeLaunchMarkers();
        constants.put("isFirstTime", markers.isFirstTime);
        constants.put("rolledBackVersion", markers.rolledBackVersion);

        constants.put("uuid", updateContext.getKv("uuid"));
        int supportedDiffVersion = 0;
        try {
            supportedDiffVersion = NativeUpdateCore.supportedDiffVersion();
        } catch (UnsatisfiedLinkError e) {
            // A mismatched librnupdate.so (stale manual copy / build cache)
            // must not crash startup via getConstants; 0 simply means "no v2
            // diff track" and the server degrades gracefully.
            Log.e("pushy", "supportedDiffVersion missing from librnupdate.so", e);
        }
        constants.put("supportedDiffVersion", supportedDiffVersion);
        return constants;
    }

    /**
     * Reads a required string option. A module call runs on the native
     * modules thread, where anything thrown (a missing key, a wrong type)
     * reaches the bridge's exception handler and kills the app, so a bad
     * argument has to come back as an INVALID_OPTIONS rejection instead
     * (CODE_AUDIT 2.11). Returns null after rejecting.
     */
    @Nullable
    private static String readRequiredString(
        @Nullable ReadableMap options,
        String key,
        Promise promise
    ) {
        String value = null;
        try {
            if (options != null && options.hasKey(key) && !options.isNull(key)) {
                value = options.getString(key);
            }
        } catch (RuntimeException e) {
            // Wrong type: treated like a missing key below.
        }
        return requireNonEmpty(value, "options." + key, promise);
    }

    /** Same contract for a plain string argument. */
    @Nullable
    private static String requireNonEmpty(
        @Nullable String value,
        String name,
        Promise promise
    ) {
        if (value == null || value.isEmpty()) {
            promise.reject(ErrorCodes.INVALID_OPTIONS, name + " must be a non-empty string");
            return null;
        }
        return value;
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

    private static UpdateContext.DownloadFileListener downloadListener(final Promise promise) {
        return new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(downloadErrorCode(error), error);
            }
        };
    }

    // Post-download failures (unzip / hdiff / resource copy, incl. copiesCrc
    // verification) reject as PATCH_FAILED so JS-side telemetry can separate
    // patch health from network health; a local refusal (reinstalling the
    // running version in place) as FILE_OPERATION_FAILED. DownloadTask
    // classifies them.
    private static String downloadErrorCode(Throwable error) {
        if (error instanceof PatchFailedException) {
            return ErrorCodes.PATCH_FAILED;
        }
        if (error instanceof FileOperationException) {
            return ErrorCodes.FILE_OPERATION_FAILED;
        }
        return ErrorCodes.DOWNLOAD_FAILED;
    }

    public void downloadFullUpdate(final ReadableMap options, final Promise promise) {
        String url = readRequiredString(options, "updateUrl", promise);
        if (url == null) {
            return;
        }
        String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        updateContext.downloadFullUpdate(url, hash, downloadListener(promise));
    }

    public void downloadAndInstallApk(final ReadableMap options, final Promise promise) {
        // Every failure of this path — a missing REQUEST_INSTALL_PACKAGES
        // declaration above all — has to come back as a promise rejection,
        // never as an exception on the native modules thread.
        try {
            final String url = readRequiredString(options, "url", promise);
            if (url == null) {
                return;
            }
            String hash = readRequiredString(options, "hash", promise);
            if (hash == null) {
                return;
            }
            String target = readRequiredString(options, "target", promise);
            if (target == null) {
                return;
            }
            if (!HttpUtils.isHttpsUrl(url)) {
                // Installing an APK is code execution and nothing verifies
                // its bytes yet (CODE_AUDIT 2.6): TLS is the only thing
                // standing between the server and the device, so a plaintext
                // URL is refused outright.
                promise.reject(ErrorCodes.INVALID_OPTIONS, "APK url must use https: " + url);
                return;
            }
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
        } catch (Throwable error) {
            promise.reject(ErrorCodes.APK_INSTALL_FAILED, error);
        }
    }

    public void downloadPatchFromPackage(final ReadableMap options, final Promise promise) {
        String url = readRequiredString(options, "updateUrl", promise);
        if (url == null) {
            return;
        }
        String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        updateContext.downloadPatchFromApk(url, hash, downloadListener(promise));
    }

    public void downloadPatchFromPpk(final ReadableMap options, final Promise promise) {
        String url = readRequiredString(options, "updateUrl", promise);
        if (url == null) {
            return;
        }
        String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        String originHash = readRequiredString(options, "originHash", promise);
        if (originHash == null) {
            return;
        }
        updateContext.downloadPatchFromPpk(url, hash, originHash, downloadListener(promise));
    }

    public void reloadUpdate(final ReadableMap options, final Promise promise) {
        String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        restartApp(hash, promise);
    }

    public void restartApp(@Nullable final String hash, final Promise promise) {
        // Two hops (CODE_AUDIT 2.2): the switch (bundle digest + commit) and
        // the launch resolution run on the state serial thread like every
        // other state write; only the React reload itself is posted to the
        // UI thread. A failure at either hop rejects with RESTART_FAILED.
        StateSerialRunner.run(promise, ErrorCodes.RESTART_FAILED, "restartApp", new StateSerialRunner.Operation() {
            @Override
            public void run() throws Throwable {
                final String bundlePath = ReactReloadManager.prepareRestart(updateContext, hash);
                UiThreadRunner.run(promise, ErrorCodes.RESTART_FAILED, "restartApp", new UiThreadRunner.Operation() {
                    @Override
                    public void run() throws Throwable {
                        ReactReloadManager.reload(updateContext, reactContext, bundlePath);
                        promise.resolve(true);
                    }
                });
            }
        });
    }

    public void setNeedUpdate(final ReadableMap options, final Promise promise) {
        final String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        StateSerialRunner.run(promise, ErrorCodes.SWITCH_VERSION_FAILED, "switchVersionLater", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                updateContext.switchVersion(hash);
                promise.resolve(true);
            }
        });
    }

    public void markSuccess(final Promise promise) {
        StateSerialRunner.run(promise, ErrorCodes.MARK_SUCCESS_FAILED, "markSuccess", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                updateContext.markSuccess();
                promise.resolve(true);
            }
        });
    }

    public void getBundleHash(final Promise promise) {
        // Threading lives in UpdateContext (download executor); resolve is
        // thread-safe. Never rejects — empty string means "unknown".
        updateContext.getBundleHash(new UpdateContext.BundleHashListener() {
            @Override
            public void onBundleHash(String hash) {
                promise.resolve(hash);
            }
        });
    }

    public void resetToPackagedBundle(final Promise promise) {
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
    public void getNativeCheckCache(final Promise promise) {
        String cached = updateContext.getKv(NativeCheckOrchestrator.KEY_RESP_CACHE);
        promise.resolve(cached == null ? "" : cached);
    }

    /**
     * Provisioning for the native cold-start update check
     * (NATIVE_CHECKUPDATE_DESIGN §10.1): the raw JSON persists as-is and is
     * parsed on read by the orchestrator; absent config = check disabled.
     * Validated at write time — a corrupt config would otherwise silently
     * disable the native check forever with no signal.
     */
    public void markJsCheckCompleted(final String config, final Promise promise) {
        if (requireNonEmpty(config, "config", promise) == null) {
            return;
        }
        NativeCheckOrchestrator.markJsCheckCompleted(config);
        promise.resolve(true);
    }

    public void syncNativeConfig(final String config, final Promise promise) {
        if (requireNonEmpty(config, "config", promise) == null) {
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

    public void setUuid(final String uuid, final Promise promise) {
        if (requireNonEmpty(uuid, "uuid", promise) == null) {
            return;
        }
        StateSerialRunner.run(promise, ErrorCodes.FILE_OPERATION_FAILED, "setUuid", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                updateContext.setKv("uuid", uuid);
                promise.resolve(true);
            }
        });
    }

    public void setLocalHashInfo(final String hash, final String info, final Promise promise) {
        if (requireNonEmpty(hash, "hash", promise) == null) {
            return;
        }
        if (!isValidHashInfo(info)) {
            promise.reject(ErrorCodes.INVALID_HASH_INFO, "setLocalHashInfo failed: invalid json string");
            return;
        }
        // A state write that did not reach disk (SharedPreferences commit
        // false) is FILE_OPERATION_FAILED, distinct from malformed input.
        StateSerialRunner.run(promise, ErrorCodes.FILE_OPERATION_FAILED, "setLocalHashInfo", new StateSerialRunner.Operation() {
            @Override
            public void run() {
                updateContext.setKv("hash_" + hash, info);
                promise.resolve(true);
            }
        });
    }

    public void getLocalHashInfo(final String hash, final Promise promise) {
        if (requireNonEmpty(hash, "hash", promise) == null) {
            return;
        }
        String value = updateContext.getKv("hash_" + hash);
        if (!isValidHashInfo(value)) {
            promise.reject(ErrorCodes.INVALID_HASH_INFO, "getLocalHashInfo failed: invalid json string");
            return;
        }

        promise.resolve(value);
    }
}
