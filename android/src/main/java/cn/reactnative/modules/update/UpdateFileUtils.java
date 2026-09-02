package cn.reactnative.modules.update;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

final class UpdateFileUtils {
    private static final int BUFFER_SIZE = 8192;

    private UpdateFileUtils() {
    }

    // Server-provided identifiers (hash/originHash/fileName) become child
    // names under the update root; anything that could resolve outside of it
    // (path separators, "..", ".") must be rejected before touching the
    // filesystem.
    static boolean isSafePathComponent(String name) {
        return name != null
                && !name.isEmpty()
                && !name.equals(".")
                && !name.equals("..")
                && !name.contains("/")
                && !name.contains("\\")
                && name.indexOf('\0') < 0;
    }

    static void ensureDirectory(File directory) throws IOException {
        if (!directory.exists() && !directory.mkdirs() && !directory.exists()) {
            throw new IOException("Failed to create directory: " + directory);
        }
    }

    static void ensureParentDirectory(File file) throws IOException {
        File parent = file.getParentFile();
        if (parent != null) {
            ensureDirectory(parent);
        }
    }

    static void removeDirectory(File file) throws IOException {
        if (file.isDirectory()) {
            File[] files = file.listFiles();
            if (files != null) {
                for (File child : files) {
                    String name = child.getName();
                    if (name.equals(".") || name.equals("..")) {
                        continue;
                    }
                    removeDirectory(child);
                }
            }
        }
        if (file.exists() && !file.delete()) {
            throw new IOException("Failed to delete " + file);
        }
    }

    /** Streaming SHA-256 of a file, lowercase hex. */
    static String sha256Hex(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                md.update(buffer, 0, read);
            }
            byte[] digest = md.digest();
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xf, 16));
                hex.append(Character.forDigit(b & 0xf, 16));
            }
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 unavailable", e);
        }
    }

    static void copyFile(File from, File to) throws IOException {
        ensureParentDirectory(to);
        try (
            InputStream in = new FileInputStream(from);
            FileOutputStream out = new FileOutputStream(to)
        ) {
            copy(in, out);
        }
    }

    static void copyInputStreamToFile(InputStream input, File destination) throws IOException {
        ensureParentDirectory(destination);
        try (InputStream in = input; FileOutputStream out = new FileOutputStream(destination)) {
            copy(in, out);
        }
    }

    private static void copy(InputStream in, FileOutputStream out) throws IOException {
        byte[] buffer = new byte[BUFFER_SIZE];
        int count;
        while ((count = in.read(buffer)) != -1) {
            out.write(buffer, 0, count);
        }
    }
}
