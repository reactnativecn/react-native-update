package cn.reactnative.modules.update;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Java mirror of cpp/patch_core/install_record.h — keep in sync by hand.
 * The completion record written as the last step of a two-phase install and
 * read back before a version directory is trusted.
 */
final class InstallRecord {
    static final int SCHEMA = 1;
    static final String FILE_NAME = ".pushy-complete";
    static final String STAGING_SUFFIX = ".staging";

    private InstallRecord() {
    }

    static File stagingDirectoryFor(File versionDir) {
        return new File(versionDir.getPath() + STAGING_SUFFIX);
    }

    static String build(String versionHash, String bundleSha256, String artifactSha256)
        throws JSONException {
        JSONObject record = new JSONObject();
        record.put("schema", SCHEMA);
        record.put("versionHash", versionHash);
        if (bundleSha256 != null && !bundleSha256.isEmpty()) {
            record.put("bundleSha256", bundleSha256);
        }
        if (artifactSha256 != null && !artifactSha256.isEmpty()) {
            record.put("artifactSha256", artifactSha256);
        }
        return record.toString();
    }

    /** Writes the record and fsyncs it: the rename that follows must find it on disk. */
    static void write(File versionDir, String recordJson) throws IOException {
        File file = new File(versionDir, FILE_NAME);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(recordJson.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        }
    }

    /**
     * Parsed record, or null when the file is absent or malformed. An empty
     * file (legacy marker) yields an empty JSONObject.
     */
    static JSONObject read(File versionDir) {
        File file = new File(versionDir, FILE_NAME);
        if (!file.isFile()) {
            return null;
        }
        if (file.length() == 0) {
            return new JSONObject();
        }
        if (file.length() > 64 * 1024) {
            return null;
        }
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int read = in.read(bytes, offset, bytes.length - offset);
                if (read < 0) {
                    break;
                }
                offset += read;
            }
            return new JSONObject(new String(bytes, 0, offset, StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    /**
     * Presence check: the record exists and, unless legacy-empty, names this
     * version. No digest work — this runs on launch / dedup paths.
     */
    static boolean isComplete(File versionDir, String versionHash) {
        JSONObject record = read(versionDir);
        if (record == null) {
            return false;
        }
        if (record.length() == 0) {
            return true;
        }
        return record.optInt("schema", 0) == SCHEMA
            && versionHash.equals(record.optString("versionHash", ""));
    }

    /**
     * Activation check: re-hashes the bundle when the record carries a digest.
     * Throws with the reason when the directory must not be activated.
     */
    static void verifyForActivation(File versionDir, String versionHash, File bundleFile)
        throws IOException {
        JSONObject record = read(versionDir);
        if (record == null) {
            throw new IOException("Bundle version " + versionHash + " has no valid completion record.");
        }
        if (record.length() == 0) {
            return;
        }
        if (record.optInt("schema", 0) != SCHEMA
            || !versionHash.equals(record.optString("versionHash", ""))) {
            throw new IOException("Bundle version " + versionHash + " completion record mismatch.");
        }
        String expected = record.optString("bundleSha256", "");
        if (expected.isEmpty()) {
            return;
        }
        String actual = UpdateFileUtils.sha256Hex(bundleFile);
        if (!expected.equalsIgnoreCase(actual)) {
            throw new IOException("Bundle version " + versionHash + " bundle digest mismatch.");
        }
    }
}
