package cn.reactnative.modules.update;

import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;


public class SafeZipFile extends ZipFile {

    public SafeZipFile(File file) throws IOException {
        super(file);
    }

    private static final int BUFFER_SIZE = 8192;

    @Override
    public Enumeration<? extends ZipEntry> entries() {
        return new SafeZipEntryIterator(super.entries());
    }

    private static class SafeZipEntryIterator implements Enumeration<ZipEntry> {

        final private Enumeration<? extends ZipEntry> delegate;

        private SafeZipEntryIterator(Enumeration<? extends ZipEntry> delegate) {
            this.delegate = delegate;
        }

        @Override
        public boolean hasMoreElements() {
            return delegate.hasMoreElements();
        }

        @Override
        public ZipEntry nextElement() {
            ZipEntry entry = delegate.nextElement();
            if (null != entry) {
                String name = entry.getName();
                /**
                 * avoid ZipperDown
                 */
                if (null != name && (name.contains("../") || name.contains("..\\"))) {
                    throw new SecurityException("illegal entry: " + name);
                }
            }
            return entry;
        }
    }

    public static void validatePath(File target, File baseDir) throws IOException {
        String canonicalTarget = target.getCanonicalPath();
        String canonicalBase = baseDir.getCanonicalPath();
        String prefix = canonicalBase.endsWith(File.separator) ? canonicalBase : canonicalBase + File.separator;
        if (!canonicalTarget.startsWith(prefix) && !canonicalTarget.equals(canonicalBase)) {
            throw new SecurityException("Illegal path: " + canonicalTarget);
        }
    }

    public void unzipToPath(ZipEntry ze, File targetPath) throws IOException {
        String name = ze.getName();
        File target = new File(targetPath, name);

        validatePath(target, targetPath);

        Log.d("react-native-update", "Unzipping " + name);

        if (ze.isDirectory()) {
            target.mkdirs();
            return;
        }
        unzipToFile(ze, target, targetPath);
    }

    public void unzipToFile(ZipEntry ze, File target, File baseDir) throws IOException {
        validatePath(target, baseDir);
        try (InputStream inputStream = getInputStream(ze)) {
            try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(target));
                 BufferedInputStream input = new BufferedInputStream(inputStream)) {
                byte[] buffer = new byte[BUFFER_SIZE];
                int n;
                while ((n = input.read(buffer, 0, BUFFER_SIZE)) >= 0) {
                    output.write(buffer, 0, n);
                }
            }
        }
    }

}