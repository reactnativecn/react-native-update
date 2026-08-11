package cn.reactnative.modules.update;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import android.util.Log;
import com.facebook.react.ReactInstanceManager;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

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

    private ReactInstanceManager reactInstanceManager;
    // Written on the launch path, read from executor/JS threads.
    private volatile boolean isUsingBundleUrl;
    private volatile boolean ignoreRollback;
    // The version whose bundle this process actually loaded (resolved in
    // getBundleUrl). resetToPackagedBundle must not delete its directory:
    // update assets (images/fonts) are read from it on demand at runtime, so
    // wiping it under a silent (no-restart) reset would break every image the
    // running app has not loaded yet. Volatile: written during launch, read
    // from the state serial executor.
    private volatile String launchVersion;
    private static final int STATE_OP_SWITCH_VERSION = 1;
    private static final int STATE_OP_MARK_SUCCESS = 2;
    private static final int STATE_OP_ROLLBACK = 3;
    private static final int STATE_OP_CLEAR_FIRST_TIME = 4;
    private static final int STATE_OP_CLEAR_ROLLBACK_MARK = 5;
    private static final int STATE_OP_RESOLVE_LAUNCH = 6;
    private static final String KEY_FIRST_LOAD_MARKED = "firstLoadMarked";
    static final String VERSION_COMPLETE_FILE = ".pushy-complete";
    // Bumped by resetToPackagedBundle. The cold-start check runs for minutes
    // and may already hold a decision when the app resets to the packaged
    // bundle; the orchestrator samples this counter and abandons activation
    // (and its response cache) when the value moved, so an in-flight rescue
    // can never resurrect the version the app just reset away from.
    private static final java.util.concurrent.atomic.AtomicLong resetGeneration =
        new java.util.concurrent.atomic.AtomicLong(0);
    // Held by resetToPackagedBundle and by the cold-start check's commit, so
    // the generation check and the writes it guards are one atomic step.
    private static final Object commitLock = new Object();
    
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
        this.executor = Executors.newSingleThreadExecutor();

        this.rootDir = new File(this.context.getFilesDir(), "_update");

        if (!rootDir.exists() && !rootDir.mkdirs() && !rootDir.exists()) {
            throw new IllegalStateException("Failed to create update root dir: " + rootDir);
        }

        this.sp = this.context.getSharedPreferences("update", Context.MODE_PRIVATE);
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

    public String getPackageVersion() {
        PackageManager pm = context.getPackageManager();
        PackageInfo pi = null;
        try {
            pi = pm.getPackageInfo(context.getPackageName(), 0);
            return pi.versionName;
        } catch( PackageManager.NameNotFoundException e) {
            e.printStackTrace();
        }
        return null;
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
        try {
            PackageInfo pi = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0);
            return pi.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
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

    // Server-provided identifiers (hash/originHash/fileName) become child
    // names under rootDir; anything that could resolve outside of it (path
    // separators, "..", ".") must be rejected before touching the filesystem.
    static boolean isSafePathComponent(String name) {
        return name != null
                && !name.isEmpty()
                && !name.equals(".")
                && !name.equals("..")
                && !name.contains("/")
                && !name.contains("\\")
                && name.indexOf('\0') < 0;
    }

    private static boolean rejectUnsafeComponent(String name, DownloadFileListener listener) {
        if (isSafePathComponent(name)) {
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

    void downloadFullUpdate(
        String url, String hash, DownloadFileListener listener, long deadlineNanos
    ) {
        if (rejectUnsafeComponent(hash, listener)) {
            return;
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

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N && fileName.equals("update.apk")) {
            params.targetFile = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "pushy_update.apk");

        } else {
            params.targetFile = new File(rootDir, fileName);

        }
//        params.unzipDirectory = new File(rootDir, hash);
        enqueue(params);
    }

    public void downloadPatchFromApk(String url, String hash, DownloadFileListener listener) {
        downloadPatchFromApk(url, hash, listener, 0);
    }

    void downloadPatchFromApk(
        String url, String hash, DownloadFileListener listener, long deadlineNanos
    ) {
        if (rejectUnsafeComponent(hash, listener)) {
            return;
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
    }

    public void downloadPatchFromPpk(String url, String hash, String originHash, DownloadFileListener listener) {
        downloadPatchFromPpk(url, hash, originHash, listener, 0);
    }

    void downloadPatchFromPpk(
        String url,
        String hash,
        String originHash,
        DownloadFileListener listener,
        long deadlineNanos
    ) {
        if (rejectUnsafeComponent(hash, listener) || rejectUnsafeComponent(originHash, listener)) {
            return;
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

    private void persistEditor(SharedPreferences.Editor editor, String reason) {
        // A lost state write can mean a missed rollback or a version switch
        // that silently never happens, so this must be visible in release too.
        if (!editor.commit()) {
            Log.e(TAG, "Failed to persist update state for " + reason);
        }
    }

    public void switchVersion(String hash) {
        if (!isSafePathComponent(hash)) {
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
        if (!new File(versionDir, VERSION_COMPLETE_FILE).isFile()
            && !isLegacyActivatedVersion) {
            // Versions activated before completion markers were introduced are
            // explicitly grandfathered through current/last state. An arbitrary
            // markerless directory may be a crash-left partial install.
            throw new IllegalStateException("Bundle version " + hash + " is incomplete.");
        }
        StateCoreResult nextState = runStateCore(
            STATE_OP_SWITCH_VERSION,
            currentState,
            hash
            ,
            false,
            false
        );
        SharedPreferences.Editor editor = sp.edit();
        applyState(editor, nextState);
        persistEditor(editor, "switch version");
        ignoreRollback = false;
    }

    public void setKv(String key, String value) {
        SharedPreferences.Editor editor = sp.edit();
        editor.putString(key, value);
        persistEditor(editor, "set key " + key);
    }

    public String getKv(String key) {
        return sp.getString(key, null);
    }

    public String getCurrentVersion() {
        return sp.getString("currentVersion", null);
    }

    public boolean isFirstTime() {
        return sp.getBoolean("firstTime", false);
    }

    public boolean consumeFirstLoadMarker() {
        boolean isFirstLoadMarked = sp.getBoolean(KEY_FIRST_LOAD_MARKED, false);
        if (isFirstLoadMarked) {
            SharedPreferences.Editor editor = sp.edit();
            editor.remove(KEY_FIRST_LOAD_MARKED);
            persistEditor(editor, "clear first load marker");
        }
        return isFirstLoadMarked;
    }

    public String rolledBackVersion() {
        return sp.getString("rolledBackVersion", null);
    }

    public void markSuccess() {
        if (!BuildConfig.DEBUG) {
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
            persistEditor(editor, "mark success");

            this.cleanUp();
        }
    }

    public void clearFirstTime() {
        StateCoreResult currentState = getStateSnapshot();
        StateCoreResult nextState = runStateCore(
            STATE_OP_CLEAR_FIRST_TIME,
            currentState,
            null,
            false,
            false
        );
        SharedPreferences.Editor editor = sp.edit();
        applyState(editor, nextState);
        editor.remove(KEY_FIRST_LOAD_MARKED);
        persistEditor(editor, "clear first time");

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
        persistEditor(editor, "reset to packaged bundle");
        ignoreRollback = false;
        // editor.clear() above already dropped the cached check response; it
        // still advertised the version this reset removed.
        Log.i(TAG, "Reset to packaged bundle");

        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
        params.maxAgeDays = 0;
        // Keep the directory of the version this process is running from (a
        // silent reset would otherwise break its on-demand asset loads); the
        // orphaned directory is removed by the next regular cleanup.
        params.hash = launchVersion;
        params.unzipDirectory = rootDir;
        enqueue(params);
    }

    public void clearRollbackMark() {
        StateCoreResult currentState = getStateSnapshot();
        StateCoreResult nextState = runStateCore(
            STATE_OP_CLEAR_ROLLBACK_MARK,
            currentState,
            null,
            false,
            false
        );
        SharedPreferences.Editor editor = sp.edit();
        applyState(editor, nextState);
        persistEditor(editor, "clear rollback mark");

        this.cleanUp();
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
        synchronized (commitLock) {
            if (resetGeneration.get() != expectedGeneration) {
                return false;
            }
            if (hash != null && hashInfoJson != null) {
                setKv("hash_" + hash, hashInfoJson);
            }
            if (activate && hash != null) {
                switchVersion(hash);
            }
            if (responseCacheJson != null) {
                setKv(NativeCheckOrchestrator.KEY_RESP_CACHE, responseCacheJson);
            }
            return true;
        }
    }

    boolean hasCompletedVersion(String hash) {
        if (!isSafePathComponent(hash)) {
            return false;
        }
        File versionDir = new File(rootDir, hash);
        return new File(versionDir, "index.bundlejs").isFile()
            && new File(versionDir, VERSION_COMPLETE_FILE).isFile();
    }

    private String rollBack() {
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

    private void cleanUp() {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
        params.hash = sp.getString("currentVersion", null);
        params.originHash = sp.getString("lastVersion", null);
        params.unzipDirectory = rootDir;
        enqueue(params);
    }
}
