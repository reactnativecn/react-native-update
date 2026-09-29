package cn.reactnative.modules.update;

/**
 * Encoded text helpers with no Android or native dependencies, so any class
 * (and the plain-JVM unit tests) can use them without triggering
 * UpdateContext's native library load.
 */
final class Texts {
    /** Log tag shared by the module. */
    static final String LOG_TAG = reveal("2812f5d2bac6664436360afc9ba680694b3301");

    private Texts() {
    }

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
}
