package cn.reactnative.modules.update;

import android.app.Activity;
import android.content.Context;
import android.util.Log;

import com.facebook.react.ReactActivity;
import com.facebook.react.ReactApplication;
import com.facebook.react.ReactDelegate;
import com.facebook.react.ReactInstanceManager;
import com.facebook.react.ReactNativeHost;
import com.facebook.react.bridge.JSBundleLoader;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.UiThreadUtil;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;

public class UpdateModuleImpl {

    public static final String NAME = "Pushy";
    
    /**
     * 获取字段的兼容性方法，尝试带m前缀和不带m前缀的字段名
     * @param clazz 目标类
     * @param fieldName 基础字段名（不带m前缀）
     * @return 找到的字段对象
     * @throws NoSuchFieldException 如果两种命名都找不到字段
     */
    private static Field getCompatibleField(Class<?> clazz, String fieldName) throws NoSuchFieldException {
        // 首先尝试带m前缀的字段名
        try {
            return clazz.getDeclaredField("m" + capitalize(fieldName));
        } catch (NoSuchFieldException e) {
            // 如果找不到带m前缀的，尝试不带m前缀的
            try {
                return clazz.getDeclaredField(fieldName);
            } catch (NoSuchFieldException e2) {
                // 如果都找不到，抛出异常并包含两种尝试的信息
                throw new NoSuchFieldException("Field not found with either name: m" + capitalize(fieldName) + " or " + fieldName);
            }
        }
    }
    
    /**
     * 首字母大写的辅助方法
     */
    private static String capitalize(String str) {
        if (str == null || str.length() == 0) {
            return str;
        }
        return str.substring(0, 1).toUpperCase() + str.substring(1);
    }

    private static String getDefaultBundleAssetName(Context application) {
        String bundleAssetName = "index.android.bundle";
        if (!(application instanceof ReactApplication)) {
            return bundleAssetName;
        }

        try {
            ReactNativeHost reactNativeHost = ((ReactApplication) application).getReactNativeHost();
            if (reactNativeHost == null) {
                return bundleAssetName;
            }

            Method getBundleAssetNameMethod = ReactNativeHost.class.getDeclaredMethod("getBundleAssetName");
            getBundleAssetNameMethod.setAccessible(true);
            Object resolvedBundleAssetName = getBundleAssetNameMethod.invoke(reactNativeHost);
            if (resolvedBundleAssetName instanceof String && !((String) resolvedBundleAssetName).isEmpty()) {
                return (String) resolvedBundleAssetName;
            }
        } catch (Exception e) {
            Log.e(NAME, "Failed to get default asset name from ReactNativeHost: " + e.getMessage());
        }

        return bundleAssetName;
    }

    private static String toAssetUrl(String bundleAssetName) {
        if (bundleAssetName == null || bundleAssetName.isEmpty()) {
            return "assets://index.android.bundle";
        }
        if (bundleAssetName.startsWith("assets://")) {
            return bundleAssetName;
        }
        return "assets://" + bundleAssetName;
    }

    private static JSBundleLoader createBundleLoader(Context application, String updateBundlePath, boolean loadAssetSynchronously) {
        if (updateBundlePath != null) {
            return JSBundleLoader.createFileLoader(updateBundlePath);
        }
        return JSBundleLoader.createAssetLoader(
            application,
            toAssetUrl(getDefaultBundleAssetName(application)),
            loadAssetSynchronously
        );
    }

    private static Object getReactHost(Activity currentActivity, Context application) {
        if (currentActivity instanceof ReactActivity) {
            try {
                Method getReactDelegateMethod = ReactActivity.class.getMethod("getReactDelegate");
                ReactDelegate reactDelegate = (ReactDelegate) getReactDelegateMethod.invoke(currentActivity);
                if (reactDelegate != null) {
                    Field reactHostField = getCompatibleField(reactDelegate.getClass(), "reactHost");
                    reactHostField.setAccessible(true);
                    Object reactHost = reactHostField.get(reactDelegate);
                    if (reactHost != null) {
                        return reactHost;
                    }
                }
            } catch (Throwable ignored) {
            }
        }

        try {
            Method getReactHostMethod = application.getClass().getMethod("getReactHost");
            return getReactHostMethod.invoke(application);
        } catch (Throwable ignored) {
        }

        return null;
    }

    private static void reloadReactHost(Object reactHost, JSBundleLoader loader) throws Throwable {
        try {
            Field devSupportField = getCompatibleField(reactHost.getClass(), "useDevSupport");
            devSupportField.setAccessible(true);
            devSupportField.set(reactHost, false);
        } catch (Throwable ignored) {
        }

        Field reactHostDelegateField = getCompatibleField(reactHost.getClass(), "reactHostDelegate");
        reactHostDelegateField.setAccessible(true);
        Object reactHostDelegate = reactHostDelegateField.get(reactHost);

        String bundleFieldName = "jsBundleLoader";
        if ("expo.modules.ExpoReactHostFactory.ExpoReactHostDelegate".equals(reactHostDelegate.getClass().getCanonicalName())) {
            bundleFieldName = "_jsBundleLoader";
        }

        Field jsBundleLoaderField = reactHostDelegate.getClass().getDeclaredField(bundleFieldName);
        jsBundleLoaderField.setAccessible(true);
        jsBundleLoaderField.set(reactHostDelegate, loader);

        Method reloadMethod = reactHost.getClass().getMethod("reload", String.class);
        reloadMethod.invoke(reactHost, "react-native-update");
    }

    public static void downloadFullUpdate(UpdateContext updateContext, final ReadableMap options, final Promise promise) {
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

    public static void downloadAndInstallApk(UpdateContext updateContext, final ReadableMap options, final Promise promise) {
        String url = options.getString("url");
        String hash = options.getString("hash");
        String target = options.getString("target");
        updateContext.downloadFile(url, hash, target, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
               UpdateModule.installApk(params.targetFile);
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    public static void installApk(String url) {
        File toInstall = new File(url);
        UpdateModule.installApk(toInstall);
    }

    public static void downloadPatchFromPackage(UpdateContext updateContext, final ReadableMap options, final Promise promise) {
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

    public static void downloadPatchFromPpk(UpdateContext updateContext, final ReadableMap options, final Promise promise) {
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
                    promise.reject(error);
                }
            });
        }catch (Exception e){
            promise.reject("downloadPatchFromPpk failed: "+e.getMessage());
        }
    }

    public static void reloadUpdate(final UpdateContext updateContext, final ReactApplicationContext mContext, final ReadableMap options, final Promise promise) {
        final String hash = options.getString("hash");
        restartApp(updateContext, mContext, hash, promise);
    }


    public static void restartApp(final UpdateContext updateContext, final ReactApplicationContext mContext, final String hash, final Promise promise) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                // 如果提供了 hash，则切换版本
                if (hash != null && updateContext != null) {
                    updateContext.switchVersion(hash);
                }
                
                final Context application = mContext.getApplicationContext();
                String updateBundlePath = updateContext.getBundleUrl(application);
                final Activity currentActivity = mContext.getCurrentActivity();

                Object reactHost = getReactHost(currentActivity, application);
                if (reactHost != null) {
                    try {
                        reloadReactHost(reactHost, createBundleLoader(application, updateBundlePath, true));
                        promise.resolve(true);
                        return;
                    } catch (Throwable err) {
                        Log.e(NAME, "Failed to reload via ReactHost", err);
                    }
                }

                JSBundleLoader loader = createBundleLoader(application, updateBundlePath, false);
                try {
                    ReactInstanceManager instanceManager = updateContext.getCustomReactInstanceManager();

                    if (instanceManager == null) {
                        instanceManager = ((ReactApplication) application).getReactNativeHost().getReactInstanceManager();
                    }

                    try {
                        Field loadField = instanceManager.getClass().getDeclaredField("mBundleLoader");
                        loadField.setAccessible(true);
                        loadField.set(instanceManager, loader);
                    } catch (Throwable err) {
                        Field jsBundleField = instanceManager.getClass().getDeclaredField("mJSBundleFile");
                        jsBundleField.setAccessible(true);
                        jsBundleField.set(instanceManager, UpdateContext.getBundleUrl(application));
                    }

                    instanceManager.recreateReactContextInBackground();
                    promise.resolve(true);

                } catch (Throwable err) {
                    if (currentActivity == null) {
                        promise.reject(err);
                        return;
                    }
                    try {
                        Object currentReactHost = getReactHost(currentActivity, application);
                        if (currentReactHost == null) {
                            throw err;
                        }
                        reloadReactHost(currentReactHost, createBundleLoader(application, updateBundlePath, true));
                        promise.resolve(true);
                    } catch (Throwable e) {
                        currentActivity.runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                currentActivity.recreate();
                            }
                        });
                        promise.resolve(true);
                    }
                }
            }
        });
    }


    public static void restartApp(final ReactApplicationContext mContext, final Promise promise) {
        restartApp(null, mContext, null, promise);
    }

    public static void setNeedUpdate(final UpdateContext updateContext, final ReadableMap options, final Promise promise) {
        final String hash = options.getString("hash");
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    updateContext.switchVersion(hash);
                    promise.resolve(true);
                } catch (Throwable err) {
                    promise.reject("switchVersionLater failed: "+err.getMessage());
                    Log.e("pushy", "switchVersionLater failed", err);
                }
            }
        });
    }

    public static void markSuccess(final UpdateContext updateContext, final Promise promise) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.markSuccess();
                promise.resolve(true);
            }
        });
    }

    public static void setUuid(final UpdateContext updateContext, final String uuid, final Promise promise) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.setKv("uuid", uuid);
                promise.resolve(true);
            }
        });
    }

    public static boolean check(String json) {
        ObjectMapper mapper = new ObjectMapper();
        try {
            mapper.readValue(json, Map.class);
            return  true;
        } catch (IOException e) {
            return  false;
        }
    }


    public static void setLocalHashInfo(final UpdateContext updateContext, final String hash, final String info, final Promise promise) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (check(info)) {
                    updateContext.setKv("hash_" + hash, info);
                    promise.resolve(true);
                } else {
                    updateContext.setKv("hash_" + hash, info);
                    promise.reject("setLocalHashInfo failed: invalid json string");
                }
            }
        });
    }

    public static void getLocalHashInfo(UpdateContext updateContext, final String hash, final Promise promise) {
        String value = updateContext.getKv("hash_" + hash);
        if (check(value)) {
            promise.resolve(value);
        } else {
            promise.reject("getLocalHashInfo failed: invalid json string");
        }

    }

}
