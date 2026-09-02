package cn.reactnative.modules.update;

/**
 * Pure string helpers for the HTTP paths (no Android or OkHttp types), kept
 * apart from DownloadTask / NativeCheckOrchestrator so they stay testable on
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

    /** Strips every trailing slash so "<base>/checkUpdate/<appKey>" never doubles one. */
    static String normalizeEndpointBase(String base) {
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base;
    }

    // "bytes <start>-<end>/<total>". Returns the total (0 when "*"), or -1
    // when the header is missing/malformed or the start does not match the
    // local partial — either way the appended bytes could not be trusted.
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
            if (start != expectedStart) {
                return -1;
            }
            String totalPart = range.substring(slash + 1).trim();
            return totalPart.equals("*") ? 0 : Long.parseLong(totalPart);
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}
