package cn.reactnative.modules.update;

import android.content.Context;
import android.os.AsyncTask;
import android.util.Log;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.Iterator;
import java.util.zip.ZipEntry;
import java.util.zip.CRC32;
import java.util.HashMap;

import okio.BufferedSink;
import okio.BufferedSource;
import okio.Okio;
import static cn.reactnative.modules.update.UpdateModule.sendEvent;


class DownloadTask extends AsyncTask<DownloadTaskParams, long[], Void> {
    final int DOWNLOAD_CHUNK_SIZE = 4096;

    Context context;
    String hash;

    DownloadTask(Context context) {
        this.context = context;
    }

    static {
        System.loadLibrary("rnupdate");
    }

    private void removeDirectory(File file) throws IOException {
        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Removing " + file);
        }
        if (file.isDirectory()) {
            File[] files = file.listFiles();
            for (File f : files) {
                String name = f.getName();
                if (name.equals(".") || name.equals("..")) {
                    continue;
                }
                removeDirectory(f);
            }
        }
        if (file.exists() && !file.delete()) {
            throw new IOException("Failed to delete directory");
        }
    }

    private void downloadFile(DownloadTaskParams param) throws IOException {
        String url = param.url;
        Log.d("😁downloadFile", url);
        File writePath = param.targetFile;
        this.hash = param.hash;
        OkHttpClient client = new OkHttpClient();
        Request request = new Request.Builder().url(url)
                .build();
        Response response = client.newCall(request).execute();
        if (response.code() > 299) {
            throw new Error("Server error:" + response.code() + " " + response.message());
        }
        ResponseBody body = response.body();
        long contentLength = body.contentLength();
        BufferedSource source = body.source();

        if (writePath.exists()) {
            writePath.delete();
        }

        BufferedSink sink = Okio.buffer(Okio.sink(writePath));

        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Downloading " + url);
        }

        long bytesRead = 0;
        long received = 0;
        int currentPercentage = 0;
        while ((bytesRead = source.read(sink.buffer(), DOWNLOAD_CHUNK_SIZE)) != -1) {
            received += bytesRead;
            sink.emit();
            if (UpdateContext.DEBUG) {
                Log.d("react-native-update", "Progress " + received + "/" + contentLength);
            }

            int percentage = (int)(received * 100.0 / contentLength + 0.5);
            if (percentage > currentPercentage) {
                currentPercentage = percentage;
                publishProgress(new long[]{received, contentLength});
            }
        }
        if (received != contentLength) {
            throw new Error("Unexpected eof while reading downloaded update");
        }
        publishProgress(new long[]{received, contentLength});
        sink.writeAll(source);
        sink.close();

        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Download finished");
        }
    }

    @Override
    protected void onProgressUpdate(final long[]... values) {
        super.onProgressUpdate(values);
        WritableMap params = Arguments.createMap();
        params.putDouble("received", (values[0][0]));
        params.putDouble("total", (values[0][1]));
        params.putString("hash", this.hash);
        sendEvent("RCTPushyDownloadProgress", params);
    }

    byte[] buffer = new byte[1024*4];

    private static native byte[] hdiffPatch(byte[] origin, byte[] patch);


    private void copyFile(File from, File fmd) throws IOException {
        int count;

        InputStream in = new FileInputStream(from);
        FileOutputStream fout = new FileOutputStream(fmd);

        while ((count = in.read(buffer)) != -1)
        {
            fout.write(buffer, 0, count);
        }

        fout.close();
        in.close();
    }

    private byte[] readBytes(InputStream zis) throws IOException {
        int count;

        ByteArrayOutputStream fout = new ByteArrayOutputStream();
        while ((count = zis.read(buffer)) != -1)
        {
            fout.write(buffer, 0, count);
        }

        fout.close();
        zis.close();
        return fout.toByteArray();
    }

    private byte[] readOriginBundle()  throws IOException {
        InputStream in;
        try {
            in = context.getAssets().open("index.android.bundle");
        } catch (Exception e) {
            return new byte[0];
        }
        int count;

        ByteArrayOutputStream fout = new ByteArrayOutputStream();
        while ((count = in.read(buffer)) != -1)
        {
            fout.write(buffer, 0, count);
        }

        fout.close();
        in.close();
        return fout.toByteArray();
    }

    private byte[] readFile(File file)  throws IOException {
        InputStream in = new FileInputStream(file);
        int count;

        ByteArrayOutputStream fout = new ByteArrayOutputStream();
        while ((count = in.read(buffer)) != -1)
        {
            fout.write(buffer, 0, count);
        }

        fout.close();
        in.close();
        return fout.toByteArray();
    }

    private String getCRC32AsDecimal(long crc32Value) {
        return String.valueOf(crc32Value & 0xFFFFFFFFL);
    }

    private void copyFilesWithBlacklist(String current, File from, File to, JSONObject blackList) throws IOException {
        File[] files = from.listFiles();
        for (File file : files) {
            if (file.isDirectory()) {
                String subName = current + file.getName() + '/';
                if (blackList.has(subName)) {
                    continue;
                }
                File toFile = new File(to, file.getName());
                if (!toFile.exists()) {
                    toFile.mkdir();
                }
                copyFilesWithBlacklist(subName, file, toFile, blackList);
            } else if (!blackList.has(current + file.getName())) {
                // Copy file.
                File toFile = new File(to, file.getName());
                if (!toFile.exists()) {
                    copyFile(file, toFile);
                }
            }
        }
    }

    private void copyFilesWithBlacklist(File from, File to, JSONObject blackList) throws IOException {
        copyFilesWithBlacklist("", from, to, blackList);
    }

    private void doFullPatch(DownloadTaskParams param) throws IOException {
        downloadFile(param);

        removeDirectory(param.unzipDirectory);
        param.unzipDirectory.mkdirs();

        SafeZipFile zipFile = new SafeZipFile(param.targetFile);
        Enumeration<? extends ZipEntry> entries = zipFile.entries();
        while (entries.hasMoreElements()) {
            ZipEntry ze = entries.nextElement();

            zipFile.unzipToPath(ze, param.unzipDirectory);
        }

        zipFile.close();


        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Unzip finished");
        }
    }

    private void copyFromResource(HashMap<String, ArrayList<File> > resToCopy, HashMap<String, ArrayList<File>> resToCopy2) throws IOException {
        SafeZipFile zipFile = new SafeZipFile(new File(context.getPackageResourcePath()));
        Enumeration<? extends ZipEntry> entries = zipFile.entries();
        while (entries.hasMoreElements()) {
            ZipEntry ze = entries.nextElement();

            String fn = ze.getName();
            long zipCrc32 = ze.getCrc();
            String crc32Decimal = getCRC32AsDecimal(zipCrc32);
            ArrayList<File> targets = resToCopy.get(fn);
            if(targets==null || targets.isEmpty()){
                targets = resToCopy2.get(crc32Decimal);
            }
            if (targets != null) {
                File lastTarget = null;
                for (File target: targets) {
                    if (UpdateContext.DEBUG) {
                        Log.d("react-native-update", "Copying from resource " + fn + " to " + target);
                    }
                    if (lastTarget != null) {
                        copyFile(lastTarget, target);
                    } else {
                        zipFile.unzipToFile(ze, target);
                        lastTarget = target;
                    }
                }
            }
        }
        zipFile.close();
    }

    private void doPatchFromApk(DownloadTaskParams param) throws IOException, JSONException {
        downloadFile(param);

        removeDirectory(param.unzipDirectory);
        param.unzipDirectory.mkdirs();
        HashMap<String, ArrayList<File>> copyList = new HashMap<String, ArrayList<File>>();
        HashMap<String, ArrayList<File>> copiesv2List = new HashMap<String, ArrayList<File>>();

        boolean foundDiff = false;
        boolean foundBundlePatch = false;

        SafeZipFile zipFile = new SafeZipFile(param.targetFile);
        Enumeration<? extends ZipEntry> entries = zipFile.entries();
        while (entries.hasMoreElements()) {
            ZipEntry ze = entries.nextElement();
            String fn = ze.getName();

            if (fn.equals("__diff.json")) {
                foundDiff = true;
                // copy files from assets
                byte[] bytes = readBytes(zipFile.getInputStream(ze));
                String json = new String(bytes, "UTF-8");
                JSONObject obj = (JSONObject)new JSONTokener(json).nextValue();

                JSONObject copies = obj.getJSONObject("copies");
                JSONObject copiesv2 = obj.getJSONObject("copiesv2");
                Iterator<?> keys = copies.keys();
                Iterator<?> keys2 = copiesv2.keys();
                while( keys.hasNext() ) {
                    String to = (String)keys.next();
                    String from = copies.getString(to);
                    if (from.isEmpty()) {
                        from = to;
                    }
                    ArrayList<File> target = null;
                    if (!copyList.containsKey(from)) {
                        target = new ArrayList<File>();
                        copyList.put(from, target);
                    } else {
                        target = copyList.get((from));
                    }
                    File toFile = new File(param.unzipDirectory, to);

                    // Fixing a Zip Path Traversal Vulnerability
                    // https://support.google.com/faqs/answer/9294009
                    String canonicalPath = toFile.getCanonicalPath();
                    if (!canonicalPath.startsWith(param.unzipDirectory.getCanonicalPath() + File.separator)) {
                        throw new SecurityException("Illegal name: " + to);
                    }
                    target.add(toFile);
                }

                while( keys2.hasNext() ) {
                    String from = (String)keys2.next();
                    String to = copiesv2.getString(from);
                    if (from.isEmpty()) {
                        from = to;
                    }
                    ArrayList<File> target = null;
                    if (!copiesv2List.containsKey(from)) {
                        target = new ArrayList<File>();
                        copiesv2List.put(from, target);
                    } else {
                        target = copiesv2List.get((from));
                    }
                    File toFile = new File(param.unzipDirectory, to);

                    // Fixing a Zip Path Traversal Vulnerability
                    // https://support.google.com/faqs/answer/9294009
                    String canonicalPath = toFile.getCanonicalPath();
                    if (!canonicalPath.startsWith(param.unzipDirectory.getCanonicalPath() + File.separator)) {
                        throw new SecurityException("Illegal name: " + to);
                    }
                    target.add(toFile);
                }
                continue;
            }
            if (fn.equals("index.bundlejs.patch")) {
                foundBundlePatch = true;

                byte[] patched = hdiffPatch(readOriginBundle(), readBytes(zipFile.getInputStream(ze)));

                FileOutputStream fout = new FileOutputStream(new File(param.unzipDirectory, "index.bundlejs"));
                fout.write(patched);
                fout.close();
                continue;
            }


            zipFile.unzipToPath(ze, param.unzipDirectory);
        }

        zipFile.close();


        if (!foundDiff) {
            throw new Error("diff.json not found");
        }
        if (!foundBundlePatch) {
            throw new Error("bundle patch not found");
        }

        copyFromResource(copyList, copiesv2List);

        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Unzip finished");
        }

    }

    private void doPatchFromPpk(DownloadTaskParams param) throws IOException, JSONException {
        downloadFile(param);

        removeDirectory(param.unzipDirectory);
        param.unzipDirectory.mkdirs();

        int count;
        String filename;
        boolean foundDiff = false;
        boolean foundBundlePatch = false;


        SafeZipFile zipFile = new SafeZipFile(param.targetFile);
        Enumeration<? extends ZipEntry> entries = zipFile.entries();
        while (entries.hasMoreElements()) {
            ZipEntry ze = entries.nextElement();
            String fn = ze.getName();

            if (fn.equals("__diff.json")) {
                foundDiff = true;
                // copy files from assets
                byte[] bytes = readBytes(zipFile.getInputStream(ze));
                String json = new String(bytes, "UTF-8");
                JSONObject obj = (JSONObject)new JSONTokener(json).nextValue();

                JSONObject copies = obj.getJSONObject("copies");
                Iterator<?> keys = copies.keys();
                while( keys.hasNext() ) {
                    String to = (String)keys.next();
                    String from = copies.getString(to);
                    if (from.isEmpty()) {
                        from = to;
                    }
                    copyFile(new File(param.originDirectory, from), new File(param.unzipDirectory, to));
                }
                JSONObject blackList = obj.getJSONObject("deletes");
                copyFilesWithBlacklist(param.originDirectory, param.unzipDirectory, blackList);
                continue;
            }
            if (fn.equals("index.bundlejs.patch")) {
                foundBundlePatch = true;
                byte[] patched = hdiffPatch(readFile(new File(param.originDirectory, "index.bundlejs")), readBytes(zipFile.getInputStream(ze)));

                FileOutputStream fout = new FileOutputStream(new File(param.unzipDirectory, "index.bundlejs"));
                fout.write(patched);
                fout.close();
                continue;
            }

            zipFile.unzipToPath(ze, param.unzipDirectory);
        }

        zipFile.close();

        if (!foundDiff) {
            throw new Error("diff.json not found");
        }
        if (!foundBundlePatch) {
            throw new Error("bundle patch not found");
        }
        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Unzip finished");
        }
    }
    private void doCleanUp(DownloadTaskParams param) throws IOException {
        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Start cleaning up");
        }
        File root = param.unzipDirectory;
        for (File sub : root.listFiles()) {
            if (sub.getName().charAt(0) == '.') {
                continue;
            }
            if (isFileUpdatedWithinDays(sub, 7)) {
                continue;
            }
            if (sub.isFile()) {
                sub.delete();
            } else {
                if (sub.getName().equals(param.hash) || sub.getName().equals(param.originHash)) {
                    continue;
                }
                removeDirectory(sub);
            }
        }
    }

    private boolean isFileUpdatedWithinDays(File file, int days) {
        long currentTime = System.currentTimeMillis();
        long lastModified = file.lastModified();
        long daysInMillis = days * 24 * 60 * 60 * 1000L;
        return (currentTime - lastModified) < daysInMillis;
    }

    @Override
    protected Void doInBackground(final DownloadTaskParams... params) {
        int taskType = params[0].type;
        try {
            switch (taskType) {
                case DownloadTaskParams.TASK_TYPE_PATCH_FULL:
                    doFullPatch(params[0]);
                    break;
                case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK:
                    doPatchFromApk(params[0]);
                    break;
                case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
                    doPatchFromPpk(params[0]);
                    break;
                case DownloadTaskParams.TASK_TYPE_CLEANUP:
                    doCleanUp(params[0]);
                    break;
                case DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD:
                    downloadFile(params[0]);
                    break;
                default:
                    break;
            }
            if (params[0].listener != null) {
                params[0].listener.onDownloadCompleted(params[0]);
            }
        } catch (Throwable e) {
            if (UpdateContext.DEBUG) {
                e.printStackTrace();
            }
            switch (taskType) {
                case DownloadTaskParams.TASK_TYPE_PATCH_FULL:
                case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK:
                case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
                    try {
                        removeDirectory(params[0].unzipDirectory);
                    } catch (IOException ioException) {
                        ioException.printStackTrace();
                    }
                    break;
                case DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD:
//                    if (targetToClean.exists()) {
                    params[0].targetFile.delete();
//                    }
                    break;
                default:
                    break;
            }
            Log.e("react-native-update", "download task failed", e);

            if (params[0].listener != null) {
                params[0].listener.onDownloadFailed(e);
            }
        }
        return null;
    }

}
