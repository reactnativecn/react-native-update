package cn.reactnative.modules.update;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.util.Log;
import androidx.annotation.Nullable;
import com.facebook.react.ReactInstanceManager;
import java.io.File;
import org.json.JSONObject;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

public class UpdateContext {
    static {
        NativeUpdateCore.ensureLoaded();
    }

    static final String TAG = "react-native-update";
    static final boolean DEBUG = BuildConfig.DEBUG;

    private final Context context;
    private final File rootDir;
    private final Executor executor;
    private final SharedPreferences sp;
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
    // The version whose bundle this process actually loaded (resolved in
    // getBundleUrl). resetToPackagedBundle must not delete its directory:
    // update assets (images/fonts) are read from it on demand at runtime, so
    // wiping it under a silent (no-restart) reset would break every image the
    // running app has not loaded yet. Volatile: written during launch, read
    // from the state serial and download executors.
    private volatile String launchVersion;
    private static final int STATE_OP_SWITCH_VERSION = 1;
    private static final int STATE_OP_MARK_SUCCESS = 2;
    private static final int STATE_OP_ROLLBACK = 3;
    // 4 (clear first time) exists in the state core but has no Android caller.
    private static final int STATE_OP_CLEAR_ROLLBACK_MARK = 5;
    private static final int STATE_OP_RESOLVE_LAUNCH = 6;
    private static final String KEY_FIRST_LOAD_MARKED = "firstLoadMarked";
    static final String VERSION_COMPLETE_FILE = InstallRecord.FILE_NAME;
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
        this.executor = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                return new Thread(r, "pushy-download");
            }
        });

        this.rootDir = new File(this.context.getFilesDir(), "_update");

        if (!rootDir.exists() && !rootDir.mkdirs() && !rootDir.exists()) {
            throw new IllegalStateException("Failed to create update root dir: " + rootDir);
        }

        this.sp = this.context.getSharedPreferences("update", Context.MODE_PRIVATE);
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
            this.cleanUp();
            SharedPreferences.Editor editor = this.sp.edit();
            editor.clear();
            applyState(editor, nextState);
            persistEditor(editor, "sync state with binary version");
        }
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
    private static final String KEY_BUNDLE_HASH_CACHE = "bundleHashCache";

    public interface BundleHashListener {
        void onBundleHash(String hash);
    }

    /**
     * bundleHash = sha256 of the JS bundle embedded in the binary — the
     * identity of the binary itself, not of whatever hot update is currently
     * running. Hashes exactly the bytes pdiff patches from: the hardcoded
     * "index.android.bundle" asset read via AssetManager, same as
     * DownloadTask.copyBundledAssetToFile. Runs on the download executor;
     * never fails — an empty string means "unknown" and the server falls back
     * to the buildTime heuristic.
     *
     * Deliberately java.security.MessageDigest instead of the C++
     * pushy::digest: librnupdate.so is a prebuilt artifact and this must not
     * force a rebuild. The NIST vectors in the patch_core tests anchor both
     * implementations to the same standard.
     */
    public void getBundleHash(final BundleHashListener listener) {
        if (DEBUG) {
            // Metro serves the bundle in debug; mirror the dev buildTime behaviour.
            listener.onBundleHash("");
            return;
        }
        executor.execute(new Runnable() {
            @Override
            public void run() {
                listener.onBundleHash(computeBundleHash());
            }
        });
    }

    // Package-private: also the native cold-start check's request input
    // (NativeCheckOrchestrator). Blocking — call off the main thread.
    String computeBundleHash() {
        String cachePrefix = getPackageVersion() + "|" + getPackageLastUpdateTime() + "|";
        String cached = sp.getString(KEY_BUNDLE_HASH_CACHE, null);
        if (cached != null && cached.startsWith(cachePrefix)) {
            return cached.substring(cachePrefix.length());
        }
        String hash = sha256OfBundledAsset("index.android.bundle");
        if (!hash.isEmpty()) {
            SharedPreferences.Editor editor = sp.edit();
            editor.putString(KEY_BUNDLE_HASH_CACHE, cachePrefix + hash);
            persistEditor(editor, "cache bundle hash");
        }
        return hash;
    }

    private long getPackageLastUpdateTime() {
        return packageInfo == null ? 0 : packageInfo.lastUpdateTime;
    }

    private String sha256OfBundledAsset(String assetName) {
        try (InputStream in = context.getAssets().open(assetName)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                md.update(buffer, 0, read);
            }
            byte[] digest = md.digest();
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xf, 16));
                hex.append(Character.forDigit(b & 0xf, 16));
            }
            return hex.toString();
        } catch (IOException | NoSuchAlgorithmException e) {
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

    public void downloadFullUpdate(String url, String hash, DownloadFileListener listener) {
        downloadFullUpdate(url, hash, listener, 0);
    }

    /**
     * The deadline-taking overloads (native cold-start check) return the
     * queued task's params so the orchestrator can cancel the task when its
     * phase budget expires (CODE_AUDIT 2.12); null when the request was
     * rejected up front (the listener has already been told).
     */
    @Nullable
    DownloadTaskParams downloadFullUpdate(
        String url, String hash, DownloadFileListener listener, long deadlineNanos
    ) {
        if (rejectUnsafeComponent(hash, listener)) {
            return null;
        }
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FULL;
        params.url = url;
        params.hash = hash;
        params.listener = listener;
        params.deadlineNanos = deadlineNanos;
        params.targetFile = new File(rootDir, hash + ".ppk");
        params.unzipDirectory = new File(rootDir, hash);
        enqueue(params);
        return params;
    }

    public void downloadFile(String url, String hash, String fileName, DownloadFileListener listener) {
        if (rejectUnsafeComponent(fileName, listener)) {
            return;
        }
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD;
        params.url = url;
        params.hash = hash;
        params.listener = listener;

        params.targetFile = new File(rootDir, fileName);
//        params.unzipDirectory = new File(rootDir, hash);
        enqueue(params);
    }

    public void downloadPatchFromApk(String url, String hash, DownloadFileListener listener) {
        downloadPatchFromApk(url, hash, listener, 0);
    }

    @Nullable
    DownloadTaskParams downloadPatchFromApk(
        String url, String hash, DownloadFileListener listener, long deadlineNanos
    ) {
        if (rejectUnsafeComponent(hash, listener)) {
            return null;
        }
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK;
        params.url = url;
        params.hash = hash;
        params.listener = listener;
        params.deadlineNanos = deadlineNanos;
        params.targetFile = new File(rootDir, hash + ".apk.patch");
        params.unzipDirectory = new File(rootDir, hash);
        enqueue(params);
        return params;
    }

    public void downloadPatchFromPpk(String url, String hash, String originHash, DownloadFileListener listener) {
        downloadPatchFromPpk(url, hash, originHash, listener, 0);
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
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
        params.url = url;
        params.hash = hash;
        params.originHash = originHash;
        params.listener = listener;
        params.deadlineNanos = deadlineNanos;
        params.targetFile = new File(rootDir, originHash + "-" + hash + ".ppk.patch");
        params.unzipDirectory = new File(rootDir, hash);
        params.originDirectory = new File(rootDir, originHash);
        enqueue(params);
        return params;
    }

    private StateCoreResult getStateSnapshot() {
        StateCoreResult state = new StateCoreResult();
        state.packageVersion = sp.getString("packageVersion", null);
        state.buildTime = sp.getString("buildTime", null);
        state.currentVersion = sp.getString("currentVersion", null);
        state.lastVersion = sp.getString("lastVersion", null);
        state.firstTime = sp.getBoolean("firstTime", false);
        state.firstTimeOk = sp.getBoolean("firstTimeOk", true);
        state.rolledBackVersion = sp.getString("rolledBackVersion", null);
        return state;
    }

    private static void putNullableString(
        SharedPreferences.Editor editor,
        String key,
        String value
    ) {
        if (value == null) {
            editor.remove(key);
        } else {
            editor.putString(key, value);
        }
    }

    private void applyState(SharedPreferences.Editor editor, StateCoreResult state) {
        putNullableString(editor, "packageVersion", state.packageVersion);
        putNullableString(editor, "buildTime", state.buildTime);
        putNullableString(editor, "currentVersion", state.currentVersion);
        putNullableString(editor, "lastVersion", state.lastVersion);
        editor.putBoolean("firstTime", state.firstTime);
        editor.putBoolean("firstTimeOk", state.firstTimeOk);
        putNullableString(editor, "rolledBackVersion", state.rolledBackVersion);
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
            Log.e(TAG, "Failed to persist update state for " + reason);
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
            throw new IllegalStateException("Failed to persist update state for " + reason);
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
        File versionDir = new File(rootDir, hash);
        File bundleFile = new File(versionDir, "index.bundlejs");
        if (!bundleFile.isFile()) {
            throw new IllegalStateException("Bundle version " + hash + " not found.");
        }
        StateCoreResult currentState = getStateSnapshot();
        boolean isLegacyActivatedVersion = hash.equals(currentState.currentVersion)
            || hash.equals(currentState.lastVersion);
        if (isLegacyActivatedVersion) {
            // Versions activated before completion markers were introduced are
            // explicitly grandfathered through current/last state.
            return;
        }
        if (!InstallRecord.isComplete(versionDir, hash)) {
            // An arbitrary markerless directory may be a crash-left partial
            // install.
            throw new IllegalStateException("Bundle version " + hash + " is incomplete.");
        }
        // The record's bundle digest must match the bytes on disk before
        // the next launch is pointed at them.
        try {
            InstallRecord.verifyForActivation(versionDir, hash, bundleFile);
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
        return runStateCore(
            STATE_OP_SWITCH_VERSION,
            getStateSnapshot(),
            hash,
            false,
            false
        );
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

    public String getKv(String key) {
        return sp.getString(key, null);
    }

    void removeKv(String key) {
        SharedPreferences.Editor editor = sp.edit();
        editor.remove(key);
        persistEditorOrThrow(editor, "remove key " + key);
    }

    public String getCurrentVersion() {
        return sp.getString("currentVersion", null);
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
     * commit. getConstants runs this synchronously on the JS thread (a
     * TurboModule constant read), so the two writes are folded into a single
     * editor; persistence is best-effort on this launch path.
     */
    LaunchMarkers consumeLaunchMarkers() {
        LaunchMarkers markers;
        synchronized (commitLock) {
            boolean isFirstLoadMarked = sp.getBoolean(KEY_FIRST_LOAD_MARKED, false);
            String rolledBackVersion = rolledBackVersion();
            markers = new LaunchMarkers(isFirstLoadMarked, rolledBackVersion);
            if (isFirstLoadMarked || rolledBackVersion != null) {
                SharedPreferences.Editor editor = sp.edit();
                if (isFirstLoadMarked) {
                    editor.remove(KEY_FIRST_LOAD_MARKED);
                }
                if (rolledBackVersion != null) {
                    StateCoreResult nextState = runStateCore(
                        STATE_OP_CLEAR_ROLLBACK_MARK,
                        getStateSnapshot(),
                        null,
                        false,
                        false
                    );
                    applyState(editor, nextState);
                }
                persistEditor(editor, "consume launch markers");
            }
        }
        if (markers.rolledBackVersion != null) {
            // The rolled-back version's directory is now eligible for cleanup.
            this.cleanUp();
        }
        return markers;
    }

    public String rolledBackVersion() {
        return sp.getString("rolledBackVersion", null);
    }

    public void markSuccess() {
        if (BuildConfig.DEBUG) {
            return;
        }
        synchronized (commitLock) {
            StateCoreResult currentState = getStateSnapshot();
            StateCoreResult nextState = runStateCore(
                STATE_OP_MARK_SUCCESS,
                currentState,
                null,
                false,
                false
            );
            SharedPreferences.Editor editor = sp.edit();
            applyState(editor, nextState);
            if (nextState.staleVersionToDelete != null) {
                editor.remove("hash_" + nextState.staleVersionToDelete);
            }
            persistEditorOrThrow(editor, "mark success");
        }

        this.cleanUp();
    }

    /**
     * Reset to the bundle packaged in the binary: wipe the whole update state
     * (so the next launch resolves to the built-in bundle) and delete the
     * downloaded versions, keeping only the directory of the version this
     * process is running from (a silent reset must not break its on-demand
     * asset loads). Only the client uuid survives — it identifies the install
     * for gray release bucketing and must not change on reset.
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
        String uuid = sp.getString("uuid", null);
        SharedPreferences.Editor editor = sp.edit();
        editor.clear();
        applyState(editor, resetState);
        if (uuid != null) {
            editor.putString("uuid", uuid);
        }
        persistEditorOrThrow(editor, "reset to packaged bundle");
        ignoreRollback = false;
        // editor.clear() above already dropped the cached check response; it
        // still advertised the version this reset removed.
        Log.i(TAG, "Reset to packaged bundle");

        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
        params.maxAgeDays = 0;
        // Keep names are resolved by the queued task at execution time, so a
        // later activation is protected too.
        params.unzipDirectory = rootDir;
        enqueue(params);
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
        String nativeCheckRolledBackVersion = null;
        try {
            // The whole resolution is one read-modify-write on the state
            // (resolve, then possibly roll back missing bundles); see
            // commitLock.
            synchronized (commitLock) {
                StateCoreResult currentState = getStateSnapshot();
                StateCoreResult launchState = runStateCore(
                    STATE_OP_RESOLVE_LAUNCH,
                    currentState,
                    null,
                    ignoreRollback,
                    true
                );
                nativeCheckRolledBackVersion = launchState.rolledBackVersion;
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
                        editor.putBoolean(KEY_FIRST_LOAD_MARKED, true);
                    }
                    persistEditor(editor, "resolve launch");
                }
                if (launchState.consumedFirstTime) {
                    // bundleURL may be resolved multiple times in one process.
                    ignoreRollback = true;
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
                    File bundleFile = new File(rootDir, currentVersion+"/index.bundlejs");
                    if (!bundleFile.exists()) {
                        Log.e(TAG, "Bundle version " + currentVersion + " not found.");
                        currentVersion = this.rollBack();
                        nativeCheckRolledBackVersion = rolledBackVersion();
                        continue;
                    }
                    launchVersion = currentVersion;
                    nativeCheckRolledBackVersion = rolledBackVersion();
                    return bundleFile.toString();
                }

                nativeCheckRolledBackVersion = rolledBackVersion();
                return defaultAssetsUrl;
            }
        } finally {
            // Even corrupted state or a state-core exception must not disable
            // the next-launch rescue check. A null snapshot simply omits the
            // rollback guard for this exceptional launch.
            NativeCheckOrchestrator.schedule(this, nativeCheckRolledBackVersion);
        }
    }

    /** Sampled/compared by the native check orchestrator; see resetGeneration. */
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
    boolean commitNativeCheckResult(
        long expectedGeneration,
        String hash,
        String hashInfoJson,
        boolean activate,
        String responseCacheJson
    ) {
        boolean switching = activate && hash != null;
        if (!switching) {
            return commitNativeCheckResultState(
                expectedGeneration, hash, hashInfoJson, false, responseCacheJson);
        }
        synchronized (versionFilesLock) {
            verifySwitchTarget(hash);
            return commitNativeCheckResultState(
                expectedGeneration, hash, hashInfoJson, true, responseCacheJson);
        }
    }

    private boolean commitNativeCheckResultState(
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
                editor.putString("hash_" + hash, hashInfoJson);
            }
            if (switching) {
                applyState(editor, computeSwitchState(hash));
            }
            if (responseCacheJson != null) {
                editor.putString(NativeCheckOrchestrator.KEY_RESP_CACHE, responseCacheJson);
            }
            persistEditorOrThrow(editor, "commit native check result");
            if (switching) {
                ignoreRollback = false;
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
        if (hash == null || hash.isEmpty() || !UpdateFileUtils.isSafePathComponent(hash)) {
            return "";
        }
        JSONObject record = InstallRecord.read(new File(rootDir, hash));
        return record == null ? "" : record.optString("bundleSha256", "");
    }

    boolean hasCompletedVersion(String hash) {
        if (!UpdateFileUtils.isSafePathComponent(hash)) {
            return false;
        }
        File versionDir = new File(rootDir, hash);
        return new File(versionDir, "index.bundlejs").isFile()
            && InstallRecord.isComplete(versionDir, hash);
    }

    private String rollBack() {
        synchronized (commitLock) {
            StateCoreResult currentState = getStateSnapshot();
            StateCoreResult nextState = runStateCore(
                STATE_OP_ROLLBACK,
                currentState,
                null,
                false,
                false
            );
            Log.e(TAG, "Rolling back version " + currentState.currentVersion
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
        void run(@Nullable String keepCurrent, @Nullable String keepPrevious);
    }

    /** Resolve keep names immediately before deletion, never when enqueued. */
    void runCleanupWithLatestState(CleanupAction action) {
        synchronized (versionFilesLock) {
            final String[] keepNames;
            synchronized (commitLock) {
                keepNames = CleanupKeepNames.select(
                    sp.getString("currentVersion", null),
                    sp.getString("lastVersion", null),
                    launchVersion
                );
            }
            if (keepNames == null) {
                // JNI has only two keep slots; three distinct live versions are
                // safer to defer until the next process than to delete one.
                Log.i(TAG, "Skipping cleanup: three live versions need protection");
                return;
            }
            action.run(keepNames[0], keepNames[1]);
        }
    }

    private void cleanUp() {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
        params.unzipDirectory = rootDir;
        enqueue(params);
    }
}
