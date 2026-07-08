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
    File        targetFile;
    File        unzipDirectory;
    File        originDirectory;
    UpdateContext.DownloadFileListener listener;
}
