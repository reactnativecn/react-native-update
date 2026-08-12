package cn.reactnative.modules.update;

import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Crash-moment brick rescue (NATIVE_CHECKUPDATE_DESIGN §11): when the app is
 * dying of an uncaught exception during startup, the process is still alive
 * and JS will never run again — a natural, false-positive-free window to
 * finish the cold-start update check before the crash dialog appears.
 *
 * Etiquette: the previous default handler (crash reporters chain the same
 * way) is always invoked afterwards, whether the rescue ran, timed out or
 * threw. The rescue itself runs on a worker thread and the handler only
 * waits with a hard timeout, so even a deadlocked rescue (a thread that died
 * holding a lock) can only delay the process death, never prevent it.
 */
final class CrashRescue {
    private static final AtomicBoolean installed = new AtomicBoolean(false);
    private static final AtomicBoolean rescueAttempted = new AtomicBoolean(false);
    // ≈ process start: install() runs during the first bundle resolution.
    // Deliberately not Process.getStartElapsedRealtime(), which is API 24+
    // while the module's minSdk floor is lower — a NoSuchMethodError here
    // would silently disable the whole rescue on those devices.
    private static volatile long installedAtElapsedRealtime;
    private static final long TRIGGER_UPTIME_MILLIS = 60000;
    private static final long BUDGET_BACKGROUND_THREAD_MILLIS = 10000;
    // A held main thread stops input dispatch; stay under the ~5s ANR window.
    private static final long BUDGET_MAIN_THREAD_MILLIS = 3500;

    private CrashRescue() {
    }

    static void install() {
        if (!installed.compareAndSet(false, true)) {
            return;
        }
        installedAtElapsedRealtime = SystemClock.elapsedRealtime();
        final Thread.UncaughtExceptionHandler previous =
            Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable error) {
                try {
                    maybeHoldForRescue(thread);
                } catch (Throwable ignored) {
                    // The dying process owes the previous handler its turn no
                    // matter what the rescue did.
                }
                if (previous != null) {
                    previous.uncaughtException(thread, error);
                } else {
                    // Mirror RuntimeInit's default behaviour so the process
                    // still dies when no other handler was registered.
                    Process.killProcess(Process.myPid());
                    System.exit(10);
                }
            }
        });
    }

    private static void maybeHoldForRescue(Thread crashedThread) {
        // Once per process; a second crashing thread passes straight through
        // instead of waiting behind the first (§11.3: prefer under-rescuing
        // over wedging the teardown).
        if (!rescueAttempted.compareAndSet(false, true)) {
            return;
        }
        long uptimeMillis =
            SystemClock.elapsedRealtime() - installedAtElapsedRealtime;
        boolean roundInFlight = NativeCheckOrchestrator.isRoundInFlight();
        // Early crashes are the brick signature; a crash with an in-flight
        // round is worth finishing regardless of uptime. Everything else is
        // an ordinary crash whose UX must not be delayed.
        if (uptimeMillis >= TRIGGER_UPTIME_MILLIS && !roundInFlight) {
            return;
        }
        boolean onMainThread = crashedThread == Looper.getMainLooper().getThread();
        long budgetMillis = onMainThread
            ? BUDGET_MAIN_THREAD_MILLIS
            : BUDGET_BACKGROUND_THREAD_MILLIS;
        final long deadlineNanos =
            System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(budgetMillis);
        Log.i(UpdateContext.TAG, "crash rescue: holding process for up to "
            + budgetMillis + "ms (uptime " + uptimeMillis + "ms)");

        final CountDownLatch done = new CountDownLatch(1);
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    NativeCheckOrchestrator.runRescue(deadlineNanos);
                } catch (Throwable e) {
                    Log.w(UpdateContext.TAG, "crash rescue failed: " + e);
                } finally {
                    done.countDown();
                }
            }
        }, "pushy-crash-rescue");
        worker.setDaemon(true);
        worker.start();
        try {
            if (!done.await(budgetMillis, TimeUnit.MILLISECONDS)) {
                Log.w(UpdateContext.TAG, "crash rescue: budget exhausted, letting go");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
