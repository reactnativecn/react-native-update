package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class SafeZipFileTest {
    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    private File zipOf(Map<String, byte[]> entries) throws IOException {
        File file = temp.newFile();
        try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(file))) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                out.putNextEntry(new ZipEntry(entry.getKey()));
                if (entry.getValue() != null) {
                    out.write(entry.getValue());
                }
                out.closeEntry();
            }
        }
        return file;
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static void drain(SafeZipFile zip) {
        Enumeration<? extends ZipEntry> entries = zip.entries();
        while (entries.hasMoreElements()) {
            entries.nextElement();
        }
    }

    @Test
    public void reservedEntryNamesAreDetectedByBaseName() {
        assertTrue(SafeZipFile.isReservedEntryName(".pushy-complete"));
        assertTrue(SafeZipFile.isReservedEntryName("sub/dir/.pushy-complete"));
        assertTrue(SafeZipFile.isReservedEntryName("sub\\dir\\.pushy-anything"));
        assertTrue(SafeZipFile.isReservedEntryName(".pushy-complete/"));
        assertFalse(SafeZipFile.isReservedEntryName("pushy-complete"));
        assertFalse(SafeZipFile.isReservedEntryName("sub/.pushy/file"));
        assertFalse(SafeZipFile.isReservedEntryName("index.bundlejs"));
        assertFalse(SafeZipFile.isReservedEntryName(""));
        assertFalse(SafeZipFile.isReservedEntryName(null));
    }

    @Test
    public void entriesRejectTraversalNames() throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("ok.txt", utf8("ok"));
        entries.put("../evil.txt", utf8("evil"));
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            drain(zip);
            fail("traversal entry must be rejected");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains("../evil.txt"));
        }
    }

    @Test
    public void entriesRejectReservedNames() throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("index.bundlejs", utf8("bundle"));
        entries.put(".pushy-complete", utf8("{}"));
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            drain(zip);
            fail("reserved entry must be rejected");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains(".pushy-complete"));
        }
    }

    @Test
    public void unzipToPathRejectsTraversalAndReservedNames() throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("ok.txt", utf8("ok"));
        File target = temp.newFolder();
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            try {
                zip.unzipToPath(new ZipEntry("../escape.txt"), target);
                fail("traversal must be rejected before extraction");
            } catch (SecurityException expected) {
                // expected
            }
            try {
                zip.unzipToPath(new ZipEntry("nested/.pushy-complete"), target);
                fail("reserved name must be rejected before extraction");
            } catch (SecurityException expected) {
                // expected
            }
        }
        assertFalse(new File(temp.getRoot(), "escape.txt").exists());
        assertFalse(new File(target, "nested").exists());
    }

    @Test
    public void unzipToPathExtractsFilesAndDirectories() throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("assets/", null);
        entries.put("assets/logo.png", new byte[] {1, 2, 3});
        entries.put("index.bundlejs", utf8("console.log(1)"));
        File target = temp.newFolder();
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            SafeZipFile.Inspection inspection = zip.inspect();
            assertEquals(3, inspection.entries);
            assertEquals(3 + "console.log(1)".length(), inspection.totalUncompressed);
            Enumeration<? extends ZipEntry> it = zip.entries();
            while (it.hasMoreElements()) {
                zip.unzipToPath(it.nextElement(), target);
            }
        }
        assertTrue(new File(target, "assets").isDirectory());
        assertEquals(3, new File(target, "assets/logo.png").length());
        assertEquals("console.log(1)", new String(
            Files.readAllBytes(new File(target, "index.bundlejs").toPath()),
            StandardCharsets.UTF_8));
    }

    @Test
    public void inspectRejectsTooManyEntries() throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        for (long i = 0; i <= ArchiveLimits.MAX_ENTRIES; i++) {
            entries.put("e" + i, null);
        }
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            zip.inspect();
            fail("entry count over the cap must be rejected");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("too many entries"));
        }
    }

    @Test
    public void inspectRejectsCompressionBombs() throws IOException {
        // A megabyte of zeros deflates to about a kilobyte: far beyond the
        // allowed ratio once the entry is large enough to be checked.
        byte[] zeros = new byte[(int) ArchiveLimits.RATIO_CHECK_MIN_BYTES + 1];
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("bomb.bin", zeros);
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            zip.inspect();
            fail("compression bomb must be rejected");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("compression ratio"));
        }
    }

    @Test
    public void inspectSkipsRatioCheckForSmallEntries() throws IOException {
        // Same ratio, but under RATIO_CHECK_MIN_BYTES: small highly
        // compressible files (JSON manifests) are legitimate.
        byte[] zeros = new byte[64 * 1024];
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("small.bin", zeros);
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            SafeZipFile.Inspection inspection = zip.inspect();
            assertEquals(1, inspection.entries);
            assertEquals(zeros.length, inspection.totalUncompressed);
        }
    }
}
