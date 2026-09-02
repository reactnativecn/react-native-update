package cn.reactnative.modules.update;

import java.io.IOException;

/**
 * A download task refused by a local file-system rule rather than by the
 * network or the patch itself — today: reinstalling the version this process
 * is running from in place (DownloadTask.ensureNotReinstallingRunningVersion).
 * UpdateModuleImpl rejects these with FILE_OPERATION_FAILED.
 */
class FileOperationException extends IOException {
    FileOperationException(String message) {
        super(message);
    }
}
