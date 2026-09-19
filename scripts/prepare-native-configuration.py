from pathlib import Path

pending = {}
def change(path, old, new, count=1):
    text = pending.get(path, Path(path).read_text())
    found = text.count(old)
    if found != count:
        raise RuntimeError(f'{path}: expected {count}, found {found}: {old[:100]!r}')
    pending[path] = text.replace(old, new)

A = 'android/src/main/java/cn/reactnative/modules/update/'
H = 'harmony/pushy/src/main/ets/'
I = 'ios/RCTPushy/'

change(A+'PushyNativeUpdate.java', 'import android.util.Log;\n', 'import android.util.Log;\nimport androidx.annotation.Nullable;\nimport org.json.JSONObject;\n')
change(A+'PushyNativeUpdate.java', '/** Native host API. Configuration remains owned and persisted by the JS SDK. */', '/** Bridge-free native configuration and update APIs. */')
change(A+'PushyNativeUpdate.java', '    private PushyNativeUpdate() {\n', '''    public interface ConfigurationCallback {
        /** Main thread; null means configuration was persisted successfully. */
        void onComplete(@Nullable Exception error);
    }

    // Configuration must not wait behind a network round that it invalidates.
    private static final Executor CONFIG_WORKER = Executors.newSingleThreadExecutor(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "pushy-host-config");
            thread.setDaemon(true);
            return thread;
        }
    });

    /**
     * Validate and persist a complete configuration, even before JS or bundle
     * resolution. This starts no network work and never resolves a bundle.
     * Await the callback before continuing startup/checkAndUpdate. Unless JS
     * uses nativeConfigSource: 'native', later JS config writes can replace it.
     */
    public static void configure(Context context, JSONObject options, final ConfigurationCallback callback) {
        if (context == null || options == null || callback == null) {
            throw new IllegalArgumentException("context, options and callback are required");
        }
        final Context applicationContext = context.getApplicationContext();
        // Snapshot caller-owned JSON before dispatch, not minutes later on a worker.
        final String snapshot = options.toString();
        CONFIG_WORKER.execute(new Runnable() {
            @Override
            public void run() {
                Exception failure = null;
                try {
                    String config = NativeUpdateConfig.normalize(snapshot);
                    UpdateContext.getInstance(applicationContext).setNativeConfig(config);
                } catch (Exception e) {
                    failure = e;
                } catch (LinkageError e) {
                    failure = new IllegalStateException("Native configuration failed", e);
                }
                final Exception error = failure;
                new Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override
                    public void run() {
                        callback.onComplete(error);
                    }
                });
            }
        });
    }

    private PushyNativeUpdate() {
''')
change(A+'UpdateContext.java', '    static long getResetGeneration() {\n', '''    /** Shared by JS and native hosts. Config replacement invalidates old native decisions. */
    void setNativeConfig(String config) {
        synchronized (commitLock) {
            if (config.equals(sp.getString(NativeCheckOrchestrator.KEY_CONFIG, null))) {
                return;
            }
            // Also invalidate on a failed persistence attempt: never allow an
            // older round to commit over uncertain configuration state.
            resetGeneration.incrementAndGet();
            SharedPreferences.Editor editor = sp.edit();
            editor.putString(NativeCheckOrchestrator.KEY_CONFIG, config);
            editor.remove(NativeCheckOrchestrator.KEY_RESP_CACHE);
            NativeCheckOrchestrator.markJsCheckCompleted(null);
            persistEditorOrThrow(editor, "configure native update");
        }
        NativeCheckOrchestrator.onConfigured(this);
    }

    // Native-decision generation: bumped by reset AND configuration replacement.
    static long getResetGeneration() {
''')
change(A+'UpdateModuleImpl.java', 'updateContext.setKv(NativeCheckOrchestrator.KEY_CONFIG, config);', 'updateContext.setNativeConfig(config);')
change(A+'NativeCheckOrchestrator.java', '        startRound(0);\n        roundDone.await();', '''        startRound(0);
        if (!roundStarted.get()) {
            return NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "config_changed");
        }
        roundDone.await();''')
change(A+'NativeCheckOrchestrator.java', '''        if (roundGeneration != UpdateContext.getResetGeneration()) {
            return NativeUpdateResult.of(NativeUpdateResult.CANCELLED, "reset");
        }
        if (!configJson.equals(roundConfigJson) || !configJson.equals(context.getKv(KEY_CONFIG))) {
            return NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "config_changed");
        }''', '''        if (!configJson.equals(roundConfigJson) || !configJson.equals(context.getKv(KEY_CONFIG))) {
            return NativeUpdateResult.of(NativeUpdateResult.CANCELLED, "config_changed");
        }
        if (roundGeneration != UpdateContext.getResetGeneration()) {
            return NativeUpdateResult.of(NativeUpdateResult.CANCELLED, "reset");
        }''')
change(A+'NativeCheckOrchestrator.java', '    private static void startRound(long deadlineNanos) {\n', '''    private static boolean hasRunnableConfig(UpdateContext context) {
        if (context == null) {
            return false;
        }
        try {
            String json = context.getKv(KEY_CONFIG);
            if (json == null) {
                return false;
            }
            JSONObject config = new JSONObject(json);
            return !config.optBoolean("disabled", false)
                && config.opt("appKey") instanceof String
                && !config.getString("appKey").trim().isEmpty();
        } catch (JSONException e) {
            return false;
        }
    }

    static void onConfigured(UpdateContext context) {
        if (nativeReady && sContext == context && hasRunnableConfig(context)) {
            CrashRescue.install();
        }
    }

    private static void startRound(long deadlineNanos) {
        // An automatic check before first-run provisioning must not consume
        // the process's only round. Hosts may configure later in this launch.
        if (!hasRunnableConfig(sContext)) {
            return;
        }
''')
change(A+'NativeCheckOrchestrator.java', '        if (!roundCompleted) {\n', '        if (roundStarted.get() && !roundCompleted) {\n')

change(I+'RCTPushy.h', 'typedef void (^RCTPushyNativeUpdateCompletion)', 'typedef void (^RCTPushyNativeConfigurationCompletion)(NSError * _Nullable error);\n\ntypedef void (^RCTPushyNativeUpdateCompletion)')
change(I+'RCTPushy.h', '+ (NSURL *)bundleURL;\n', '''+ (NSURL *)bundleURL;

/** Validate and persist native options without JS, network work or bundle resolution.
 * Completion is on the main queue; nil error means success. Call before the
 * normal launch bundle resolution for first-install native-only provisioning.
 */
+ (void)configure:(NSDictionary<NSString *, id> * _Nonnull)options
       completion:(RCTPushyNativeConfigurationCompletion _Nullable)completion
    NS_SWIFT_NAME(configure(_:completion:));
''')
change(I+'RCTPushy.mm', '#import "RCTPushy.h"\n', '#import "RCTPushy.h"\n#import "RCTPushyNativeConfig.h"\n')
change(I+'RCTPushy.mm', '@interface RCTPushyOrchestrator : NSObject\n', '@interface RCTPushyOrchestrator : NSObject\n+ (void)persistConfiguration:(NSString *)config;\n+ (BOOL)hasRunnableConfig;\n')
change(I+'RCTPushy.mm', '+ (void)checkAndUpdateWithCompletion:(RCTPushyNativeUpdateCompletion)completion\n', '''+ (void)configure:(NSDictionary<NSString *, id> *)options
       completion:(RCTPushyNativeConfigurationCompletion)completion
{
    NSError *validationError = nil;
    // Snapshot nested mutable caller values before crossing a queue boundary.
    NSString *config = RCTPushyNormalizeNativeConfig(options, &validationError);
    static dispatch_queue_t configQueue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        configQueue = dispatch_queue_create("cn.reactnative.pushy.host-config", DISPATCH_QUEUE_SERIAL);
    });
    dispatch_async(configQueue, ^{
        NSError *failure = validationError;
        if (config != nil) {
            @try {
                [RCTPushyOrchestrator persistConfiguration:config];
            } @catch (NSException *exception) {
                failure = PushyErrorWithCode(pushy::error_codes::kFileOperationFailed,
                    exception.reason ?: @"Native configuration failed");
            }
        }
        if (completion != nil) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(failure);
            });
        }
    });
}

+ (void)checkAndUpdateWithCompletion:(RCTPushyNativeUpdateCompletion)completion
''')
change(I+'RCTPushy.mm', '    [PushyDefaults() setObject:config forKey:keyNativeConfig];\n    resolve(@true);', '''    @try {
        [RCTPushyOrchestrator persistConfiguration:config];
        resolve(@true);
    } @catch (NSException *exception) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kFileOperationFailed,
            exception.reason ?: @"Native configuration failed"));
    }''')
change(I+'RCTPushy.mm', '@implementation RCTPushyOrchestrator\n', '''@implementation RCTPushyOrchestrator

+ (void)persistConfiguration:(NSString *)config {
    PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();
        if ([[defaults stringForKey:keyNativeConfig] isEqualToString:config]) {
            return;
        }
        // The same generation protects reset and replacement of the request
        // identity/policy, including a late crash-rescue activation.
        pushyResetGeneration.fetch_add(1);
        [defaults setObject:config forKey:keyNativeConfig];
        [defaults removeObjectForKey:keyNativeCheckCache];
        [self markJsCheckCompleted:nil];
    });
    if (pushyNativeCheckReady.load() && [self hasRunnableConfig]) {
        PushyInstallCrashRescueHandler();
    }
}

+ (BOOL)hasRunnableConfig {
    NSString *json = [PushyDefaults() stringForKey:keyNativeConfig];
    if (json.length == 0) {
        return NO;
    }
    bool ok = false;
    flowjson::Value config = flowjson::Parse(PushyToStdString(json), &ok);
    return ok && config.IsObject() && !config.Get("disabled").Truthy()
        && !config.Get("appKey").AsString().empty();
}
''')
change(I+'RCTPushy.mm', '    dispatch_group_wait(pushyHostRoundGroup, DISPATCH_TIME_FOREVER);\n', '''    if (!pushyRoundStarted.load()) {
        return PushyHostResult(@"skipped", @"config_changed", nil, NO);
    }
    dispatch_group_wait(pushyHostRoundGroup, DISPATCH_TIME_FOREVER);
''')
change(I+'RCTPushy.mm', '''    if (pushyHostRoundGeneration != pushyResetGeneration.load()) {
        return PushyHostResult(@"cancelled", @"reset", nil, NO);
    }
    if (![configJson isEqualToString:pushyHostRoundConfig]
        || ![configJson isEqualToString:[PushyDefaults() stringForKey:keyNativeConfig]]) {
        return PushyHostResult(@"skipped", @"config_changed", nil, NO);
    }''', '''    if (![configJson isEqualToString:pushyHostRoundConfig]
        || ![configJson isEqualToString:[PushyDefaults() stringForKey:keyNativeConfig]]) {
        return PushyHostResult(@"cancelled", @"config_changed", nil, NO);
    }
    if (pushyHostRoundGeneration != pushyResetGeneration.load()) {
        return PushyHostResult(@"cancelled", @"reset", nil, NO);
    }''')
change(I+'RCTPushy.mm', '+ (void)startRoundWithDeadline:(NSTimeInterval)deadlineUptime {\n', '''+ (void)startRoundWithDeadline:(NSTimeInterval)deadlineUptime {
    // Missing/disabled configuration is a preflight skip, not a used round.
    if (![self hasRunnableConfig]) {
        return;
    }
''')
change(I+'RCTPushy.mm', '    if (!pushyRoundCompleted.load()) {\n', '    if (pushyRoundStarted.load() && !pushyRoundCompleted.load()) {\n')

change(H+'UpdateContext.ts', '  KEY_RESP_CACHE,\n  scheduleNativeCheck,', '  KEY_CONFIG,\n  KEY_RESP_CACHE,\n  markJsCheckCompleted,\n  scheduleNativeCheck,')
change(H+'UpdateContext.ts', '  public setKv(key: string, value: string): Promise<void> {\n', '''  /** Shared JS/native configuration writer; all mutations precede the first await. */
  public setNativeConfig(config: string): Promise<void> {
    if (this.getKv(KEY_CONFIG) !== config) {
      // Also guards A -> B -> A replacements and late download commits.
      UpdateContext.resetGeneration += 1;
      this.preferences.putSync(KEY_CONFIG, config);
      this.preferences.deleteSync(KEY_RESP_CACHE);
      markJsCheckCompleted('');
    }
    // Flush even an equal value so a retry after a storage error can succeed.
    return this.flushPreferences('configure native update');
  }

  public setKv(key: string, value: string): Promise<void> {
''')
change(H+'PushyTurboModule.ts', 'await this.context.setKv(KEY_CONFIG, config);', 'await this.context.setNativeConfig(config);')
change(H+'PushyFileJSBundleProvider.ets', "import type { NativeUpdateResult } from './NativeUpdateResult';\n", "import type { NativeUpdateResult } from './NativeUpdateResult';\nimport { normalizeNativeUpdateConfig } from './NativeUpdateConfig';\nimport type { NativeUpdateConfig } from './NativeUpdateConfig';\n")
change(H+'PushyFileJSBundleProvider.ets', '  /** Call after the host\'s real bundle resolution; never resolves it again. */\n', '''  /** Configure before normal bundle resolution; no JS or network work is required. */
  async configure(options: NativeUpdateConfig): Promise<void> {
    const config = normalizeNativeUpdateConfig(options);
    await this.updateContext.setNativeConfig(config);
  }

  /** Call after the host's real bundle resolution; never resolves it again. */
''')
change('harmony/pushy/index.ets', "export type { NativeUpdateResult } from './src/main/ets/NativeUpdateResult';\n", "export type { NativeUpdateResult } from './src/main/ets/NativeUpdateResult';\nexport type { NativeUpdateConfig } from './src/main/ets/NativeUpdateConfig';\n")
change(H+'NativeCheckOrchestrator.ts', '''  return hostRound.run(async () => {
''', '''  const preflight = configurationError(context);
  if (preflight !== undefined) {
    return Promise.resolve(preflight);
  }
  return hostRound.run(async () => {
''')
change(H+'NativeCheckOrchestrator.ts', 'export async function checkAndUpdateNative(\n', '''// A preflight skip must not consume the process's only round: configuration
// may arrive after the delayed startup timer on a first-ever launch.
function configurationError(context: UpdateContext): NativeUpdateResult | undefined {
  const json = context.getKv(KEY_CONFIG);
  if (!json) {
    return nativeUpdateResult('skipped', 'not_configured');
  }
  try {
    const config = JSON.parse(json) as NativeConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return nativeUpdateResult('failed', 'invalid_config');
    }
    if (config.disabled) {
      return nativeUpdateResult('skipped', 'disabled');
    }
    if (typeof config.appKey !== 'string' || config.appKey.trim().length === 0) {
      return nativeUpdateResult('failed', 'invalid_config');
    }
  } catch (e) {
    return nativeUpdateResult('failed', 'invalid_config');
  }
  return undefined;
}

export async function checkAndUpdateNative(
''')
change(H+'NativeCheckOrchestrator.ts', '''  if (roundGeneration !== context.getResetGeneration()) {
    return nativeUpdateResult('cancelled', 'reset');
  }
  if (configJson !== roundConfigJson || configJson !== context.getKv(KEY_CONFIG)) {
    return nativeUpdateResult('skipped', 'config_changed');
  }''', '''  if (configJson !== roundConfigJson || configJson !== context.getKv(KEY_CONFIG)) {
    return nativeUpdateResult('cancelled', 'config_changed');
  }
  if (roundGeneration !== context.getResetGeneration()) {
    return nativeUpdateResult('cancelled', 'reset');
  }''')

change('src/type.ts', '  disableNativeCheck?: boolean;\n', '''  disableNativeCheck?: boolean;
  /**
   * Owner of persisted native update configuration. Default: 'javascript'.
   * Use 'native' when configure() is called by the host: JS will not overwrite
   * that configuration. This does not configure or disable JS checks itself;
   * keep appKey/server consistent and use checkStrategy to control JS checks.
   */
  nativeConfigSource?: 'javascript' | 'native';
''')
change('src/client.ts', '  private flushNativeConfig = () => {\n', '''  private flushNativeConfig = () => {
    if (this.options.nativeConfigSource === 'native') {
      this.pendingNativeConfigJson = undefined;
      return;
    }
''')
change('src/client.ts', '  private syncNativeConfig = () => {\n', '''  private syncNativeConfig = () => {
    if (this.options.nativeConfigSource === 'native') {
      this.pendingNativeConfigJson = undefined;
      return;
    }
''')
change('src/NativePushy.ts', '''   * single config source — a native side without persisted config silently
   * skips its check, which doubles as the feature's rollout gate.''', '''   * default config source. Native hosts may also call configure(); select
   * nativeConfigSource: 'native' in JS to leave host configuration untouched.
   * A native side without persisted config skips its check.''')

for path, content in pending.items():
    Path(path).write_text(content)
print('Integrated native configuration across', len(pending), 'files')
