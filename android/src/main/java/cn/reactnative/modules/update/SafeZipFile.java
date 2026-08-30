package cn.reactnative.modules.update;

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

    // Bytes written by unzipToFile across the archive: the sum of the central
    // directory's declared sizes is checked up front (inspect), the actual
    // stream is re-checked here — headers can lie.
    private long totalWritten = 0;

    static final class Inspection {
        long entries;
        long totalUncompressed;
    }

    /**
     * Walks the central directory once, enforcing the archive_limits caps
     * (entry count, per-entry size, total size, compression ratio) and the
     * reserved-name / traversal rules, before a single byte is extracted.
     */
    Inspection inspect() throws IOException {
        Inspection result = new Inspection();
        Enumeration<? extends ZipEntry> entries = entries();
        while (entries.hasMoreElements()) {
            ZipEntry entry = entries.nextElement();
            result.entries++;
            if (result.entries > ArchiveLimits.MAX_ENTRIES) {
                throw new IOException(
                    "archive has too many entries (> " + ArchiveLimits.MAX_ENTRIES + ")");
            }
            long size = entry.getSize();
            long compressed = entry.getCompressedSize();
            if (size > ArchiveLimits.MAX_ENTRY_BYTES) {
                throw new IOException(
                    "archive entry too large: " + entry.getName() + " (" + size + " bytes)");
            }
            if (size > 0) {
                result.totalUncompressed += size;
                if (result.totalUncompressed > ArchiveLimits.MAX_TOTAL_UNCOMPRESSED_BYTES) {
                    throw new IOException("archive expands beyond "
                        + ArchiveLimits.MAX_TOTAL_UNCOMPRESSED_BYTES + " bytes");
                }
                if (compressed > 0 && size > ArchiveLimits.RATIO_CHECK_MIN_BYTES
                    && size / compressed > ArchiveLimits.MAX_COMPRESSION_RATIO) {
                    throw new IOException(
                        "archive entry compression ratio too high: " + entry.getName());
                }
            }
        }
        return result;
    }

    // Files the SDK itself writes into a version directory to record its own
    // decisions (the ".pushy-complete" install marker today). An archive
    // must never be able to ship one: a package that unzips its own marker
    // next to a bundle would be trusted as a finished install even when the
    // patch step that follows fails.
    static final String RESERVED_ENTRY_PREFIX = ".pushy-";

    static boolean isReservedEntryName(String name) {
        if (name == null) {
            return false;
        }
        String normalized = name.replace('\\', '/');
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        int slash = normalized.lastIndexOf('/');
        String baseName = slash >= 0 ? normalized.substring(slash + 1) : normalized;
        return baseName.startsWith(RESERVED_ENTRY_PREFIX);
    }

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
                if (isReservedEntryName(name)) {
                    throw new SecurityException("reserved entry: " + name);
                }
            }
            return entry;
        }
    }

    public void unzipToPath(ZipEntry ze, File targetPath) throws IOException {
        String name = ze.getName();
        File target = new File(targetPath, name);

        // Fixing a Zip Path Traversal Vulnerability
        // https://support.google.com/faqs/answer/9294009
        String canonicalPath = target.getCanonicalPath();
        if (!canonicalPath.startsWith(targetPath.getCanonicalPath() + File.separator)) {
            throw new SecurityException("Illegal name: " + name);
        }
        if (isReservedEntryName(name)) {
            throw new SecurityException("reserved entry: " + name);
        }

        if (ze.isDirectory()) {
            target.mkdirs();
            return;
        }
        unzipToFile(ze, target);
    }

    public void unzipToFile(ZipEntry ze, File target) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
            throw new IOException("Failed to create parent dir for " + target);
        }

        // The declared size is the budget when known; otherwise the global
        // per-entry cap. Either way the stream may not exceed it.
        long declared = ze.getSize();
        long budget = declared >= 0
            ? Math.min(declared, ArchiveLimits.MAX_ENTRY_BYTES)
            : ArchiveLimits.MAX_ENTRY_BYTES;
        long written = 0;
        try (InputStream inputStream = getInputStream(ze)) {
            try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(target));
                 BufferedInputStream input = new BufferedInputStream(inputStream)) {
                byte[] buffer = new byte[BUFFER_SIZE];
                int n;
                while ((n = input.read(buffer, 0, BUFFER_SIZE)) >= 0) {
                    written += n;
                    totalWritten += n;
                    if (written > budget) {
                        throw new IOException(
                            "archive entry exceeds its declared size: " + ze.getName());
                    }
                    if (totalWritten > ArchiveLimits.MAX_TOTAL_UNCOMPRESSED_BYTES) {
                        throw new IOException("archive expands beyond "
                            + ArchiveLimits.MAX_TOTAL_UNCOMPRESSED_BYTES + " bytes");
                    }
                    output.write(buffer, 0, n);
                }
            }
        }
    }

}
