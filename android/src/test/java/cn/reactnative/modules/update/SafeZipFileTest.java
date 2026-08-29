package cn.reactnative.modules.update;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public final class SafeZipFileTest {
    public static void main(String[] args) throws Exception {
        rejectsReservedEntry(".pushy-complete");
        rejectsReservedEntry("./.pushy-complete");
        rejectsReservedEntry(".pushy-complete/payload");
        extractsOrdinaryEntry();
        System.out.println("SafeZipFile tests passed");
    }

    private static void rejectsReservedEntry(String entryName) throws Exception {
        File root = Files.createTempDirectory("safe-zip-reserved").toFile();
        try {
            File archive = new File(root, "input.zip");
            writeArchive(archive, entryName, "forged");
            File destination = new File(root, "out");
            if (!destination.mkdirs()) {
                throw new AssertionError("failed to create destination");
            }

            boolean rejected = false;
            try (SafeZipFile zip = new SafeZipFile(archive)) {
                Enumeration<? extends ZipEntry> entries = zip.entries();
                while (entries.hasMoreElements()) {
                    try {
                        zip.unzipToPath(entries.nextElement(), destination);
                    } catch (SecurityException expected) {
                        rejected = true;
                    }
                }
            }

            if (!rejected) {
                throw new AssertionError("reserved entry was accepted: " + entryName);
            }
            if (new File(destination, ".pushy-complete").exists()) {
                throw new AssertionError("reserved completion path was created: " + entryName);
            }
        } finally {
            deleteRecursively(root);
        }
    }

    private static void extractsOrdinaryEntry() throws Exception {
        File root = Files.createTempDirectory("safe-zip-ordinary").toFile();
        try {
            File archive = new File(root, "input.zip");
            writeArchive(archive, "assets/icon.txt", "ok");
            File destination = new File(root, "out");
            if (!destination.mkdirs()) {
                throw new AssertionError("failed to create destination");
            }

            try (SafeZipFile zip = new SafeZipFile(archive)) {
                Enumeration<? extends ZipEntry> entries = zip.entries();
                while (entries.hasMoreElements()) {
                    zip.unzipToPath(entries.nextElement(), destination);
                }
            }

            File extracted = new File(destination, "assets/icon.txt");
            String content = new String(
                Files.readAllBytes(extracted.toPath()),
                StandardCharsets.UTF_8
            );
            if (!"ok".equals(content)) {
                throw new AssertionError("ordinary entry was not extracted correctly");
            }
        } finally {
            deleteRecursively(root);
        }
    }

    private static void writeArchive(File archive, String entryName, String content)
        throws Exception {
        try (ZipOutputStream output = new ZipOutputStream(new FileOutputStream(archive))) {
            output.putNextEntry(new ZipEntry(entryName));
            output.write(content.getBytes(StandardCharsets.UTF_8));
            output.closeEntry();
        }
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        if (!file.delete() && file.exists()) {
            throw new AssertionError("failed to delete " + file);
        }
    }
}
