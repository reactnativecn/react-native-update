package cn.reactnative.modules.update;

final class NativeUpdateCore {
    private static boolean loaded = false;

    private NativeUpdateCore() {
    }

    static synchronized void ensureLoaded() {
        if (loaded) {
            return;
        }

        try {
            System.loadLibrary("rnupdate");
        } catch (UnsatisfiedLinkError error) {
            UnsatisfiedLinkError wrapped = new UnsatisfiedLinkError(
                "Failed to load rnupdate native library. Original error: "
                    + error.getMessage());
            wrapped.initCause(error);
            throw wrapped;
        }

        loaded = true;
    }

    /**
     * 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道)。
     * 经 getConstants 暴露给 JS,再随 checkUpdate 以 diffV 上报,
     * 服务端按能力门控下发。
     */
    static int supportedDiffVersion() {
        ensureLoaded();
        return getSupportedDiffVersion();
    }

    private static native int getSupportedDiffVersion();
}
