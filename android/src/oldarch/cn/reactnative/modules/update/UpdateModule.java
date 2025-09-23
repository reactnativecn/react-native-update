package cn.reactnative.modules.update;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import com.facebook.react.ReactApplication;
import com.facebook.react.ReactInstanceManager;
// import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.bridge.JSBundleLoader;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;
import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.Map;

import static androidx.core.content.FileProvider.getUriForFile;

public class UpdateModule extends ReactContextBaseJavaModule {
    UpdateContext updateContext;
    public static ReactApplicationContext mContext;
    // private LifecycleEventListener mLifecycleEventListener = null;

    public UpdateModule(ReactApplicationContext reactContext, UpdateContext updateContext) {
        super(reactContext);
        this.updateContext = updateContext;
        mContext = reactContext;
    }

    public UpdateModule(ReactApplicationContext reactContext) {
        this(reactContext, new UpdateContext(reactContext.getApplicationContext()));
    }

    @Override
    public Map<String, Object> getConstants() {
        final Map<String, Object> constants = new HashMap<>();
        constants.put("downloadRootDir", updateContext.getRootDir());
        constants.put("packageVersion", updateContext.getPackageVersion());
        String currentVersion = updateContext.getCurrentVersion();
        constants.put("currentVersion", currentVersion);
        constants.put("currentVersionInfo", updateContext.getKv("hash_" + currentVersion));
        constants.put("buildTime", updateContext.getBuildTime());
        constants.put("isUsingBundleUrl", updateContext.getIsUsingBundleUrl());
        boolean isFirstTime = updateContext.isFirstTime();
        constants.put("isFirstTime", isFirstTime);
        if (isFirstTime) {
            updateContext.clearFirstTime();
        }
        String rolledBackVersion = updateContext.rolledBackVersion();
        constants.put("rolledBackVersion", rolledBackVersion);
        if (rolledBackVersion != null) {
            updateContext.clearRollbackMark();
        }
        constants.put("uuid", updateContext.getKv("uuid"));
        return constants;
    }

    @Override
    public String getName() {
        return UpdateModuleImpl.NAME;
    }

    @ReactMethod
    public void downloadFullUpdate(ReadableMap options, final Promise promise) {
        String url = options.getString("updateUrl");
        String hash = options.getString("hash");
        updateContext.downloadFullUpdate(url, hash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    @ReactMethod
    public void downloadAndInstallApk(ReadableMap options, final Promise promise) {
        String url = options.getString("url");
        String hash = options.getString("hash");
        String target = options.getString("target");
        updateContext.downloadFile(url, hash, target, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                installApk(params.targetFile);
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    // install downloaded apk
    @ReactMethod
    public static void installApk(String url) {
        File toInstall = new File(url);
        installApk(toInstall);
    }

    public static void installApk(File toInstall) {
        Uri apkUri;
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            apkUri = getUriForFile(mContext, mContext.getPackageName() + ".pushy.fileprovider", toInstall);
            intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            intent.setData(apkUri);
            intent.setFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        } else {
            apkUri = Uri.fromFile(toInstall);
            intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        }
        mContext.startActivity(intent);
    }

    @ReactMethod
    private void downloadPatchFromPackage(ReadableMap options, final Promise promise) {
        String url = options.getString("updateUrl");
        String hash = options.getString("hash");
        
        updateContext.downloadPatchFromApk(url, hash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }
   
    @ReactMethod
    private void downloadPatchFromPpk(ReadableMap options, final Promise promise) {
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
                promise.reject(error);
            }
        });
    }

    private void loadBundleLegacy() {
        final Activity currentActivity = getCurrentActivity();
        if (currentActivity == null) {
            return;
        }

        currentActivity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                currentActivity.recreate();
            }
        });
    }

    @ReactMethod
    public void reloadUpdate(ReadableMap options, final Promise promise) {
        final String hash = options.getString("hash");

        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    updateContext.switchVersion(hash);
                    final Context application = getReactApplicationContext().getApplicationContext();
                    ReactInstanceManager instanceManager = updateContext.getCustomReactInstanceManager();

                    if (instanceManager == null) {
                        instanceManager = ((ReactApplication) application).getReactNativeHost().getReactInstanceManager();
                    }

                    try {
                        JSBundleLoader loader = JSBundleLoader.createFileLoader(UpdateContext.getBundleUrl(application));
                        Field loadField = instanceManager.getClass().getDeclaredField("mBundleLoader");
                        loadField.setAccessible(true);
                        loadField.set(instanceManager, loader);
                    } catch (Throwable err) {
                        promise.reject(err);
                        Field jsBundleField = instanceManager.getClass().getDeclaredField("mJSBundleFile");
                        jsBundleField.setAccessible(true);
                        jsBundleField.set(instanceManager, UpdateContext.getBundleUrl(application));
                    }
                    
                    instanceManager.recreateReactContextInBackground();
                    promise.resolve(true);

                } catch (Throwable err) {
                    promise.reject(err);
                    Log.e("pushy", "switchVersion failed ", err);
                    loadBundleLegacy();
                }
            }
        });
    }

    @ReactMethod
    public void restartApp(final Promise promise) {

        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    final Context application = getReactApplicationContext().getApplicationContext();
                    ReactInstanceManager instanceManager = updateContext.getCustomReactInstanceManager();
                    if (instanceManager == null) {
                        instanceManager = ((ReactApplication) application).getReactNativeHost().getReactInstanceManager();
                    }
                    instanceManager.recreateReactContextInBackground();
                    promise.resolve(true);

                } catch (Throwable err) {
                    promise.reject(err);
                    Log.e("pushy", "restartApp failed ", err);
                }
            }
        });
    }

    @ReactMethod
    public void setNeedUpdate(ReadableMap options) {
        final String hash = options.getString("hash");

        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    updateContext.switchVersion(hash);
                } catch (Throwable err) {
                    Log.e("pushy", "switchVersionLater failed", err);
                }
            }
        });
    }

    @ReactMethod
    public void markSuccess() {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.markSuccess();
            }
        });
    }

    @ReactMethod
    public void setUuid(final String uuid) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.setKv("uuid", uuid);
            }
        });
    }

    @ReactMethod
    public void setLocalHashInfo(final String hash, final String info) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.setKv("hash_" + hash, info);
            }
        });
    }

    @ReactMethod
    public void getLocalHashInfo(final String hash, final Promise promise) {
        promise.resolve(updateContext.getKv("hash_" + hash));
    }

    @ReactMethod
    public void addListener(String eventName) {
    // Set up any upstream listeners or background tasks as necessary
    }

    @ReactMethod
    public void removeListeners(Integer count) {
    // Remove upstream listeners, stop unnecessary background tasks
    }
    
    /* 发送事件*/
    public static void sendEvent(String eventName, WritableMap params) {
        ((ReactContext) mContext).getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(eventName,
                params);
    }
}
