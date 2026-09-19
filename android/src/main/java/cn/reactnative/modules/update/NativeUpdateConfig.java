package cn.reactnative.modules.update;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Internal normalizer for the JSONObject accepted by PushyNativeUpdate.configure. */
final class NativeUpdateConfig {
    private static final Set<String> KEYS = new HashSet<>(Arrays.asList(
        "appKey", "endpoints", "queryUrls", "afterDownload", "disabled",
        "packageVersion", "rnu", "rn"));
    private static final Pattern URL = Pattern.compile(
        "^https?://(\\[[0-9a-fA-F:]+\\]|[a-zA-Z0-9.-]+)(:[0-9]+)?([/?#]|$)");
    private static final String[] ENDPOINTS = {
        "https://update.react-native.cn/api", "https://update.reactnative.cn/api"
    };
    private static final String[] QUERY_URLS = {
        "https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json",
        "https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json"
    };

    private NativeUpdateConfig() {}

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
