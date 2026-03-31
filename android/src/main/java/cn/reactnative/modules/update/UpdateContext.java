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
    private boolean isUsingBundleUrl;
    private boolean ignoreRollback;
    private static final int STATE_OP_SWITCH_VERSION = 1;
    private static final int STATE_OP_MARK_SUCCESS = 2;
    private static final int STATE_OP_ROLLBACK = 3;
    private static final int STATE_OP_CLEAR_FIRST_TIME = 4;
    private static final int STATE_OP_CLEAR_ROLLBACK_MARK = 5;
    private static final int STATE_OP_RESOLVE_LAUNCH = 6;
    private static final String KEY_FIRST_LOAD_MARKED = "firstLoadMarked";
    
    // Singleton instance
    private static UpdateContext sInstance;
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

    public UpdateContext(Context context) {
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

    private void enqueue(DownloadTaskParams params) {
        executor.execute(new DownloadTask(context, params));
    }

    public interface DownloadFileListener {
        void onDownloadCompleted(DownloadTaskParams params);
        void onDownloadFailed(Throwable error);
    }

    public void downloadFullUpdate(String url, String hash, DownloadFileListener listener) {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FULL;
        params.url = url;
        params.hash = hash;
        params.listener = listener;
        params.targetFile = new File(rootDir, hash + ".ppk");
        params.unzipDirectory = new File(rootDir, hash);
        enqueue(params);
    }

    public void downloadFile(String url, String hash, String fileName, DownloadFileListener listener) {
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
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK;
        params.url = url;
        params.hash = hash;
        params.listener = listener;
        params.targetFile = new File(rootDir, hash + ".apk.patch");
        params.unzipDirectory = new File(rootDir, hash);
        enqueue(params);
    }

    public void downloadPatchFromPpk(String url, String hash, String originHash, DownloadFileListener listener) {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
        params.url = url;
        params.hash = hash;
        params.originHash = originHash;
        params.listener = listener;
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
        if (!editor.commit() && DEBUG) {
            Log.w(TAG, "Failed to persist update state for " + reason);
        }
    }

    public void switchVersion(String hash) {
        if (!new File(rootDir, hash+"/index.bundlejs").exists()) {
            throw new Error("Bundle version " + hash + " not found.");
        }
        StateCoreResult currentState = getStateSnapshot();
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
        StateCoreResult currentState = getStateSnapshot();
        StateCoreResult launchState = runStateCore(
            STATE_OP_RESOLVE_LAUNCH,
            currentState,
            null,
            ignoreRollback,
            true
        );
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

        while (currentVersion != null) {
            File bundleFile = new File(rootDir, currentVersion+"/index.bundlejs");
            if (!bundleFile.exists()) {
                Log.e(TAG, "Bundle version " + currentVersion + " not found.");
                currentVersion = this.rollBack();
                continue;
            }
            return bundleFile.toString();
        }

        return defaultAssetsUrl;
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
