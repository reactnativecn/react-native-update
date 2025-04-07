package expo.modules.pushy;

import android.content.Context;
import android.util.Log;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import cn.reactnative.modules.update.UpdateContext;
import expo.modules.core.interfaces.Package;
import expo.modules.core.interfaces.ReactNativeHostHandler;

public class ExpoPushyPackage  implements Package {
    @Override
    public List<ReactNativeHostHandler> createReactNativeHostHandlers(Context context) {
        List<ReactNativeHostHandler> handlers = new ArrayList<>();
        handlers.add(new ReactNativeHostHandler() {
            @Nullable
            @Override
            public String getJSBundleFile(boolean useDeveloperSupport) {
                return UpdateContext.getBundleUrl(context);
            }
        });
        return handlers;
    }
}