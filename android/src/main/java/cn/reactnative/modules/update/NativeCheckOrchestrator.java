package cn.reactnative.modules.update;

import android.os.Build;
import android.util.Log;
import java.util.HashSet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native cold-start update check (NATIVE_CHECKUPDATE_DESIGN §10): once per
 * process, a few seconds after getBundleUrl, entirely independent of the app
 * bundle — this is what lets a device bricked by a bad hot update pull the
 * fixed version on the next launch. All decisions come from
 * cpp/update_flow_core via NativeUpdateFlow; this class is IO glue only.
 * Failures are silent and bounded: one round per launch, no retry storms, no
 * version blacklisting.
 */
final class NativeCheckOrchestrator {
    static final String KEY_CONFIG = "nativeConfig";
    // Raw response cache for the JS side to reuse (§10.3), scoped to the
    // exact logical request and native config that produced it.
    static final String KEY_RESP_CACHE = "nativeCheckResp";
    private static final int MAX_CHECK_HTTP_ATTEMPTS = 8;
    private static final long DOWNLOAD_PHASE_TIMEOUT_SECONDS = 600;

    private static final AtomicBoolean scheduled = new AtomicBoolean(false);

    private NativeCheckOrchestrator() {
    }

    static void schedule(final UpdateContext context, final String launchRolledBackVersion) {
        if (UpdateContext.DEBUG) {
            return;
        }
        if (!scheduled.compareAndSet(false, true)) {
            return;
        }
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // Keep the check away from the cold-start critical path
                    // (§7 R5) — its result targets the NEXT launch anyway.
                    Thread.sleep(5000);
                    runOnce(context, launchRolledBackVersion);
                } catch (Throwable e) {
                    // The rescue path must never take the app down with it.
                    Log.w(UpdateContext.TAG, "native check failed: " + e);
                }
            }
        }, "pushy-native-check");
        thread.setPriority(Thread.MIN_PRIORITY + 1);
        thread.setDaemon(true);
        thread.start();
    }

    private static void runOnce(
        UpdateContext context,
        String launchRolledBackVersion
    ) throws JSONException {
        // Sampled before any IO: a reset landing while this round runs must
        // win over the round's decision.
        final long resetGeneration = UpdateContext.getResetGeneration();
        String configJson = context.getKv(KEY_CONFIG);
        if (configJson == null || configJson.isEmpty()) {
            // No persisted config (old integration / first ever launch): the
            // native check silently does not run — this is the rollout gate.
            return;
        }
        JSONObject config;
        try {
            config = new JSONObject(configJson);
        } catch (JSONException e) {
            return;
        }
        if (config.optBoolean("disabled", false)) {
            return;
        }
        String appKey = config.optString("appKey", "");
        if (appKey.isEmpty()) {
            return;
        }
        String packageVersion = config.optString(
            "packageVersion", context.getPackageVersion());
        if (packageVersion.isEmpty()) {
            packageVersion = context.getPackageVersion();
        }

        String currentVersion = context.getCurrentVersion();
        // Snapshot captured on the launch path before getConstants consumes
        // the one-shot rollback marker. Reading SharedPreferences here, five
        // seconds later, would lose the guard and could forceBoot the version
        // that this very launch just rolled back.
        String rolledBackVersion = launchRolledBackVersion;
        String uuid = context.getKv("uuid");
        if (uuid == null) {
            uuid = "";
        }

        JSONObject identity = new JSONObject();
        identity.put("packageVersion", packageVersion);
        identity.put(
            "currentVersion",
            currentVersion == null ? JSONObject.NULL : currentVersion
        );
        identity.put("uuid", uuid);
        if (rolledBackVersion != null) {
            identity.put("rolledBackVersion", rolledBackVersion);
        }

        JSONObject cInfo = new JSONObject();
        cInfo.put("rnu", config.optString("rnu", ""));
        cInfo.put("rn", config.optString("rn", ""));
        // React Native's Platform.Version is the Android SDK integer; use the
        // same value so this request can be fingerprinted against the JS one.
        cInfo.put("os", "android " + Build.VERSION.SDK_INT);
        cInfo.put("uuid", uuid);

        JSONObject input = new JSONObject();
        input.put("packageVersion", packageVersion);
        input.put(
            "currentVersion",
            currentVersion == null ? JSONObject.NULL : currentVersion
        );
        input.put("buildTime", context.getBuildTime());
        input.put("cInfo", cInfo);
        input.put("supportedDiffVersion", NativeUpdateCore.supportedDiffVersion());
        input.put("bundleHash", context.computeBundleHash());

        String body = NativeUpdateFlow.buildCheckRequestBody(input.toString());
        if (body == null) {
            return;
        }

        String responseText = runCheckRequest(config, appKey, body);
        if (responseText == null) {
            Log.i(UpdateContext.TAG,
                "native check: no endpoint reachable, giving up until next launch");
            return;
        }
        // Cache freshness is anchored to when the server response arrived,
        // not to when a potentially long download/patch/activation finished.
        final long responseAtSeconds = System.currentTimeMillis() / 1000;

        String decisionJson = NativeUpdateFlow.handleCheckResponse(
            responseText, identity.toString(), config.optString("afterDownload", ""));
        if (decisionJson == null) {
            return;
        }
        JSONObject decision = new JSONObject(decisionJson);
        if (!"download".equals(decision.optString("action"))) {
            if (UpdateContext.getResetGeneration() == resetGeneration) {
                persistResponseCache(
                    context, configJson, body, responseText, responseAtSeconds);
            }
            Log.i(UpdateContext.TAG,
                "native check: nothing to do (" + decision.optString("reason") + ")");
            return;
        }
        String hash = decision.optString("hash", "");
        if (!UpdateContext.isSafePathComponent(hash)) {
            return;
        }

        boolean downloaded = context.hasCompletedVersion(hash);
        if (!downloaded) {
            downloaded = performAttempts(
                context, decision.optJSONArray("attempts"), hash, currentVersion);
        }
        if (!downloaded) {
            // The native attempt has finished, so JS may safely reuse the
            // response and retry through its own strategy chain.
            if (UpdateContext.getResetGeneration() == resetGeneration) {
                persistResponseCache(
                    context, configJson, body, responseText, responseAtSeconds);
            }
            return;
        }

        // Persist name/description/metaInfo alongside the version, mirroring
        // the JS side's setLocalHashInfo after a successful download.
        JSONObject info = decision.optJSONObject("info");
        if (info != null) {
            JSONObject hashInfo = new JSONObject();
            for (String key : new String[] {"name", "description", "metaInfo"}) {
                Object value = info.opt(key);
                if (value instanceof String) {
                    hashInfo.put(key, value);
                }
            }
            context.setKv("hash_" + hash, hashInfo.toString());
        }

        if (UpdateContext.getResetGeneration() != resetGeneration) {
            Log.i(UpdateContext.TAG, "native check: reset during round, dropping result");
            return;
        }

        if (decision.optBoolean("activate", false)) {
            // Silent strategies or a server-marked forceBoot version
            // (per-version remote override — the brick rescue): activate for
            // the next launch. Otherwise activation stays with the JS side.
            try {
                context.switchVersion(hash);
                Log.i(UpdateContext.TAG,
                    "native check: downloaded " + hash + " and set for next launch");
            } catch (Exception e) {
                Log.w(UpdateContext.TAG, "native check: switchVersion failed: " + e);
            }
        } else {
            Log.i(UpdateContext.TAG,
                "native check: downloaded " + hash + ", activation left to JS");
        }
        // Publish the response only after native file/state work is complete;
        // otherwise JS can observe it and start a competing download.
        persistResponseCache(
            context, configJson, body, responseText, responseAtSeconds);
    }

    private static void persistResponseCache(
        UpdateContext context,
        String configJson,
        String requestBody,
        String responseText,
        long responseAtSeconds
    ) throws JSONException {
        JSONObject cacheEntry = new JSONObject();
        cacheEntry.put("ts", responseAtSeconds);
        cacheEntry.put("body", responseText);
        cacheEntry.put("request", requestBody);
        cacheEntry.put("config", configJson);
        context.setKv(KEY_RESP_CACHE, cacheEntry.toString());
    }

    private static final OkHttpClient httpClient = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build();

    private static String httpRequest(String url, String postBody) {
        try {
            Request.Builder builder =
                new Request.Builder().url(url).header("Accept", "application/json");
            if (postBody != null) {
                builder.post(RequestBody.create(
                    postBody, MediaType.parse("application/json; charset=utf-8")));
            }
            try (Response response = httpClient.newCall(builder.build()).execute()) {
                if (!response.isSuccessful() || response.body() == null) {
                    return null;
                }
                return response.body().string();
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isValidCheckResponse(String responseText) {
        if (responseText == null) {
            return false;
        }
        try {
            new JSONObject(responseText);
            return true;
        } catch (JSONException e) {
            return false;
        }
    }

    private static String normalizeEndpointBase(String base) {
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base;
    }

    /**
     * Sequential fallback over the ordered candidates (§5.1): one request at
     * a time with its own timeout; after the configured round fails,
     * queryUrls discovery merges remote candidates (excluding the
     * already-tried) for one more round. No hedged race on purpose — this
     * path is latency-insensitive.
     */
    private static String runCheckRequest(JSONObject config, String appKey, String body) {
        JSONArray endpoints = config.optJSONArray("endpoints");
        String orderedJson = NativeUpdateFlow.orderEndpointCandidates(
            endpoints == null ? "[]" : endpoints.toString(), Math.random());
        JSONArray ordered;
        try {
            ordered = orderedJson == null ? new JSONArray() : new JSONArray(orderedJson);
        } catch (JSONException e) {
            return null;
        }
        HashSet<String> tried = new HashSet<>();
        int httpAttempts = 0;
        for (int i = 0; i < ordered.length(); i++) {
            String base = normalizeEndpointBase(ordered.optString(i, ""));
            if (base.isEmpty() || !tried.add(base)) {
                continue;
            }
            if (httpAttempts++ >= MAX_CHECK_HTTP_ATTEMPTS) {
                return null;
            }
            String response = httpRequest(base + "/checkUpdate/" + appKey, body);
            if (isValidCheckResponse(response)) {
                return response;
            }
        }
        JSONArray queryUrls = config.optJSONArray("queryUrls");
        if (queryUrls == null) {
            return null;
        }
        for (int i = 0; i < queryUrls.length(); i++) {
            String listUrl = queryUrls.optString(i, "");
            if (listUrl.isEmpty()) {
                continue;
            }
            if (httpAttempts++ >= MAX_CHECK_HTTP_ATTEMPTS) {
                return null;
            }
            String listText = httpRequest(listUrl, null);
            if (listText == null) {
                continue;
            }
            JSONArray remote;
            try {
                remote = new JSONArray(listText);
            } catch (JSONException e) {
                continue;
            }
            for (int j = 0; j < remote.length(); j++) {
                String base = normalizeEndpointBase(remote.optString(j, ""));
                if (base.isEmpty() || tried.contains(base)) {
                    continue;
                }
                if (httpAttempts++ >= MAX_CHECK_HTTP_ATTEMPTS) {
                    return null;
                }
                tried.add(base);
                String response = httpRequest(base + "/checkUpdate/" + appKey, body);
                if (isValidCheckResponse(response)) {
                    return response;
                }
            }
            // One successfully fetched remote list is enough.
            break;
        }
        return null;
    }

    private static boolean performAttempts(
        UpdateContext context, JSONArray attempts, String hash, String originHash
    ) {
        if (attempts == null) {
            return false;
        }
        final long incrementalDeadlineNanos = System.nanoTime()
            + TimeUnit.SECONDS.toNanos(DOWNLOAD_PHASE_TIMEOUT_SECONDS);
        long fullDeadlineNanos = 0;
        for (int i = 0; i < attempts.length(); i++) {
            JSONObject attempt = attempts.optJSONObject(i);
            if (attempt == null) {
                continue;
            }
            String type = attempt.optString("type");
            if ("diff".equals(type) && (originHash == null || originHash.isEmpty())) {
                // diff patches from the running version; none is running.
                continue;
            }
            final boolean isFullAttempt = !"diff".equals(type) && !"pdiff".equals(type);
            if (isFullAttempt && fullDeadlineNanos == 0) {
                // Incremental failures must not consume the last-resort full
                // download's budget. Each phase gets one bounded 10min window.
                fullDeadlineNanos = System.nanoTime()
                    + TimeUnit.SECONDS.toNanos(DOWNLOAD_PHASE_TIMEOUT_SECONDS);
            }
            final long deadlineNanos = isFullAttempt
                ? fullDeadlineNanos : incrementalDeadlineNanos;
            JSONArray urls = attempt.optJSONArray("urls");
            if (urls == null) {
                continue;
            }
            for (int j = 0; j < urls.length(); j++) {
                String url = urls.optString(j, "");
                if (url.isEmpty()) {
                    continue;
                }
                // Check before enqueueing: once the phase budget is gone we
                // must not launch an orphan download that outlives the round.
                long remainingNanos = deadlineNanos - System.nanoTime();
                if (remainingNanos <= 0) {
                    if (isFullAttempt) {
                        return false;
                    }
                    break;
                }
                final CountDownLatch latch = new CountDownLatch(1);
                final AtomicBoolean succeeded = new AtomicBoolean(false);
                final String attemptType = type;
                UpdateContext.DownloadFileListener listener =
                    new UpdateContext.DownloadFileListener() {
                        @Override
                        public void onDownloadCompleted(DownloadTaskParams params) {
                            succeeded.set(true);
                            latch.countDown();
                        }

                        @Override
                        public void onDownloadFailed(Throwable error) {
                            Log.i(UpdateContext.TAG, "native check: " + attemptType
                                + " attempt failed: " + error);
                            latch.countDown();
                        }
                    };
                if ("diff".equals(type)) {
                    context.downloadPatchFromPpk(
                        url, hash, originHash, listener, deadlineNanos);
                } else if ("pdiff".equals(type)) {
                    context.downloadPatchFromApk(
                        url, hash, listener, deadlineNanos);
                } else {
                    context.downloadFullUpdate(
                        url, hash, listener, deadlineNanos);
                }
                try {
                    if (!latch.await(remainingNanos, TimeUnit.NANOSECONDS)) {
                        Log.w(UpdateContext.TAG,
                            "native check: download phase timed out during " + type);
                        if (isFullAttempt) {
                            return false;
                        }
                        break;
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
                if (succeeded.get()) {
                    return true;
                }
            }
        }
        return false;
    }
}
