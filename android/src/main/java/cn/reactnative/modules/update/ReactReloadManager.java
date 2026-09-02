package cn.reactnative.modules.update;

import android.app.Activity;
import android.content.Context;
import android.util.Log;
import androidx.annotation.Nullable;
import com.facebook.react.ReactActivity;
import com.facebook.react.ReactApplication;
import com.facebook.react.ReactDelegate;
import com.facebook.react.ReactInstanceManager;
import com.facebook.react.ReactNativeHost;
import com.facebook.react.bridge.JSBundleLoader;
import com.facebook.react.bridge.ReactApplicationContext;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

final class ReactReloadManager {
    private ReactReloadManager() {
    }

    /**
     * First half of a restart, for the state serial thread: activate the
     * requested version (bundle digest + commit) and resolve the bundle to
     * load. Nothing here touches React, so nothing here needs the UI thread
     * (CODE_AUDIT 2.2). Returns the bundle path, or null for the packaged
     * bundle.
     */
    @Nullable
    static String prepareRestart(UpdateContext updateContext, @Nullable String hash) {
        if (hash != null) {
            updateContext.switchVersion(hash);
        }
        return updateContext.getBundleUrl();
    }

    /**
     * Second half, for the UI thread: point the running React instance at
     * {@code updateBundlePath} and reload it. Throws when no supported
     * injection worked — the caller rejects RESTART_FAILED. There is
     * deliberately no Activity.recreate() fallback: it would reload the
     * previous bundle while the promise reported success (CODE_AUDIT 2.9).
     */
    static void reload(
        UpdateContext updateContext,
        ReactApplicationContext reactContext,
        @Nullable String updateBundlePath
    ) throws Throwable {
        Context application = reactContext.getApplicationContext();
        Activity currentActivity = reactContext.getCurrentActivity();

        boolean newArchitectureEnabled = isNewArchitectureEnabled(application);
        Object reactHost = newArchitectureEnabled ? getReactHost(currentActivity, application) : null;
        if (reactHost != null) {
            try {
                reloadReactHost(reactHost, createBundleLoader(application, updateBundlePath, true));
                return;
            } catch (Throwable err) {
                Log.e(UpdateContext.TAG,
                    "Failed to reload via ReactHost, trying ReactInstanceManager", err);
            }
        }

        JSBundleLoader loader = createBundleLoader(application, updateBundlePath, false);
        ReactInstanceManager instanceManager =
            resolveReactInstanceManager(updateContext, application);

        // Java (mBundleLoader / mJSBundleFile) and Kotlin (bundleLoader /
        // jsBundleFile) spellings of the private fields are both tried.
        try {
            Field loadField = getCompatibleField(instanceManager.getClass(), "bundleLoader");
            loadField.setAccessible(true);
            loadField.set(instanceManager, loader);
        } catch (Throwable err) {
            Field jsBundleField = getCompatibleField(instanceManager.getClass(), "jsBundleFile");
            jsBundleField.setAccessible(true);
            jsBundleField.set(instanceManager, updateBundlePath);
        }

        instanceManager.recreateReactContextInBackground();
    }

    private static Field getCompatibleField(Class<?> clazz, String fieldName)
        throws NoSuchFieldException {
        try {
            return clazz.getDeclaredField("m" + capitalize(fieldName));
        } catch (NoSuchFieldException e) {
            try {
                return clazz.getDeclaredField(fieldName);
            } catch (NoSuchFieldException e2) {
                throw new NoSuchFieldException(
                    "Field not found with either name: m"
                        + capitalize(fieldName)
                        + " or "
                        + fieldName
                );
            }
        }
    }

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
            Log.e(UpdateContext.TAG, "Failed to get default asset name from ReactNativeHost", e);
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

    private static JSBundleLoader createBundleLoader(
        Context application,
        @Nullable String updateBundlePath,
        boolean loadAssetSynchronously
    ) {
        if (updateBundlePath != null) {
            return JSBundleLoader.createFileLoader(updateBundlePath);
        }
        return JSBundleLoader.createAssetLoader(
            application,
            toAssetUrl(getDefaultBundleAssetName(application)),
            loadAssetSynchronously
        );
    }

    @Nullable
    private static Object getReactHost(@Nullable Activity currentActivity, Context application) {
        if (currentActivity instanceof ReactActivity) {
            try {
                Method getReactDelegateMethod = ReactActivity.class.getMethod("getReactDelegate");
                ReactDelegate reactDelegate =
                    (ReactDelegate) getReactDelegateMethod.invoke(currentActivity);
                if (reactDelegate != null) {
                    Field reactHostField = getCompatibleField(reactDelegate.getClass(), "reactHost");
                    reactHostField.setAccessible(true);
                    Object reactHost = reactHostField.get(reactDelegate);
                    if (reactHost != null) {
                        return reactHost;
                    }
                }
            } catch (Throwable ignored) {
                Log.w(UpdateContext.TAG, "getReactHost via ReactDelegate reflection failed", ignored);
            }
        }

        try {
            Method getReactHostMethod = application.getClass().getMethod("getReactHost");
            return getReactHostMethod.invoke(application);
        } catch (Throwable ignored) {
            Log.w(UpdateContext.TAG, "getReactHost via Application.getReactHost() failed", ignored);
        }

        return null;
    }

    private static boolean isNewArchitectureEnabled(Context application) {
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            return true;
        }

        try {
            Class<?> buildConfigClass = Class.forName(application.getPackageName() + ".BuildConfig");
            Field newArchitectureField = buildConfigClass.getField("IS_NEW_ARCHITECTURE_ENABLED");
            if (newArchitectureField.getBoolean(null)) {
                return true;
            }
        } catch (Throwable ignored) {
        }

        if (application instanceof ReactApplication) {
            try {
                ReactNativeHost reactNativeHost = ((ReactApplication) application).getReactNativeHost();
                Method isNewArchEnabledMethod = getDeclaredMethodInHierarchy(
                    reactNativeHost.getClass(),
                    "isNewArchEnabled"
                );
                isNewArchEnabledMethod.setAccessible(true);
                Object result = isNewArchEnabledMethod.invoke(reactNativeHost);
                return result instanceof Boolean && (Boolean) result;
            } catch (Throwable ignored) {
            }
        }

        return false;
    }

    private static Method getDeclaredMethodInHierarchy(Class<?> clazz, String methodName)
        throws NoSuchMethodException {
        Class<?> current = clazz;
        while (current != null) {
            try {
                return current.getDeclaredMethod(methodName);
            } catch (NoSuchMethodException ignored) {
                current = current.getSuperclass();
            }
        }

        throw new NoSuchMethodException(methodName);
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
        if ("expo.modules.ExpoReactHostFactory.ExpoReactHostDelegate".equals(
            reactHostDelegate.getClass().getCanonicalName()
        )) {
            bundleFieldName = "_jsBundleLoader";
        }

        Field jsBundleLoaderField = reactHostDelegate.getClass().getDeclaredField(bundleFieldName);
        jsBundleLoaderField.setAccessible(true);
        jsBundleLoaderField.set(reactHostDelegate, loader);

        Method reloadMethod = reactHost.getClass().getMethod("reload", String.class);
        reloadMethod.invoke(reactHost, "react-native-update");
    }

    private static ReactInstanceManager resolveReactInstanceManager(
        UpdateContext updateContext,
        Context application
    ) {
        ReactInstanceManager instanceManager = updateContext.getCustomReactInstanceManager();
        if (instanceManager != null) {
            return instanceManager;
        }
        return ((ReactApplication) application).getReactNativeHost().getReactInstanceManager();
    }
}
