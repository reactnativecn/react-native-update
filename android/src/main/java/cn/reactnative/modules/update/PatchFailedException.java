package cn.reactnative.modules.update;

import java.io.IOException;

/**
 * A download task failure that happened after the artifact was fully
 * downloaded — unzip, hdiff apply, or bundled-resource copy (including the
 * copiesCrc content verification). UpdateModuleImpl rejects these with
 * PATCH_FAILED instead of DOWNLOAD_FAILED so the JS layer and server-side
 * telemetry can separate patch health from network health.
 */
class PatchFailedException extends IOException {
    PatchFailedException(String message, Throwable cause) {
        super(message, cause);
    }
}
