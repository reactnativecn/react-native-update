package cn.reactnative.modules.update;

/**
 * Snapshot of a native check-and-update round. A downloaded result does not
 * mean that the running React Native instance has been reloaded.
 */
public final class NativeUpdateResult {
    public static final String SKIPPED = "skipped";
    public static final String NO_UPDATE = "noUpdate";
    public static final String DOWNLOADED = "downloaded";
    public static final String FAILED = "failed";
    public static final String CANCELLED = "cancelled";

    private final String status;
    private final String reason;
    private final String hash;
    private final boolean activated;

    private NativeUpdateResult(String status, String reason, String hash, boolean activated) {
        this.status = status;
        this.reason = reason;
        this.hash = hash;
        this.activated = activated;
    }

    static NativeUpdateResult of(String status, String reason) {
        return new NativeUpdateResult(status, reason, "", false);
    }

    static NativeUpdateResult downloaded(String hash, boolean activated) {
        return new NativeUpdateResult(DOWNLOADED, "", hash, activated);
    }

    public String getStatus() {
        return status;
    }

    public String getReason() {
        return reason;
    }

    /** Installed update hash, or an empty string when this round installed nothing. */
    public String getHash() {
        return hash;
    }

    /** Whether this round selected the downloaded version for the next launch. */
    public boolean isActivated() {
        return activated;
    }
}
