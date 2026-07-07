package cn.reactnative.modules.update;

import android.util.Log;
import androidx.annotation.Nullable;
import com.facebook.react.bridge.Promise;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/**
 * Runs state-persistence operations (switchVersion / markSuccess / setUuid /
 * setLocalHashInfo) on a dedicated single background thread.
 *
 * These operations only read/modify SharedPreferences via a synchronous
 * commit(); they were previously dispatched to the UI thread purely to
 * serialize them. markSuccess in particular runs on every cold start, so doing
 * its blocking disk write on the main thread caused jank/ANR on low-end
 * devices. A single-thread executor preserves the same serialization guarantee
 * while keeping the disk I/O off the UI thread.
 *
 * Note: reload/restart operations must still run on the UI thread and therefore
 * keep using {@link UiThreadRunner}.
 */
final class StateSerialRunner {
    interface Operation {
        void run() throws Throwable;
    }

    // Single worker thread -> operations stay serialized in submission order,
    // matching the previous UI-thread behavior. The thread is named so it is
    // identifiable in thread dumps / ANR traces when diagnosing persistence.
    private static final Executor EXECUTOR = Executors.newSingleThreadExecutor(
        new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                return new Thread(r, "pushy-state-serial");
            }
        });

    private StateSerialRunner() {
    }

    static void run(
        @Nullable final Promise promise,
        final String errorCode,
        final String operationName,
        final Operation operation
    ) {
        EXECUTOR.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    operation.run();
                } catch (Throwable error) {
                    if (promise != null) {
                        promise.reject(errorCode, operationName + " failed", error);
                    } else {
                        Log.e(UpdateContext.TAG, operationName + " failed", error);
                    }
                }
            }
        });
    }
}
