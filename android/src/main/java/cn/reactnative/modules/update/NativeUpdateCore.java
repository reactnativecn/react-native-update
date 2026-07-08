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
     * 原生 patch 内核支持的 HBC 变换规范版本(hdiffv2 能力特征)。
     * 经 getConstants 暴露给 JS,再随 checkUpdate 上报,服务端按能力门控。
     */
    static int hbcTransformVersion() {
        ensureLoaded();
        return getHbcTransformVersion();
    }

    private static native int getHbcTransformVersion();
}
