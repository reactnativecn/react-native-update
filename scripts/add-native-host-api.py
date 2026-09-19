from pathlib import Path

ROOT = Path.cwd()
PENDING = []

def replace(text, old, new):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'Expected one match, found {count}: {old[:100]!r}')
    return text.replace(old, new, 1)

def region(text, start, end, transform):
    a = text.index(start)
    b = text.index(end, a + len(start))
    return text[:a] + transform(text[a:b]) + text[b:]

def edit(path, transform):
    target = ROOT / path
    before = target.read_text()
    after = transform(before)
    if before == after:
        raise RuntimeError(f'No changes: {path}')
    PENDING.append((target, after))

A = 'android/src/main/java/cn/reactnative/modules/update/NativeCheckOrchestrator.java'
I = 'ios/RCTPushy/RCTPushy.mm'
H = 'harmony/pushy/src/main/ets/NativeCheckOrchestrator.ts'

ANDROID_HOST = '''    /** Blocking only on the host API's worker; never call on the UI thread. */
    static NativeUpdateResult checkAndUpdate(UpdateContext context) throws InterruptedException {
        if (UpdateContext.DEBUG) {
            return NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "debug");
        }
        if (!nativeReady || sContext != context || !context.getIsUsingBundleUrl()) {
            return NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "not_initialized");
        }
        String configJson = context.getKv(KEY_CONFIG);
        if (configJson == null || configJson.isEmpty()) {
            return NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "not_configured");
        }
        try {
            JSONObject config = new JSONObject(configJson);
            if (config.optBoolean("disabled", false)) {
                return NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "disabled");
            }
            if (config.optString("appKey", "").isEmpty()) {
                return NativeUpdateResult.of(NativeUpdateResult.FAILED, "invalid_config");
            }
        } catch (JSONException e) {
            return NativeUpdateResult.of(NativeUpdateResult.FAILED, "invalid_config");
        }
        startRound(0);
        roundDone.await();
        if (roundGeneration != UpdateContext.getResetGeneration()) {
            return NativeUpdateResult.of(NativeUpdateResult.CANCELLED, "reset");
        }
        if (!configJson.equals(roundConfigJson) || !configJson.equals(context.getKv(KEY_CONFIG))) {
            return NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "config_changed");
        }
        return roundResult;
    }

'''

ANDROID_ONCE = '''    private static void runOnce(
        UpdateContext context,
        String launchRolledBackVersion,
        long deadlineNanos
    ) throws JSONException {
        final long resetGeneration = UpdateContext.getResetGeneration();
        roundGeneration = resetGeneration;
        roundResult = NativeUpdateResult.of(NativeUpdateResult.FAILED, "check_failed");
        String configJson = context.getKv(KEY_CONFIG);
        roundConfigJson = configJson;
        if (configJson == null || configJson.isEmpty()) {
            roundResult = NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "not_configured");
            return;
        }
        JSONObject config;
        try {
            config = new JSONObject(configJson);
        } catch (JSONException e) {
            roundResult = NativeUpdateResult.of(NativeUpdateResult.FAILED, "invalid_config");
            return;
        }
        if (config.optBoolean("disabled", false)) {
            roundResult = NativeUpdateResult.of(NativeUpdateResult.SKIPPED, "disabled");
            return;
        }
        String appKey = config.optString("appKey", "");
        if (appKey.isEmpty()) {
            roundResult = NativeUpdateResult.of(NativeUpdateResult.FAILED, "invalid_config");
            return;
        }
        // Keep the existing interrupted-round breadcrumb and reset generation.
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

'''

def android_configured(s):
    s = replace(s, 'if (body == null) {\n            return;', 'if (body == null) {\n            roundResult = NativeUpdateResult.of(NativeUpdateResult.FAILED, "invalid_request");\n            return;')
    s = replace(s, 'if (decisionJson == null) {\n            return;', 'if (decisionJson == null) {\n            roundResult = NativeUpdateResult.of(NativeUpdateResult.FAILED, "invalid_response");\n            return;')
    s = replace(s, '''            context.commitNativeCheckResult(
                resetGeneration, null, null, false,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
            Log.i(UpdateContext.TAG,
                "native check: nothing to do (" + decision.optString("reason") + ")");''', '''            boolean committed = context.commitNativeCheckResult(
                resetGeneration, null, null, false,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
            roundResult = committed
                ? NativeUpdateResult.of(NativeUpdateResult.NO_UPDATE, decision.optString("reason"))
                : NativeUpdateResult.of(NativeUpdateResult.CANCELLED, "reset");
            Log.i(UpdateContext.TAG,
                "native check: nothing to do (" + decision.optString("reason") + ")");''')
    s = replace(s, '''if (!UpdateFileUtils.isSafePathComponent(hash)) {
            return;''', '''if (!UpdateFileUtils.isSafePathComponent(hash)) {
            roundResult = NativeUpdateResult.of(NativeUpdateResult.FAILED, "invalid_response");
            return;''')
    s = replace(s, '''            context.commitNativeCheckResult(
                resetGeneration, null, null, false,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
            return;''', '''            boolean committed = context.commitNativeCheckResult(
                resetGeneration, null, null, false,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
            roundResult = NativeUpdateResult.of(
                committed ? NativeUpdateResult.FAILED : NativeUpdateResult.CANCELLED,
                committed ? "download_failed" : "reset");
            return;''')
    s = replace(s, 'Log.w(UpdateContext.TAG, "native check: commit failed: " + e);\n            return;', 'Log.w(UpdateContext.TAG, "native check: commit failed: " + e);\n            roundResult = NativeUpdateResult.of(NativeUpdateResult.FAILED, "commit_failed");\n            return;')
    s = replace(s, '''                "native check: downloaded " + hash + ", activation left to JS");
        }
    }
''', '''                "native check: downloaded " + hash + ", activation left to JS");
        }
        roundResult = committed
            ? NativeUpdateResult.downloaded(hash, activate)
            : NativeUpdateResult.of(NativeUpdateResult.CANCELLED, "reset");
    }
''')
    return s

def android(s):
    s = replace(s, '    private static volatile String sJsCompletedConfig;\n', '''    private static volatile String sJsCompletedConfig;
    // Published after the launch rollback snapshot, before host calls are accepted.
    private static volatile boolean nativeReady;
    private static volatile NativeUpdateResult roundResult =
        NativeUpdateResult.of(NativeUpdateResult.FAILED, "check_failed");
    private static volatile long roundGeneration = -1;
    private static volatile String roundConfigJson;

''' + ANDROID_HOST)
    s = replace(s, '        sLaunchRolledBackVersion = launchRolledBackVersion;\n', '        sLaunchRolledBackVersion = launchRolledBackVersion;\n        nativeReady = true;\n')
    s = region(s, '    private static void startRound(', '    static void runRescue(', lambda t: replace(t,
        '            Log.w(UpdateContext.TAG, "native check failed: " + e);',
        '            Log.w(UpdateContext.TAG, "native check failed: " + e);\n            roundResult = NativeUpdateResult.of(NativeUpdateResult.FAILED, "internal_error");'))
    s = region(s, '    private static void runOnce(', '    private static void runConfiguredRound(', lambda _: ANDROID_ONCE)
    return region(s, '    private static void runConfiguredRound(', '    private static String buildResponseCacheJson(', android_configured)

IOS_HOST = '''+ (NSDictionary *)checkAndUpdate {
#if DEBUG
    return PushyHostResult(@"skipped", @"debug", nil, NO);
#else
    if (!pushyNativeCheckReady.load()) {
        return PushyHostResult(@"skipped", @"not_initialized", nil, NO);
    }
    NSString *configJson = [PushyDefaults() stringForKey:keyNativeConfig];
    if (configJson.length == 0) {
        return PushyHostResult(@"skipped", @"not_configured", nil, NO);
    }
    id config = [NSJSONSerialization JSONObjectWithData:
        [configJson dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![config isKindOfClass:NSDictionary.class]) {
        return PushyHostResult(@"failed", @"invalid_config", nil, NO);
    }
    id disabled = config[@"disabled"];
    if ([disabled respondsToSelector:@selector(boolValue)] && [disabled boolValue]) {
        return PushyHostResult(@"skipped", @"disabled", nil, NO);
    }
    id appKey = config[@"appKey"];
    if (![appKey isKindOfClass:NSString.class] || [appKey length] == 0) {
        return PushyHostResult(@"failed", @"invalid_config", nil, NO);
    }
    [self startRoundWithDeadline:0];
    // A group is broadcast-style. Sharing the rescue semaphore would let one
    // waiter consume the only signal and leave the other waiting forever.
    dispatch_group_wait(pushyHostRoundGroup, DISPATCH_TIME_FOREVER);
    if (pushyHostRoundGeneration != pushyResetGeneration.load()) {
        return PushyHostResult(@"cancelled", @"reset", nil, NO);
    }
    if (![configJson isEqualToString:pushyHostRoundConfig]
        || ![configJson isEqualToString:[PushyDefaults() stringForKey:keyNativeConfig]]) {
        return PushyHostResult(@"skipped", @"config_changed", nil, NO);
    }
    return pushyHostRoundResult ?: PushyHostResult(@"failed", @"internal_error", nil, NO);
#endif
}

'''

IOS_PUBLIC = '''+ (void)checkAndUpdateWithCompletion:(RCTPushyNativeUpdateCompletion)completion
{
    static dispatch_queue_t hostQueue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        hostQueue = dispatch_queue_create("cn.reactnative.pushy.host-check", DISPATCH_QUEUE_SERIAL);
    });
    dispatch_async(hostQueue, ^{
        NSDictionary *result;
        @try {
            result = [RCTPushyOrchestrator checkAndUpdate];
        } @catch (NSException *exception) {
            RCTLogWarn(@"RCTPushy -- native host check failed: %@", exception.reason);
            result = PushyHostResult(@"failed", @"internal_error", nil, NO);
        }
        if (completion != nil) {
            NSDictionary *snapshot = [result copy];
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(snapshot);
            });
        }
    });
}

'''

IOS_ONCE = '''+ (void)runOnce:(NSString *)launchRolledBackVersion deadline:(NSTimeInterval)deadlineUptime {
    const uint64_t resetGeneration = pushyResetGeneration.load();
    pushyHostRoundGeneration = resetGeneration;
    pushyHostRoundResult = PushyHostResult(@"failed", @"check_failed", nil, NO);
    NSUserDefaults *defaults = PushyDefaults();
    NSString *configJson = [defaults stringForKey:keyNativeConfig];
    pushyHostRoundConfig = [configJson copy];
    if (configJson.length == 0) {
        pushyHostRoundResult = PushyHostResult(@"skipped", @"not_configured", nil, NO);
        return;
    }
    bool ok = false;
    flowjson::Value config = flowjson::Parse(PushyToStdString(configJson), &ok);
    if (!ok || !config.IsObject()) {
        pushyHostRoundResult = PushyHostResult(@"failed", @"invalid_config", nil, NO);
        return;
    }
    if (config.Get("disabled").Truthy()) {
        pushyHostRoundResult = PushyHostResult(@"skipped", @"disabled", nil, NO);
        return;
    }
    NSString *appKey = PushyFromStdString(config.Get("appKey").AsString());
    if (appKey.length == 0) {
        pushyHostRoundResult = PushyHostResult(@"failed", @"invalid_config", nil, NO);
        return;
    }
    // Preserve the interrupted-round breadcrumb and reset-safe atomic commit.
    [defaults setObject:@YES forKey:keyNativeCheckIncomplete];
    @try {
        [self runConfiguredRound:config
                      configJson:configJson
                          appKey:appKey
        launchRolledBackVersion:launchRolledBackVersion
                 resetGeneration:resetGeneration
                        deadline:deadlineUptime];
    } @finally {
        [defaults removeObjectForKey:keyNativeCheckIncomplete];
    }
}

'''

def ios_configured(s):
    s = replace(s, 'RCTLogWarn(@"RCTPushy -- native check: request body is not valid UTF-8");\n        return;', 'RCTLogWarn(@"RCTPushy -- native check: request body is not valid UTF-8");\n        pushyHostRoundResult = PushyHostResult(@"failed", @"invalid_request", nil, NO);\n        return;')
    s = replace(s, '''        [self commitRoundWithGeneration:resetGeneration
                               hashInfo:nil
                               activate:nil
                           responseText:responseText
                                request:body
                                 config:configJson
                             responseAt:responseAtSeconds];
        RCTLogInfo(@"RCTPushy -- native check: nothing to do (%s)",''', '''        BOOL committed = [self commitRoundWithGeneration:resetGeneration
                               hashInfo:nil
                               activate:nil
                           responseText:responseText
                                request:body
                                 config:configJson
                             responseAt:responseAtSeconds];
        pushyHostRoundResult = committed
            ? PushyHostResult(@"noUpdate", PushyFromStdString(decision.Get("reason").AsString()), nil, NO)
            : PushyHostResult(@"cancelled", @"reset", nil, NO);
        RCTLogInfo(@"RCTPushy -- native check: nothing to do (%s)",''')
    s = replace(s, 'if (!PushyIsSafePathComponent(hash)) {\n        return;', 'if (!PushyIsSafePathComponent(hash)) {\n        pushyHostRoundResult = PushyHostResult(@"failed", @"invalid_response", nil, NO);\n        return;')
    s = replace(s, '''        [self commitRoundWithGeneration:resetGeneration
                               hashInfo:nil
                               activate:nil
                           responseText:responseText
                                request:body
                                 config:configJson
                             responseAt:responseAtSeconds];
        return;''', '''        BOOL committed = [self commitRoundWithGeneration:resetGeneration
                               hashInfo:nil
                               activate:nil
                           responseText:responseText
                                request:body
                                 config:configJson
                             responseAt:responseAtSeconds];
        pushyHostRoundResult = committed
            ? PushyHostResult(@"failed", @"download_failed", nil, NO)
            : PushyHostResult(@"cancelled", @"reset", nil, NO);
        return;''')
    s = replace(s, '''        RCTLogInfo(@"RCTPushy -- native check: downloaded %@, activation left to JS", hash);
    }
}
''', '''        RCTLogInfo(@"RCTPushy -- native check: downloaded %@, activation left to JS", hash);
    }
    pushyHostRoundResult = committed
        ? PushyHostResult(@"downloaded", @"", hash, activate)
        : PushyHostResult(@"cancelled", @"reset", nil, NO);
}
''')
    return s

def ios(s):
    s = replace(s, '#include <sys/stat.h>\n', '''#include <sys/stat.h>

// Immutable host-facing snapshot; activated always means NEXT launch.
static NSDictionary *PushyHostResult(NSString *status, NSString *reason,
                                    NSString *hash, BOOL activated) {
    return @{@"status": status, @"reason": reason ?: @"",
             @"hash": hash ?: @"", @"activated": @(activated)};
}
''')
    s = replace(s, '@interface RCTPushyOrchestrator : NSObject\n', '@interface RCTPushyOrchestrator : NSObject\n+ (NSDictionary *)checkAndUpdate;\n')
    s = replace(s, 'static NSString *pushyJsCompletedConfig = nil;\n', '''static NSString *pushyJsCompletedConfig = nil;
// The group supplements (rather than consumes) the crash-rescue semaphore.
static dispatch_group_t pushyHostRoundGroup;
static std::atomic<bool> pushyNativeCheckReady{false};
static NSDictionary *pushyHostRoundResult = nil;
static NSString *pushyHostRoundConfig = nil;
static uint64_t pushyHostRoundGeneration = 0;
''')
    s = replace(s, '+ (BOOL)requiresMainQueueSetup\n', IOS_PUBLIC + '+ (BOOL)requiresMainQueueSetup\n')
    s = replace(s, '        pushyRoundDone = dispatch_semaphore_create(0);\n', '        pushyRoundDone = dispatch_semaphore_create(0);\n        pushyHostRoundGroup = dispatch_group_create();\n        dispatch_group_enter(pushyHostRoundGroup);\n')
    s = replace(s, '        pushyLaunchRolledBackForRescue = [launchRolledBackVersion copy];\n', '        pushyLaunchRolledBackForRescue = [launchRolledBackVersion copy];\n        pushyNativeCheckReady.store(true);\n')
    s = replace(s, '+ (void)markJsCheckCompleted:(NSString *)config {\n', IOS_HOST + '+ (void)markJsCheckCompleted:(NSString *)config {\n')
    s = region(s, '+ (void)startRoundWithDeadline:(NSTimeInterval)deadlineUptime {', '+ (void)runRescueWithDeadline:(NSTimeInterval)deadlineUptime {', lambda t: replace(replace(t,
        '        RCTLogWarn(@"RCTPushy -- native check crashed: %@", exception.reason);',
        '        RCTLogWarn(@"RCTPushy -- native check crashed: %@", exception.reason);\n        pushyHostRoundResult = PushyHostResult(@"failed", @"internal_error", nil, NO);'),
        '        dispatch_semaphore_signal(pushyRoundDone);',
        '        dispatch_semaphore_signal(pushyRoundDone);\n        dispatch_group_leave(pushyHostRoundGroup);'))
    s = region(s, '+ (void)runOnce:(NSString *)launchRolledBackVersion deadline:(NSTimeInterval)deadlineUptime {', '+ (void)runConfiguredRound:', lambda _: IOS_ONCE)
    return region(s, '+ (void)runConfiguredRound:', '+ (BOOL)commitRoundWithGeneration:(uint64_t)generation\n', ios_configured)

HARMONY_HOST = '''// The host and delayed check use one promise, including its settled result.
const hostRound = new NativeUpdateRound();
let scheduledContext: UpdateContext | undefined;
let scheduledRollback = '';
let roundGeneration = -1;
let roundConfigJson: string | undefined;
let roundResult = nativeUpdateResult('failed', 'check_failed');

function startNativeRound(
  context: UpdateContext,
  launchRolledBackVersion: string,
): Promise<NativeUpdateResult> {
  return hostRound.run(async () => {
    try {
      await runOnce(context, launchRolledBackVersion);
    } catch (e) {
      logger.error(TAG, `native check failed: ${getErrorMessage(e)}`);
      roundResult = nativeUpdateResult('failed', 'internal_error');
    }
    return roundResult;
  });
}

export async function checkAndUpdateNative(
  context: UpdateContext,
): Promise<NativeUpdateResult> {
  if (scheduledContext !== context) {
    return nativeUpdateResult('skipped', 'not_initialized');
  }
  const configJson = context.getKv(KEY_CONFIG);
  if (!configJson) {
    return nativeUpdateResult('skipped', 'not_configured');
  }
  try {
    const config = JSON.parse(configJson) as NativeConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return nativeUpdateResult('failed', 'invalid_config');
    }
    if (config.disabled) {
      return nativeUpdateResult('skipped', 'disabled');
    }
    if (typeof config.appKey !== 'string' || !config.appKey) {
      return nativeUpdateResult('failed', 'invalid_config');
    }
  } catch (e) {
    return nativeUpdateResult('failed', 'invalid_config');
  }
  const result = await startNativeRound(context, scheduledRollback);
  if (roundGeneration !== context.getResetGeneration()) {
    return nativeUpdateResult('cancelled', 'reset');
  }
  if (configJson !== roundConfigJson || configJson !== context.getKv(KEY_CONFIG)) {
    return nativeUpdateResult('skipped', 'config_changed');
  }
  // Do not let a caller mutate the cached result observed by later callers.
  return nativeUpdateResult(result.status, result.reason, result.hash, result.activated);
}

'''

def harmony_once(s):
    s = replace(s, '  const resetGeneration = context.getResetGeneration();\n  const configJson = context.getKv(KEY_CONFIG);', '''  const resetGeneration = context.getResetGeneration();
  roundGeneration = resetGeneration;
  roundResult = nativeUpdateResult('failed', 'check_failed');
  const configJson = context.getKv(KEY_CONFIG);
  roundConfigJson = configJson;''')
    s = replace(s, '    // 无落盘配置(老接入/首启):静默不跑——这就是灰度开关。\n    return;', "    // No persisted configuration: report the rollout gate to native callers.\n    roundResult = nativeUpdateResult('skipped', 'not_configured');\n    return;")
    s = replace(s, '''    config = JSON.parse(configJson) as NativeConfig;
  } catch (e) {
    return;''', '''    config = JSON.parse(configJson) as NativeConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      roundResult = nativeUpdateResult('failed', 'invalid_config');
      return;
    }
  } catch (e) {
    roundResult = nativeUpdateResult('failed', 'invalid_config');
    return;''')
    s = replace(s, '  if (config.disabled) {\n    return;', "  if (config.disabled) {\n    roundResult = nativeUpdateResult('skipped', 'disabled');\n    return;")
    s = replace(s, '  if (!appKey) {\n    return;', "  if (!appKey) {\n    roundResult = nativeUpdateResult('failed', 'invalid_config');\n    return;")
    return s

def harmony_configured(s):
    s = replace(s, '  if (!body) {\n    return;', "  if (!body) {\n    roundResult = nativeUpdateResult('failed', 'invalid_request');\n    return;")
    s = replace(s, '  if (!decisionJson) {\n    return;', "  if (!decisionJson) {\n    roundResult = nativeUpdateResult('failed', 'invalid_response');\n    return;")
    old = '''    await context.commitNativeCheckResult(
      resetGeneration,
      '',
      '',
      false,
      buildResponseCacheJson(configJson, body, responseText, responseAtSeconds),
    );'''
    a = s.index("  if (decision.action !== 'download') {")
    b = s.index("  const hash = decision.hash ?? '';", a)
    piece = replace(s[a:b], old, old.replace('    await context.', '    const committed = await context.') + "\n    roundResult = committed\n      ? nativeUpdateResult('noUpdate', decision.reason ?? '')\n      : nativeUpdateResult('cancelled', 'reset');")
    s = s[:a] + piece + s[b:]
    s = replace(s, "    logger.warn(TAG, 'decision carries an unsafe hash, ignoring');\n    return;", "    logger.warn(TAG, 'decision carries an unsafe hash, ignoring');\n    roundResult = nativeUpdateResult('failed', 'invalid_response');\n    return;")
    s = replace(s, old, old.replace('    await context.', '    const committed = await context.') + "\n    roundResult = committed\n      ? nativeUpdateResult('failed', 'download_failed')\n      : nativeUpdateResult('cancelled', 'reset');")
    s = replace(s, '    logger.error(TAG, `commit failed: ${getErrorMessage(e)}`);\n    return;', "    logger.error(TAG, `commit failed: ${getErrorMessage(e)}`);\n    roundResult = nativeUpdateResult('failed', 'commit_failed');\n    return;")
    s = replace(s, '''    logger.info(TAG, `downloaded ${hash}, activation left to JS`);
  }
}
''', '''    logger.info(TAG, `downloaded ${hash}, activation left to JS`);
  }
  roundResult = committed
    ? nativeUpdateResult('downloaded', '', hash, activate)
    : nativeUpdateResult('cancelled', 'reset');
}
''')
    return s

def harmony(s):
    s = replace(s, "import type { UpdateContext } from './UpdateContext';\n", "import type { UpdateContext } from './UpdateContext';\nimport { NativeUpdateRound, nativeUpdateResult } from './NativeUpdateResult';\nimport type { NativeUpdateResult } from './NativeUpdateResult';\n")
    s = replace(s, 'let scheduled = false;\n', 'let scheduled = false;\n' + HARMONY_HOST)
    s = replace(s, '  scheduled = true;\n', '  scheduled = true;\n  scheduledContext = context;\n  scheduledRollback = launchRolledBackVersion;\n')
    s = replace(s, '    runOnce(context, launchRolledBackVersion).catch', '    startNativeRound(context, launchRolledBackVersion).catch')
    s = region(s, 'async function runOnce(', '// 配置端点全为 https 时', harmony_once)
    return region(s, 'async function runConfiguredRound(', 'function buildResponseCacheJson(', harmony_configured)

edit(A, android)
edit(I, ios)
edit(H, harmony)
provider = 'harmony/pushy/src/main/ets/PushyFileJSBundleProvider.ets'
edit(provider, lambda s: replace(replace(s,
    "import { UpdateContext } from './UpdateContext';\n",
    "import { UpdateContext } from './UpdateContext';\nimport { checkAndUpdateNative } from './NativeCheckOrchestrator';\nimport type { NativeUpdateResult } from './NativeUpdateResult';\n"),
    '  getAppKeys(): string[] {\n', '''  /** Call after the host's real bundle resolution; never resolves it again. */
  checkAndUpdate(): Promise<NativeUpdateResult> {
    return checkAndUpdateNative(this.updateContext);
  }

  getAppKeys(): string[] {
'''))
edit('harmony/pushy/index.ets', lambda s: s + "export type { NativeUpdateResult } from './src/main/ets/NativeUpdateResult';\n")
for target, content in PENDING:
    target.write_text(content)
print('Applied native host API changes to Android, iOS and Harmony.')
