package cn.reactnative.modules.update;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import java.util.Map;

public class UpdateModule extends NativePushySpec {
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
    protected Map<String, Object> getTypedExportedConstants() {
        return UpdateModuleSupport.getConstants(updateContext);
    }

    @Override
    public String getName() {
        return UpdateModuleImpl.NAME;
    }

    @Override
    public void downloadFullUpdate(ReadableMap options, Promise promise) {
        UpdateModuleImpl.downloadFullUpdate(updateContext, options, promise);
    }

    @Override
    public void downloadAndInstallApk(ReadableMap options, Promise promise) {
        UpdateModuleImpl.downloadAndInstallApk(
            getReactApplicationContext(),
            updateContext,
            options,
            promise
        );
    }

    @Override
    public void downloadPatchFromPackage(ReadableMap options, Promise promise) {
        UpdateModuleImpl.downloadPatchFromPackage(updateContext, options, promise);
    }

    @Override
    public void downloadPatchFromPpk(ReadableMap options, Promise promise) {
        UpdateModuleImpl.downloadPatchFromPpk(updateContext, options, promise);
    }

    @Override
    public void reloadUpdate(ReadableMap options, Promise promise) {
        UpdateModuleImpl.reloadUpdate(updateContext, getReactApplicationContext(), options, promise);
    }

    @Override
    public void restartApp(Promise promise) {
        UpdateModuleImpl.restartApp(updateContext, getReactApplicationContext(), null, promise);
    }

    @Override
    public void setNeedUpdate(ReadableMap options, Promise promise) {
        UpdateModuleImpl.setNeedUpdate(updateContext, options, promise);
    }

    @Override
    public void markSuccess(Promise promise) {
        UpdateModuleImpl.markSuccess(updateContext, promise);
    }

    @Override
    public void setUuid(String uuid, Promise promise) {
        UpdateModuleImpl.setUuid(updateContext, uuid, promise);
    }

    @Override
    public void setLocalHashInfo(String hash, String info, Promise promise) {
        UpdateModuleImpl.setLocalHashInfo(updateContext, hash, info, promise);
    }

    @Override
    public void getLocalHashInfo(String hash, Promise promise) {
        UpdateModuleImpl.getLocalHashInfo(updateContext, hash, promise);
    }

    @Override
    public void addListener(String eventName) {
    }

    @Override
    public void removeListeners(double count) {
    }
}
