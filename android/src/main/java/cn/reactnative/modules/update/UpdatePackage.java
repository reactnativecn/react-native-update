package cn.reactnative.modules.update;

import androidx.annotation.Nullable;
import com.facebook.react.TurboReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;
import java.util.HashMap;
import java.util.Map;

public class UpdatePackage extends TurboReactPackage {
    @Nullable
    @Override
    public NativeModule getModule(String name, ReactApplicationContext reactContext) {
        return name.equals(UpdateModuleImpl.NAME) ? new UpdateModule(reactContext) : null;
    }

    @Override
    public ReactModuleInfoProvider getReactModuleInfoProvider() {
        return new ReactModuleInfoProvider() {
            @Override
            public Map<String, ReactModuleInfo> getReactModuleInfos() {
                final Map<String, ReactModuleInfo> moduleInfos = new HashMap<>();
                boolean isTurboModule = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED;
                moduleInfos.put(
                        UpdateModuleImpl.NAME,
                        new ReactModuleInfo(
                                UpdateModuleImpl.NAME,
                                UpdateModuleImpl.NAME,
                                false, // canOverrideExistingModule
                                false, // needsEagerInit
                                true, // hasConstants
                                false, // isCxxModule
                                isTurboModule // isTurboModule
                        ));
                return moduleInfos;
            }
        };
    }
}
