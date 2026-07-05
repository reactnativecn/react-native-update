package cn.reactnative.modules.update;

import androidx.annotation.Nullable;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.facebook.react.bridge.WritableMap;
import java.lang.ref.WeakReference;

final class UpdateEventEmitter {
    private static WeakReference<ReactApplicationContext> reactContextRef =
        new WeakReference<ReactApplicationContext>(null);

    private UpdateEventEmitter() {
    }

    static synchronized void register(ReactApplicationContext reactContext) {
        reactContextRef = new WeakReference<ReactApplicationContext>(reactContext);
    }

    @Nullable
    private static synchronized ReactApplicationContext getReactContext() {
        return reactContextRef.get();
    }

    static void sendEvent(String eventName, WritableMap params) {
        ReactApplicationContext reactContext = getReactContext();
        if (reactContext == null || !hasActiveInstance(reactContext)) {
            return;
        }

        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(eventName, params);
    }

    @SuppressWarnings("deprecation")
    private static boolean hasActiveInstance(ReactApplicationContext reactContext) {
        try {
            // hasActiveCatalystInstance() is always false in bridgeless mode, which
            // silently drops every progress event on the new architecture.
            return reactContext.hasActiveReactInstance();
        } catch (NoSuchMethodError e) {
            // RN < 0.68 has no hasActiveReactInstance(); fall back for old peers.
            return reactContext.hasActiveCatalystInstance();
        }
    }
}
