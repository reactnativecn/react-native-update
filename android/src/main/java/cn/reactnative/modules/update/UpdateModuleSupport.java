package cn.reactnative.modules.update;

import android.util.Log;
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
        constants.put("currentBundleSha256", updateContext.currentBundleSha256(currentVersion));
        constants.put("buildTime", updateContext.getBuildTime());
        constants.put("isUsingBundleUrl", updateContext.getIsUsingBundleUrl());

        boolean isFirstTime = updateContext.consumeFirstLoadMarker();
        constants.put("isFirstTime", isFirstTime);

        String rolledBackVersion = updateContext.rolledBackVersion();
        constants.put("rolledBackVersion", rolledBackVersion);
        if (rolledBackVersion != null) {
            updateContext.clearRollbackMark();
        }

        constants.put("uuid", updateContext.getKv("uuid"));
        int supportedDiffVersion = 0;
        try {
            supportedDiffVersion = NativeUpdateCore.supportedDiffVersion();
        } catch (UnsatisfiedLinkError e) {
            // A mismatched librnupdate.so (stale manual copy / build cache)
            // must not crash startup via getConstants; 0 simply means "no v2
            // diff track" and the server degrades gracefully.
            Log.e("pushy", "supportedDiffVersion missing from librnupdate.so", e);
        }
        constants.put("supportedDiffVersion", supportedDiffVersion);
        return constants;
    }
}
