package cn.reactnative.modules.update;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import java.util.Map;

/**
 * Old-architecture bridge: @ReactMethod declarations only, every method
 * forwards to UpdateModuleImpl. Each state-changing method takes a trailing
 * Promise, like the TurboModule spec, so a failed persistence rejects instead
 * of resolving early (CODE_AUDIT 2.3).
 */
public class UpdateModule extends ReactContextBaseJavaModule {
    private final UpdateModuleImpl impl;

    public UpdateModule(ReactApplicationContext reactContext, UpdateContext updateContext) {
        super(reactContext);
        this.impl = new UpdateModuleImpl(reactContext, updateContext);
    }

    public UpdateModule(ReactApplicationContext reactContext) {
        this(reactContext, UpdateContext.getInstance(reactContext));
    }

    @Override
    public Map<String, Object> getConstants() {
        return impl.getConstants();
    }

    @Override
    public String getName() {
        return UpdateModuleImpl.NAME;
    }

    @ReactMethod
    public void downloadFullUpdate(ReadableMap options, Promise promise) {
        impl.downloadFullUpdate(options, promise);
    }

    @ReactMethod
    public void downloadAndInstallApk(ReadableMap options, Promise promise) {
        impl.downloadAndInstallApk(options, promise);
    }

    @ReactMethod
    public void downloadPatchFromPackage(ReadableMap options, Promise promise) {
        impl.downloadPatchFromPackage(options, promise);
    }

    @ReactMethod
    public void downloadPatchFromPpk(ReadableMap options, Promise promise) {
        impl.downloadPatchFromPpk(options, promise);
    }

    @ReactMethod
    public void reloadUpdate(ReadableMap options, Promise promise) {
        impl.reloadUpdate(options, promise);
    }

    @ReactMethod
    public void restartApp(Promise promise) {
        impl.restartApp(null, promise);
    }

    @ReactMethod
    public void setNeedUpdate(ReadableMap options, Promise promise) {
        impl.setNeedUpdate(options, promise);
    }

    @ReactMethod
    public void markSuccess(Promise promise) {
        impl.markSuccess(promise);
    }

    @ReactMethod
    public void getBundleHash(Promise promise) {
        impl.getBundleHash(promise);
    }

    @ReactMethod
    public void resetToPackagedBundle(Promise promise) {
        impl.resetToPackagedBundle(promise);
    }

    @ReactMethod
    public void setUuid(String uuid, Promise promise) {
        impl.setUuid(uuid, promise);
    }

    @ReactMethod
    public void syncNativeConfig(String config, Promise promise) {
        impl.syncNativeConfig(config, promise);
    }

    @ReactMethod
    public void getNativeCheckCache(Promise promise) {
        impl.getNativeCheckCache(promise);
    }

    @ReactMethod
    public void markJsCheckCompleted(String config, Promise promise) {
        impl.markJsCheckCompleted(config, promise);
    }

    @ReactMethod
    public void setLocalHashInfo(String hash, String info, Promise promise) {
        impl.setLocalHashInfo(hash, info, promise);
    }

    @ReactMethod
    public void getLocalHashInfo(String hash, Promise promise) {
        impl.getLocalHashInfo(hash, promise);
    }

    @ReactMethod
    public void addListener(String eventName) {
    }

    @ReactMethod
    public void removeListeners(Integer count) {
    }
}
