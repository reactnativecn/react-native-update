package cn.reactnative.modules.update;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Internal normalizer for the JSONObject accepted by PushyRuntime.configure. */
final class PushyConfiguration {
    private static final Set<String> KEYS = new HashSet<>(Arrays.asList(
        "appKey", "endpoints", "queryUrls", "afterDownload", "disabled",
        "packageVersion", "rnu", "rn"));
    private static final Pattern URL = Pattern.compile(
        "^https?://(\\[[0-9a-fA-F:]+\\]|[a-zA-Z0-9.-]+)(:[0-9]+)?([/?#]|$)");
    // Default service addresses, encoded by scripts/encode-native-text.ts.
    private static final String[] ENDPOINTS = {
        HttpUtils.reveal("3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5b3d5b9817b592947e5cdefbc8a7e"),
        HttpUtils.reveal("3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5f0daac9c644a620ae88ca1ad93")
    };
    private static final String[] QUERY_URLS = {
        HttpUtils.reveal("3203e0c1bdd1270a253608fcd3fd9362476817f4f0d5a1996342631be3c2a3a9d779552507fdcde8928a6f512f5ce2ccbdc869404d2f1de79daa826d562c0913eec4fa9b7d4426"),
        HttpUtils.reveal("3203e0c1bdd1270a213b12b7dca09468462e12f3b0d5bd813d482446f4c6a1be8e79552507fdcda68cd06e5c3710e480a4867048483e55e0c2ab8d7d43030d1ce9c3b183214e2601f2f0d5b782601e2719e8ca")
    };

    private PushyConfiguration() {}

    static String normalize(String json) throws JSONException {
        JSONObject options = new JSONObject(json);
        for (Iterator<String> keys = options.keys(); keys.hasNext();) {
            String key = keys.next();
            if (!KEYS.contains(key)) {
                throw invalid("unknown option " + key);
            }
        }
        String appKey = string(options.opt("appKey"), "appKey", false);
        boolean customEndpoints = options.has("endpoints");
        JSONArray endpoints = urls(customEndpoints ? options.get("endpoints")
            : new JSONArray(Arrays.asList(ENDPOINTS)), "endpoints", true);
        JSONArray queryUrls = urls(options.has("queryUrls") ? options.get("queryUrls")
            : new JSONArray(Arrays.asList(customEndpoints ? new String[0] : QUERY_URLS)),
            "queryUrls", false);
        String afterDownload = options.has("afterDownload")
            ? string(options.get("afterDownload"), "afterDownload", false) : "none";
        if (!"none".equals(afterDownload) && !"setNeedUpdate".equals(afterDownload)) {
            throw invalid("afterDownload must be none or setNeedUpdate");
        }
        Object disabled = options.has("disabled") ? options.get("disabled") : Boolean.FALSE;
        if (!(disabled instanceof Boolean)) {
            throw invalid("disabled must be a boolean");
        }
        JSONObject result = new JSONObject();
        result.put("appKey", appKey);
        result.put("endpoints", endpoints);
        result.put("queryUrls", queryUrls);
        result.put("afterDownload", afterDownload);
        result.put("disabled", disabled);
        result.put("rnu", options.has("rnu") ? string(options.get("rnu"), "rnu", true) : "");
        result.put("rn", options.has("rn") ? string(options.get("rn"), "rn", true) : "");
        if (options.has("packageVersion")) {
            result.put("packageVersion", string(options.get("packageVersion"), "packageVersion", false));
        }
        return result.toString();
    }

    private static String string(Object value, String name, boolean allowEmpty) {
        if (!(value instanceof String) || (!allowEmpty && ((String) value).trim().isEmpty())) {
            throw invalid(name + " must be a string" + (allowEmpty ? "" : " and must not be blank"));
        }
        return (String) value;
    }

    private static JSONArray urls(Object value, String name, boolean base) throws JSONException {
        if (!(value instanceof JSONArray) || (base && ((JSONArray) value).length() == 0)) {
            throw invalid(name + " must be " + (base ? "a non-empty" : "an") + " array");
        }
        JSONArray values = (JSONArray) value;
        JSONArray result = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < values.length(); i++) {
            String url = string(values.get(i), name, false).trim();
            if (!URL.matcher(url).find() || url.matches("(?s).*\\s.*") || url.contains("\\")
                || (base && (url.contains("?") || url.contains("#")))) {
                throw invalid(name + " requires absolute HTTP(S) URLs without credentials"
                    + (base ? ", queries or fragments" : ""));
            }
            String normalized = base ? url.replaceAll("/+$", "") : url;
            if (seen.add(normalized)) {
                result.put(normalized);
            }
        }
        return result;
    }

    private static IllegalArgumentException invalid(String message) {
        return new IllegalArgumentException("Invalid native configuration: " + message);
    }
}
