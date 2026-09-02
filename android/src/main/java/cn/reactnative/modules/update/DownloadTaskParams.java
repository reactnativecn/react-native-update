package cn.reactnative.modules.update;

import java.io.File;

/**
 * Created by tdzl2003 on 3/31/16.
 */
class DownloadTaskParams {
    static final int TASK_TYPE_CLEANUP          = 0; //Keep hash & originHash

    static final int TASK_TYPE_PATCH_FULL       = 1;
    static final int TASK_TYPE_PATCH_FROM_APK   = 2;
    static final int TASK_TYPE_PATCH_FROM_PPK   = 3;
    static final int TASK_TYPE_PLAIN_DOWNLOAD   = 4;


    int         type;
    String      url;
    String      hash;
    String      originHash;
    // TASK_TYPE_CLEANUP only: entries younger than this survive; 0 = delete all
    int         maxAgeDays = 3;
    // Absolute System.nanoTime deadline for orchestrated cold-start downloads;
    // 0 keeps the normal public API's 10-minute per-call timeout.
    long        deadlineNanos;
    File        targetFile;
    File        unzipDirectory;
    File        originDirectory;
    UpdateContext.DownloadFileListener listener;

    // Cooperative cancellation for orchestrated downloads (CODE_AUDIT 2.12):
    // the native check cancels a task whose phase budget expired, so it
    // neither starts late on the single download thread nor keeps
    // transferring behind the next attempt. Guarded by this.
    private boolean cancelled;
    private okhttp3.Call activeCall;

    synchronized void cancel() {
        cancelled = true;
        if (activeCall != null) {
            activeCall.cancel();
        }
    }

    synchronized boolean isCancelled() {
        return cancelled;
    }

    /**
     * Registers the transfer in flight (null clears it); a task cancelled
     * before its transfer started cancels the call right here.
     */
    synchronized void attachCall(okhttp3.Call call) {
        activeCall = call;
        if (cancelled && call != null) {
            call.cancel();
        }
    }
}
