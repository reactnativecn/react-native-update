package cn.reactnative.modules.update;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.os.AsyncTask;
import android.os.Build;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.TypedValue;
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
import java.util.regex.Pattern;

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
        NativeUpdateCore.ensureLoaded();
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
        InputStream in = context.getAssets().open(assetName);
        copyInputStreamToFile(in, destination);
    }

    private void copyInputStreamToFile(InputStream in, File destination) throws IOException {
        FileOutputStream fout = new FileOutputStream(destination);
        try {
            int count;
            while ((count = in.read(buffer)) != -1) {
                fout.write(buffer, 0, count);
            }
        } finally {
            fout.close();
            in.close();
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

    // Pattern to strip -vN version qualifiers from resource directory paths
    // e.g., "res/drawable-xxhdpi-v4/img.png" → "res/drawable-xxhdpi/img.png"
    private static final Pattern VERSION_QUALIFIER_PATTERN =
        Pattern.compile("-v\\d+(?=/)");
    // AAB internal paths are prefixed with "base/" (e.g., "base/res/drawable-xxhdpi/img.png")
    // which does not exist in standard APK layout
    private static final String AAB_BASE_PREFIX = "base/";

    private String normalizeResPath(String path) {
        String result = path;
        if (result.startsWith(AAB_BASE_PREFIX)) {
            result = result.substring(AAB_BASE_PREFIX.length());
        }
        return VERSION_QUALIFIER_PATTERN.matcher(result).replaceAll("");
    }

    private static class ResolvedResourceSource {
        final int resourceId;
        final String assetPath;

        ResolvedResourceSource(int resourceId, String assetPath) {
            this.resourceId = resourceId;
            this.assetPath = assetPath;
        }
    }

    private String extractResourceType(String directoryName) {
        int qualifierIndex = directoryName.indexOf('-');
        if (qualifierIndex == -1) {
            return directoryName;
        }
        return directoryName.substring(0, qualifierIndex);
    }

    private String extractResourceName(String fileName) {
        if (fileName.endsWith(".9.png")) {
            return fileName.substring(0, fileName.length() - ".9.png".length());
        }
        int extensionIndex = fileName.lastIndexOf('.');
        if (extensionIndex == -1) {
            return fileName;
        }
        return fileName.substring(0, extensionIndex);
    }

    private Integer parseDensityQualifier(String directoryName) {
        String[] qualifiers = directoryName.split("-");
        for (String qualifier : qualifiers) {
            if ("ldpi".equals(qualifier)) {
                return DisplayMetrics.DENSITY_LOW;
            }
            if ("mdpi".equals(qualifier)) {
                return DisplayMetrics.DENSITY_MEDIUM;
            }
            if ("hdpi".equals(qualifier)) {
                return DisplayMetrics.DENSITY_HIGH;
            }
            if ("xhdpi".equals(qualifier)) {
                return DisplayMetrics.DENSITY_XHIGH;
            }
            if ("xxhdpi".equals(qualifier)) {
                return DisplayMetrics.DENSITY_XXHIGH;
            }
            if ("xxxhdpi".equals(qualifier)) {
                return DisplayMetrics.DENSITY_XXXHIGH;
            }
            if ("tvdpi".equals(qualifier)) {
                return DisplayMetrics.DENSITY_TV;
            }
        }
        return null;
    }

    private ResolvedResourceSource resolveBundledResource(String resourcePath) {
        String normalizedPath = normalizeResPath(resourcePath);
        if (normalizedPath.startsWith("res/")) {
            normalizedPath = normalizedPath.substring("res/".length());
        }

        int slash = normalizedPath.indexOf('/');
        if (slash == -1 || slash == normalizedPath.length() - 1) {
            return null;
        }

        String directoryName = normalizedPath.substring(0, slash);
        String fileName = normalizedPath.substring(slash + 1);
        String resourceType = extractResourceType(directoryName);
        String resourceName = extractResourceName(fileName);
        if (resourceType == null || resourceType.isEmpty() || resourceName.isEmpty()) {
            return null;
        }

        Resources resources = context.getResources();
        int resourceId = resources.getIdentifier(resourceName, resourceType, context.getPackageName());
        if (resourceId == 0) {
            return null;
        }

        TypedValue typedValue = new TypedValue();
        try {
            Integer density = parseDensityQualifier(directoryName);
            if (density != null) {
                resources.getValueForDensity(resourceId, density, typedValue, true);
            } else {
                resources.getValue(resourceId, typedValue, true);
            }
        } catch (Resources.NotFoundException e) {
            if (UpdateContext.DEBUG) {
                Log.d("react-native-update", "Failed to resolve resource value for " + resourcePath + ": " + e.getMessage());
            }
            return null;
        }

        if (typedValue.string == null) {
            return null;
        }

        String assetPath = typedValue.string.toString();
        if (assetPath.startsWith("/")) {
            assetPath = assetPath.substring(1);
        }

        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Resolved resource path " + resourcePath + " -> " + assetPath);
        }
        return new ResolvedResourceSource(resourceId, assetPath);
    }

    private InputStream openResolvedResourceStream(ResolvedResourceSource source) throws IOException {
        try {
            return context.getResources().openRawResource(source.resourceId);
        } catch (Resources.NotFoundException e) {
            throw new IOException("Unable to open resolved resource: " + source.assetPath, e);
        }
    }

    private void copyFromResource(HashMap<String, ArrayList<File> > resToCopy) throws IOException {
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
        
        // 构建规范化路径映射，用于 APK ↔ AAB 版本限定符无关匹配
        // 例如 "res/drawable-xxhdpi-v4/img.png" → "res/drawable-xxhdpi/img.png"
        HashMap<String, String> normalizedEntryMap = new HashMap<>();
        for (String entryName : availableEntries.keySet()) {
            String normalized = normalizeResPath(entryName);
            normalizedEntryMap.putIfAbsent(normalized, entryName);
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
            ResolvedResourceSource resolvedResource = null;
            
            // 如果精确匹配找不到，尝试版本限定符无关匹配（APK ↔ AAB 兼容）
            // 例如 __diff.json 中的 "res/drawable-xxhdpi-v4/img.png" 匹配设备上的 "res/drawable-xxhdpi/img.png"
            if (ze == null) {
                String normalizedFrom = normalizeResPath(fromPath);
                String actualEntry = normalizedEntryMap.get(normalizedFrom);
                if (actualEntry != null) {
                    ze = availableEntries.get(actualEntry);
                    actualSourcePath = actualEntry;
                    if (UpdateContext.DEBUG) {
                        Log.d("react-native-update", "Normalized match: " + fromPath + " -> " + actualEntry);
                    }
                }
            }

            // release APK 可能会将资源 entry 名压缩为 res/9w.png 之类的短路径；
            // 这时通过 Resources 解析逻辑资源名，再直接读取资源内容。
            if (ze == null) {
                resolvedResource = resolveBundledResource(fromPath);
                if (resolvedResource != null) {
                    actualSourcePath = resolvedResource.assetPath;
                }
            }
            
            if (ze != null || resolvedResource != null) {
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
                            if (ze != null) {
                                // 从保存的映射中获取包含该条目的 ZipFile
                                SafeZipFile sourceZipFile = entryToZipFileMap.get(actualSourcePath);
                                if (sourceZipFile == null) {
                                    sourceZipFile = zipFile; // 回退到基础 APK
                                }
                                sourceZipFile.unzipToFile(ze, target);
                            } else {
                                InputStream in = openResolvedResourceStream(resolvedResource);
                                copyInputStreamToFile(in, target);
                            }
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
        ArrayList<String> entryNames = new ArrayList<String>();
        ArrayList<String> copyFroms = new ArrayList<String>();
        ArrayList<String> copyTos = new ArrayList<String>();
        ArrayList<String> deletes = new ArrayList<String>();

        SafeZipFile zipFile = new SafeZipFile(param.targetFile);
        Enumeration<? extends ZipEntry> entries = zipFile.entries();
        while (entries.hasMoreElements()) {
            ZipEntry ze = entries.nextElement();
            String fn = ze.getName();
            entryNames.add(fn);

            if (fn.equals("__diff.json")) {
                // copy files from assets
                byte[] bytes = readBytes(zipFile.getInputStream(ze));
                String json = new String(bytes, "UTF-8");
                JSONObject obj = (JSONObject)new JSONTokener(json).nextValue();
                appendManifestEntries(obj, copyFroms, copyTos, deletes);
                continue;
            }
            zipFile.unzipToPath(ze, param.unzipDirectory);
        }

        zipFile.close();

        buildArchivePatchPlan(
            DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK,
            entryNames.toArray(new String[0]),
            copyFroms.toArray(new String[0]),
            copyTos.toArray(new String[0]),
            deletes.toArray(new String[0])
        );
        HashMap<String, ArrayList<File>> copyList = buildCopyList(
            param.unzipDirectory,
            buildCopyGroups(
                copyFroms.toArray(new String[0]),
                copyTos.toArray(new String[0])
            )
        );

        File originBundleFile = new File(param.unzipDirectory, ".origin.bundle");
        copyBundledAssetToFile("index.android.bundle", originBundleFile);
        try {
            applyPatchFromFileSource(
                param.unzipDirectory.getAbsolutePath(),
                param.unzipDirectory.getAbsolutePath(),
                originBundleFile.getAbsolutePath(),
                new File(param.unzipDirectory, "index.bundlejs.patch").getAbsolutePath(),
                new File(param.unzipDirectory, "index.bundlejs").getAbsolutePath(),
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
            Log.d("react-native-update", "copyList size: " + copyList.size());
            for (String from : copyList.keySet()) {
                Log.d("react-native-update", "copyList entry: " + from + " -> " + copyList.get(from).size() + " targets");
            }
        }

        copyFromResource(copyList);

        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Unzip finished");
        }

    }

    private void doPatchFromPpk(DownloadTaskParams param) throws IOException, JSONException {
        downloadFile(param);

        removeDirectory(param.unzipDirectory);
        param.unzipDirectory.mkdirs();

        ArrayList<String> entryNames = new ArrayList<String>();
        ArrayList<String> copyFroms = new ArrayList<String>();
        ArrayList<String> copyTos = new ArrayList<String>();
        ArrayList<String> deletes = new ArrayList<String>();


        SafeZipFile zipFile = new SafeZipFile(param.targetFile);
        Enumeration<? extends ZipEntry> entries = zipFile.entries();
        while (entries.hasMoreElements()) {
            ZipEntry ze = entries.nextElement();
            String fn = ze.getName();
            entryNames.add(fn);

            if (fn.equals("__diff.json")) {
                // copy files from assets
                byte[] bytes = readBytes(zipFile.getInputStream(ze));
                String json = new String(bytes, "UTF-8");
                JSONObject obj = (JSONObject)new JSONTokener(json).nextValue();
                appendManifestEntries(obj, copyFroms, copyTos, deletes);
                continue;
            }
            zipFile.unzipToPath(ze, param.unzipDirectory);
        }

        zipFile.close();

        ArchivePatchPlanResult plan = buildArchivePatchPlan(
            DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK,
            entryNames.toArray(new String[0]),
            copyFroms.toArray(new String[0]),
            copyTos.toArray(new String[0]),
            deletes.toArray(new String[0])
        );

        applyPatchFromFileSource(
            param.originDirectory.getAbsolutePath(),
            param.unzipDirectory.getAbsolutePath(),
            new File(param.originDirectory, "index.bundlejs").getAbsolutePath(),
            new File(param.unzipDirectory, "index.bundlejs.patch").getAbsolutePath(),
            new File(param.unzipDirectory, "index.bundlejs").getAbsolutePath(),
            plan.mergeSourceSubdir,
            plan.enableMerge,
            copyFroms.toArray(new String[0]),
            copyTos.toArray(new String[0]),
            deletes.toArray(new String[0])
        );

        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Unzip finished");
        }
    }
    private void doCleanUp(DownloadTaskParams param) throws IOException {
        if (UpdateContext.DEBUG) {
            Log.d("react-native-update", "Start cleaning up");
        }
        cleanupOldEntries(
            param.unzipDirectory.getAbsolutePath(),
            param.hash,
            param.originHash,
            7
        );
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
