package cn.reactnative.modules.update;

import android.app.Activity;
import android.content.Context;
import android.util.Log;

import com.facebook.react.ReactActivity;
import com.facebook.react.ReactApplication;
import com.facebook.react.ReactDelegate;
import com.facebook.react.ReactInstanceManager;
import com.facebook.react.bridge.JSBundleLoader;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.UiThreadUtil;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.Map;

public class UpdateModuleImpl {

    public static final String NAME = "Pushy";

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

    public static void reloadUpdate(final UpdateContext updateContext,final ReactApplicationContext mContext, final ReadableMap options, final Promise promise) {
        final String hash = options.getString("hash");
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {

                updateContext.switchVersion(hash);
                final Context application = mContext.getApplicationContext();
                JSBundleLoader loader = JSBundleLoader.createFileLoader(UpdateContext.getBundleUrl(application));
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
                    final Activity currentActivity = mContext.getCurrentActivity();
                    if (currentActivity == null) {
                        return;
                    }
                    try {
                        java.lang.reflect.Method getReactDelegateMethod = 
                            ReactActivity.class.getMethod("getReactDelegate");

                        ReactDelegate reactDelegate = (ReactDelegate) 
                            getReactDelegateMethod.invoke(currentActivity);

                        Field reactHostField = ReactDelegate.class.getDeclaredField("mReactHost");
                        reactHostField.setAccessible(true);
                        Object reactHost = reactHostField.get(reactDelegate);

                        Field devSupport = reactHost.getClass().getDeclaredField("mUseDevSupport");
                        devSupport.setAccessible(true);
                        devSupport.set(reactHost, false);

                        // Access the mReactHostDelegate field
                        Field reactHostDelegateField = reactHost.getClass().getDeclaredField("mReactHostDelegate");
                        reactHostDelegateField.setAccessible(true);
                        Object reactHostDelegate = reactHostDelegateField.get(reactHost);

                        String bundleFieldName = "jsBundleLoader";
                        if (reactHostDelegate.getClass().getCanonicalName().equals("expo.modules.ExpoReactHostFactory.ExpoReactHostDelegate")) {
                            bundleFieldName = "_jsBundleLoader";
                        }

                        // Modify the jsBundleLoader field
                        Field jsBundleLoaderField = reactHostDelegate.getClass().getDeclaredField(bundleFieldName);
                        jsBundleLoaderField.setAccessible(true);
                        jsBundleLoaderField.set(reactHostDelegate, loader);
                        
                        // Get the reload method with a String parameter
                        java.lang.reflect.Method reloadMethod = reactHost.getClass().getMethod("reload", String.class);

                        // Invoke the reload method with a reason
                        reloadMethod.invoke(reactHost, "react-native-update");
                    } catch (Throwable e) {
                        currentActivity.runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                currentActivity.recreate();
                            }
                        });
                    }
                }
                promise.resolve(true);
            }
        });
    }

    public static void restartApp(final ReactApplicationContext mContext, final Promise promise) {
          UiThreadUtil.runOnUiThread(new Runnable() {
              @Override
              public void run() {
                  try {
                      final Context application = mContext.getApplicationContext();
                      ReactInstanceManager instanceManager = ((ReactApplication) application).getReactNativeHost().getReactInstanceManager();

                      instanceManager.recreateReactContextInBackground();
                      promise.resolve(true);

                  } catch (Throwable err) {
                      promise.reject("restartApp failed: "+err.getMessage());
                      Log.e("pushy", "restartApp failed", err);

                      final Activity currentActivity = mContext.getCurrentActivity();
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
              }
          });
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
