package cn.reactnative.modules.update;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Iterator;
import java.util.zip.ZipEntry;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSink;
import okio.BufferedSource;
import okio.Okio;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

class DownloadTask implements Runnable {
    private static final int DOWNLOAD_CHUNK_SIZE = 4096;
    // When the server does not report Content-Length we cannot key progress
    // events on percentage change, so throttle by bytes to avoid flooding the
    // bridge (e.g. a 20MB chunked download would otherwise emit ~5000 events).
    private static final long PROGRESS_BYTES_THRESHOLD = 256 * 1024;
    // Explicit timeouts: the default client has no call timeout, so a
    // slow-dripping connection could occupy the single-threaded download
    // executor indefinitely and starve queued tasks. The call timeout is a
    // generous upper bound sized for large full-package downloads.
    private static final OkHttpClient HTTP_CLIENT = new OkHttpClient.Builder()
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .callTimeout(10, java.util.concurrent.TimeUnit.MINUTES)
            .build();

    static {
        NativeUpdateCore.ensureLoaded();
    }

    private static final class PatchArchiveContents {
        final ArrayList<String> entryNames = new ArrayList<String>();
        final ArrayList<String> copyFroms = new ArrayList<String>();
        final ArrayList<String> copyTos = new ArrayList<String>();
        final ArrayList<String> deletes = new ArrayList<String>();
        // __diff.json 的 hbcTransform 元数据(按 patch 条目名索引);
        // 为空对象/缺失时返回 ""(native 走现状路径)
        JSONObject hbcTransform;

        String hbcTransformMetaFor(String patchEntryName) {
            if (hbcTransform == null) {
                return "";
            }
            JSONObject meta = hbcTransform.optJSONObject(patchEntryName);
            return meta != null ? meta.toString() : "";
        }
        // Maps a copy source path ("from") to the CRC32 of the file content,
        // when provided by the manifest ("copiesCrc"). Lets the resource
        // copier locate the file by content if the path is not present on
        // device (APK baseline -> AAB install path shortening).
        final HashMap<String, Long> copyCrcs = new HashMap<String, Long>();
    }

    private final Context context;
    private final DownloadTaskParams params;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final byte[] buffer = new byte[DOWNLOAD_CHUNK_SIZE];
    private final BundledResourceCopier bundledResourceCopier;
    private String hash;
    // Set once downloadFile() returns: failures after this point in a patch
    // task are patch-application failures, not download failures.
    private boolean downloadPhaseCompleted = false;

    DownloadTask(Context context, DownloadTaskParams params) {
        this.context = context.getApplicationContext();
        this.params = params;
        this.bundledResourceCopier = new BundledResourceCopier(this.context);
    }

    private void postProgress(final long received, final long total) {
        // Cross-platform progress contract: unknown length is reported as
        // total=0, never a raw -1 (OkHttp's contentLength for chunked/gzip).
        final long normalizedTotal = total > 0 ? total : 0;
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WritableMap progress = Arguments.createMap();
                progress.putDouble("received", received);
                progress.putDouble("total", normalizedTotal);
                progress.putString("hash", hash);
                UpdateEventEmitter.sendEvent("RCTPushyDownloadProgress", progress);
            }
        });
    }

    private void downloadFile() throws IOException {
        this.hash = params.hash;
        String url = params.url;
        File writePath = params.targetFile;
        Request request = new Request.Builder().url(url).build();

        OkHttpClient requestClient = HTTP_CLIENT;
        if (params.deadlineNanos > 0) {
            long remainingNanos = params.deadlineNanos - System.nanoTime();
            if (remainingNanos <= 0) {
                throw new IOException("Download deadline expired before start");
            }
            long remainingMillis = Math.max(
                1L,
                java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(remainingNanos)
            );
            requestClient = HTTP_CLIENT.newBuilder()
                .callTimeout(remainingMillis, java.util.concurrent.TimeUnit.MILLISECONDS)
                .build();
        }

        UpdateFileUtils.ensureParentDirectory(writePath);
        if (writePath.exists() && !writePath.delete()) {
            throw new IOException("Failed to replace existing file: " + writePath);
        }

        try (Response response = requestClient.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("Server error: " + response.code() + " " + response.message());
            }

            ResponseBody body = response.body();
            if (body == null) {
                throw new IOException("Empty response body for " + url);
            }

            long contentLength = body.contentLength();
            long bytesRead;
            long received = 0;
            int currentPercentage = 0;
            long lastPostedBytes = 0;

            try (
                BufferedSource source = body.source();
                BufferedSink sink = Okio.buffer(Okio.sink(writePath))
            ) {
                while ((bytesRead = source.read(sink.buffer(), DOWNLOAD_CHUNK_SIZE)) != -1) {
                    received += bytesRead;
                    sink.emit();

                    if (contentLength > 0) {
                        int percentage = (int) (received * 100.0 / contentLength + 0.5);
                        if (percentage > currentPercentage) {
                            currentPercentage = percentage;
                            lastPostedBytes = received;
                            postProgress(received, contentLength);
                        }
                    } else if (received - lastPostedBytes >= PROGRESS_BYTES_THRESHOLD) {
                        lastPostedBytes = received;
                        postProgress(received, contentLength);
                    }
                }
                sink.flush();
            }

            if (contentLength >= 0 && received != contentLength) {
                throw new IOException("Unexpected eof while reading downloaded update");
            }
            // Final progress event, skipped when the loop already posted this
            // exact value (known length reaching 100% posts it in-loop).
            if (received != lastPostedBytes) {
                postProgress(received, contentLength);
            }
        }

        downloadPhaseCompleted = true;
    }

    private byte[] readBytes(InputStream input) throws IOException {
        try (
            InputStream in = input;
            ByteArrayOutputStream out = new ByteArrayOutputStream()
        ) {
            int count;
            while ((count = in.read(buffer)) != -1) {
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    private void appendManifestEntries(
        JSONObject manifest,
        ArrayList<String> copyFroms,
        ArrayList<String> copyTos,
        ArrayList<String> deletes,
        HashMap<String, Long> copyCrcs
    ) throws JSONException {
        JSONObject copiesCrc = manifest.optJSONObject("copiesCrc");

        JSONObject copies = manifest.optJSONObject("copies");
        if (copies != null) {
            Iterator<?> keys = copies.keys();
            while (keys.hasNext()) {
                String to = (String) keys.next();
                String from = copies.getString(to);
                if (from.isEmpty()) {
                    from = to;
                }
                copyFroms.add(from);
                copyTos.add(to);
                if (copiesCrc != null && copyCrcs != null && copiesCrc.has(to)) {
                    // Same content => same crc, so grouping multiple "to" under
                    // one "from" stays consistent.
                    copyCrcs.put(from, copiesCrc.getLong(to));
                }
            }
        }

        JSONObject deleteMap = manifest.optJSONObject("deletes");
        if (deleteMap != null) {
            Iterator<?> deleteKeys = deleteMap.keys();
            while (deleteKeys.hasNext()) {
                deletes.add((String) deleteKeys.next());
            }
        }
    }

    private void copyBundledAssetToFile(String assetName, File destination) throws IOException {
        try (InputStream in = context.getAssets().open(assetName)) {
            UpdateFileUtils.copyInputStreamToFile(in, destination);
        }
    }

    private HashMap<String, ArrayList<File>> buildCopyList(
        File unzipDirectory,
        CopyGroupResult[] groups
    ) throws IOException {
        HashMap<String, ArrayList<File>> copyList = new HashMap<String, ArrayList<File>>();
        if (groups == null) {
            return copyList;
        }

        String rootPath = unzipDirectory.getCanonicalPath() + File.separator;
        for (CopyGroupResult group : groups) {
            ArrayList<File> targets = new ArrayList<File>();
            if (group.toPaths != null) {
                for (String to : group.toPaths) {
                    File toFile = new File(unzipDirectory, to);
                    String canonicalPath = toFile.getCanonicalPath();
                    if (!canonicalPath.startsWith(rootPath)) {
                        throw new SecurityException("Illegal name: " + to);
                    }
                    targets.add(toFile);
                }
            }
            copyList.put(group.from, targets);
        }

        return copyList;
    }

    private PatchArchiveContents extractPatchArchive(File archiveFile, File unzipDirectory)
        throws IOException, JSONException {
        UpdateFileUtils.removeDirectory(unzipDirectory);
        UpdateFileUtils.ensureDirectory(unzipDirectory);

        PatchArchiveContents contents = new PatchArchiveContents();
        try (SafeZipFile zipFile = new SafeZipFile(archiveFile)) {
            Enumeration<? extends ZipEntry> entries = zipFile.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                contents.entryNames.add(name);

                if (name.equals("__diff.json")) {
                    byte[] bytes = readBytes(zipFile.getInputStream(entry));
                    String json = new String(bytes, StandardCharsets.UTF_8);
                    JSONObject manifest = (JSONObject) new JSONTokener(json).nextValue();
                    appendManifestEntries(
                        manifest,
                        contents.copyFroms,
                        contents.copyTos,
                        contents.deletes,
                        contents.copyCrcs
                    );
                    contents.hbcTransform = manifest.optJSONObject("hbcTransform");
                    continue;
                }

                zipFile.unzipToPath(entry, unzipDirectory);
            }
        }
        return contents;
    }

    private void doFullPatch() throws IOException {
        downloadFile();

        UpdateFileUtils.removeDirectory(params.unzipDirectory);
        UpdateFileUtils.ensureDirectory(params.unzipDirectory);

        try (SafeZipFile zipFile = new SafeZipFile(params.targetFile)) {
            Enumeration<? extends ZipEntry> entries = zipFile.entries();
            while (entries.hasMoreElements()) {
                zipFile.unzipToPath(entries.nextElement(), params.unzipDirectory);
            }
        }

        if (params.targetFile.exists()) {
            params.targetFile.delete();
        }
    }

    private void doPatchFromApk() throws IOException, JSONException {
        downloadFile();
        PatchArchiveContents contents = extractPatchArchive(params.targetFile, params.unzipDirectory);

        buildArchivePatchPlan(
            DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK,
            contents.entryNames.toArray(new String[0]),
            contents.copyFroms.toArray(new String[0]),
            contents.copyTos.toArray(new String[0]),
            contents.deletes.toArray(new String[0])
        );

        HashMap<String, ArrayList<File>> copyList = buildCopyList(
            params.unzipDirectory,
            buildCopyGroups(
                contents.copyFroms.toArray(new String[0]),
                contents.copyTos.toArray(new String[0])
            )
        );

        File originBundleFile = new File(params.unzipDirectory, ".origin.bundle");
        copyBundledAssetToFile("index.android.bundle", originBundleFile);
        try {
            applyPatchFromFileSource(
                params.unzipDirectory.getAbsolutePath(),
                params.unzipDirectory.getAbsolutePath(),
                originBundleFile.getAbsolutePath(),
                new File(params.unzipDirectory, "index.bundlejs.patch").getAbsolutePath(),
                new File(params.unzipDirectory, "index.bundlejs").getAbsolutePath(),
                "",
                false,
                new String[0],
                new String[0],
                new String[0],
                contents.hbcTransformMetaFor("index.bundlejs.patch")
            );
        } finally {
            originBundleFile.delete();
        }

        bundledResourceCopier.copyFromResource(copyList, contents.copyCrcs);
        if (params.targetFile.exists()) {
            params.targetFile.delete();
        }
    }

    private void doPatchFromPpk() throws IOException, JSONException {
        downloadFile();
        PatchArchiveContents contents = extractPatchArchive(params.targetFile, params.unzipDirectory);

        ArchivePatchPlanResult plan = buildArchivePatchPlan(
            DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK,
            contents.entryNames.toArray(new String[0]),
            contents.copyFroms.toArray(new String[0]),
            contents.copyTos.toArray(new String[0]),
            contents.deletes.toArray(new String[0])
        );

        applyPatchFromFileSource(
            params.originDirectory.getAbsolutePath(),
            params.unzipDirectory.getAbsolutePath(),
            new File(params.originDirectory, "index.bundlejs").getAbsolutePath(),
            new File(params.unzipDirectory, "index.bundlejs.patch").getAbsolutePath(),
            new File(params.unzipDirectory, "index.bundlejs").getAbsolutePath(),
            plan.mergeSourceSubdir,
            plan.enableMerge,
            contents.copyFroms.toArray(new String[0]),
            contents.copyTos.toArray(new String[0]),
            contents.deletes.toArray(new String[0]),
            contents.hbcTransformMetaFor("index.bundlejs.patch")
        );
        if (params.targetFile.exists()) {
            params.targetFile.delete();
        }
    }

    private void doCleanUp() {
        cleanupOldEntries(
            params.unzipDirectory.getAbsolutePath(),
            params.hash,
            params.originHash,
            params.maxAgeDays
        );
    }

    private void cleanUpAfterFailure(int taskType) {
        switch (taskType) {
            case DownloadTaskParams.TASK_TYPE_PATCH_FULL:
            case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK:
            case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
                try {
                    UpdateFileUtils.removeDirectory(params.unzipDirectory);
                } catch (IOException ioException) {
                    Log.e(UpdateContext.TAG, "Failed to clean patched directory", ioException);
                }
                break;
            case DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD:
                if (
                    params.targetFile.exists()
                        && !params.targetFile.delete()
                        && UpdateContext.DEBUG
                ) {
                    Log.w(UpdateContext.TAG, "Failed to clean partial download " + params.targetFile);
                }
                break;
            default:
                break;
        }
    }

    private boolean isPatchTask(int taskType) {
        return taskType == DownloadTaskParams.TASK_TYPE_PATCH_FULL
            || taskType == DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK
            || taskType == DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
    }

    private boolean hasCompletedPatchDirectory() {
        return params.unzipDirectory != null
            && new File(params.unzipDirectory, "index.bundlejs").isFile()
            && new File(
                params.unzipDirectory,
                UpdateContext.VERSION_COMPLETE_FILE
            ).isFile();
    }

    @Override
    public void run() {
        int taskType = params.type;
        final boolean alreadyCompleted = isPatchTask(taskType)
            && hasCompletedPatchDirectory();
        try {
            if (alreadyCompleted) {
                Log.i(UpdateContext.TAG,
                    "download task: version " + params.hash + " already completed");
            } else {
                switch (taskType) {
                    case DownloadTaskParams.TASK_TYPE_PATCH_FULL:
                        doFullPatch();
                        break;
                    case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK:
                        doPatchFromApk();
                        break;
                    case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
                        doPatchFromPpk();
                        break;
                    case DownloadTaskParams.TASK_TYPE_CLEANUP:
                        doCleanUp();
                        break;
                    case DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD:
                        downloadFile();
                        break;
                    default:
                        break;
                }
            }
        } catch (Throwable error) {
            Log.e(UpdateContext.TAG, "download task failed", error);
            // A duplicate task must never delete a version completed by an
            // earlier queued task. The marker + bundle pair is the ownership
            // handoff: once present, this failure did not create that install.
            if (!hasCompletedPatchDirectory()) {
                cleanUpAfterFailure(taskType);
            }

            if (params.listener != null) {
                // A patch task that failed after its artifact was fully
                // downloaded (unzip / hdiff / resource copy, incl. copiesCrc
                // verification) is a patch failure, not a download failure —
                // the module maps the exception type to PATCH_FAILED.
                Throwable classified = error;
                if (downloadPhaseCompleted
                    && isPatchTask(taskType)
                    && !(error instanceof PatchFailedException)) {
                    classified = new PatchFailedException(
                        String.valueOf(error.getMessage()), error);
                }
                params.listener.onDownloadFailed(classified);
            }
            return;
        }

        if (isPatchTask(taskType) && !alreadyCompleted) {
            try {
                File marker = new File(
                    params.unzipDirectory,
                    UpdateContext.VERSION_COMPLETE_FILE
                );
                if (!marker.createNewFile() && !marker.isFile()) {
                    throw new IOException("Failed to mark completed update: " + marker);
                }
            } catch (Throwable error) {
                Log.e(UpdateContext.TAG, "failed to mark completed update", error);
                cleanUpAfterFailure(taskType);
                if (params.listener != null) {
                    params.listener.onDownloadFailed(error);
                }
                return;
            }
        }

        // The task itself succeeded. Run the completion callback outside the
        // try/catch above so an exception thrown by the callback (e.g. a
        // FileProvider misconfiguration during installApk) is not mistaken for
        // a download failure that deletes the successfully downloaded file and
        // settles the promise a second time.
        if (params.listener != null) {
            try {
                params.listener.onDownloadCompleted(params);
            } catch (Throwable error) {
                Log.e(UpdateContext.TAG, "download completion callback failed", error);
                params.listener.onDownloadFailed(error);
            }
        }
    }

    private static native void applyPatchFromFileSource(
        String sourceRoot,
        String targetRoot,
        String originBundlePath,
        String bundlePatchPath,
        String bundleOutputPath,
        String mergeSourceSubdir,
        boolean enableMerge,
        String[] copyFroms,
        String[] copyTos,
        String[] deletes,
        String hbcTransformMeta
    );

    private static native void cleanupOldEntries(
        String rootDir,
        String keepCurrent,
        String keepPrevious,
        int maxAgeDays
    );

    private static native ArchivePatchPlanResult buildArchivePatchPlan(
        int patchType,
        String[] entryNames,
        String[] copyFroms,
        String[] copyTos,
        String[] deletes
    );

    private static native CopyGroupResult[] buildCopyGroups(
        String[] copyFroms,
        String[] copyTos
    );
}
