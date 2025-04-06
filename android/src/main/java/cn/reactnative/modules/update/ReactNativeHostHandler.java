package cn.reactnative.modules.update;

import androidx.annotation.Nullable;

public interface ReactNativeHostHandler {
    @Nullable
    String getJSBundleFile(boolean useDeveloperSupport);
    
    @Nullable
    String getBundleAssetName(boolean useDeveloperSupport);
    
    void onWillCreateReactInstance(boolean useDeveloperSupport);
} 