package cn.reactnative.modules.update;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;
import androidx.annotation.Nullable;
import com.facebook.react.ReactInstanceManager;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.Executor;

public class UpdateContext {
    // The one place that loads librnpushy.so (see NativeCore).
    static {
        NativeCore.ensureLoaded();
    }

    static final String TAG = Texts.LOG_TAG;

    private final Context context;
    private final File rootDir;
    private final Executor executor;
    // The state store and the cache store (StoreSchema): the response cache
    // is a whole server response, and keeping it in sp would make every small
    // state commit rewrite it.
    private final SharedPreferences sp;
    private final SharedPreferences checkCacheSp;
    // Our own PackageInfo, looked up once: every getPackageInfo call is a
    // Binder IPC, and the constructor, the bundle-hash cache and the native
    // check all need the version name / install time.
    @Nullable
    private final PackageInfo packageInfo;

    // Written under sLock (setCustomInstanceManager), read on the restart
    // path without it.
    private volatile ReactInstanceManager reactInstanceManager;
    // Written on the launch path, read from executor/JS threads.
    private volatile boolean isUsingBundleUrl;
    private volatile boolean ignoreRollback;
    // Guarded by commitLock: the callback that starts a deferred first load.
    private Application.ActivityLifecycleCallbacks firstLoadStarter;
    // The version whose bundle this process actually loaded (resolved in
    // getBundleUrl). resetToPackagedBundle must not delete its directory:
    // update assets (images/fonts) are read from it on demand at runtime, so
    // wiping it under a silent (no-restart) reset would break every image the
    // running app has not loaded yet. Volatile: written during launch, read
    // from the state serial and download executors.
    private volatile String launchVersion;
    // bundleSha256 of launchVersion's install record, read once at launch
    // resolution so getConstants does not hit the file system on the JS
    // thread. {hash, sha256}; null until a version was resolved.
    private volatile String[] launchBundleSha256;
    // bundleHash of the embedded bundle, computed once per process on its own
    // thread (see startBundleHashComputation); null until known.
    private final Object bundleHashLock = new Object();
    private String bundleHash;
    private java.util.ArrayList<BundleHashListener> pendingBundleHashListeners =
        new java.util.ArrayList<>();
    // <generated:state-operations> (scripts/contract.ts; bun scripts/generate-contract.ts)
    private static final int STATE_OP_SWITCH_VERSION = 1;
    private static final int STATE_OP_MARK_SUCCESS = 2;
    private static final int STATE_OP_ROLLBACK = 3;
    // 4 (ClearFirstTime) has no caller on this side.
    private static final int STATE_OP_CLEAR_ROLLBACK_MARK = 5;
    private static final int STATE_OP_RESOLVE_LAUNCH = 6;
    // </generated:state-operations>
    // Bumped by resetToPackagedBundle. The cold-start check runs for minutes
    // and may already hold a decision when the app resets to the packaged
    // bundle; the orchestrator samples this counter and abandons activation
    // (and its response cache) when the value moved, so an in-flight rescue
    // can never resurrect the version the app just reset away from.
    private static final java.util.concurrent.atomic.AtomicLong resetGeneration =
        new java.util.concurrent.atomic.AtomicLong(0);
    // The one mutex for every snapshot -> state core -> commit sequence
    // (switchVersion, markSuccess, the launch resolution and its rollback,
    // the launch markers, the cold-start round's commit,
    // resetToPackagedBundle). They are read-modify-write cycles on the same
    // SharedPreferences from different threads (state serial executor,
    // native check thread, JS thread); without a common lock a commit built
    // on an older snapshot silently undoes an earlier one — e.g. a JS
    // markSuccess erasing the activation a crash-rescue round just committed
    // (CODE_AUDIT 2.1). Intrinsic locks are reentrant, so nested takers such
    // as getBundleUrl -> rollBack are fine. Nothing slow runs inside it: the
    // bundle digest of a switch is verified before the lock is taken.
    private static final Object commitLock = new Object();
    // Cleanup and activation share this lock from directory verification through
    // deletion/state commit. Slow filesystem work still stays outside commitLock.
    private static final Object versionFilesLock = new Object();
    
    // Singleton instance
    private static volatile UpdateContext sInstance;
    private static final Object sLock = new Object();
    private static ReactInstanceManager pendingReactInstanceManager;

    private static native StateCoreResult syncStateWithBinaryVersion(
        String packageVersion,
        String buildTime,
        StateCoreResult state
    );

    private static native StateCoreResult runStateCore(
        int operation,
        StateCoreResult state,
        String stringArg,
        boolean flagA,
        boolean flagB
    );

    private UpdateContext(Context context) {
        this.context = context.getApplicationContext();
        this.executor = Threads.single("pushy-download", false);

        this.rootDir = new File(this.context.getFilesDir(), Texts.STORAGE_DIR_NAME);

        if (!rootDir.exists() && !rootDir.mkdirs() && !rootDir.exists()) {
            throw new IllegalStateException("Failed to create storage root dir: " + rootDir);
        }

        this.sp = this.context.getSharedPreferences(StoreSchema.STATE_STORE, Context.MODE_PRIVATE);
        this.checkCacheSp = this.context.getSharedPreferences(
            StoreSchema.CACHE_STORE, Context.MODE_PRIVATE);
        // Before anything reads the state store (the one-time move out of the
        // legacy files; a no-op once done).
        StoreMigration.Result migration = StoreMigration.run(
            sp,
            this.context.getSharedPreferences(Texts.PREFERENCES_NAME, Context.MODE_PRIVATE),
            this.context.getSharedPreferences(Texts.PREFERENCES_NAME + "_check", Context.MODE_PRIVATE),
            StoreMigration.NATIVE);
        if (migration != StoreMigration.Result.CURRENT) {
            Log.i(TAG, "State store migration: " + migration);
        }
        this.packageInfo = lookupPackageInfo(this.context);
        this.reactInstanceManager = pendingReactInstanceManager;

        String packageVersion = getPackageVersion();
        String buildTime = getBuildTime();
        StateCoreResult nextState = syncStateWithBinaryVersion(
            packageVersion,
            buildTime,
            getStateSnapshot()
        );

        if (nextState.changed) {
            // Execute cleanUp before clearing SharedPreferences to avoid race condition
            cleanUp(DownloadTaskParams.DEFAULT_MAX_AGE_DAYS);
            SharedPreferences.Editor editor = this.sp.edit();
            removeKeys(editor, VersionScopedKeys.clearedOnUpgrade(sp.getAll().keySet()));
            applyState(editor, nextState);
            persistEditor(editor, "sync state with binary version");
            clearNativeCheckCache();
        }
        startBundleHashComputation();
    }

    public String getRootDir() {
        return rootDir.toString();
    }

    @Nullable
    private static PackageInfo lookupPackageInfo(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        } catch (PackageManager.NameNotFoundException e) {
            // Our own package is always installed; a failure here is a
            // platform bug worth a log line, not a crash on the launch path.
            Log.e(TAG, "Unable to read own package info", e);
            return null;
        }
    }

    public String getPackageVersion() {
        return packageInfo == null ? null : packageInfo.versionName;
    }

    public String getBuildTime() {
        return context.getString(R.string.pushy_build_time);
    }

    public boolean getIsUsingBundleUrl() {
        return isUsingBundleUrl;
    }

    // bundleHash cache: "<packageVersion>|<lastUpdateTime>|<sha256hex>". The
    // key identifies the installed binary; every (re)install changes
    // lastUpdateTime, so the hash is recomputed once per install.
    public interface BundleHashListener {
        void onBundleHash(String hash);
    }

    /**
     * bundleHash = sha256 of the JS bundle embedded in the binary — the
     * identity of the binary itself, not of whatever hot update is currently
     * running. Hashes exactly the bytes pdiff patches from: the hardcoded
     * "index.android.bundle" asset read via AssetManager, same as
     * DownloadTask.copyBundledAssetToFile. Never fails — an empty string
     * means "unknown" and the server falls back to the buildTime heuristic.
     *
     * Computed once per process on a dedicated thread started by the
     * constructor (not on the download executor, where it used to queue
     * behind cleanup and downloads and make the first JS checkUpdate send an
     * empty hash). The listener runs on that thread, or on the caller's when
     * the value is already known.
     *
     * java.security.MessageDigest rather than the C++ pushy::digest: the
     * bytes come from an AssetManager stream on the Java side, and the
     * platform digest is native-backed already. The NIST vectors in the
     * patch_core tests anchor both implementations to the same standard.
     */
    public void getBundleHash(final BundleHashListener listener) {
        String known;
        synchronized (bundleHashLock) {
            known = bundleHash;
            if (known == null) {
                pendingBundleHashListeners.add(listener);
                return;
            }
        }
        listener.onBundleHash(known);
    }

    // Package-private: also the native cold-start check's request input
    // (SyncCoordinator). Blocks until the shared computation finished — call
    // off the main thread.
    String computeBundleHash() {
        synchronized (bundleHashLock) {
            while (bundleHash == null) {
                try {
                    bundleHashLock.wait();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return "";
                }
            }
            return bundleHash;
        }
    }

    private void startBundleHashComputation() {
        if (BuildConfig.DEBUG) {
            // Metro serves the bundle in debug; mirror the dev buildTime behaviour.
            publishBundleHash("");
            return;
        }
        Threads.startDaemon("pushy-bundle-hash", () -> {
            String hash = "";
            try {
                hash = loadOrHashBundledAsset();
            } catch (Throwable e) {
                Log.w(TAG, "bundle hash failed: " + e);
            } finally {
                publishBundleHash(hash);
            }
        });
    }

    private void publishBundleHash(String hash) {
        java.util.ArrayList<BundleHashListener> listeners;
        synchronized (bundleHashLock) {
            bundleHash = hash;
            listeners = pendingBundleHashListeners;
            pendingBundleHashListeners = null;
            bundleHashLock.notifyAll();
        }
        if (listeners != null) {
            for (BundleHashListener listener : listeners) {
                try {
                    listener.onBundleHash(hash);
                } catch (Throwable e) {
                    Log.w(TAG, "bundle hash listener failed: " + e);
                }
            }
        }
    }

    private String loadOrHashBundledAsset() {
        String cachePrefix = getPackageVersion() + "|" + getPackageLastUpdateTime() + "|";
        String cached = StoreSchema.readString(sp, StoreSchema.KEY_BUNDLE_HASH_CACHE);
        if (cached != null && cached.startsWith(cachePrefix)) {
            return cached.substring(cachePrefix.length());
        }
        String hash = sha256OfBundledAsset("index.android.bundle");
        if (!hash.isEmpty()) {
            SharedPreferences.Editor editor = sp.edit();
            editor.putString(StoreSchema.KEY_BUNDLE_HASH_CACHE, cachePrefix + hash);
            persistEditor(editor, "cache bundle hash");
        }
        return hash;
    }

    private long getPackageLastUpdateTime() {
        return packageInfo == null ? 0 : packageInfo.lastUpdateTime;
    }

    private String sha256OfBundledAsset(String assetName) {
        try (InputStream in = context.getAssets().open(assetName)) {
            return UpdateFileUtils.sha256Hex(in);
        } catch (IOException e) {
            // Expected when there is no embedded bundle (custom name, no
            // release bundle); "unknown" is a valid answer, not an error.
            Log.i(TAG, "Cannot hash bundled asset " + assetName + ": " + e);
            return "";
        }
    }

    private void enqueue(DownloadTaskParams params) {
        executor.execute(new DownloadTask(context, params));
    }

    private static boolean rejectUnsafeComponent(String name, DownloadFileListener listener) {
        if (UpdateFileUtils.isSafePathComponent(name)) {
            return false;
        }
        listener.onDownloadFailed(new IllegalArgumentException("Invalid path component: " + name));
        return true;
    }

    public interface DownloadFileListener {
        void onDownloadCompleted(DownloadTaskParams params);
        void onDownloadFailed(Throwable error);
    }

    /**
     * Params shared by every download task. deadlineNanos is an absolute
     * System.nanoTime deadline for orchestrated (native cold-start) tasks; 0
     * keeps the per-call timeout of a JS-initiated download.
     */
    private static DownloadTaskParams downloadParams(
        int type, String url, String hash, DownloadFileListener listener, long deadlineNanos
    ) {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = type;
        params.url = url;
        params.hash = hash;
        params.listener = listener;
        params.deadlineNanos = deadlineNanos;
        return params;
    }

    /*
     * The patch downloads return the queued task's params so the native
     * orchestrator can cancel the task when its phase budget expires
     * (CODE_AUDIT 2.12); null when the request was rejected up front (the
     * listener has already been told).
     */

    @Nullable
    DownloadTaskParams downloadFullUpdate(
        String url, String hash, DownloadFileListener listener, long deadlineNanos
    ) {
        if (rejectUnsafeComponent(hash, listener)) {
            return null;
        }
        DownloadTaskParams params = downloadParams(
            DownloadTaskParams.TASK_TYPE_PATCH_FULL, url, hash, listener, deadlineNanos);
        params.targetFile = new File(rootDir, hash + ".ppk");
        params.unzipDirectory = new File(rootDir, hash);
        enqueue(params);
        return params;
    }

    /** A plain file download into the root dir; hash only keys progress events. */
    public void downloadFile(String url, String hash, String fileName, DownloadFileListener listener) {
        if (rejectUnsafeComponent(fileName, listener)) {
            return;
        }
        DownloadTaskParams params = downloadParams(
            DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD, url, hash, listener, 0);
        params.targetFile = new File(rootDir, fileName);
        enqueue(params);
    }

    @Nullable
    DownloadTaskParams downloadPatchFromApk(
        String url, String hash, DownloadFileListener listener, long deadlineNanos
    ) {
        if (rejectUnsafeComponent(hash, listener)) {
            return null;
        }
        DownloadTaskParams params = downloadParams(
            DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK, url, hash, listener, deadlineNanos);
        params.targetFile = new File(rootDir, hash + Texts.PACKAGE_DELTA_SUFFIX);
        params.unzipDirectory = new File(rootDir, hash);
        enqueue(params);
        return params;
    }

    @Nullable
    DownloadTaskParams downloadPatchFromPpk(
        String url,
        String hash,
        String originHash,
        DownloadFileListener listener,
        long deadlineNanos
    ) {
        if (rejectUnsafeComponent(hash, listener) || rejectUnsafeComponent(originHash, listener)) {
            return null;
        }
        DownloadTaskParams params = downloadParams(
            DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK, url, hash, listener, deadlineNanos);
        params.originHash = originHash;
        params.targetFile = new File(rootDir, originHash + "-" + hash + Texts.PPK_DELTA_SUFFIX);
        params.unzipDirectory = new File(rootDir, hash);
        params.originDirectory = new File(rootDir, originHash);
        enqueue(params);
        return params;
    }

    private StateCoreResult getStateSnapshot() {
        return StoreSchema.readState(sp);
    }

    // Not editor.clear(): that also wiped the uuid (re-bucketing every gray
    // release on each app upgrade) and the native config (no crash hold and
    // no cold-start round until JS ran again). See VersionScopedKeys.
    private void removeKeys(SharedPreferences.Editor editor, java.util.List<String> keys) {
        for (String key : keys) {
            editor.remove(key);
        }
    }

    private void applyState(SharedPreferences.Editor editor, StateCoreResult state) {
        StoreSchema.writeState(editor, state);
    }

    /**
     * Best-effort persistence for launch-path bookkeeping (binary-version
     * sync, first-load markers, rollback resolution): a failure is logged but
     * must not take the app down while it is resolving which bundle to run.
     */
    private boolean persistEditor(SharedPreferences.Editor editor, String reason) {
        // A lost state write can mean a missed rollback or a version switch
        // that silently never happens, so this must be visible in release too.
        if (!editor.commit()) {
            Log.e(TAG, "Failed to persist state for " + reason);
            return false;
        }
        return true;
    }

    /**
     * Persistence for operations whose result is promised to a caller
     * (switchVersion / markSuccess / setLocalHashInfo / the cold-start round):
     * a commit that did not reach disk is a failed operation, never a
     * resolved promise whose effect silently evaporates on the next launch.
     */
    private void persistEditorOrThrow(SharedPreferences.Editor editor, String reason) {
        if (!persistEditor(editor, reason)) {
            throw new IllegalStateException("Failed to persist state for " + reason);
        }
    }

    /**
     * Validates that {@code hash} is a switchable version: the slow half of
     * a switch (file checks and the bundle digest of a multi-MB bundle),
     * deliberately run without commitLock. The state snapshot read here only
     * decides whether a markerless directory is grandfathered; a concurrent
     * commit cannot make an unverified directory pass.
     */
    private void verifySwitchTarget(String hash) {
        if (!UpdateFileUtils.isSafePathComponent(hash)) {
            throw new IllegalArgumentException("Invalid hash: " + hash);
        }
        StateCoreResult currentState = getStateSnapshot();
        // Versions activated before completion records existed are
        // grandfathered through current/last state, but only while their
        // directory has no record; any other directory must carry a record
        // whose bundle digest matches the bytes on disk before the next
        // launch is pointed at them.
        boolean grandfathered = hash.equals(currentState.currentVersion)
            || hash.equals(currentState.lastVersion);
        try {
            InstallRecord.verifyInstalled(new File(rootDir, hash), hash, grandfathered);
        } catch (IOException e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
    }

    /**
     * The fast half of a switch: snapshot -> state core, without persisting,
     * so callers can fold it into a larger single-commit transaction. Caller
     * holds commitLock and has run verifySwitchTarget.
     */
    private StateCoreResult computeSwitchState(String hash) {
        return runStateOp(STATE_OP_SWITCH_VERSION, hash);
    }

    /** One state-core operation on the current snapshot; caller holds commitLock. */
    private StateCoreResult runStateOp(int operation, @Nullable String hash) {
        return runStateCore(operation, getStateSnapshot(), hash, false, false);
    }

    public void switchVersion(String hash) {
        synchronized (versionFilesLock) {
            verifySwitchTarget(hash);
            synchronized (commitLock) {
                StateCoreResult nextState = computeSwitchState(hash);
                SharedPreferences.Editor editor = sp.edit();
                applyState(editor, nextState);
                persistEditorOrThrow(editor, "switch version");
                ignoreRollback = false;
            }
        }
    }

    public void setKv(String key, String value) {
        SharedPreferences.Editor editor = sp.edit();
        editor.putString(key, value);
        persistEditorOrThrow(editor, "set key " + key);
    }

    @Nullable
    public String getKv(String key) {
        return StoreSchema.readString(sp, key);
    }

    void removeKv(String key) {
        SharedPreferences.Editor editor = sp.edit();
        editor.remove(key);
        persistEditorOrThrow(editor, "remove key " + key);
    }

    public String getCurrentVersion() {
        return StoreSchema.readString(sp, StoreSchema.KEY_CURRENT_VERSION);
    }

    /** The one-shot launch markers getConstants reports, consumed together. */
    static final class LaunchMarkers {
        final boolean isFirstTime;
        @Nullable
        final String rolledBackVersion;

        LaunchMarkers(boolean isFirstTime, @Nullable String rolledBackVersion) {
            this.isFirstTime = isFirstTime;
            this.rolledBackVersion = rolledBackVersion;
        }
    }

    /**
     * Reads and clears the first-load marker and the rollback mark in one
     * editor. getConstants runs this synchronously on the JS thread (a
     * TurboModule constant read), so the write is applied asynchronously;
     * persistence is best-effort on this launch path.
     */
    LaunchMarkers consumeLaunchMarkers() {
        LaunchMarkers markers;
        synchronized (commitLock) {
            boolean isFirstLoadMarked = StoreSchema.readMarker(sp, StoreSchema.KEY_FIRST_LOAD_MARKER);
            String rolledBackVersion = rolledBackVersion();
            markers = new LaunchMarkers(isFirstLoadMarked, rolledBackVersion);
            if (isFirstLoadMarked || rolledBackVersion != null) {
                SharedPreferences.Editor editor = sp.edit();
                if (isFirstLoadMarked) {
                    StoreSchema.writeMarker(editor, StoreSchema.KEY_FIRST_LOAD_MARKER, false);
                }
                if (rolledBackVersion != null) {
                    applyState(editor, runStateOp(STATE_OP_CLEAR_ROLLBACK_MARK, null));
                }
                // Asynchronous on purpose: the in-memory state changes
                // immediately, the disk write happens on the
                // SharedPreferences writer. Losing it to a crash only
                // re-reports the one-shot markers on the next launch.
                editor.apply();
            }
        }
        if (markers.rolledBackVersion != null) {
            // The rolled-back version's directory is now eligible for cleanup.
            cleanUp(DownloadTaskParams.DEFAULT_MAX_AGE_DAYS);
        }
        return markers;
    }

    public String rolledBackVersion() {
        return StoreSchema.readString(sp, StoreSchema.KEY_ROLLED_BACK_VERSION);
    }

    public void markSuccess() {
        if (BuildConfig.DEBUG) {
            return;
        }
        synchronized (commitLock) {
            StateCoreResult nextState = runStateOp(STATE_OP_MARK_SUCCESS, null);
            SharedPreferences.Editor editor = sp.edit();
            applyState(editor, nextState);
            if (nextState.staleVersionToDelete != null) {
                editor.remove(StoreSchema.KEY_HASH_INFO + nextState.staleVersionToDelete);
            }
            persistEditorOrThrow(editor, "mark success");
        }

        cleanUp(DownloadTaskParams.DEFAULT_MAX_AGE_DAYS);
    }

    /**
     * Reset to the bundle packaged in the binary: wipe the whole update state
     * (so the next launch resolves to the built-in bundle) and delete the
     * downloaded versions, keeping only the directory of the version this
     * process is running from (a silent reset must not break its on-demand
     * asset loads). The install's own keys survive (VersionScopedKeys): the
     * client uuid identifies the install for gray release bucketing and must
     * not change on reset, and the native config stays with the host, as on
     * iOS and Harmony.
     */
    public void resetToPackagedBundle() {
        synchronized (commitLock) {
            resetToPackagedBundleLocked();
        }
    }

    private void resetToPackagedBundleLocked() {
        // Invalidate any in-flight cold-start round before clearing state: a
        // round committing under the same lock afterwards sees the new
        // generation and drops its result.
        resetGeneration.incrementAndGet();
        StateCoreResult resetState = new StateCoreResult();
        resetState.packageVersion = getPackageVersion();
        resetState.buildTime = getBuildTime();
        resetState.firstTime = false;
        resetState.firstTimeOk = true;
        // The cached check response still advertises the version this reset
        // removes; drop it first so a failure aborts before the state wipe.
        if (!clearNativeCheckCache()) {
            throw new IllegalStateException("Failed to persist state for reset check cache");
        }
        SharedPreferences.Editor editor = sp.edit();
        removeKeys(editor, VersionScopedKeys.clearedOnReset(sp.getAll().keySet()));
        applyState(editor, resetState);
        persistEditorOrThrow(editor, "reset to packaged bundle");
        ignoreRollback = false;
        Log.i(TAG, "Reset to packaged bundle");
        cleanUp(0);
    }

    public static void setCustomInstanceManager(ReactInstanceManager instanceManager) {
        synchronized (sLock) {
            pendingReactInstanceManager = instanceManager;
            if (sInstance != null) {
                sInstance.reactInstanceManager = instanceManager;
            }
        }
    }

    public ReactInstanceManager getCustomReactInstanceManager() {
        return reactInstanceManager;
    }

    /**
     * Get singleton instance of UpdateContext
     */
    public static UpdateContext getInstance(Context context) {
        if (sInstance == null) {
            synchronized (sLock) {
                if (sInstance == null) {
                    sInstance = new UpdateContext(context.getApplicationContext());
                }
            }
        }
        return sInstance;
    }

    public static String getBundleUrl(Context context) {
        return getInstance(context).getBundleUrl();
    }

    public static String getBundleUrl(Context context, String defaultAssetsUrl) {
        return getInstance(context).getBundleUrl(defaultAssetsUrl);
    }

    public String getBundleUrl() {
        return this.getBundleUrl((String) null);
    }

    public String getBundleUrl(String defaultAssetsUrl) {
        isUsingBundleUrl = true;
        String syncRolledBackVersion = null;
        try {
            // The whole resolution is one read-modify-write on the state
            // (resolve, then possibly roll back missing bundles); see
            // commitLock.
            synchronized (commitLock) {
                StateCoreResult currentState = getStateSnapshot();
                boolean deferFirstLoad = currentState.firstTime && !isProcessForeground();
                StateCoreResult launchState = runStateCore(
                    STATE_OP_RESOLVE_LAUNCH,
                    currentState,
                    null,
                    ignoreRollback,
                    !deferFirstLoad
                );
                syncRolledBackVersion = launchState.rolledBackVersion;
                if (launchState.didRollback) {
                    // The crash-protection rollback: the new version never called
                    // markSuccess. Keep this visible in release logs.
                    Log.e(TAG, "Version " + currentState.currentVersion
                        + " was not marked as successful, rolling back to "
                        + launchState.currentVersion);
                }
                if (launchState.didRollback || launchState.consumedFirstTime) {
                    SharedPreferences.Editor editor = sp.edit();
                    applyState(editor, launchState);
                    if (launchState.consumedFirstTime) {
                        StoreSchema.writeMarker(editor, StoreSchema.KEY_FIRST_LOAD_MARKER, true);
                    }
                    persistEditor(editor, "resolve launch");
                }
                if (launchState.consumedFirstTime) {
                    // bundleURL may be resolved multiple times in one process.
                    ignoreRollback = true;
                }
                if (deferFirstLoad) {
                    // JS reads the marker once per load: if the user opens the
                    // app while this instance is alive, its markSuccess has to
                    // work.
                    SharedPreferences.Editor editor = sp.edit();
                    StoreSchema.writeMarker(editor, StoreSchema.KEY_FIRST_LOAD_MARKER, true);
                    persistEditor(editor, "defer first load");
                    startFirstLoadWithFirstActivity();
                    Log.i(TAG, "Started without UI, first load of "
                        + currentState.currentVersion + " is not counted");
                }

                String currentVersion = launchState.loadVersion;
                if (currentVersion == null) {
                    return defaultAssetsUrl;
                }

                // Guard the rollback chain against cycles: a corrupted state returning
                // an already-visited version would otherwise spin this loop forever on
                // the main thread.
                java.util.HashSet<String> visitedVersions = new java.util.HashSet<>();
                while (currentVersion != null && visitedVersions.add(currentVersion)) {
                    File bundleFile = InstallRecord.bundleFile(new File(rootDir, currentVersion));
                    if (!bundleFile.exists()) {
                        Log.e(TAG, "Bundle version " + currentVersion + " not found.");
                        currentVersion = this.rollBack();
                        syncRolledBackVersion = rolledBackVersion();
                        continue;
                    }
                    launchVersion = currentVersion;
                    launchBundleSha256 = new String[] {
                        currentVersion, readBundleSha256(currentVersion)};
                    syncRolledBackVersion = rolledBackVersion();
                    return bundleFile.toString();
                }

                syncRolledBackVersion = rolledBackVersion();
                return defaultAssetsUrl;
            }
        } finally {
            // Even corrupted state or a state-core exception must not disable
            // the next-launch rescue check. A null snapshot simply omits the
            // rollback guard for this exceptional launch.
            SyncCoordinator.schedule(this, syncRolledBackVersion);
        }
    }

    /**
     * A start without UI (push message, HeadlessJS task, alarm, boot receiver)
     * creates the RN instance but mounts no UpdateProvider, so it can never
     * mark success. It must not use up the new version's first load, or the
     * next launch rolls back a version that never failed.
     */
    private static boolean isProcessForeground() {
        ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(info);
        return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    /**
     * Importance can read as background on a launch that does show UI (screen
     * off, the host created early in Application.onCreate), and a version that
     * crashes there must still be rolled back. So the first activity started in
     * this process starts the deferred first load.
     */
    private void startFirstLoadWithFirstActivity() {
        if (firstLoadStarter != null || !(context instanceof Application)) {
            return;
        }
        final Application application = (Application) context;
        firstLoadStarter = new Application.ActivityLifecycleCallbacks() {
            @Override
            public void onActivityStarted(Activity activity) {
                application.unregisterActivityLifecycleCallbacks(this);
                startDeferredFirstLoad();
            }

            @Override
            public void onActivityCreated(Activity activity, Bundle savedInstanceState) {}

            @Override
            public void onActivityResumed(Activity activity) {}

            @Override
            public void onActivityPaused(Activity activity) {}

            @Override
            public void onActivityStopped(Activity activity) {}

            @Override
            public void onActivitySaveInstanceState(Activity activity, Bundle outState) {}

            @Override
            public void onActivityDestroyed(Activity activity) {}
        };
        application.registerActivityLifecycleCallbacks(firstLoadStarter);
    }

    private void startDeferredFirstLoad() {
        synchronized (commitLock) {
            firstLoadStarter = null;
            StateCoreResult currentState = getStateSnapshot();
            // Already marked, or another version is now pending and this
            // process is not running it.
            if (!currentState.firstTime
                || currentState.currentVersion == null
                || !currentState.currentVersion.equals(launchVersion)) {
                return;
            }
            SharedPreferences.Editor editor = sp.edit();
            applyState(editor, runStateCore(
                STATE_OP_RESOLVE_LAUNCH, currentState, null, false, true));
            persistEditor(editor, "start deferred first load");
            ignoreRollback = true;
        }
    }

    /** Shared by JS and native hosts. Config replacement invalidates old native decisions. */
    private static final java.util.concurrent.atomic.AtomicLong nativeConfigGeneration =
        new java.util.concurrent.atomic.AtomicLong(0);

    static long getNativeConfigGeneration() {
        return nativeConfigGeneration.get();
    }

    void setNativeConfig(String config) {
        synchronized (commitLock) {
            // Canonical comparison (C1, FlowBridge.configsEquivalent):
            // re-sending the same config with another key order or trailing
            // slashes must not cancel an in-flight round or drop its cache.
            boolean changed = !FlowBridge.configsEquivalent(
                config, StoreSchema.readString(sp, StoreSchema.KEY_NATIVE_CONFIG));
            SharedPreferences.Editor editor = sp.edit();
            if (changed) {
                // Also invalidate on a failed persistence attempt: an older
                // round must not commit over uncertain configuration state.
                resetGeneration.incrementAndGet();
                nativeConfigGeneration.incrementAndGet();
                SyncCoordinator.recordJsRound(null);
                if (!clearNativeCheckCache()) {
                    throw new IllegalStateException(
                        "Failed to persist state for configuration check cache");
                }
            }
            // A native-only first launch needs a stable gray-release identity
            // before JS initializes. Never replace an existing installation ID.
            if (StoreSchema.readString(sp, StoreSchema.KEY_UUID) == null) {
                editor.putString(StoreSchema.KEY_UUID, java.util.UUID.randomUUID().toString());
            }
            editor.putString(StoreSchema.KEY_NATIVE_CONFIG, config);
            // Persist even an equal value: a previous commit may have updated
            // SharedPreferences memory but failed to write its file.
            persistEditorOrThrow(editor, "persist configuration");
        }
        SyncCoordinator.onConfigured(this);
    }

    /**
     * Native-decision generation, sampled/compared by the native check
     * orchestrator: bumped by reset AND configuration replacement (see
     * resetGeneration).
     */
    static long getResetGeneration() {
        return resetGeneration.get();
    }

    /**
     * Commit everything a cold-start round persists — version info, the
     * activation, the response cache — under one lock that first re-checks the
     * reset generation. resetToPackagedBundle takes the same lock, so there is
     * no compare-and-act window: either the whole round lands, or the reset
     * wins and none of it does. Returns whether the round was committed.
     */
    boolean commitSyncResult(
        long expectedGeneration,
        String hash,
        String hashInfoJson,
        boolean activate,
        String responseCacheJson
    ) {
        boolean switching = activate && hash != null;
        if (!switching) {
            return commitSyncResultState(
                expectedGeneration, hash, hashInfoJson, false, responseCacheJson);
        }
        synchronized (versionFilesLock) {
            verifySwitchTarget(hash);
            return commitSyncResultState(
                expectedGeneration, hash, hashInfoJson, true, responseCacheJson);
        }
    }

    private boolean commitSyncResultState(
        long expectedGeneration,
        String hash,
        String hashInfoJson,
        boolean switching,
        String responseCacheJson
    ) {
        synchronized (commitLock) {
            if (resetGeneration.get() != expectedGeneration) {
                return false;
            }
            SharedPreferences.Editor editor = sp.edit();
            if (hash != null && hashInfoJson != null) {
                editor.putString(StoreSchema.KEY_HASH_INFO + hash, hashInfoJson);
            }
            if (switching) {
                applyState(editor, computeSwitchState(hash));
            }
            // The round is over once its result lands: clear the
            // interrupted-round breadcrumb in the same commit.
            editor.remove(StoreSchema.KEY_ROUND_BREADCRUMB);
            persistEditorOrThrow(editor, "commit sync result");
            if (switching) {
                ignoreRollback = false;
            }
            // Advisory cache, separate file: written after the state it
            // describes, still under commitLock so a reset cannot interleave.
            if (responseCacheJson != null
                && !checkCacheSp.edit()
                    .putString(StoreSchema.KEY_CHECK_CACHE, responseCacheJson).commit()) {
                Log.w(TAG, "Failed to persist native sync response cache");
            }
            return true;
        }
    }

    /**
     * bundleSha256 from the running version's install record (see
     * InstallRecord); "" for the embedded bundle, a legacy install or an
     * unreadable record. Exposed to JS for crash-report attribution.
     */
    String currentBundleSha256(String hash) {
        String[] cached = launchBundleSha256;
        if (cached != null && cached[0].equals(hash)) {
            return cached[1];
        }
        return readBundleSha256(hash);
    }

    private String readBundleSha256(String hash) {
        if (hash == null || hash.isEmpty() || !UpdateFileUtils.isSafePathComponent(hash)) {
            return "";
        }
        return InstallRecord.recordedBundleSha256(new File(rootDir, hash));
    }

    /** Raw native check response for JS (§10.3); null when absent. */
    @Nullable
    String getNativeCheckCache() {
        return StoreSchema.readString(checkCacheSp, StoreSchema.KEY_CHECK_CACHE);
    }

    private boolean clearNativeCheckCache() {
        if (!checkCacheSp.contains(StoreSchema.KEY_CHECK_CACHE)) {
            return true;
        }
        if (!checkCacheSp.edit().remove(StoreSchema.KEY_CHECK_CACHE).commit()) {
            Log.e(TAG, "Failed to clear native sync response cache");
            return false;
        }
        return true;
    }

    boolean hasCompletedVersion(String hash) {
        if (!UpdateFileUtils.isSafePathComponent(hash)) {
            return false;
        }
        return InstallRecord.isInstalled(new File(rootDir, hash), hash);
    }

    private String rollBack() {
        synchronized (commitLock) {
            String rollingBack = getCurrentVersion();
            StateCoreResult nextState = runStateOp(STATE_OP_ROLLBACK, null);
            Log.e(TAG, "Rolling back version " + rollingBack
                + " to " + nextState.currentVersion);
            SharedPreferences.Editor editor = sp.edit();
            applyState(editor, nextState);
            persistEditor(editor, "rollback");
            return nextState.currentVersion;
        }
    }

    /**
     * The version this process is running from (null before getBundleUrl
     * resolved one, or when the packaged bundle runs). Read by DownloadTask
     * to refuse reinstalling that directory in place.
     */
    @Nullable
    static String runningVersion() {
        UpdateContext instance = sInstance;
        return instance == null ? null : instance.launchVersion;
    }

    interface CleanupAction {
        void run(String[] keepNames);
    }

    /**
     * Resolve keep names immediately before the cleanup acts, never when
     * enqueued. The action runs under versionFilesLock, so it must stay cheap
     * (DownloadTask only renames doomed entries into a trash directory and
     * deletes them after this returns).
     */
    void runCleanupWithLatestState(CleanupAction action) {
        synchronized (versionFilesLock) {
            final String[] keepNames;
            synchronized (commitLock) {
                keepNames = CleanupKeepNames.select(
                    StoreSchema.readString(sp, StoreSchema.KEY_CURRENT_VERSION),
                    StoreSchema.readString(sp, StoreSchema.KEY_LAST_VERSION),
                    launchVersion
                );
            }
            action.run(keepNames);
        }
    }

    /**
     * Queues removal of every version entry older than maxAgeDays (0: all)
     * except the keep names, which the queued task resolves at execution
     * time so a later activation is protected too.
     */
    private void cleanUp(int maxAgeDays) {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
        params.maxAgeDays = maxAgeDays;
        params.unzipDirectory = rootDir;
        enqueue(params);
    }
}
