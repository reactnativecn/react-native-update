package cn.reactnative.modules.update;

/**
 * JNI bindings to the shared update-flow decision layer
 * (cpp/update_flow_core). String-in/string-out JSON on purpose — it matches
 * the decision layer's own boundary and keeps this surface trivially stable.
 * A null return means the input did not parse; callers skip the check round.
 */
final class FlowBridge {
    static {
        NativeCore.ensureLoaded();
    }

    private FlowBridge() {
    }

    static native String buildRequestBody(String inputJson);

    static native String orderEndpointCandidates(String endpointsJson, double randomSample);

    static native boolean isValidResponse(String responseText);

    static native String handleResponse(
        String responseText, String identityJson, String afterDownload);
}
