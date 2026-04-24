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
