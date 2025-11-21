package cn.reactnative.modules.update;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.AsyncTask;
import android.os.Build;
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

    private String findDrawableFallback(String originalToPath, HashMap<String, String> copiesMap, HashMap<String, ZipEntry> availableEntries) {
        // 检查是否是 drawable 路径
        if (!originalToPath.contains("drawable")) {
            return null;
        }

        // 提取文件名（路径的最后部分）
        int lastSlash = originalToPath.lastIndexOf('/');
        if (lastSlash == -1) {
            return null;
        }
        String fileName = originalToPath.substring(lastSlash + 1);
        
        // 定义密度优先级（从高到低）
        String[] densities = {"xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi", "ldpi"};
        
        // 尝试找到相同文件名但不同密度的 key
        for (String density : densities) {
            // 构建可能的 key 路径（替换密度部分）
            String fallbackToPath = originalToPath.replaceFirst("drawable-[^/]+", "drawable-" + density);
            
            // 检查这个 key 是否在 copies 映射中
            if (copiesMap.containsKey(fallbackToPath)) {
                String fallbackFromPath = copiesMap.get(fallbackToPath);
                // 检查对应的 value 路径是否在 APK 中存在
                if (availableEntries.containsKey(fallbackFromPath)) {
                    if (UpdateContext.DEBUG) {
                        Log.d("react-native-update", "Found fallback for " + originalToPath + ": " + fallbackToPath + " -> " + fallbackFromPath);
                    }
                    return fallbackFromPath;
                }
            }
        }
        
        return null;
    }

    private void copyFromResource(HashMap<String, ArrayList<File> > resToCopy, HashMap<String, String> copiesMap) throws IOException {
        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "copyFromResource called, resToCopy size: " + resToCopy.size());
        }
        
        // 收集所有 APK 路径（包括基础 APK 和所有 split APK）
        ArrayList<String> apkPaths = new ArrayList<>();
        apkPaths.add(context.getPackageResourcePath());
        
        // 获取所有 split APK 路径（用于资源分割的情况）
        try {
            ApplicationInfo appInfo = context.getPackageManager().getApplicationInfo(
                context.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && appInfo.splitSourceDirs != null) {
                for (String splitPath : appInfo.splitSourceDirs) {
                    apkPaths.add(splitPath);
                    if (UpdateContext.DEBUG) {
                        Log.d("react-native-update", "Found split APK: " + splitPath);
                    }
                }
            }
        } catch (PackageManager.NameNotFoundException e) {
            if (UpdateContext.DEBUG) {
                Log.w("react-native-update", "Failed to get application info: " + e.getMessage());
            }
        }
        
        // 第一遍：从所有 APK 中收集所有可用的 zip 条目
        HashMap<String, ZipEntry> availableEntries = new HashMap<>();
        HashMap<String, SafeZipFile> zipFileMap = new HashMap<>(); // 保存每个路径对应的 ZipFile
        HashMap<String, SafeZipFile> entryToZipFileMap = new HashMap<>(); // 保存每个条目对应的 ZipFile
        
        for (String apkPath : apkPaths) {
            SafeZipFile zipFile = new SafeZipFile(new File(apkPath));
            zipFileMap.put(apkPath, zipFile);
            Enumeration<? extends ZipEntry> entries = zipFile.entries();
            while (entries.hasMoreElements()) {
                ZipEntry ze = entries.nextElement();
                String entryName = ze.getName();
                // 如果条目已存在，保留第一个（基础 APK 优先）
                if (!availableEntries.containsKey(entryName)) {
                    availableEntries.put(entryName, ze);
                    entryToZipFileMap.put(entryName, zipFile);
                }
            }
        }
        
        // 使用基础 APK 的 ZipFile 作为主要操作对象
        SafeZipFile zipFile = zipFileMap.get(context.getPackageResourcePath());
        
        // 处理所有需要复制的文件
        HashMap<String, ArrayList<File>> remainingFiles = new HashMap<>(resToCopy);
        
        for (String fromPath : new ArrayList<>(remainingFiles.keySet())) {
            if (UpdateContext.DEBUG) {
                Log.d("react-native-update", "Processing fromPath: " + fromPath);
            }
            ArrayList<File> targets = remainingFiles.get(fromPath);
            if (targets == null || targets.isEmpty()) {
                continue;
            }
            
            ZipEntry ze = availableEntries.get(fromPath);
            String actualSourcePath = fromPath;
            
            // 如果文件不存在，尝试 fallback
            if (ze == null) {
                if (UpdateContext.DEBUG) {
                    Log.d("react-native-update", "File not found in APK: " + fromPath + ", trying fallback");
                }
                // 找到对应的 to 路径（从 copiesMap 的反向查找）
                String toPath = null;
                for (String to : copiesMap.keySet()) {
                    if (copiesMap.get(to).equals(fromPath)) {
                        toPath = to;
                        break;
                    }
                }
                
                if (toPath != null) {
                    if (UpdateContext.DEBUG) {
                        Log.d("react-native-update", "Found toPath: " + toPath + " for fromPath: " + fromPath);
                    }
                    String fallbackFromPath = findDrawableFallback(toPath, copiesMap, availableEntries);
                    if (fallbackFromPath != null) {
                        ze = availableEntries.get(fallbackFromPath);
                        actualSourcePath = fallbackFromPath;
                        // 确保 fallback 路径也在 entryToZipFileMap 中
                        if (!entryToZipFileMap.containsKey(fallbackFromPath)) {
                            // 查找包含该 fallback 路径的 ZipFile
                            for (String apkPath : apkPaths) {
                                SafeZipFile testZipFile = zipFileMap.get(apkPath);
                                if (testZipFile != null) {
                                    try {
                                        ZipEntry testEntry = testZipFile.getEntry(fallbackFromPath);
                                        if (testEntry != null) {
                                            entryToZipFileMap.put(fallbackFromPath, testZipFile);
                                            break;
                                        }
                                    } catch (Exception e) {
                                        // 继续查找
                                    }
                                }
                            }
                        }
                        if (UpdateContext.DEBUG) {
                            Log.w("react-native-update", "Using fallback: " + fallbackFromPath + " for " + fromPath);
                        }
                    } else {
                        if (UpdateContext.DEBUG) {
                            Log.w("react-native-update", "No fallback found for: " + fromPath + " (toPath: " + toPath + ")");
                        }
                    }
                } else {
                    if (UpdateContext.DEBUG) {
                        Log.w("react-native-update", "No toPath found for fromPath: " + fromPath);
                    }
                }
            }
            
            if (ze != null) {
                File lastTarget = null;
                for (File target: targets) {
                    if (UpdateContext.DEBUG) {
                        Log.d("react-native-update", "Copying from resource " + actualSourcePath + " to " + target);
                    }
                    try {
                        // 确保目标文件的父目录存在
                        File parentDir = target.getParentFile();
                        if (parentDir != null && !parentDir.exists()) {
                            parentDir.mkdirs();
                        }
                        
                        if (lastTarget != null) {
                            copyFile(lastTarget, target);
                        } else {
                            // 从保存的映射中获取包含该条目的 ZipFile
                            SafeZipFile sourceZipFile = entryToZipFileMap.get(actualSourcePath);
                            if (sourceZipFile == null) {
                                sourceZipFile = zipFile; // 回退到基础 APK
                            }
                            sourceZipFile.unzipToFile(ze, target);
                            lastTarget = target;
                        }
                    } catch (IOException e) {
                        if (UpdateContext.DEBUG) {
                            Log.w("react-native-update", "Failed to copy resource " + actualSourcePath + " to " + target + ": " + e.getMessage());
                        }
                        // 继续处理下一个目标
                    }
                }
                remainingFiles.remove(fromPath);
            }
        }
        
        // 处理剩余的文件（如果还有的话）
        if (!remainingFiles.isEmpty() && UpdateContext.DEBUG) {
            for (String fromPath : remainingFiles.keySet()) {
                Log.w("react-native-update", "Resource not found and no fallback available: " + fromPath);
            }
        }
        
        // 关闭所有 ZipFile
        for (SafeZipFile zf : zipFileMap.values()) {
            zf.close();
        }
    }

    private void doPatchFromApk(DownloadTaskParams param) throws IOException, JSONException {
        downloadFile(param);

        removeDirectory(param.unzipDirectory);
        param.unzipDirectory.mkdirs();
        HashMap<String, ArrayList<File>> copyList = new HashMap<String, ArrayList<File>>();
        HashMap<String, String> copiesMap = new HashMap<String, String>(); // to -> from 映射

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
                    // 保存 copies 映射关系（to -> from）
                    copiesMap.put(to, from);
                    
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

        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "copyList size: " + copyList.size() + ", copiesMap size: " + copiesMap.size());
            for (String from : copyList.keySet()) {
                Log.d("react-native-update", "copyList entry: " + from + " -> " + copyList.get(from).size() + " targets");
            }
        }

        copyFromResource(copyList, copiesMap);

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
