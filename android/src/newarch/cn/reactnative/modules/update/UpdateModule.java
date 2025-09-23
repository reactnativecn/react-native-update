package cn.reactnative.modules.update;

import static androidx.core.content.FileProvider.getUriForFile;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import java.io.File;
import java.util.HashMap;
import java.util.Map;

public class UpdateModule extends NativePushySpec {
    UpdateContext updateContext;
    public static ReactApplicationContext mContext;
    private final Handler handler = new Handler(Looper.getMainLooper());
    public UpdateModule(ReactApplicationContext reactContext, UpdateContext updateContext) {
        super(reactContext);
        this.updateContext = updateContext;
        mContext = reactContext;
    }

    public UpdateModule(ReactApplicationContext reactContext) {
        this(reactContext, new UpdateContext(reactContext.getApplicationContext()));
    }

    @Override
    protected Map<String, Object> getTypedExportedConstants() {
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
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    updateContext.clearFirstTime();
                }
            }, 2000);
        }
        String rolledBackVersion = updateContext.rolledBackVersion();
        constants.put("rolledBackVersion", rolledBackVersion);
        if (rolledBackVersion != null) {
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    updateContext.clearRollbackMark();
                }
            }, 2000);
        }
        constants.put("uuid", updateContext.getKv("uuid"));
        return constants;
    }

    @Override
    public String getName() {
        return UpdateModuleImpl.NAME;
    }

    @Override
    public void downloadFullUpdate(ReadableMap options, final Promise promise) {
        UpdateModuleImpl.downloadFullUpdate(this.updateContext,options,promise);
    }

    @Override
    public void downloadAndInstallApk(ReadableMap options, final Promise promise) {
        UpdateModuleImpl.downloadAndInstallApk(this.updateContext,options,promise);
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

    @Override
    public void downloadPatchFromPackage(ReadableMap options, final Promise promise) {
        UpdateModuleImpl.downloadPatchFromPackage(updateContext,options,promise);
    }

    @Override
    public void downloadPatchFromPpk(ReadableMap options, final Promise promise) {
        UpdateModuleImpl.downloadPatchFromPpk(updateContext,options,promise);
    }

    @Override
    public void reloadUpdate(ReadableMap options,Promise promise) {
        UpdateModuleImpl.reloadUpdate(updateContext, mContext, options,promise);
    }

    @Override
    public void restartApp(Promise promise) {
        UpdateModuleImpl.restartApp(mContext, promise);
    }

    @Override
    public void setNeedUpdate(ReadableMap options,Promise promise) {
        UpdateModuleImpl.setNeedUpdate(updateContext, options,promise);
    }

    @Override
    public void markSuccess(Promise promise) {
        UpdateModuleImpl.markSuccess(updateContext,promise);
    }

    @Override
    public void setUuid(final String uuid, Promise promise) {
        UpdateModuleImpl.setUuid(updateContext,uuid,promise);
    }

    @Override
    public void setLocalHashInfo(final String hash, final String info, final Promise promise) {
        UpdateModuleImpl.setLocalHashInfo(updateContext,hash,info,promise);
    }

    @Override
    public void getLocalHashInfo(final String hash, final Promise promise) {
        UpdateModuleImpl.getLocalHashInfo(updateContext,hash,promise);
    }

    @Override
    public void addListener(String eventName) {
        // Set up any upstream listeners or background tasks as necessary
    }

    @Override
    public void removeListeners(double count) {
        // Remove upstream listeners, stop unnecessary background tasks
    }


    /* 发送事件*/
    public static void sendEvent(String eventName, WritableMap params) {
        ((ReactContext) mContext).getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(eventName,
                params);
    }
}
