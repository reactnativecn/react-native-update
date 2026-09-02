package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class InstallRecordTest {
    private static final String HASH = "0123456789abcdef";

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    private static void writeFile(File file, byte[] bytes) throws IOException {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
    }

    private static String sha256Hex(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) {
            hex.append(String.format("%02x", b));
        }
        return hex.toString();
    }

    @Test
    public void buildWritesSchemaAndOnlyPresentDigests() throws JSONException {
        JSONObject full = new JSONObject(InstallRecord.build(HASH, "bb", "aa"));
        assertEquals(InstallRecord.SCHEMA, full.getInt("schema"));
        assertEquals(HASH, full.getString("versionHash"));
        assertEquals("bb", full.getString("bundleSha256"));
        assertEquals("aa", full.getString("artifactSha256"));

        JSONObject bare = new JSONObject(InstallRecord.build(HASH, "", null));
        assertEquals(HASH, bare.getString("versionHash"));
        assertFalse(bare.has("bundleSha256"));
        assertFalse(bare.has("artifactSha256"));
    }

    @Test
    public void writeThenReadRoundTrips() throws Exception {
        File dir = temp.newFolder();
        InstallRecord.write(dir, InstallRecord.build(HASH, "bb", "aa"));
        assertTrue(new File(dir, InstallRecord.FILE_NAME).isFile());

        JSONObject record = InstallRecord.read(dir);
        assertNotNull(record);
        assertEquals(HASH, record.getString("versionHash"));
        assertTrue(InstallRecord.isComplete(dir, HASH));
        assertFalse(InstallRecord.isComplete(dir, "someotherhash"));
    }

    @Test
    public void readHandlesAbsentLegacyAndMalformedRecords() throws Exception {
        File dir = temp.newFolder();
        assertNull(InstallRecord.read(dir));
        assertFalse(InstallRecord.isComplete(dir, HASH));

        // Legacy marker: an empty file counts as complete for any hash.
        File marker = new File(dir, InstallRecord.FILE_NAME);
        writeFile(marker, new byte[0]);
        JSONObject legacy = InstallRecord.read(dir);
        assertNotNull(legacy);
        assertEquals(0, legacy.length());
        assertTrue(InstallRecord.isComplete(dir, HASH));

        writeFile(marker, "not json".getBytes(StandardCharsets.UTF_8));
        assertNull(InstallRecord.read(dir));
        assertFalse(InstallRecord.isComplete(dir, HASH));

        byte[] oversized = new byte[64 * 1024 + 1];
        Arrays.fill(oversized, (byte) ' ');
        writeFile(marker, oversized);
        assertNull(InstallRecord.read(dir));
    }

    @Test
    public void isCompleteRequiresMatchingSchemaAndHash() throws Exception {
        File dir = temp.newFolder();
        File marker = new File(dir, InstallRecord.FILE_NAME);
        writeFile(marker, ("{\"schema\":" + (InstallRecord.SCHEMA + 1)
            + ",\"versionHash\":\"" + HASH + "\"}").getBytes(StandardCharsets.UTF_8));
        assertFalse(InstallRecord.isComplete(dir, HASH));

        writeFile(marker, ("{\"schema\":" + InstallRecord.SCHEMA
            + ",\"versionHash\":\"other\"}").getBytes(StandardCharsets.UTF_8));
        assertFalse(InstallRecord.isComplete(dir, HASH));
    }

    @Test
    public void verifyForActivationChecksTheBundleDigest() throws Exception {
        File dir = temp.newFolder();
        File bundle = new File(dir, "index.bundlejs");
        byte[] bundleBytes = "var a = 1;".getBytes(StandardCharsets.UTF_8);
        writeFile(bundle, bundleBytes);

        InstallRecord.write(dir, InstallRecord.build(HASH, sha256Hex(bundleBytes), ""));
        InstallRecord.verifyForActivation(dir, HASH, bundle);

        // Digest stored upper-case still matches.
        InstallRecord.write(dir, InstallRecord.build(HASH, sha256Hex(bundleBytes).toUpperCase(), ""));
        InstallRecord.verifyForActivation(dir, HASH, bundle);

        writeFile(bundle, "var a = 2;".getBytes(StandardCharsets.UTF_8));
        try {
            InstallRecord.verifyForActivation(dir, HASH, bundle);
            fail("tampered bundle must not activate");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("digest mismatch"));
        }
    }

    @Test
    public void verifyForActivationAcceptsRecordsWithoutDigestAndLegacyMarkers() throws Exception {
        File dir = temp.newFolder();
        File bundle = new File(dir, "index.bundlejs");
        writeFile(bundle, "x".getBytes(StandardCharsets.UTF_8));

        InstallRecord.write(dir, InstallRecord.build(HASH, "", ""));
        InstallRecord.verifyForActivation(dir, HASH, bundle);

        writeFile(new File(dir, InstallRecord.FILE_NAME), new byte[0]);
        InstallRecord.verifyForActivation(dir, HASH, bundle);
    }

    @Test
    public void verifyForActivationRejectsMissingOrForeignRecords() throws Exception {
        File dir = temp.newFolder();
        File bundle = new File(dir, "index.bundlejs");
        writeFile(bundle, "x".getBytes(StandardCharsets.UTF_8));
        try {
            InstallRecord.verifyForActivation(dir, HASH, bundle);
            fail("missing record must not activate");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("no valid completion record"));
        }

        InstallRecord.write(dir, InstallRecord.build("anotherhash", "", ""));
        try {
            InstallRecord.verifyForActivation(dir, HASH, bundle);
            fail("record for another version must not activate");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("record mismatch"));
        }
    }

    @Test
    public void stagingDirectoryIsASibling() {
        File version = new File("/data/_update/" + HASH);
        assertEquals(new File("/data/_update/" + HASH + InstallRecord.STAGING_SUFFIX),
            InstallRecord.stagingDirectoryFor(version));
    }
}
