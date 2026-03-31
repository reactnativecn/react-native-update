package cn.reactnative.modules.update;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import java.util.Map;

public class UpdateModule extends ReactContextBaseJavaModule {
    private final UpdateContext updateContext;

    public UpdateModule(ReactApplicationContext reactContext, UpdateContext updateContext) {
        super(reactContext);
        this.updateContext = updateContext;
        UpdateEventEmitter.register(reactContext);
    }

    public UpdateModule(ReactApplicationContext reactContext) {
        this(reactContext, UpdateContext.getInstance(reactContext));
    }

    @Override
    public Map<String, Object> getConstants() {
        return UpdateModuleSupport.getConstants(updateContext);
    }

    @Override
    public String getName() {
        return UpdateModuleImpl.NAME;
    }

    @ReactMethod
    public void downloadFullUpdate(ReadableMap options, Promise promise) {
        UpdateModuleImpl.downloadFullUpdate(updateContext, options, promise);
    }

    @ReactMethod
    public void downloadAndInstallApk(ReadableMap options, Promise promise) {
        UpdateModuleImpl.downloadAndInstallApk(
            getReactApplicationContext(),
            updateContext,
            options,
            promise
        );
    }

    @ReactMethod
    public void downloadPatchFromPackage(ReadableMap options, Promise promise) {
        UpdateModuleImpl.downloadPatchFromPackage(updateContext, options, promise);
    }

    @ReactMethod
    public void downloadPatchFromPpk(ReadableMap options, Promise promise) {
        UpdateModuleImpl.downloadPatchFromPpk(updateContext, options, promise);
    }

    @ReactMethod
    public void reloadUpdate(ReadableMap options, Promise promise) {
        UpdateModuleImpl.reloadUpdate(updateContext, getReactApplicationContext(), options, promise);
    }

    @ReactMethod
    public void restartApp(Promise promise) {
        UpdateModuleImpl.restartApp(updateContext, getReactApplicationContext(), null, promise);
    }

    @ReactMethod
    public void setNeedUpdate(ReadableMap options) {
        UpdateModuleImpl.setNeedUpdate(updateContext, options);
    }

    @ReactMethod
    public void markSuccess() {
        UpdateModuleImpl.markSuccess(updateContext);
    }

    @ReactMethod
    public void setUuid(String uuid) {
        UpdateModuleImpl.setUuid(updateContext, uuid);
    }

    @ReactMethod
    public void setLocalHashInfo(String hash, String info) {
        UpdateModuleImpl.setLocalHashInfo(updateContext, hash, info);
    }

    @ReactMethod
    public void getLocalHashInfo(String hash, Promise promise) {
        UpdateModuleImpl.getLocalHashInfo(updateContext, hash, promise);
    }

    @ReactMethod
    public void addListener(String eventName) {
    }

    @ReactMethod
    public void removeListeners(Integer count) {
    }
}
