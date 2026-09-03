package cn.reactnative.modules.update;

/** Selects the at-most-two distinct version names supported by cleanup JNI. */
final class CleanupKeepNames {
    private CleanupKeepNames() {
    }

    static String[] select(String current, String previous, String running) {
        String[] keep = new String[2];
        for (String candidate : new String[] {current, previous, running}) {
            if (candidate == null || candidate.isEmpty()
                || candidate.equals(keep[0]) || candidate.equals(keep[1])) {
                continue;
            }
            if (keep[0] == null) {
                keep[0] = candidate;
            } else if (keep[1] == null) {
                keep[1] = candidate;
            } else {
                return null;
            }
        }
        return keep;
    }
}
