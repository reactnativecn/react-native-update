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
    // Set when a round starts, cleared when it ends (§11.4). Residue on the
    // next launch means the previous process died mid-round (a crash rescue
    // was truncated): that launch resumes immediately instead of waiting 5s.
    static final String KEY_ROUND_INCOMPLETE = "nativeCheckIncomplete";
    private static final int MAX_CHECK_HTTP_ATTEMPTS = 8;
    private static final long DOWNLOAD_PHASE_TIMEOUT_SECONDS = 600;

    private static final AtomicBoolean scheduled = new AtomicBoolean(false);
    // One round per process, whoever starts it first — the delayed cold-start
    // thread or the crash-rescue thread (§11.3). roundDone lets the rescue
    // wait for an in-flight round instead of racing it.
    private static final AtomicBoolean roundStarted = new AtomicBoolean(false);
    private static final CountDownLatch roundDone = new CountDownLatch(1);
    private static volatile boolean roundCompleted = false;
    // Flipped the moment a crash is being held. JS is dead from that point
    // on, so there is no second decision maker: the round force-activates
    // whatever it downloads (§11.3).
    private static volatile boolean crashRescueActive = false;
    // A version this process downloaded but left for JS to activate. If the
    // process then crashes, JS will never activate it — the crash handler
    // activates it directly (bounded local work, no network). The generation
    // is the one the round committed under: a reset that lands afterwards
    // bumps it, and the late activation must lose to that reset exactly like
    // the round itself would. Written generation-first, read hash-first, so
    // a torn read can only see a stricter (newer) generation.
    private static volatile String unactivatedHash;
    private static volatile long unactivatedGeneration;
    private static volatile UpdateContext sContext;
    private static volatile String sLaunchRolledBackVersion;
    // Config JSON for which JS reported a completed check in this process
    // (markJsCheckCompleted). Process-scoped by design: the next launch
    // starts with no signal and the cold-start round runs again.
    private static volatile String sJsCompletedConfig;

    static void markJsCheckCompleted(String config) {
        sJsCompletedConfig = config;
    }

    /**
     * True when JS already obtained a valid response in this process for the
     * exact config the native round would use: the delayed round is then a
     * duplicate request. Only the scheduled round consults this — the
     * crash-rescue path still runs, JS is dead by then.
     */
    private static boolean isJsCheckCompleted(UpdateContext context) {
        String jsConfig = sJsCompletedConfig;
        return jsConfig != null && jsConfig.equals(context.getKv(KEY_CONFIG));
    }

    private NativeCheckOrchestrator() {
    }

    static void schedule(final UpdateContext context, final String launchRolledBackVersion) {
        if (UpdateContext.DEBUG) {
            return;
        }
        if (!scheduled.compareAndSet(false, true)) {
            return;
        }
        sContext = context;
        sLaunchRolledBackVersion = launchRolledBackVersion;
        // The crash-hold rescue shares the orchestrator's rollout gate: no
        // persisted config, no handler (§11.3).
        if (context.getKv(KEY_CONFIG) != null) {
            CrashRescue.install();
        }
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // Keep the check away from the cold-start critical path
                    // (§7 R5) — unless the previous process died mid-round,
                    // in which case every launch second counts (§11.4).
                    if (context.getKv(KEY_ROUND_INCOMPLETE) == null) {
                        Thread.sleep(5000);
                    }
                    if (isJsCheckCompleted(context)) {
                        // Not consuming the round: a later crash rescue may
                        // still need it.
                        Log.i(UpdateContext.TAG,
                            "native check skipped: JS check completed in this process");
                        return;
                    }
                    startRound(0);
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

    static boolean isRoundInFlight() {
        return roundStarted.get() && !roundCompleted;
    }

    /**
     * Runs the process's single round on the calling thread if nobody has
     * started it yet. deadlineNanos > 0 (crash rescue) caps every HTTP call
     * and download phase to the remaining budget.
     */
    private static void startRound(long deadlineNanos) {
        if (!roundStarted.compareAndSet(false, true)) {
            return;
        }
        try {
            runOnce(sContext, sLaunchRolledBackVersion, deadlineNanos);
        } catch (Throwable e) {
            Log.w(UpdateContext.TAG, "native check failed: " + e);
        } finally {
            roundCompleted = true;
            roundDone.countDown();
        }
    }

    /**
     * Crash-rescue entry (§11.3), called from the handler's worker thread
     * while the uncaught-exception handler holds the dying process. Ensures
     * this process's round runs to completion within the budget, then
     * activates a downloaded-but-unactivated version if one exists — the
     * last chance before the process is gone.
     */
    static void runRescue(long deadlineNanos) {
        UpdateContext context = sContext;
        if (context == null) {
            return;
        }
        crashRescueActive = true;
        startRound(deadlineNanos);
        if (!roundCompleted) {
            long remainingNanos = deadlineNanos - System.nanoTime();
            if (remainingNanos > 0) {
                try {
                    roundDone.await(remainingNanos, TimeUnit.NANOSECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
        activatePendingVersion(context);
    }

    // The alert-strategy variant of the §10.7 hole: the round downloaded a
    // fix but deferred activation to JS, and JS is now dead. Activation is
    // local and bounded (a state switch under the commit lock).
    private static void activatePendingVersion(UpdateContext context) {
        String hash = unactivatedHash;
        if (hash == null) {
            return;
        }
        String hashInfoJson = null;
        String existingInfo = context.getKv("hash_" + hash);
        if (existingInfo != null) {
            try {
                JSONObject info = new JSONObject(existingInfo);
                info.put("crashRescue", true);
                hashInfoJson = info.toString();
            } catch (JSONException ignored) {
            }
        }
        try {
            if (context.commitNativeCheckResult(
                    unactivatedGeneration, hash, hashInfoJson, true, null)) {
                unactivatedHash = null;
                Log.i(UpdateContext.TAG,
                    "crash rescue: activated downloaded version " + hash);
            } else {
                Log.i(UpdateContext.TAG,
                    "crash rescue: reset since download, dropping activation");
            }
        } catch (Exception e) {
            Log.w(UpdateContext.TAG, "crash rescue: activation failed: " + e);
        }
    }

    private static void runOnce(
        UpdateContext context,
        String launchRolledBackVersion,
        long deadlineNanos
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
        // From here on the round does real work: leave the breadcrumb that
        // the next launch reads to skip its 5s delay if we die mid-round.
        // Best-effort: a lost breadcrumb costs one 5s delay, it must not
        // abort the rescue round itself.
        try {
            context.setKv(KEY_ROUND_INCOMPLETE, "1");
        } catch (IllegalStateException ignored) {
        }
        try {
            runConfiguredRound(
                context, launchRolledBackVersion, deadlineNanos,
                resetGeneration, configJson, config, appKey);
        } finally {
            try {
                context.removeKv(KEY_ROUND_INCOMPLETE);
            } catch (IllegalStateException ignored) {
            }
        }
    }

    private static void runConfiguredRound(
        UpdateContext context,
        String launchRolledBackVersion,
        long deadlineNanos,
        long resetGeneration,
        String configJson,
        JSONObject config,
        String appKey
    ) throws JSONException {
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

        String responseText = runCheckRequest(config, appKey, body, deadlineNanos);
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
            context.commitNativeCheckResult(
                resetGeneration, null, null, false,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
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
                context, decision.optJSONArray("attempts"), hash, currentVersion,
                deadlineNanos);
        }
        if (!downloaded) {
            // The native attempt has finished, so JS may safely reuse the
            // response and retry through its own strategy chain.
            context.commitNativeCheckResult(
                resetGeneration, null, null, false,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
            return;
        }

        // Version info (mirroring the JS side's setLocalHashInfo), the
        // activation and the response cache all land in one atomic commit —
        // see UpdateContext.commitNativeCheckResult.
        String hashInfoJson = null;
        JSONObject info = decision.optJSONObject("info");
        if (info != null) {
            JSONObject hashInfo = new JSONObject();
            for (String key : new String[] {"name", "description", "metaInfo"}) {
                Object value = info.opt(key);
                if (value instanceof String) {
                    hashInfo.put(key, value);
                }
            }
            // A forceBoot activation is the brick-rescue path: mark it in the
            // persisted info so JS can report force_boot_rescue when this
            // version survives to markSuccess. Only the server-sent directive
            // counts — a silent-strategy activation is ordinary delivery.
            JSONObject infoConfig = info.optJSONObject("config");
            if (infoConfig != null && infoConfig.optBoolean("forceBoot", false)) {
                hashInfo.put("forceBootRescue", true);
            }
            if (crashRescueActive) {
                hashInfo.put("crashRescue", true);
            }
            hashInfoJson = hashInfo.toString();
        }
        // Silent strategies or a server-marked forceBoot version (per-version
        // remote override — the brick rescue) activate for the next launch;
        // otherwise activation stays with the JS side. Unless a crash is
        // being held: JS is dead, deferring to it would leave the fix on
        // disk forever (§11.3).
        boolean activate = decision.optBoolean("activate", false) || crashRescueActive;
        boolean committed;
        try {
            committed = context.commitNativeCheckResult(
                resetGeneration,
                hash,
                hashInfoJson,
                activate,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
        } catch (Exception e) {
            Log.w(UpdateContext.TAG, "native check: commit failed: " + e);
            return;
        }
        if (!committed) {
            Log.i(UpdateContext.TAG, "native check: reset during round, dropping result");
        } else if (activate) {
            unactivatedHash = null;
            Log.i(UpdateContext.TAG,
                "native check: downloaded " + hash + " and set for next launch");
        } else {
            // Remembered so a crash later in this process can still activate
            // it (activatePendingVersion) — JS never will.
            unactivatedGeneration = resetGeneration;
            unactivatedHash = hash;
            Log.i(UpdateContext.TAG,
                "native check: downloaded " + hash + ", activation left to JS");
        }
    }

    private static String buildResponseCacheJson(
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
        return cacheEntry.toString();
    }

    private static final OkHttpClient httpClient = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build();

    private static String httpRequest(String url, String postBody, long deadlineNanos) {
        try {
            Request.Builder builder =
                new Request.Builder().url(url).header("Accept", "application/json");
            if (postBody != null) {
                builder.post(RequestBody.create(
                    postBody, MediaType.parse("application/json; charset=utf-8")));
            }
            OkHttpClient client = httpClient;
            if (deadlineNanos > 0) {
                // Crash-rescue budget: never let a single request outlive the
                // handler's hold window.
                long remainingMillis = TimeUnit.NANOSECONDS.toMillis(
                    deadlineNanos - System.nanoTime());
                if (remainingMillis <= 0) {
                    return null;
                }
                if (remainingMillis < 15000) {
                    client = httpClient.newBuilder()
                        .callTimeout(remainingMillis, TimeUnit.MILLISECONDS)
                        .build();
                }
            }
            try (Response response = client.newCall(builder.build()).execute()) {
                // Same rule as the artifact download: an https endpoint that
                // redirects to plaintext http is a failed endpoint.
                DownloadTask.rejectProtocolDowngrade(url, response);
                if (!response.isSuccessful() || response.body() == null) {
                    return null;
                }
                return response.body().string();
            }
        } catch (Exception e) {
            return null;
        }
    }

    // Shared schema rule (update_flow_core::IsValidCheckResponse): a 200 with
    // `{"error": ...}` is a failed endpoint, not a verdict, and must not stop
    // the endpoint fallback.
    private static boolean isValidCheckResponse(String responseText) {
        return responseText != null && NativeUpdateFlow.isValidCheckResponse(responseText);
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
    private static String runCheckRequest(
        JSONObject config, String appKey, String body, long deadlineNanos
    ) {
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
            String response = httpRequest(
                base + "/checkUpdate/" + appKey, body, deadlineNanos);
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
            String listText = httpRequest(listUrl, null, deadlineNanos);
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
                String response = httpRequest(
                    base + "/checkUpdate/" + appKey, body, deadlineNanos);
                if (isValidCheckResponse(response)) {
                    return response;
                }
            }
            // One successfully fetched remote list is enough.
            break;
        }
        return null;
    }

    private static long capToRescueBudget(long phaseDeadlineNanos, long rescueDeadlineNanos) {
        if (rescueDeadlineNanos <= 0) {
            return phaseDeadlineNanos;
        }
        return Math.min(phaseDeadlineNanos, rescueDeadlineNanos);
    }

    private static boolean performAttempts(
        UpdateContext context, JSONArray attempts, String hash, String originHash,
        long rescueDeadlineNanos
    ) {
        if (attempts == null) {
            return false;
        }
        final long incrementalDeadlineNanos = capToRescueBudget(
            System.nanoTime() + TimeUnit.SECONDS.toNanos(DOWNLOAD_PHASE_TIMEOUT_SECONDS),
            rescueDeadlineNanos);
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
                fullDeadlineNanos = capToRescueBudget(
                    System.nanoTime()
                        + TimeUnit.SECONDS.toNanos(DOWNLOAD_PHASE_TIMEOUT_SECONDS),
                    rescueDeadlineNanos);
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
