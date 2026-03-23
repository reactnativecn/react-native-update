package cn.reactnative.modules.update;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import android.util.Log;
import com.facebook.react.ReactInstanceManager;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.io.File;

public class UpdateContext {
    static {
        NativeUpdateCore.ensureLoaded();
    }

    private Context context;
    private File rootDir;
    private Executor executor;

    public static boolean DEBUG = true;
    private static ReactInstanceManager mReactInstanceManager;
    private static boolean isUsingBundleUrl = false;
    private static final int STATE_OP_SWITCH_VERSION = 1;
    private static final int STATE_OP_MARK_SUCCESS = 2;
    private static final int STATE_OP_ROLLBACK = 3;
    private static final int STATE_OP_CLEAR_FIRST_TIME = 4;
    private static final int STATE_OP_CLEAR_ROLLBACK_MARK = 5;
    private static final int STATE_OP_RESOLVE_LAUNCH = 6;
    
    // Singleton instance
    private static UpdateContext sInstance;
    private static final Object sLock = new Object();

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
        this.context = context;
        this.executor = Executors.newSingleThreadExecutor();

        this.rootDir = new File(context.getFilesDir(), "_update");

        if (!rootDir.exists()) {
            rootDir.mkdir();
        }

        this.sp = context.getSharedPreferences("update", Context.MODE_PRIVATE);

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
            editor.apply();
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
        new DownloadTask(context).executeOnExecutor(this.executor, params);
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
        new DownloadTask(context).executeOnExecutor(this.executor, params);
    }

    public void downloadPatchFromApk(String url, String hash, DownloadFileListener listener) {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK;
        params.url = url;
        params.hash = hash;
        params.listener = listener;
        params.targetFile = new File(rootDir, hash + ".apk.patch");
        params.unzipDirectory = new File(rootDir, hash);
        new DownloadTask(context).executeOnExecutor(this.executor, params);
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
        new DownloadTask(context).executeOnExecutor(this.executor, params);
    }

    private SharedPreferences sp;

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
        editor.apply();
    }

    public void setKv(String key, String value) {
        SharedPreferences.Editor editor = sp.edit();
        editor.putString(key, value);
        editor.apply();
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
            editor.apply();

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
        editor.apply();

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
        editor.apply();

        this.cleanUp();
    }


    public static void setCustomInstanceManager(ReactInstanceManager instanceManager) {
        mReactInstanceManager = instanceManager;
    }

    public ReactInstanceManager getCustomReactInstanceManager() {
        return mReactInstanceManager;
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
            false,
            false
        );
        if (launchState.didRollback || launchState.consumedFirstTime) {
            SharedPreferences.Editor editor = sp.edit();
            applyState(editor, launchState);
            editor.apply();
        }

        String currentVersion = launchState.loadVersion;
        if (currentVersion == null) {
            return defaultAssetsUrl;
        }

        while (currentVersion != null) {
            File bundleFile = new File(rootDir, currentVersion+"/index.bundlejs");
            if (!bundleFile.exists()) {
                Log.e("getBundleUrl", "Bundle version " + currentVersion + " not found.");
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
        editor.apply();
        return nextState.currentVersion;
    }

    private void cleanUp() {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
        params.hash = sp.getString("currentVersion", null);
        params.originHash = sp.getString("lastVersion", null);
        params.unzipDirectory = rootDir;
        new DownloadTask(context).executeOnExecutor(this.executor, params);
    }
}
