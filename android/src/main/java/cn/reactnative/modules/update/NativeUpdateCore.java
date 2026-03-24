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
            System.loadLibrary("c++_shared");
        } catch (UnsatisfiedLinkError ignored) {
            // Fall back to the transitive dependency load path when the host app already
            // packages libc++_shared.so but the linker has not loaded it yet.
        }

        try {
            System.loadLibrary("rnupdate");
        } catch (UnsatisfiedLinkError error) {
            UnsatisfiedLinkError wrapped = new UnsatisfiedLinkError(
                "Failed to load rnupdate. Ensure the host app packages libc++_shared.so "
                    + "when using the shared C++ runtime. Original error: "
                    + error.getMessage());
            wrapped.initCause(error);
            throw wrapped;
        }

        loaded = true;
    }
}
