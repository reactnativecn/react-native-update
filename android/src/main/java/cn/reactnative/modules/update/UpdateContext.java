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
    private Context context;
    private File rootDir;
    private Executor executor;

    public static boolean DEBUG = true;
    private static ReactInstanceManager mReactInstanceManager;
    private static boolean isUsingBundleUrl = false;
    
    // Singleton instance
    private static UpdateContext sInstance;
    private static final Object sLock = new Object();

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
        String storedPackageVersion = this.sp.getString("packageVersion", null);
        String storedBuildTime = this.sp.getString("buildTime", null);
        

        SharedPreferences.Editor editor = this.sp.edit();
        if (storedPackageVersion == null) {
            editor.putString("packageVersion", packageVersion);
            editor.apply();
            storedPackageVersion = packageVersion;
        }

        if (storedBuildTime == null) {
            editor.putString("buildTime", buildTime);
            editor.apply();
            storedBuildTime = buildTime;
        }
        
        boolean packageVersionChanged = !packageVersion.equals(storedPackageVersion);
        boolean buildTimeChanged = !buildTime.equals(storedBuildTime);
        
        if (packageVersionChanged || buildTimeChanged) {
            // Execute cleanUp before clearing SharedPreferences to avoid race condition
            this.cleanUp();
            
            SharedPreferences.Editor editor = sp.edit();
            editor.clear();
            editor.putString("packageVersion", packageVersion);
            editor.putString("buildTime", buildTime);
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

    public void switchVersion(String hash) {
        if (!new File(rootDir, hash+"/index.bundlejs").exists()) {
            throw new Error("Bundle version " + hash + " not found.");
        }
        String lastVersion = getCurrentVersion();
        SharedPreferences.Editor editor = sp.edit();
        editor.putString("currentVersion", hash);
        if (lastVersion != null && !lastVersion.equals(hash)) {
            editor.putString("lastVersion", lastVersion);
        }
        editor.putBoolean("firstTime", true);
        editor.putBoolean("firstTimeOk", false);
        editor.putString("rolledBackVersion", null);
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
            SharedPreferences.Editor editor = sp.edit();
            editor.putBoolean("firstTimeOk", true);
            String lastVersion = sp.getString("lastVersion", null);
            String curVersion = sp.getString("currentVersion", null);
            if (lastVersion != null && !lastVersion.equals(curVersion)) {
                editor.remove("lastVersion");
                editor.remove("hash_" + lastVersion);
            }
            editor.apply();

            this.cleanUp();
        }
    }

    public void clearFirstTime() {
        SharedPreferences.Editor editor = sp.edit();
        editor.putBoolean("firstTime", false);
        editor.apply();

        this.cleanUp();
    }

    public void clearRollbackMark() {
        SharedPreferences.Editor editor = sp.edit();
        editor.putString("rolledBackVersion", null);
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
        String currentVersion = getCurrentVersion();
        if (currentVersion == null) {
            return defaultAssetsUrl;
        }
        // Test should rollback.
        if (!sp.getBoolean("firstTime", false)) {
            if (!sp.getBoolean("firstTimeOk", true)) {
                // Not firstTime, but not ok, so we roll back.
                currentVersion = this.rollBack();
            }
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
        String lastVersion = sp.getString("lastVersion", null);
        String currentVersion = sp.getString("currentVersion", null);
        SharedPreferences.Editor editor = sp.edit();
        if (lastVersion == null) {
            editor.remove("currentVersion");
        } else {
            editor.remove("lastVersion");
            editor.putString("currentVersion", lastVersion);
        }
        editor.putBoolean("firstTimeOk", true);
        editor.putBoolean("firstTime", false);
        editor.putString("rolledBackVersion", currentVersion);
        editor.apply();
        return lastVersion;
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
