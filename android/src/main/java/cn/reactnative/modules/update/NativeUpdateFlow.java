package cn.reactnative.modules.update;

/**
 * JNI bindings to the shared update-flow decision layer
 * (cpp/update_flow_core). String-in/string-out JSON on purpose — it matches
 * the decision layer's own boundary and keeps this surface trivially stable.
 * A null return means the input did not parse; callers skip the check round.
 */
final class NativeUpdateFlow {
    static {
        NativeUpdateCore.ensureLoaded();
    }

    private NativeUpdateFlow() {
    }

    static native String buildCheckRequestBody(String inputJson);

    static native String orderEndpointCandidates(String endpointsJson, double randomSample);

    static native String handleCheckResponse(String responseText, String identityJson);
}
