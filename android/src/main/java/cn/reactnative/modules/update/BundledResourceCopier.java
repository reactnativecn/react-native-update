package cn.reactnative.modules.update;

import android.content.Context;
import android.content.res.Resources;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.TypedValue;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.zip.ZipEntry;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class BundledResourceCopier {
    private static final Pattern VERSION_QUALIFIER_PATTERN = Pattern.compile("-v\\d+(?=/)");
    private static final String AAB_BASE_PREFIX = "base/";
    // split_config.xxhdpi.apk, split_feature.config.xxhdpi.apk
    private static final Pattern DENSITY_SPLIT_PATTERN =
        Pattern.compile("(?:^|[._])config\\.((?:ld|md|hd|xhd|xxhd|xxxhd|tvd)pi)\\.apk$");

    private final Context context;

    private static final class ResolvedResourceSource {
        final int resourceId;
        final String assetPath;
        final int density;

        ResolvedResourceSource(int resourceId, String assetPath, int density) {
            this.resourceId = resourceId;
            this.assetPath = assetPath;
            this.density = density;
        }
    }

    // An entry together with the exact archive it came from, so a copy reads
    // from that archive even if another APK exposes the same entry name with
    // different bytes.
    private static final class ZipSource {
        final ZipEntry entry;
        final SafeZipFile zipFile;

        ZipSource(ZipEntry entry, SafeZipFile zipFile) {
            this.entry = entry;
            this.zipFile = zipFile;
        }
    }

    BundledResourceCopier(Context context) {
        this.context = context.getApplicationContext();
    }

    /**
     * Performs the manifest copies of an APK-based patch (the host share of
     * the native applyArchiveDelta): each group's targets, relative to
     * targetRoot, receive its source entry. The native manifest parser has
     * already validated every path and the copiesCrc rules.
     */
    void copyFromResource(File targetRoot, CopyGroupResult[] groups) throws IOException {
        HashMap<String, ArrayList<File>> resToCopy = new HashMap<String, ArrayList<File>>();
        HashMap<String, Long> crcByFrom = new HashMap<String, Long>();
        HashMap<String, String[]> toPathsByFrom = new HashMap<String, String[]>();
        for (CopyGroupResult group : groups) {
            ArrayList<File> targets = new ArrayList<File>();
            for (String to : group.toPaths) {
                targets.add(new File(targetRoot, to));
            }
            resToCopy.put(group.from, targets);
            toPathsByFrom.put(group.from, group.toPaths);
            if (group.expectedCrc >= 0) {
                crcByFrom.put(group.from, group.expectedCrc);
            }
        }
        ArrayList<String> apkPaths = collectApkPaths();
        HashSet<String> installedDensities = installedSplitDensities(apkPaths);
        ArrayList<SafeZipFile> zipFiles = new ArrayList<SafeZipFile>();
        // Entry name -> first archive (base APK first) that carries it.
        HashMap<String, ZipSource> availableEntries = new HashMap<String, ZipSource>();
        // Content checksum index: CRC32 -> matched archive source. Lets us
        // locate a file by content when its origin path is not present verbatim
        // on device (e.g. APK baseline diff applied on an AAB/split-apk install
        // whose res/ paths were shortened). First entry for a given crc wins.
        HashMap<Long, ZipSource> crcToEntry = new HashMap<Long, ZipSource>();

        try {
            for (String apkPath : apkPaths) {
                SafeZipFile zipFile = new SafeZipFile(new File(apkPath));
                zipFiles.add(zipFile);
                Enumeration<? extends ZipEntry> entries = zipFile.entries();
                while (entries.hasMoreElements()) {
                    ZipEntry ze = entries.nextElement();
                    ZipSource source = new ZipSource(ze, zipFile);
                    // No Map.putIfAbsent: it is API 24+ and minSdk is 21.
                    if (!availableEntries.containsKey(ze.getName())) {
                        availableEntries.put(ze.getName(), source);
                    }
                    long crc = ze.getCrc();
                    if (crc != -1L && !crcToEntry.containsKey(crc)) {
                        crcToEntry.put(crc, source);
                    }
                }
            }

            HashMap<String, String> normalizedEntryMap = new HashMap<String, String>();
            for (String entryName : availableEntries.keySet()) {
                String normalized = normalizeResPath(entryName);
                if (!normalizedEntryMap.containsKey(normalized)) {
                    normalizedEntryMap.put(normalized, entryName);
                }
            }

            HashMap<String, ArrayList<File>> remainingFiles =
                new HashMap<String, ArrayList<File>>(resToCopy);
            // Track copies that were located but failed to write. These are real
            // failures (disk full, corrupt archive) that must fail the update,
            // not skips — otherwise the update activates with missing resources.
            ArrayList<String> failedCopies = new ArrayList<String>();
            // Entries whose manifest-declared CRC32 could not be satisfied by
            // any installed archive: the path-matched file has different bytes
            // and no entry anywhere carries the expected content. Copying would
            // install a wrong resource (rebuilt binary with drifted assets), so
            // these fail the whole patch — the JS strategy chain then falls
            // back to the full package.
            ArrayList<String> crcMismatches = new ArrayList<String>();
            int substitutedDensities = 0;

            for (String fromPath : new ArrayList<String>(remainingFiles.keySet())) {
                ArrayList<File> targets = remainingFiles.get(fromPath);
                if (targets == null || targets.isEmpty()) {
                    continue;
                }

                ZipSource entry = availableEntries.get(fromPath);
                String actualSourcePath = fromPath;
                ResolvedResourceSource resolvedResource = null;
                Long wantedCrc = crcByFrom.get(fromPath);
                boolean pathMatchDrifted = false;

                if (entry == null) {
                    String normalizedFrom = normalizeResPath(fromPath);
                    String actualEntry = normalizedEntryMap.get(normalizedFrom);
                    if (actualEntry != null) {
                        entry = availableEntries.get(actualEntry);
                        actualSourcePath = actualEntry;
                    }
                }

                // Verify a path-matched entry against the manifest-declared
                // CRC32: a rebuilt binary can keep the path but drift the
                // content. On mismatch, discard the path match and try to
                // locate the expected content elsewhere. An entry with an
                // unknown CRC (-1) cannot be verified and is accepted as-is.
                if (entry != null && wantedCrc != null
                    && entry.entry.getCrc() != -1L
                    && entry.entry.getCrc() != wantedCrc.longValue()) {
                    entry = null;
                    actualSourcePath = fromPath;
                    pathMatchDrifted = true;
                }

                // Content (CRC32) match: robust across APK/AAB packaging because
                // the checksum is over the uncompressed file content, not its
                // path. Preferred over the resource-id heuristic below.
                if (entry == null && wantedCrc != null) {
                    ZipSource matched = crcToEntry.get(wantedCrc);
                    if (matched != null) {
                        entry = matched;
                        actualSourcePath = matched.entry.getName();
                    }
                }

                // A density split install only carries the device's density,
                // so the expected bytes of another density cannot be on disk.
                // That is not drift: fill the targets with the installed
                // variant, because the JS side picks drawable-<scale>/ by the
                // current PixelRatio and a missing file is a broken image.
                if (entry == null && wantedCrc != null && !pathMatchDrifted) {
                    String[] toPaths = toPathsByFrom.get(fromPath);
                    ZipSource[] substitutes = resolveDensitySubstitutes(
                        toPaths, installedDensities, availableEntries
                    );
                    if (substitutes != null) {
                        for (int i = 0; i < substitutes.length; i++) {
                            File target = targets.get(i);
                            try {
                                substitutes[i].zipFile.unzipToFile(substitutes[i].entry, target);
                                substitutedDensities++;
                            } catch (IOException e) {
                                Log.e(
                                    Texts.LOG_TAG,
                                    "Failed to copy resource "
                                        + substitutes[i].entry.getName()
                                        + " to "
                                        + target,
                                    e
                                );
                                failedCopies.add(substitutes[i].entry.getName() + " -> " + target);
                            }
                        }
                        remainingFiles.remove(fromPath);
                        continue;
                    }
                }

                // A declared CRC that no installed entry satisfies is a hard
                // content mismatch. The resource-id heuristic below cannot be
                // trusted here: the content index above already covers every
                // entry, so anything the heuristic finds has the wrong bytes.
                if (entry == null && wantedCrc != null) {
                    crcMismatches.add(fromPath);
                    remainingFiles.remove(fromPath);
                    continue;
                }

                if (entry == null) {
                    resolvedResource = resolveBundledResource(fromPath);
                    if (resolvedResource != null) {
                        actualSourcePath = resolvedResource.assetPath;
                        // resolveBundledResource resolved the density-correct
                        // file path; copy that exact entry from the already-open
                        // archives so the right variant is used. (openRawResource
                        // would re-resolve the id at the current configuration
                        // density and ignore the requested one.)
                        ZipSource resolvedEntry = availableEntries.get(actualSourcePath);
                        if (resolvedEntry != null) {
                            entry = resolvedEntry;
                            resolvedResource = null;
                        }
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
                            entry.zipFile.unzipToFile(entry.entry, target);
                        } else {
                            InputStream in = openResolvedResourceStream(resolvedResource);
                            UpdateFileUtils.copyInputStreamToFile(in, target);
                        }
                        lastTarget = target;
                    } catch (IOException e) {
                        // A located resource that fails to write is a hard
                        // failure, not a skip: record it and fail the update
                        // after the loop so a broken update is not activated.
                        Log.e(
                            Texts.LOG_TAG,
                            "Failed to copy resource "
                                + actualSourcePath
                                + " to "
                                + target,
                            e
                        );
                        failedCopies.add(actualSourcePath + " -> " + target);
                    }
                }
                remainingFiles.remove(fromPath);
            }

            if (!crcMismatches.isEmpty()) {
                throw new IOException(
                    "Bundled resource content mismatch (crc32) for "
                        + crcMismatches.size() + " entries: " + crcMismatches
                );
            }

            if (!failedCopies.isEmpty()) {
                throw new IOException(
                    "Failed to copy " + failedCopies.size()
                        + " bundled resource(s): " + failedCopies
                );
            }

            if (substitutedDensities > 0) {
                Log.i(
                    Texts.LOG_TAG,
                    "Filled " + substitutedDensities
                        + " density variants missing from this split install ("
                        + installedDensities + ") with the installed variant"
                );
            }

            if (!remainingFiles.isEmpty()) {
                Log.w(
                    Texts.LOG_TAG,
                    "Skipped " + remainingFiles.size() + " missing bundled resources"
                );
            }
        } finally {
            closeZipFiles(zipFiles);
        }
    }

    private ZipSource[] resolveDensitySubstitutes(
        String[] toPaths,
        HashSet<String> installedDensities,
        HashMap<String, ZipSource> availableEntries
    ) {
        if (!canSubstituteDensityVariant(toPaths, installedDensities)) {
            return null;
        }
        ZipSource[] substitutes = new ZipSource[toPaths.length];
        for (int i = 0; i < toPaths.length; i++) {
            ResolvedResourceSource resolved = resolveBundledResource(toPaths[i]);
            // Resolving to the target's own density means this very variant is
            // installed, so its bytes should have matched: that is drift. So is
            // a resource the binary no longer has. bundletool can place another
            // density's variant in the device's split, so the split name alone
            // does not settle this.
            if (resolved == null
                || Integer.valueOf(resolved.density).equals(densityOf(toPaths[i]))) {
                return null;
            }
            substitutes[i] = availableEntries.get(resolved.assetPath);
            if (substitutes[i] == null) {
                return null;
            }
        }
        return substitutes;
    }

    /**
     * Whether copy targets can be outside what a density split install carries.
     * Only the targets can tell: release APKs shorten res/ paths (res/5u.png),
     * so the manifest's source path says nothing about its density.
     */
    static boolean canSubstituteDensityVariant(
        String[] toPaths,
        HashSet<String> installedDensities
    ) {
        if (installedDensities.isEmpty() || toPaths == null || toPaths.length == 0) {
            return false;
        }
        for (String toPath : toPaths) {
            String directory = resourceDirectory(toPath);
            if (!toPath.startsWith("drawable-")
                || densityOf(toPath) == null
                // Another qualifier (drawable-night-hdpi) would not survive the
                // lookup, which resolves those from the current configuration.
                || !directory.equals("drawable-" + densityQualifier(directory))
                || installedDensities.contains(densityQualifier(directory))) {
                return false;
            }
        }
        return true;
    }

    private static Integer densityOf(String resourcePath) {
        String directory = resourceDirectory(resourcePath);
        return directory == null ? null : parseDensityQualifier(directory);
    }

    private static String densityQualifier(String directory) {
        for (String qualifier : directory.split("-")) {
            if (parseDensityQualifier(qualifier) != null) {
                return qualifier;
            }
        }
        return null;
    }

    private static String resourceDirectory(String resourcePath) {
        String path = resourcePath.startsWith("res/")
            ? resourcePath.substring("res/".length())
            : resourcePath;
        int slash = path.indexOf('/');
        return slash <= 0 ? null : path.substring(0, slash);
    }

    static HashSet<String> installedSplitDensities(ArrayList<String> apkPaths) {
        HashSet<String> densities = new HashSet<String>();
        for (String apkPath : apkPaths) {
            Matcher matcher = DENSITY_SPLIT_PATTERN.matcher(new File(apkPath).getName());
            if (matcher.find()) {
                densities.add(matcher.group(1));
            }
        }
        return densities;
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

    private static Integer parseDensityQualifier(String directoryName) {
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

        return new ResolvedResourceSource(resourceId, assetPath, typedValue.density);
    }

    private InputStream openResolvedResourceStream(ResolvedResourceSource source) throws IOException {
        // Defensive fallback only: reached when the density-resolved assetPath
        // is not present as a zip entry in any loaded APK. Best-effort, resolves
        // at the current configuration density.
        try {
            return context.getResources().openRawResource(source.resourceId);
        } catch (Resources.NotFoundException e) {
            throw new IOException("Unable to open resolved resource: " + source.assetPath, e);
        }
    }

    // The base APK first, then the split APKs of an AAB install.
    private ArrayList<String> collectApkPaths() {
        ArrayList<String> apkPaths = new ArrayList<String>();
        apkPaths.add(context.getPackageResourcePath());
        String[] splitSourceDirs = context.getApplicationInfo().splitSourceDirs;
        if (splitSourceDirs != null) {
            for (String splitPath : splitSourceDirs) {
                apkPaths.add(splitPath);
            }
        }
        return apkPaths;
    }

    private void closeZipFiles(ArrayList<SafeZipFile> zipFiles) {
        for (SafeZipFile zipFile : zipFiles) {
            try {
                zipFile.close();
            } catch (IOException e) {
                if (BuildConfig.DEBUG) {
                    Log.w(Texts.LOG_TAG, "Failed to close zip file", e);
                }
            }
        }
    }
}
