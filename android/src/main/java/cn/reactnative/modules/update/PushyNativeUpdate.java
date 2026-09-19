package cn.reactnative.modules.update;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.Nullable;
import org.json.JSONObject;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/** Bridge-free native configuration and update APIs. */
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

    public interface ConfigurationCallback {
        /** Main thread; null means configuration was persisted successfully. */
        void onComplete(@Nullable Exception error);
    }

    // Configuration must not wait behind a network round that it invalidates.
    private static final Executor CONFIG_WORKER = Executors.newSingleThreadExecutor(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "pushy-host-config");
            thread.setDaemon(true);
            return thread;
        }
    });

    /**
     * Validate and persist a complete configuration, even before JS or bundle
     * resolution. This starts no network work and never resolves a bundle.
     * Await the callback before continuing startup/checkAndUpdate. Unless JS
     * uses nativeConfigSource: 'native', later JS config writes can replace it.
     */
    public static void configure(Context context, JSONObject options, final ConfigurationCallback callback) {
        if (context == null || options == null || callback == null) {
            throw new IllegalArgumentException("context, options and callback are required");
        }
        final Context applicationContext = context.getApplicationContext();
        // Snapshot caller-owned JSON before dispatch, not minutes later on a worker.
        final String snapshot = options.toString();
        CONFIG_WORKER.execute(new Runnable() {
            @Override
            public void run() {
                Exception failure = null;
                try {
                    String config = NativeUpdateConfig.normalize(snapshot);
                    UpdateContext.getInstance(applicationContext).setNativeConfig(config);
                } catch (Exception e) {
                    failure = e;
                } catch (LinkageError e) {
                    failure = new IllegalStateException("Native configuration failed", e);
                }
                final Exception error = failure;
                new Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override
                    public void run() {
                        callback.onComplete(error);
                    }
                });
            }
        });
    }

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
