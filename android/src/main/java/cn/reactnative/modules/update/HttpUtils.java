package cn.reactnative.modules.update;

/**
 * Pure string helpers for the HTTP paths (no Android or OkHttp types), kept
 * apart from DownloadTask / SyncCoordinator so they stay testable on
 * a plain JVM: DownloadTask loads librnupdate.so in its static initializer
 * and both pull in OkHttp.
 */
final class HttpUtils {
    private HttpUtils() {
    }

    /** True for an "https:" URL, case-insensitively; false for anything else (incl. null). */
    static boolean isHttpsUrl(String url) {
        return url != null && url.regionMatches(true, 0, "https://", 0, 8);
    }

    /** Request path appended to an endpoint base, kept out of the plain string table. */
    static final String QUERY_PATH = reveal("7514fcd4ad805d55263e08fc99");

    /**
     * Decodes text produced by scripts/encode-native-text.ts: byte i is XORed
     * with (0x5A + 0x1D * i) & 0xFF. Keeps service addresses and paths out of
     * static string scans of the binary; it is not a secret.
     */
    static String reveal(String hex) {
        char[] out = new char[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int b = Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            out[i] = (char) (b ^ ((0x5A + 0x1D * i) & 0xFF));
        }
        return new String(out);
    }

    /** Strips every trailing slash so "<base><QUERY_PATH><appKey>" never doubles one. */
    static String normalizeEndpointBase(String base) {
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base;
    }

    // "bytes <start>-<end>/<total>". Returns the total (0 when "*"), or -1
    // when the header is missing/malformed, the start does not match the
    // local partial, or the range and total contradict each other (end
    // before start, or a numeric total not beyond the end) — either way the
    // appended bytes could not be trusted. A total of 0 would otherwise pass
    // as "unknown" and skip the final size check (RFC 9110 §14.4: the
    // complete length must exceed the last position).
    static long parseContentRange(String header, long expectedStart) {
        if (header == null || !header.startsWith("bytes ")) {
            return -1;
        }
        try {
            String range = header.substring("bytes ".length()).trim();
            int slash = range.indexOf('/');
            int dash = range.indexOf('-');
            if (slash < 0 || dash < 0 || dash > slash) {
                return -1;
            }
            long start = Long.parseLong(range.substring(0, dash).trim());
            long end = Long.parseLong(range.substring(dash + 1, slash).trim());
            if (start != expectedStart || end < start) {
                return -1;
            }
            String totalPart = range.substring(slash + 1).trim();
            if (totalPart.equals("*")) {
                return 0;
            }
            long total = Long.parseLong(totalPart);
            return total > end ? total : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}
