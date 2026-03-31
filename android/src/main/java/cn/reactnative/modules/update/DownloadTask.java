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
    private static final OkHttpClient HTTP_CLIENT = new OkHttpClient();

    static {
        NativeUpdateCore.ensureLoaded();
    }

    private static final class PatchArchiveContents {
        final ArrayList<String> entryNames = new ArrayList<String>();
        final ArrayList<String> copyFroms = new ArrayList<String>();
        final ArrayList<String> copyTos = new ArrayList<String>();
        final ArrayList<String> deletes = new ArrayList<String>();
    }

    private final Context context;
    private final DownloadTaskParams params;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final byte[] buffer = new byte[DOWNLOAD_CHUNK_SIZE];
    private final BundledResourceCopier bundledResourceCopier;
    private String hash;

    DownloadTask(Context context, DownloadTaskParams params) {
        this.context = context.getApplicationContext();
        this.params = params;
        this.bundledResourceCopier = new BundledResourceCopier(this.context);
    }

    private void postProgress(final long received, final long total) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WritableMap progress = Arguments.createMap();
                progress.putDouble("received", received);
                progress.putDouble("total", total);
                progress.putString("hash", hash);
                UpdateEventEmitter.sendEvent("RCTPushyDownloadProgress", progress);
            }
        });
    }

    private void downloadFile() throws IOException {
        this.hash = params.hash;
        String url = params.url;
        File writePath = params.targetFile;
        UpdateFileUtils.ensureParentDirectory(writePath);
        Request request = new Request.Builder().url(url).build();

        if (writePath.exists() && !writePath.delete()) {
            throw new IOException("Failed to replace existing file: " + writePath);
        }

        if (UpdateContext.DEBUG) {
            Log.d(UpdateContext.TAG, "Downloading " + url);
        }

        try (Response response = HTTP_CLIENT.newCall(request).execute()) {
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
                            postProgress(received, contentLength);
                        }
                    } else {
                        postProgress(received, contentLength);
                    }
                }
                sink.flush();
            }

            if (contentLength >= 0 && received != contentLength) {
                throw new IOException("Unexpected eof while reading downloaded update");
            }
            postProgress(received, contentLength);
        }

        if (UpdateContext.DEBUG) {
            Log.d(UpdateContext.TAG, "Download finished");
        }
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
        ArrayList<String> deletes
    ) throws JSONException {
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
                        contents.deletes
                    );
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

        if (UpdateContext.DEBUG) {
            Log.d(UpdateContext.TAG, "Unzip finished");
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
                new String[0]
            );
        } finally {
            originBundleFile.delete();
        }

        if (UpdateContext.DEBUG) {
            Log.d(UpdateContext.TAG, "copyList size: " + copyList.size());
            for (String from : copyList.keySet()) {
                Log.d(
                    UpdateContext.TAG,
                    "copyList entry: " + from + " -> " + copyList.get(from).size() + " targets"
                );
            }
        }

        bundledResourceCopier.copyFromResource(copyList);

        if (UpdateContext.DEBUG) {
            Log.d(UpdateContext.TAG, "Unzip finished");
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
            contents.deletes.toArray(new String[0])
        );

        if (UpdateContext.DEBUG) {
            Log.d(UpdateContext.TAG, "Unzip finished");
        }
    }

    private void doCleanUp() {
        if (UpdateContext.DEBUG) {
            Log.d(UpdateContext.TAG, "Start cleaning up");
        }
        cleanupOldEntries(
            params.unzipDirectory.getAbsolutePath(),
            params.hash,
            params.originHash,
            7
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

    @Override
    public void run() {
        int taskType = params.type;
        try {
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

            if (params.listener != null) {
                params.listener.onDownloadCompleted(params);
            }
        } catch (Throwable error) {
            if (UpdateContext.DEBUG) {
                Log.e(UpdateContext.TAG, "download task failed", error);
            }
            cleanUpAfterFailure(taskType);

            if (params.listener != null) {
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
        String[] deletes
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
