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
import okhttp3.Call;
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

    // Two-phase install (cpp/patch_core/install_record.h): all unpack/patch
    // work happens in <hash>.staging; the final <hash> directory only ever
    // appears through an atomic rename after the completion record was
    // written, so a crash or failure can never leave a half-installed
    // directory that looks like a version.
    private File stagingDirectory() {
        return InstallRecord.stagingDirectoryFor(params.unzipDirectory);
    }

    // SHA-256 of the downloaded archive, computed right before extraction.
    private String artifactSha256 = "";

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

    // Sidecar next to the archive recording what a partial download belongs
    // to (url + validators + total). An archive without a matching sidecar is
    // untrusted and restarted from zero; the pair is deleted together with
    // the archive once it is consumed or classified as poisoned.
    private static File resumeSidecarFile(File archive) {
        return new File(archive.getPath() + ".resume");
    }

    static void deleteResumeSidecar(File archive) {
        File sidecar = resumeSidecarFile(archive);
        if (sidecar.exists() && !sidecar.delete() && UpdateContext.DEBUG) {
            Log.w(UpdateContext.TAG, "Failed to delete resume sidecar " + sidecar);
        }
    }

    private JSONObject readResumeMeta(File sidecar, String url) {
        if (!sidecar.isFile()) {
            return null;
        }
        try {
            byte[] bytes = readBytes(new java.io.FileInputStream(sidecar));
            JSONObject meta = (JSONObject) new JSONTokener(
                new String(bytes, StandardCharsets.UTF_8)).nextValue();
            if (url.equals(meta.optString("url"))) {
                return meta;
            }
        } catch (Throwable e) {
            // A corrupt sidecar simply means "cannot resume".
        }
        return null;
    }

    private void writeResumeMeta(
        File sidecar, String url, Response response, JSONObject previousMeta, long total
    ) {
        try {
            JSONObject meta = new JSONObject();
            meta.put("url", url);
            String etag = response.header("ETag");
            String lastModified = response.header("Last-Modified");
            if (etag == null && previousMeta != null) {
                etag = previousMeta.optString("etag", null);
            }
            if (lastModified == null && previousMeta != null) {
                lastModified = previousMeta.optString("lastModified", null);
            }
            if (etag != null) {
                meta.put("etag", etag);
            }
            if (lastModified != null) {
                meta.put("lastModified", lastModified);
            }
            if (total > 0) {
                meta.put("total", total);
            }
            UpdateFileUtils.ensureParentDirectory(sidecar);
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(sidecar)) {
                out.write(meta.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable e) {
            // Non-fatal: without a sidecar the next attempt starts from zero.
            Log.w(UpdateContext.TAG, "Failed to persist resume sidecar: " + e);
        }
    }

    private void downloadFile() throws IOException {
        this.hash = params.hash;
        String url = params.url;
        File writePath = params.targetFile;
        File sidecar = resumeSidecarFile(writePath);
        UpdateFileUtils.ensureParentDirectory(writePath);

        // Cross-launch resume (NATIVE_CHECKUPDATE_DESIGN §11.4): a brick gets
        // a few hundred milliseconds per launch plus a bounded crash-rescue
        // window, so every partial byte must survive process death and count.
        long resumeOffset = 0;
        JSONObject resumeMeta = readResumeMeta(sidecar, url);
        if (resumeMeta != null && writePath.isFile() && writePath.length() > 0) {
            long knownTotal = resumeMeta.optLong("total", 0);
            long size = writePath.length();
            if (knownTotal > 0 && size == knownTotal) {
                // Fully received in a previous attempt (the process died
                // between download end and unzip): nothing left to transfer.
                downloadPhaseCompleted = true;
                postProgress(knownTotal, knownTotal);
                return;
            }
            if (knownTotal <= 0 || size < knownTotal) {
                resumeOffset = size;
            }
        }
        if (resumeOffset == 0) {
            if (writePath.exists() && !writePath.delete()) {
                throw new IOException("Failed to replace existing file: " + writePath);
            }
            deleteResumeSidecar(writePath);
        }

        if (!transferArchive(url, writePath, sidecar, resumeMeta, resumeOffset)) {
            // The server rejected the range for a partial that no longer
            // matches (416): drop it and retry once from zero.
            if (writePath.exists() && !writePath.delete()) {
                throw new IOException("Failed to replace existing file: " + writePath);
            }
            deleteResumeSidecar(writePath);
            if (!transferArchive(url, writePath, sidecar, null, 0)) {
                throw new IOException("Server rejected the download range for " + url);
            }
        }
        downloadPhaseCompleted = true;
    }

    /**
     * One HTTP transfer, appending from resumeOffset when the server honours
     * the range. Returns false only for the retryable stale-partial case
     * (416 with a size mismatch); throws on every other failure.
     */
    private boolean transferArchive(
        String url, File writePath, File sidecar, JSONObject resumeMeta, long resumeOffset
    ) throws IOException {
        Request.Builder builder = new Request.Builder().url(url);
        if (resumeOffset > 0) {
            // Only resume requests pin the encoding: Range offsets must
            // address the same bytes that are on disk. Fresh downloads keep
            // OkHttp's transparent gzip (it decompresses and strips the
            // headers itself), matching the pre-resume behaviour for servers
            // that compress regardless.
            builder.header("Accept-Encoding", "identity");
            builder.header("Range", "bytes=" + resumeOffset + "-");
            String validator = null;
            if (resumeMeta != null) {
                validator = resumeMeta.optString("etag", null);
                if (validator == null) {
                    validator = resumeMeta.optString("lastModified", null);
                }
            }
            if (validator != null) {
                // With a validator the server falls back to a full 200 when
                // the file changed instead of appending mismatched bytes.
                builder.header("If-Range", validator);
            }
        }

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

        Call call = requestClient.newCall(builder.build());
        // Registered so an orchestrated phase timeout can cancel it
        // (CODE_AUDIT 2.12); cleared once the transfer is over.
        params.attachCall(call);
        try (Response response = call.execute()) {
            rejectProtocolDowngrade(url, response);
            if (response.code() == 416) {
                long total = resumeMeta == null ? 0 : resumeMeta.optLong("total", 0);
                if (total > 0 && writePath.length() == total) {
                    // The partial is actually the complete file.
                    postProgress(total, total);
                    return true;
                }
                return false;
            }
            if (!response.isSuccessful()) {
                throw new IOException("Server error: " + response.code() + " " + response.message());
            }

            ResponseBody body = response.body();
            if (body == null) {
                throw new IOException("Empty response body for " + url);
            }

            String contentEncoding = response.header("Content-Encoding");
            // Visible only when the server encoded the body itself (OkHttp
            // strips the header when it transparently decompresses its own
            // gzip). Byte offsets in an encoded representation do not match
            // the decoded bytes on disk, so resume is off the table.
            boolean encodedBody = contentEncoding != null
                && !contentEncoding.equalsIgnoreCase("identity");
            boolean append = response.code() == 206 && resumeOffset > 0;
            if (append && encodedBody) {
                // The server ignored Accept-Encoding: identity on a range
                // request; the appended bytes could not be trusted.
                return false;
            }
            long baseOffset = append ? resumeOffset : 0;
            long contentLength = body.contentLength();
            long totalAll;
            if (append) {
                totalAll = HttpUtils.parseContentRange(
                    response.header("Content-Range"), resumeOffset);
                if (totalAll < 0) {
                    // Malformed or mismatched Content-Range: treat like a
                    // stale partial (one clean retry from zero) instead of
                    // failing — a throw would keep the partial and hit the
                    // same wall on every future attempt.
                    return false;
                }
            } else {
                totalAll = contentLength > 0 ? contentLength : 0;
            }
            if (totalAll > ArchiveLimits.MAX_ARCHIVE_BYTES) {
                throw new IOException("archive too large: " + totalAll + " bytes");
            }
            ArchiveLimits.ensureFreeSpace(
                writePath, totalAll > 0 ? totalAll - baseOffset : 0);
            if (!append) {
                // Destroy the old bytes before the sidecar can vouch for
                // them with the new validators (a crash between the two
                // writes must never leave a sidecar describing stale bytes).
                if (writePath.exists() && !writePath.delete()) {
                    throw new IOException("Failed to replace existing file: " + writePath);
                }
            }
            if (encodedBody) {
                // No resume across an encoded transfer.
                deleteResumeSidecar(writePath);
            } else {
                // Persist before streaming so a mid-stream crash can resume.
                writeResumeMeta(sidecar, url, response, resumeMeta, totalAll);
            }

            long bytesRead;
            long received = 0;
            int currentPercentage = 0;
            long lastPostedBytes = baseOffset;
            // Unknown length: the response-time check could only reserve the
            // margin, so the disk is probed before the first write and then
            // every PROBE bytes, each probe reserving the next PROBE bytes —
            // the writes between two probes can never eat into the margin
            // (the archive cap alone is far more than the margin). A throw
            // keeps the partial for a later attempt.
            long nextFreeSpaceProbeAt = 0;

            try (
                BufferedSource source = body.source();
                BufferedSink sink = Okio.buffer(
                    append ? Okio.appendingSink(writePath) : Okio.sink(writePath))
            ) {
                while ((bytesRead = source.read(sink.buffer(), DOWNLOAD_CHUNK_SIZE)) != -1) {
                    received += bytesRead;
                    if (totalAll <= 0 && received - bytesRead >= nextFreeSpaceProbeAt) {
                        nextFreeSpaceProbeAt = received - bytesRead
                            + ArchiveLimits.UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES;
                        ArchiveLimits.ensureFreeSpace(
                            writePath, ArchiveLimits.UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES);
                    }
                    sink.emit();

                    long overall = baseOffset + received;
                    if (overall > ArchiveLimits.MAX_ARCHIVE_BYTES) {
                        // Unknown/chunked length backstop.
                        throw new IOException(
                            "archive too large: exceeded " + ArchiveLimits.MAX_ARCHIVE_BYTES);
                    }
                    if (totalAll > 0) {
                        int percentage = (int) (overall * 100.0 / totalAll + 0.5);
                        if (percentage > currentPercentage) {
                            currentPercentage = percentage;
                            lastPostedBytes = overall;
                            postProgress(overall, totalAll);
                        }
                    } else if (overall - lastPostedBytes >= PROGRESS_BYTES_THRESHOLD) {
                        lastPostedBytes = overall;
                        postProgress(overall, totalAll);
                    }
                }
                sink.flush();
            }

            if (contentLength >= 0 && received != contentLength) {
                throw new IOException("Unexpected eof while reading downloaded update");
            }
            if (totalAll > 0 && writePath.length() != totalAll) {
                throw new IOException("Download incomplete: expected " + totalAll
                    + " bytes, got " + writePath.length());
            }
            // Final progress event, skipped when the loop already posted this
            // exact value (known length reaching 100% posts it in-loop).
            if (baseOffset + received != lastPostedBytes) {
                postProgress(baseOffset + received, totalAll);
            }
        } finally {
            params.attachCall(null);
        }
        return true;
    }

    private byte[] readBytes(InputStream input) throws IOException {
        return readBytes(input, Long.MAX_VALUE);
    }

    private byte[] readBytes(InputStream input, long maxBytes) throws IOException {
        try (
            InputStream in = input;
            ByteArrayOutputStream out = new ByteArrayOutputStream()
        ) {
            int count;
            long total = 0;
            while ((count = in.read(buffer)) != -1) {
                total += count;
                if (total > maxBytes) {
                    throw new IOException("content exceeds " + maxBytes + " bytes");
                }
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
            ensureArchiveWithinLimits(archiveFile, zipFile, unzipDirectory);
            Enumeration<? extends ZipEntry> entries = zipFile.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                contents.entryNames.add(name);

                if (name.equals("__diff.json")) {
                    if (entry.getSize() > ArchiveLimits.MAX_MANIFEST_BYTES) {
                        throw new IOException("patch manifest too large: " + entry.getSize());
                    }
                    byte[] bytes = readBytes(
                        zipFile.getInputStream(entry), ArchiveLimits.MAX_MANIFEST_BYTES);
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

        File work = stagingDirectory();
        UpdateFileUtils.removeDirectory(work);
        UpdateFileUtils.ensureDirectory(work);
        artifactSha256 = UpdateFileUtils.sha256Hex(params.targetFile);

        try (SafeZipFile zipFile = new SafeZipFile(params.targetFile)) {
            ensureArchiveWithinLimits(params.targetFile, zipFile, work);
            Enumeration<? extends ZipEntry> entries = zipFile.entries();
            while (entries.hasMoreElements()) {
                zipFile.unzipToPath(entries.nextElement(), work);
            }
        }

        deleteConsumedArchive();
    }

    /**
     * Last step of a successful patch task: the completion record (with the
     * final bundle's digest) goes into the staging directory, which is then
     * renamed over the version directory in one atomic step.
     */
    private void promoteStaging() throws IOException, JSONException {
        File work = stagingDirectory();
        if (targetsRunningVersion()) {
            // The process switched to this very version while the task ran
            // (a restartApp racing the download): never rename over the
            // live directory. Its verified install stands; staging goes.
            ensureNotReinstallingRunningVersion();
            UpdateFileUtils.removeDirectory(work);
            return;
        }
        File bundle = new File(work, "index.bundlejs");
        if (!bundle.isFile()) {
            throw new IOException("bundle missing after install: " + bundle);
        }
        String bundleSha256 = UpdateFileUtils.sha256Hex(bundle);
        InstallRecord.write(
            work, InstallRecord.build(params.hash, bundleSha256, artifactSha256));
        if (params.unzipDirectory.exists()) {
            UpdateFileUtils.removeDirectory(params.unzipDirectory);
        }
        if (!work.renameTo(params.unzipDirectory)) {
            throw new IOException("failed to promote staging directory to " + params.unzipDirectory);
        }
        // The rename rewrote the versions root's entries; the record's own
        // directory was synced by InstallRecord.write, the root was not.
        File versionsRoot = params.unzipDirectory.getParentFile();
        if (versionsRoot != null) {
            InstallRecord.syncDirectory(versionsRoot);
        }
    }

    /**
     * Resource caps before extraction (cpp/patch_core/archive_limits.h): the
     * archive itself, the central directory's declared contents, and the
     * free space the expansion needs. Failing here is a PATCH_FAILED (the
     * bytes arrived; they cannot be applied).
     */
    private static void ensureArchiveWithinLimits(
        File archiveFile, SafeZipFile zipFile, File unzipDirectory
    ) throws IOException {
        long archiveBytes = archiveFile.length();
        if (archiveBytes > ArchiveLimits.MAX_ARCHIVE_BYTES) {
            throw new IOException("archive too large: " + archiveBytes + " bytes");
        }
        SafeZipFile.Inspection inspection = zipFile.inspect();
        ArchiveLimits.ensureFreeSpace(unzipDirectory, inspection.totalUncompressed);
    }

    // The archive and its resume sidecar live and die together: once the
    // archive is consumed (or classified as poisoned) the sidecar must not
    // survive to vouch for a file that no longer exists or cannot be trusted.
    private void deleteConsumedArchive() {
        if (params.targetFile.exists()) {
            params.targetFile.delete();
        }
        deleteResumeSidecar(params.targetFile);
    }

    private void doPatchFromApk() throws IOException, JSONException {
        downloadFile();
        File work = stagingDirectory();
        artifactSha256 = UpdateFileUtils.sha256Hex(params.targetFile);
        PatchArchiveContents contents = extractPatchArchive(params.targetFile, work);

        buildArchivePatchPlan(
            DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK,
            contents.entryNames.toArray(new String[0]),
            contents.copyFroms.toArray(new String[0]),
            contents.copyTos.toArray(new String[0]),
            contents.deletes.toArray(new String[0])
        );

        HashMap<String, ArrayList<File>> copyList = buildCopyList(
            work,
            buildCopyGroups(
                contents.copyFroms.toArray(new String[0]),
                contents.copyTos.toArray(new String[0])
            )
        );

        File originBundleFile = new File(work, ".origin.bundle");
        copyBundledAssetToFile("index.android.bundle", originBundleFile);
        try {
            applyPatchFromFileSource(
                work.getAbsolutePath(),
                work.getAbsolutePath(),
                originBundleFile.getAbsolutePath(),
                new File(work, "index.bundlejs.patch").getAbsolutePath(),
                new File(work, "index.bundlejs").getAbsolutePath(),
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
        deleteConsumedArchive();
    }

    private void doPatchFromPpk() throws IOException, JSONException {
        downloadFile();
        File work = stagingDirectory();
        artifactSha256 = UpdateFileUtils.sha256Hex(params.targetFile);
        PatchArchiveContents contents = extractPatchArchive(params.targetFile, work);

        ArchivePatchPlanResult plan = buildArchivePatchPlan(
            DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK,
            contents.entryNames.toArray(new String[0]),
            contents.copyFroms.toArray(new String[0]),
            contents.copyTos.toArray(new String[0]),
            contents.deletes.toArray(new String[0])
        );

        applyPatchFromFileSource(
            params.originDirectory.getAbsolutePath(),
            work.getAbsolutePath(),
            new File(params.originDirectory, "index.bundlejs").getAbsolutePath(),
            new File(work, "index.bundlejs.patch").getAbsolutePath(),
            new File(work, "index.bundlejs").getAbsolutePath(),
            plan.mergeSourceSubdir,
            plan.enableMerge,
            contents.copyFroms.toArray(new String[0]),
            contents.copyTos.toArray(new String[0]),
            contents.deletes.toArray(new String[0]),
            contents.hbcTransformMetaFor("index.bundlejs.patch")
        );
        deleteConsumedArchive();
    }

    private void doCleanUp() {
        UpdateContext.getInstance(context).runCleanupWithLatestState(
            new UpdateContext.CleanupAction() {
                @Override
                public void run(String keepCurrent, String keepPrevious) {
                    cleanupOldEntries(
                        params.unzipDirectory.getAbsolutePath(),
                        keepCurrent,
                        keepPrevious,
                        params.maxAgeDays
                    );
                }
            }
        );
    }

    private void cleanUpAfterFailure(int taskType) {
        switch (taskType) {
            case DownloadTaskParams.TASK_TYPE_PATCH_FULL:
            case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK:
            case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
                // Only the staging directory is ours to drop: the final
                // version directory is never touched by a failed install.
                try {
                    UpdateFileUtils.removeDirectory(stagingDirectory());
                } catch (IOException ioException) {
                    Log.e(UpdateContext.TAG, "Failed to clean staging directory", ioException);
                }
                if (downloadPhaseCompleted) {
                    // Fully received but failed to unzip/patch: the archive is
                    // poisoned, and resuming it would fail the same way on
                    // every future attempt. A download-phase failure keeps the
                    // partial + sidecar instead — that is the resume state.
                    deleteConsumedArchive();
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
                deleteResumeSidecar(params.targetFile);
                break;
            default:
                break;
        }
    }

    /**
     * An https artifact URL must stay on https through every redirect: the
     * package is the supply-chain boundary and TLS is what authenticates
     * it. OkHttp follows cross-scheme redirects by default, so the final
     * request is checked here (the redirected bytes are discarded).
     */
    static void rejectProtocolDowngrade(String requestedUrl, Response response)
        throws IOException {
        if (requestedUrl != null
            && requestedUrl.regionMatches(true, 0, "https:", 0, 6)
            && !response.request().url().isHttps()) {
            throw new IOException(
                "https download redirected to plaintext http: "
                    + response.request().url());
        }
    }

    private boolean isPatchTask(int taskType) {
        return taskType == DownloadTaskParams.TASK_TYPE_PATCH_FULL
            || taskType == DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK
            || taskType == DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
    }

    private boolean hasCompletedPatchDirectory() {
        return params.unzipDirectory != null
            && params.hash != null
            && new File(params.unzipDirectory, "index.bundlejs").isFile()
            && InstallRecord.isComplete(params.unzipDirectory, params.hash);
    }

    // True when this task targets the version the process is running from.
    private boolean targetsRunningVersion() {
        String running = UpdateContext.runningVersion();
        return running != null && params.hash != null && running.equals(params.hash);
    }

    /**
     * The running version's directory is never replaced in place
     * (CODE_AUDIT 2.10): images and fonts are read from it on demand, and an
     * install from before completion records existed has no marker, so a
     * re-download of the same hash would wipe the live directory. A running
     * version whose record verifies against the bundle on disk needs no
     * install and passes; anything else is refused as a file-operation
     * failure rather than overwritten.
     */
    private void ensureNotReinstallingRunningVersion() throws IOException {
        File bundle = new File(params.unzipDirectory, "index.bundlejs");
        if (bundle.isFile() && InstallRecord.isComplete(params.unzipDirectory, params.hash)) {
            try {
                InstallRecord.verifyForActivation(params.unzipDirectory, params.hash, bundle);
                return;
            } catch (IOException e) {
                throw new FileOperationException("Running version " + params.hash
                    + " cannot be reinstalled in place: " + e.getMessage());
            }
        }
        throw new FileOperationException("Running version " + params.hash
            + " has no verifiable install record and cannot be reinstalled in place");
    }

    @Override
    public void run() {
        int taskType = params.type;
        final boolean runningVersion = isPatchTask(taskType) && targetsRunningVersion();
        final boolean alreadyCompleted = isPatchTask(taskType)
            && hasCompletedPatchDirectory();
        try {
            if (params.isCancelled()) {
                throw new IOException("download task cancelled before it started");
            }
            if (runningVersion) {
                ensureNotReinstallingRunningVersion();
                Log.i(UpdateContext.TAG, "download task: version " + params.hash
                    + " is running in this process and already installed");
            } else if (alreadyCompleted) {
                Log.i(UpdateContext.TAG,
                    "download task: version " + params.hash + " already completed");
            } else {
                switch (taskType) {
                    case DownloadTaskParams.TASK_TYPE_PATCH_FULL:
                        doFullPatch();
                        promoteStaging();
                        break;
                    case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK:
                        doPatchFromApk();
                        promoteStaging();
                        break;
                    case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
                        doPatchFromPpk();
                        promoteStaging();
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
                    && !(error instanceof PatchFailedException)
                    && !(error instanceof FileOperationException)) {
                    classified = new PatchFailedException(
                        String.valueOf(error.getMessage()), error);
                }
                params.listener.onDownloadFailed(classified);
            }
            return;
        }

        if (taskType == DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD) {
            // A plain download's file is final at completion — a surviving
            // sidecar would make a later download of the same URL return
            // these bytes without ever asking the server again.
            deleteResumeSidecar(params.targetFile);
        }

        // The task itself succeeded. Run the completion callback outside the
        // try/catch above so an exception thrown by the callback (e.g. a
        // PackageInstaller failure during APK staging) is not mistaken for
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
