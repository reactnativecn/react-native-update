package cn.reactnative.modules.update;

import static androidx.core.content.FileProvider.getUriForFile;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import com.facebook.react.bridge.ReactApplicationContext;
import java.io.File;
import java.util.HashMap;
import java.util.Map;

final class UpdateModuleSupport {
    private UpdateModuleSupport() {
    }

    static Map<String, Object> getConstants(UpdateContext updateContext) {
        final Map<String, Object> constants = new HashMap<String, Object>();
        constants.put("downloadRootDir", updateContext.getRootDir());
        constants.put("packageVersion", updateContext.getPackageVersion());

        String currentVersion = updateContext.getCurrentVersion();
        constants.put("currentVersion", currentVersion);
        constants.put("currentVersionInfo", updateContext.getKv("hash_" + currentVersion));
        constants.put("buildTime", updateContext.getBuildTime());
        constants.put("bundleHash", updateContext.getBundleHash());
        constants.put("isUsingBundleUrl", updateContext.getIsUsingBundleUrl());

        boolean isFirstTime = updateContext.consumeFirstLoadMarker();
        constants.put("isFirstTime", isFirstTime);

        String rolledBackVersion = updateContext.rolledBackVersion();
        constants.put("rolledBackVersion", rolledBackVersion);
        if (rolledBackVersion != null) {
            updateContext.clearRollbackMark();
        }

        constants.put("uuid", updateContext.getKv("uuid"));
        return constants;
    }

    static void installApk(ReactApplicationContext reactContext, File toInstall) {
        Uri apkUri;
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            apkUri = getUriForFile(
                reactContext,
                reactContext.getPackageName() + ".pushy.fileprovider",
                toInstall
            );
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

        reactContext.startActivity(intent);
    }
}
