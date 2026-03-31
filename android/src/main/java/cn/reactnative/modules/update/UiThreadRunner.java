package cn.reactnative.modules.update;

import android.util.Log;
import androidx.annotation.Nullable;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.UiThreadUtil;

final class UiThreadRunner {
    interface Operation {
        void run() throws Throwable;
    }

    private UiThreadRunner() {
    }

    static void run(
        @Nullable final Promise promise,
        final String operationName,
        final Operation operation
    ) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    operation.run();
                } catch (Throwable error) {
                    if (promise != null) {
                        promise.reject(operationName + " failed", error);
                    } else {
                        Log.e(UpdateContext.TAG, operationName + " failed", error);
                    }
                }
            }
        });
    }
}
