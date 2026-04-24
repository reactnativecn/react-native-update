package cn.reactnative.modules.update;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.os.Build;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.TypedValue;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.zip.ZipEntry;
import java.util.regex.Pattern;

final class BundledResourceCopier {
    private static final Pattern VERSION_QUALIFIER_PATTERN = Pattern.compile("-v\\d+(?=/)");
    private static final String AAB_BASE_PREFIX = "base/";

    private final Context context;

    private static final class ResolvedResourceSource {
        final int resourceId;
        final String assetPath;

        ResolvedResourceSource(int resourceId, String assetPath) {
            this.resourceId = resourceId;
            this.assetPath = assetPath;
        }
    }

    BundledResourceCopier(Context context) {
        this.context = context.getApplicationContext();
    }

    void copyFromResource(HashMap<String, ArrayList<File>> resToCopy) throws IOException {
        ArrayList<String> apkPaths = collectApkPaths();
        HashMap<String, ZipEntry> availableEntries = new HashMap<String, ZipEntry>();
        HashMap<String, SafeZipFile> zipFileMap = new HashMap<String, SafeZipFile>();
        HashMap<String, SafeZipFile> entryToZipFileMap = new HashMap<String, SafeZipFile>();

        try {
            for (String apkPath : apkPaths) {
                SafeZipFile zipFile = new SafeZipFile(new File(apkPath));
                zipFileMap.put(apkPath, zipFile);
                Enumeration<? extends ZipEntry> entries = zipFile.entries();
                while (entries.hasMoreElements()) {
                    ZipEntry ze = entries.nextElement();
                    String entryName = ze.getName();
                    if (!availableEntries.containsKey(entryName)) {
                        availableEntries.put(entryName, ze);
                        entryToZipFileMap.put(entryName, zipFile);
                    }
                }
            }

            HashMap<String, String> normalizedEntryMap = new HashMap<String, String>();
            for (String entryName : availableEntries.keySet()) {
                String normalized = normalizeResPath(entryName);
                normalizedEntryMap.putIfAbsent(normalized, entryName);
            }

            SafeZipFile baseZipFile = zipFileMap.get(context.getPackageResourcePath());
            HashMap<String, ArrayList<File>> remainingFiles =
                new HashMap<String, ArrayList<File>>(resToCopy);

            for (String fromPath : new ArrayList<String>(remainingFiles.keySet())) {
                ArrayList<File> targets = remainingFiles.get(fromPath);
                if (targets == null || targets.isEmpty()) {
                    continue;
                }

                ZipEntry entry = availableEntries.get(fromPath);
                String actualSourcePath = fromPath;
                ResolvedResourceSource resolvedResource = null;

                if (entry == null) {
                    String normalizedFrom = normalizeResPath(fromPath);
                    String actualEntry = normalizedEntryMap.get(normalizedFrom);
                    if (actualEntry != null) {
                        entry = availableEntries.get(actualEntry);
                        actualSourcePath = actualEntry;
                    }
                }

                if (entry == null) {
                    resolvedResource = resolveBundledResource(fromPath);
                    if (resolvedResource != null) {
                        actualSourcePath = resolvedResource.assetPath;
                    }
                }

                if (entry == null && resolvedResource == null) {
                    continue;
                }

                File lastTarget = null;
                for (File target : targets) {
                    try {
                        if (lastTarget != null) {
                            UpdateFileUtils.copyFile(lastTarget, target);
                        } else if (entry != null) {
                            SafeZipFile sourceZipFile = entryToZipFileMap.get(actualSourcePath);
                            if (sourceZipFile == null) {
                                sourceZipFile = baseZipFile;
                            }
                            sourceZipFile.unzipToFile(entry, target);
                        } else {
                            InputStream in = openResolvedResourceStream(resolvedResource);
                            UpdateFileUtils.copyInputStreamToFile(in, target);
                        }
                        lastTarget = target;
                    } catch (IOException e) {
                        if (UpdateContext.DEBUG) {
                            Log.w(
                                UpdateContext.TAG,
                                "Failed to copy resource "
                                    + actualSourcePath
                                    + " to "
                                    + target
                                    + ": "
                                    + e.getMessage()
                            );
                        }
                    }
                }
                remainingFiles.remove(fromPath);
            }

            if (!remainingFiles.isEmpty() && UpdateContext.DEBUG) {
                Log.w(
                    UpdateContext.TAG,
                    "Skipped " + remainingFiles.size() + " missing bundled resources"
                );
            }
        } finally {
            closeZipFiles(zipFileMap);
        }
    }

    private String normalizeResPath(String path) {
        String result = path;
        if (result.startsWith(AAB_BASE_PREFIX)) {
            result = result.substring(AAB_BASE_PREFIX.length());
        }
        return VERSION_QUALIFIER_PATTERN.matcher(result).replaceAll("");
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
            return null;
        }

        if (typedValue.string == null) {
            return null;
        }

        String assetPath = typedValue.string.toString();
        if (assetPath.startsWith("/")) {
            assetPath = assetPath.substring(1);
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

    private ArrayList<String> collectApkPaths() {
        ArrayList<String> apkPaths = new ArrayList<String>();
        apkPaths.add(context.getPackageResourcePath());

        try {
            ApplicationInfo appInfo =
                context.getPackageManager().getApplicationInfo(context.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && appInfo.splitSourceDirs != null) {
                for (String splitPath : appInfo.splitSourceDirs) {
                    apkPaths.add(splitPath);
                }
            }
        } catch (PackageManager.NameNotFoundException e) {
            if (UpdateContext.DEBUG) {
                Log.w(UpdateContext.TAG, "Failed to get application info: " + e.getMessage());
            }
        }

        return apkPaths;
    }

    private void closeZipFiles(HashMap<String, SafeZipFile> zipFileMap) {
        for (SafeZipFile zipFile : zipFileMap.values()) {
            try {
                zipFile.close();
            } catch (IOException e) {
                if (UpdateContext.DEBUG) {
                    Log.w(UpdateContext.TAG, "Failed to close zip file", e);
                }
            }
        }
    }
}
