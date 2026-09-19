package cn.reactnative.modules.update;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/** Native host API. Configuration remains owned and persisted by the JS SDK. */
public final class PushyNativeUpdate {
    public interface Callback {
        /** Always called on the main thread, including skipped and failed checks. */
        void onComplete(NativeUpdateResult result);
    }

    // A single waiting worker, not one thread per caller. The actual round is
    // shared with cold start and crash rescue by NativeCheckOrchestrator.
    private static final Executor WORKER = Executors.newSingleThreadExecutor(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "pushy-host-check");
            thread.setDaemon(true);
            return thread;
        }
    });

    private PushyNativeUpdate() {
    }

    /**
     * Start the process's native check now, join its in-flight round, or return
     * its completed result. This does not reload React Native or show UI.
     *
     * Call after the host has resolved its real launch bundle with
     * UpdateContext.getBundleUrl. Do not resolve the bundle again just to call
     * this method: bundle resolution consumes first-load/rollback markers.
     * Missing persisted configuration and debug builds are reported as skipped.
     */
    public static void checkAndUpdate(Context context, final Callback callback) {
        if (context == null || callback == null) {
            throw new IllegalArgumentException("context and callback are required");
        }
        final Context applicationContext = context.getApplicationContext();
        WORKER.execute(new Runnable() {
            @Override
            public void run() {
                NativeUpdateResult outcome;
                try {
                    if (BuildConfig.DEBUG) {
                        outcome = NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "debug");
                    } else {
                        outcome = NativeCheckOrchestrator.checkAndUpdate(
                            UpdateContext.getInstance(applicationContext));
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    outcome = NativeUpdateResult.of(NativeUpdateResult.CANCELLED, "interrupted");
                } catch (Exception | LinkageError e) {
                    Log.w("react-native-update", "native host check failed", e);
                    outcome = NativeUpdateResult.of(NativeUpdateResult.FAILED, "internal_error");
                }
                final NativeUpdateResult result = outcome;
                new Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override
                    public void run() {
                        callback.onComplete(result);
                    }
                });
            }
        });
    }
}
