package cn.reactnative.modules.update;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import java.util.Map;

/**
 * New-architecture bridge: the codegen spec overrides only, every method
 * forwards to UpdateModuleImpl.
 */
public class UpdateModule extends NativePushySpec {
    private final UpdateModuleImpl impl;

    public UpdateModule(ReactApplicationContext reactContext, UpdateContext updateContext) {
        super(reactContext);
        this.impl = new UpdateModuleImpl(reactContext, updateContext);
    }

    public UpdateModule(ReactApplicationContext reactContext) {
        this(reactContext, UpdateContext.getInstance(reactContext));
    }

    @Override
    protected Map<String, Object> getTypedExportedConstants() {
        return impl.getConstants();
    }

    @Override
    public String getName() {
        return UpdateModuleImpl.NAME;
    }

    @Override
    public void downloadFullUpdate(ReadableMap options, Promise promise) {
        impl.downloadFullUpdate(options, promise);
    }

    @Override
    public void downloadAndInstallApk(ReadableMap options, Promise promise) {
        impl.downloadAndInstallApk(options, promise);
    }

    @Override
    public void downloadPatchFromPackage(ReadableMap options, Promise promise) {
        impl.downloadPatchFromPackage(options, promise);
    }

    @Override
    public void downloadPatchFromPpk(ReadableMap options, Promise promise) {
        impl.downloadPatchFromPpk(options, promise);
    }

    @Override
    public void reloadUpdate(ReadableMap options, Promise promise) {
        impl.reloadUpdate(options, promise);
    }

    @Override
    public void restartApp(Promise promise) {
        impl.restartApp(null, promise);
    }

    @Override
    public void setNeedUpdate(ReadableMap options, Promise promise) {
        impl.setNeedUpdate(options, promise);
    }

    @Override
    public void markSuccess(Promise promise) {
        impl.markSuccess(promise);
    }

    @Override
    public void getBundleHash(Promise promise) {
        impl.getBundleHash(promise);
    }

    @Override
    public void resetToPackagedBundle(Promise promise) {
        impl.resetToPackagedBundle(promise);
    }

    @Override
    public void setUuid(String uuid, Promise promise) {
        impl.setUuid(uuid, promise);
    }

    @Override
    public void syncNativeConfig(String config, Promise promise) {
        impl.syncNativeConfig(config, promise);
    }

    @Override
    public void getNativeCheckCache(Promise promise) {
        impl.getNativeCheckCache(promise);
    }

    @Override
    public void markJsCheckCompleted(String config, Promise promise) {
        impl.markJsCheckCompleted(config, promise);
    }

    @Override
    public void setLocalHashInfo(String hash, String info, Promise promise) {
        impl.setLocalHashInfo(hash, info, promise);
    }

    @Override
    public void getLocalHashInfo(String hash, Promise promise) {
        impl.getLocalHashInfo(hash, promise);
    }

    @Override
    public void addListener(String eventName) {
    }

    @Override
    public void removeListeners(double count) {
    }
}
