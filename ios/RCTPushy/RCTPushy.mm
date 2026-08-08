#import "RCTPushy.h"
#import "RCTPushyDownloader.h"
#import "ZipArchive.h"
#include "../../cpp/patch_core/archive_patch_core.h"
#include "../../cpp/patch_core/digest.h"
#include "../../cpp/patch_core/hbc_transform_wire.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/patch_core.h"
#include "../../cpp/patch_core/state_core.h"
#include "../../cpp/update_flow_core/flow_json.h"
#include "../../cpp/update_flow_core/update_flow_core.h"

#import <UIKit/UIKit.h>

#if __has_include("RCTReloadCommand.h")
#import "RCTReloadCommand.h"
#endif
#ifdef RCT_NEW_ARCH_ENABLED
#import "RCTPushySpec.h"
#endif

#import <React/RCTConvert.h>
#import <React/RCTLog.h>
#import <os/lock.h>

#include <atomic>

static NSString *const keyPushyInfo = @"REACTNATIVECN_PUSHY_INFO_KEY";
static NSString *const paramPackageVersion = @"packageVersion";
static NSString *const paramBuildTime = @"buildTime";
static NSString *const paramLastVersion = @"lastVersion";
static NSString *const paramCurrentVersion = @"currentVersion";
static NSString *const paramIsFirstTime = @"isFirstTime";
static NSString *const paramIsFirstLoadOk = @"isFirstLoadOK";
static NSString *const keyUuid = @"REACTNATIVECN_PUSHY_UUID";
static NSString *const keyHashInfo = @"REACTNATIVECN_PUSHY_HASH_";
static NSString *const keyFirstLoadMarked = @"REACTNATIVECN_PUSHY_FIRSTLOADMARKED_KEY";
static NSString *const keyRolledBackMarked = @"REACTNATIVECN_PUSHY_ROLLEDBACKMARKED_KEY";
static NSString *const KeyPackageUpdatedMarked = @"REACTNATIVECN_PUSHY_ISPACKAGEUPDATEDMARKED_KEY";
// bundleHash cache: "<cacheKey>|<sha256hex>" where cacheKey identifies the
// installed binary (packageVersion + embedded bundle size + mtime). Recomputed
// only when the key changes, i.e. once per install.
static NSString *const keyBundleHashCache = @"REACTNATIVECN_PUSHY_BUNDLEHASH_KEY";
// Raw JSON persisted by JS (syncNativeConfig) for the native cold-start
// update check; parsed on read by the orchestrator. Absent = check disabled.
static NSString *const keyNativeConfig = @"REACTNATIVECN_PUSHY_NATIVE_CONFIG_KEY";
// Raw response cache written by the native cold-start check for the JS side
// to reuse (§10.3): {"ts": <epoch seconds>, "body": <raw response>}.
static NSString *const keyNativeCheckCache = @"REACTNATIVECN_PUSHY_NATIVE_CHECK_RESP_KEY";
static NSString *const PushyErrorDomain = @"cn.reactnative.pushy";

// file def
static NSString * const BUNDLE_FILE_NAME = @"index.bundlejs";
static NSString * const SOURCE_PATCH_NAME = @"__diff.json";
static NSString * const BUNDLE_PATCH_NAME = @"index.bundlejs.patch";

// error def — messages are human-readable; the stable cross-platform codes
// live in cpp/patch_core/error_codes.h and travel in PushyErrorCodeKey.
static NSString * const ERROR_OPTIONS = @"options error";
static NSString * const ERROR_FILE_OPERATION = @"file operation error";
static NSString * const PushyErrorCodeKey = @"PushyErrorCode";

static NSString *PushyCode(const char *code) {
    return [NSString stringWithUTF8String:code];
}

// event def
static NSString * const EVENT_PROGRESS_DOWNLOAD = @"RCTPushyDownloadProgress";
static NSString * const PARAM_PROGRESS_HASH = @"hash";
static NSString * const PARAM_PROGRESS_RECEIVED = @"received";
static NSString * const PARAM_PROGRESS_TOTAL = @"total";


typedef NS_ENUM(NSInteger, PushyType) {
    PushyTypeFullDownload = 1,
    PushyTypePatchFromPackage = 2,
    PushyTypePatchFromPpk = 3,
    //TASK_TYPE_PLAIN_DOWNLOAD=4?
};

static std::atomic<bool> ignoreRollback{false};
// The version whose bundle this process actually loaded (resolved in
// +bundleURL). resetToPackagedBundle must not delete its directory: update
// assets (images/fonts) are read from it on demand at runtime, so wiping it
// under a silent (no-restart) reset would break every image the running app
// has not loaded yet. Guarded by the state lock.
static NSString *pushyLaunchVersion = nil;

// Serializes every read-modify-write of the persisted update state. The state
// machine itself is a pure function (state_core), but callers run on different
// threads (main thread bundleURL, module method queue, _fileQueue), so the
// read→transform→write sequence must be atomic to avoid e.g. markSuccess being
// overwritten by a concurrent bundleURL and the version being rolled back.
static os_unfair_lock pushyStateLock = OS_UNFAIR_LOCK_INIT;

static void PushyWithStateLock(void (NS_NOESCAPE ^block)(void)) {
    os_unfair_lock_lock(&pushyStateLock);
    block();
    os_unfair_lock_unlock(&pushyStateLock);
}

static std::string PushyToStdString(NSString *value) {
    if (value == nil) {
        return std::string();
    }
    return std::string([value UTF8String]);
}

static NSError *PushyNSErrorFromStatus(const pushy::patch::Status &status) {
    return [NSError errorWithDomain:PushyErrorDomain
                               code:-1
                           userInfo:@{
                               NSLocalizedDescriptionKey: [NSString stringWithUTF8String:status.message.c_str()],
                               PushyErrorCodeKey: PushyCode(pushy::error_codes::kPatchFailed),
                           }];
}

static NSUserDefaults *PushyDefaults(void) {
    return [NSUserDefaults standardUserDefaults];
}

static NSString *PushyFromStdString(const std::string &value) {
    if (value.empty()) {
        return nil;
    }
    return [NSString stringWithUTF8String:value.c_str()];
}

static void PushySetNullableString(NSUserDefaults *defaults, NSString *key, NSString *value) {
    if (value != nil) {
        [defaults setObject:value forKey:key];
    } else {
        [defaults removeObjectForKey:key];
    }
}

static NSString *PushyHashInfoKey(NSString *hash) {
    return [keyHashInfo stringByAppendingString:hash ?: @""];
}

static NSString *PushyOptionString(NSDictionary *options, NSString *key) {
    return [RCTConvert NSString:options[key]];
}

static BOOL PushyStringIsBlank(NSString *value) {
    if (value == nil || [value isKindOfClass:[NSNull class]]) {
        return YES;
    }
    return [[value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] == 0;
}

// Server-provided identifiers (hash/originHash) are used as child names under
// the download root; anything that could resolve outside of it (path
// separators, "..", ".") must be rejected before touching the filesystem.
static BOOL PushyIsSafePathComponent(NSString *value) {
    if (PushyStringIsBlank(value)) {
        return NO;
    }
    if ([value isEqualToString:@"."] || [value isEqualToString:@".."]) {
        return NO;
    }
    if ([value containsString:@"/"] || [value containsString:@"\\"]) {
        return NO;
    }
    if ([value rangeOfString:@"\0"].location != NSNotFound) {
        return NO;
    }
    return YES;
}

static void PushyRejectError(RCTPromiseRejectBlock reject, NSError *error) {
    // Prefer the stable cross-platform code (error_codes.h); fall back to the
    // numeric NSError code for system errors that were not classified.
    NSString *code = error.userInfo[PushyErrorCodeKey];
    if (code == nil) {
        code = [NSString stringWithFormat:@"%ld", (long)error.code];
    }
    reject(code, error.localizedDescription, error);
}

static NSError *PushyErrorWithCode(const char *code, NSString *message) {
    return [NSError errorWithDomain:PushyErrorDomain
                               code:-1
                           userInfo:@{
                               NSLocalizedDescriptionKey: message ?: @"unknown error",
                               PushyErrorCodeKey: PushyCode(code),
                           }];
}

static pushy::patch::PatchManifest PushyPatchManifestFromJson(NSDictionary *json) {
    pushy::patch::PatchManifest manifest;

    NSDictionary *copies = json[@"copies"];
    // Content checksum per copy target ("copiesCrc", pdiff manifests from
    // CLI >= 2.21.2). The patch core verifies the copy source against it and
    // fails the patch on mismatch, so the JS strategy chain falls back to the
    // full package instead of copying drifted bytes from a rebuilt binary.
    NSDictionary *copiesCrc = json[@"copiesCrc"];
    if (![copiesCrc isKindOfClass:[NSDictionary class]]) {
        copiesCrc = nil;
    }
    for (NSString *to in copies) {
        NSString *from = copies[to];
        if (from.length <= 0) {
            from = to;
        }
        pushy::patch::CopyOperation operation;
        operation.from = PushyToStdString(from);
        operation.to = PushyToStdString(to);
        NSNumber *expectedCrc = copiesCrc[to];
        if ([expectedCrc isKindOfClass:[NSNumber class]]) {
            operation.has_expected_crc = true;
            operation.expected_crc = (uint32_t)[expectedCrc unsignedLongLongValue];
        }
        manifest.copies.push_back(operation);
    }

    NSDictionary *deletes = json[@"deletes"];
    for (NSString *path in deletes) {
        manifest.deletes.push_back(PushyToStdString(path));
    }

    return manifest;
}

static pushy::state::State PushyStateFromDefaults(NSUserDefaults *defaults) {
    pushy::state::State state;
    state.package_version = PushyToStdString([defaults stringForKey:paramPackageVersion]);
    state.build_time = PushyToStdString([defaults stringForKey:paramBuildTime]);
    NSDictionary *pushyInfo = [defaults dictionaryForKey:keyPushyInfo];
    if (pushyInfo != nil) {
        state.current_version = PushyToStdString(pushyInfo[paramCurrentVersion]);
        state.last_version = PushyToStdString(pushyInfo[paramLastVersion]);
        state.first_time = [pushyInfo[paramIsFirstTime] boolValue];
        id firstLoadOk = pushyInfo[paramIsFirstLoadOk];
        state.first_time_ok = firstLoadOk == nil ? true : [firstLoadOk boolValue];
    }
    state.rolled_back_version = PushyToStdString([defaults stringForKey:keyRolledBackMarked]);
    return state;
}

static void PushyApplyStateToDefaults(NSUserDefaults *defaults, const pushy::state::State &state) {
    PushySetNullableString(defaults, paramPackageVersion, PushyFromStdString(state.package_version));
    PushySetNullableString(defaults, paramBuildTime, PushyFromStdString(state.build_time));

    BOOL hasPushyInfo = !state.current_version.empty() || !state.last_version.empty() || state.first_time || !state.first_time_ok;
    if (hasPushyInfo) {
        NSMutableDictionary *newInfo = [[NSMutableDictionary alloc] init];
        if (!state.current_version.empty()) {
            newInfo[paramCurrentVersion] = PushyFromStdString(state.current_version);
        }
        if (!state.last_version.empty()) {
            newInfo[paramLastVersion] = PushyFromStdString(state.last_version);
        }
        newInfo[paramIsFirstTime] = @(state.first_time);
        newInfo[paramIsFirstLoadOk] = @(state.first_time_ok);
        [defaults setObject:newInfo forKey:keyPushyInfo];
    } else {
        [defaults removeObjectForKey:keyPushyInfo];
    }

    PushySetNullableString(
        defaults,
        keyRolledBackMarked,
        PushyFromStdString(state.rolled_back_version));
}

@interface RCTPushy ()
- (void)downloadUpdate:(PushyType)type
               options:(NSDictionary *)options
              resolver:(RCTPromiseResolveBlock)resolve
              rejecter:(RCTPromiseRejectBlock)reject;
- (void)performUpdate:(PushyType)type
              options:(NSDictionary *)options
             callback:(void (^)(NSError *error))callback;
- (void)reloadBridgeWithReason:(NSString *)reason;
- (void)unzipDownloadedPackage:(NSString *)zipFilePath
                          hash:(NSString *)hash
                          type:(PushyType)type
                    originHash:(NSString *)originHash
                      callback:(void (^)(NSError *error))callback;
- (void)finishDownloadedPackage:(NSString *)hash
                           type:(PushyType)type
                     originHash:(NSString *)originHash
                       callback:(void (^)(NSError *error))callback;
- (void)applyPatchForHash:(NSString *)hash
                     type:(PushyType)type
               fromBundle:(NSString *)bundleOrigin
                   source:(NSString *)sourceOrigin
                 callback:(void (^)(NSError *error))callback;
- (BOOL)switchVersion:(NSString *)hash error:(NSError **)error;
- (BOOL)ensureDirectoryExistsAtPath:(NSString *)path;
+ (void)excludeFromBackup:(NSString *)path;
- (void)unzipFileAtPath:(NSString *)path
          toDestination:(NSString *)destination
      completionHandler:(void (^)(NSError *error))completionHandler;
+ (NSString *)downloadDir;
+ (NSURL *)binaryBundleURL;
+ (NSString *)packageVersion;
+ (NSString *)buildTime;
@end

// Native cold-start update check (NATIVE_CHECKUPDATE_DESIGN §10): runs once
// per process, a few seconds after launch, entirely independent of the app
// bundle — this is what lets a bricked hot update be replaced on the next
// launch. Decisions come from cpp/update_flow_core; this class is IO glue.
@interface RCTPushyOrchestrator : NSObject
+ (void)scheduleFromColdStart;
@end

// Shared by the getBundleHash RCT method and the native cold-start check.
// Returns @"" when unknown; blocking (sha256 of the embedded bundle on first
// call per install, cached afterwards) — call off the main thread.
static NSString *PushyBundleHashSync(void) {
    NSString *path = [[RCTPushy binaryBundleURL] path];
    if (path == nil) {
        return @"";
    }
    NSDictionary *attributes =
        [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    if (attributes == nil) {
        return @"";
    }
    NSString *cacheKey = [NSString stringWithFormat:@"%@|%llu|%.0f",
        [RCTPushy packageVersion],
        attributes.fileSize,
        [attributes.fileModificationDate timeIntervalSince1970]];

    NSUserDefaults *defaults = PushyDefaults();
    NSString *cached = [defaults stringForKey:keyBundleHashCache];
    NSString *cachedPrefix = [cacheKey stringByAppendingString:@"|"];
    if ([cached hasPrefix:cachedPrefix]) {
        return [cached substringFromIndex:cachedPrefix.length];
    }

    NSString *hash = PushyFromStdString(
        pushy::digest::Sha256File(PushyToStdString(path))) ?: @"";
    if (hash.length > 0) {
        [defaults setObject:[cachedPrefix stringByAppendingString:hash]
                     forKey:keyBundleHashCache];
    }
    return hash;
}

@implementation RCTPushy {
    dispatch_queue_t _fileQueue;
    bool hasListeners;
}

RCT_EXPORT_MODULE(RCTPushy);

+ (NSURL *)bundleURL
{
    // Integration guarantees bundleURL runs at every startup, which makes it
    // the natural anchor for the once-per-process native check. Cheap:
    // dispatch_once + a delayed dispatch, outside the state lock.
    [RCTPushyOrchestrator scheduleFromColdStart];

    __block NSURL *resolvedURL = nil;
    PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();

        NSString *curPackageVersion = [RCTPushy packageVersion];
        NSString *curBuildTime = [RCTPushy buildTime];

        pushy::state::State state = PushyStateFromDefaults(defaults);
        pushy::state::BinaryVersionSyncResult sync = pushy::state::SyncBinaryVersion(
            state,
            PushyToStdString(curPackageVersion),
            PushyToStdString(curBuildTime)
        );
        if (sync.changed) {
            [defaults setObject:@(YES) forKey:KeyPackageUpdatedMarked];
            state = sync.state;
            PushyApplyStateToDefaults(defaults, state);
        }

        if (!state.current_version.empty()) {
            std::string const versionBeforeLaunch = state.current_version;
            pushy::state::LaunchDecision decision = pushy::state::ResolveLaunchState(
                state,
                ignoreRollback.load(),
                true
            );
            state = decision.state;

            if (decision.did_rollback) {
                // The crash-protection rollback: the new version never called
                // markSuccess. Keep this visible in release logs.
                RCTLogWarn(@"RCTPushy -- version %@ was not marked as successful, rolled back to %@",
                    PushyFromStdString(versionBeforeLaunch),
                    PushyFromStdString(state.current_version));
            }
            if (decision.did_rollback || decision.consumed_first_time) {
                PushyApplyStateToDefaults(defaults, state);
            }
            if (decision.consumed_first_time) {
                // bundleURL may be called many times, ignore rollbacks before process restarted again.
                ignoreRollback = true;
                [defaults setObject:@(YES) forKey:keyFirstLoadMarked];
            }

            NSString *loadVersion = PushyFromStdString(decision.load_version);
            NSString *downloadDir = [RCTPushy downloadDir];
            // Guard the rollback chain against cycles: a corrupted state
            // returning an already-visited version would otherwise spin this
            // loop forever during startup (Android has the same guard).
            NSMutableSet<NSString *> *visitedVersions = [NSMutableSet set];
            while (loadVersion.length && ![visitedVersions containsObject:loadVersion]) {
                [visitedVersions addObject:loadVersion];
                NSString *bundlePath = [[downloadDir stringByAppendingPathComponent:loadVersion] stringByAppendingPathComponent:BUNDLE_FILE_NAME];
                if ([[NSFileManager defaultManager] fileExistsAtPath:bundlePath isDirectory:NULL]) {
                    pushyLaunchVersion = loadVersion;
                    resolvedURL = [NSURL fileURLWithPath:bundlePath];
                    return;
                } else {
                    RCTLogError(@"RCTPushy -- bundle version %@ not found, rolling back", loadVersion);
                    state = pushy::state::Rollback(state);
                    PushyApplyStateToDefaults(defaults, state);
                    loadVersion = PushyFromStdString(state.current_version);
                }
            }
        }
    });

    return resolvedURL ?: [RCTPushy binaryBundleURL];
}

+ (NSString *) rollback {
    __block NSString *currentVersion = nil;
    PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();
        pushy::state::State state = pushy::state::Rollback(PushyStateFromDefaults(defaults));
        PushyApplyStateToDefaults(defaults, state);
        currentVersion = PushyFromStdString(state.current_version);
    });
    return currentVersion;
}

+ (BOOL)requiresMainQueueSetup
{
    return NO;
}

- (NSDictionary *)constantsToExport
{
    NSMutableDictionary *ret = [NSMutableDictionary new];
    PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();

        ret[@"downloadRootDir"] = [RCTPushy downloadDir];
        ret[@"packageVersion"] = [RCTPushy packageVersion];
        ret[@"buildTime"] = [RCTPushy buildTime];
        ret[@"rolledBackVersion"] = [defaults objectForKey:keyRolledBackMarked];
        ret[@"isFirstTime"] = [defaults objectForKey:keyFirstLoadMarked];
        ret[@"uuid"] = [defaults objectForKey:keyUuid];
        // 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道),
        // JS 随 checkUpdate 以 diffV 上报,服务端按能力门控下发
        ret[@"supportedDiffVersion"] = @(pushy::hbc::kSupportedDiffVersion);
        NSDictionary *pushyInfo = [defaults dictionaryForKey:keyPushyInfo];
        NSString *currentVersion = [pushyInfo objectForKey:paramCurrentVersion];
        ret[@"currentVersion"] = currentVersion;
        if (currentVersion != nil) {
            ret[@"currentVersionInfo"] = [defaults objectForKey:PushyHashInfoKey(currentVersion)];
        }

        if (ret[@"isFirstTime"]) {
            [defaults removeObjectForKey:keyFirstLoadMarked];
        }

        if (ret[@"rolledBackVersion"] != nil) {
            [defaults removeObjectForKey:keyRolledBackMarked];
            [self clearInvalidFiles];
        }

        if ([[defaults objectForKey:KeyPackageUpdatedMarked] boolValue]) {
            [defaults removeObjectForKey:KeyPackageUpdatedMarked];
            [self clearInvalidFiles];
        }
    });

    return ret;
}

- (instancetype)init
{
    self = [super init];
    if (self) {
        // One process-wide serial queue, not per-instance: a bridge reload can
        // briefly keep two RCTPushy instances alive, and destructive file work
        // (resetToPackagedBundle's full cleanup) must stay serialized with the
        // other instance's unzip/patch jobs.
        static dispatch_queue_t sharedFileQueue;
        static dispatch_once_t onceToken;
        dispatch_once(&onceToken, ^{
            sharedFileQueue = dispatch_queue_create("cn.reactnative.pushy.file", DISPATCH_QUEUE_SERIAL);
        });
        _fileQueue = sharedFileQueue;
    }
    return self;
}

RCT_EXPORT_METHOD(setUuid:(NSString *)uuid  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (PushyStringIsBlank(uuid)) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }

    NSUserDefaults *defaults = PushyDefaults();
    [defaults setObject:uuid forKey:keyUuid];
    resolve(@true);
}

RCT_EXPORT_METHOD(syncNativeConfig:(NSString *)config
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    // Provisioning for the native cold-start check (NATIVE_CHECKUPDATE_DESIGN
    // §10.1). Validate at write time: a corrupt config would otherwise
    // silently disable the native check forever with no signal.
    if (PushyStringIsBlank(config)) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }
    NSData *data = [config dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    id object = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (![object isKindOfClass:[NSDictionary class]]) {
        PushyRejectError(reject, PushyErrorWithCode(
            pushy::error_codes::kInvalidOptions,
            error != nil ? error.localizedDescription : ERROR_OPTIONS));
        return;
    }
    [PushyDefaults() setObject:config forKey:keyNativeConfig];
    resolve(@true);
}

RCT_EXPORT_METHOD(getNativeCheckCache:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    resolve([PushyDefaults() stringForKey:keyNativeCheckCache] ?: @"");
}

RCT_EXPORT_METHOD(setLocalHashInfo:(NSString *)hash
                  value:(NSString *)value resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (PushyStringIsBlank(hash) || PushyStringIsBlank(value)) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }

    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (object && [object isKindOfClass:[NSDictionary class]]) {
        NSUserDefaults *defaults = PushyDefaults();
        [defaults setObject:value forKey:PushyHashInfoKey(hash)];
        
        resolve(@true);
    } else {
        PushyRejectError(reject, PushyErrorWithCode(
            pushy::error_codes::kInvalidHashInfo,
            error != nil ? error.localizedDescription : @"invalid json string"));
    }
}


RCT_EXPORT_METHOD(getLocalHashInfo:(NSString *)hash
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    
    NSUserDefaults *defaults = PushyDefaults();
    resolve([defaults stringForKey:PushyHashInfoKey(hash)]);
}

RCT_EXPORT_METHOD(downloadFullUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self downloadUpdate:PushyTypeFullDownload options:options resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(downloadPatchFromPackage:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self downloadUpdate:PushyTypePatchFromPackage options:options resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(downloadPatchFromPpk:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self downloadUpdate:PushyTypePatchFromPpk options:options resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(downloadAndInstallApk:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    PushyRejectError(reject, PushyErrorWithCode(
        pushy::error_codes::kUnsupportedPlatform,
        @"downloadAndInstallApk is only supported on Android"));
}

RCT_EXPORT_METHOD(setNeedUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSError *error = nil;
    if (![self switchVersion:PushyOptionString(options, @"hash") error:&error]) {
        PushyRejectError(reject, error);
        return;
    }

    resolve(@true);
}

RCT_EXPORT_METHOD(reloadUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSError *error = nil;
    if (![self switchVersion:PushyOptionString(options, @"hash") error:&error]) {
        PushyRejectError(reject, error);
        return;
    }

    [self reloadBridgeWithReason:@"pushy reloadUpdate"];
    resolve(@true);
}

RCT_EXPORT_METHOD(restartApp:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self reloadBridgeWithReason:@"pushy restartApp"];
    resolve(@true);
}

RCT_EXPORT_METHOD(getBundleHash:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    // bundleHash = sha256 of the bundle embedded in the binary — the identity
    // of the binary itself, not of whatever hot update is currently running.
    // It must hash exactly the bytes pdiff patches from (binaryBundleURL, the
    // pdiff fromBundle). Lazily computed once per install, cached in defaults.
    // Never rejects: an empty string means "unknown" and the server falls back
    // to the buildTime heuristic.
#if DEBUG
    // Metro serves the bundle in debug; the embedded file (if any) is not what
    // is running. Mirrors the dev behaviour of buildTime.
    resolve(@"");
#else
    dispatch_async(_fileQueue, ^{
        resolve(PushyBundleHashSync());
    });
#endif
}

RCT_EXPORT_METHOD(markSuccess:(RCTPromiseResolveBlock)resolve
                                    rejecter:(RCTPromiseRejectBlock)reject)
{
    #if DEBUG
    resolve(@true);
    #else

    PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();
        pushy::state::MarkSuccessResult result =
            pushy::state::MarkSuccess(PushyStateFromDefaults(defaults));
        if (!result.stale_version_to_delete.empty()) {
            [defaults removeObjectForKey:PushyHashInfoKey(PushyFromStdString(result.stale_version_to_delete))];
        }
        PushyApplyStateToDefaults(defaults, result.state);
    });

    [self clearInvalidFiles];
    resolve(@true);
    #endif
}

RCT_EXPORT_METHOD(resetToPackagedBundle:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    // Reset to the bundle packaged in the binary: wipe the whole update state
    // (so the next launch resolves to the built-in bundle) and delete the
    // downloaded versions, keeping only the directory of the version this
    // process is running from (a silent reset must not break its on-demand
    // asset loads). Only the client uuid survives — it identifies the install
    // for gray release bucketing and must not change on reset.
    __block NSString *keepVersion = nil;
    PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();
        keepVersion = pushyLaunchVersion;

        // A default-constructed State is exactly the reset state (no current /
        // last version, first_time=false, first_time_ok=true); keep the binary
        // identity so the next launch does not re-trigger the package-updated
        // sync path.
        pushy::state::State state;
        state.package_version = PushyToStdString([RCTPushy packageVersion]);
        state.build_time = PushyToStdString([RCTPushy buildTime]);
        PushyApplyStateToDefaults(defaults, state);

        for (NSString *key in [defaults dictionaryRepresentation].allKeys) {
            if ([key hasPrefix:keyHashInfo]) {
                [defaults removeObjectForKey:key];
            }
        }
        [defaults removeObjectForKey:keyFirstLoadMarked];
        [defaults removeObjectForKey:KeyPackageUpdatedMarked];
        ignoreRollback = false;
    });

    dispatch_async(_fileQueue, ^{
        // maxAgeDays=0: remove every downloaded entry except the running
        // version's directory (cleaned up by the next regular cleanup).
        pushy::patch::Status status = pushy::patch::CleanupOldEntries(
            PushyToStdString([RCTPushy downloadDir]),
            PushyToStdString(keepVersion),
            "",
            0
        );
        if (!status.ok) {
            RCTLogWarn(@"Pushy reset cleanup error: %s", status.message.c_str());
        }
    });

    resolve(@true);
}



#pragma mark - private
- (NSArray<NSString *> *)supportedEvents
{
  return @[
      EVENT_PROGRESS_DOWNLOAD,
  ];
}

-(void)startObserving {
    hasListeners = YES;
}

-(void)stopObserving {
    hasListeners = NO;
}

- (void)downloadUpdate:(PushyType)type
               options:(NSDictionary *)options
              resolver:(RCTPromiseResolveBlock)resolve
              rejecter:(RCTPromiseRejectBlock)reject
{
    [self performUpdate:type options:options callback:^(NSError *error) {
        if (error != nil) {
            if (error.userInfo[PushyErrorCodeKey] == nil) {
                // Unclassified (system/network) errors from the download
                // pipeline; keep the original message.
                error = PushyErrorWithCode(pushy::error_codes::kDownloadFailed,
                                           error.localizedDescription);
            }
            PushyRejectError(reject, error);
            return;
        }
        resolve(nil);
    }];
}

- (void)reloadBridgeWithReason:(NSString *)reason
{
    dispatch_async(dispatch_get_main_queue(), ^{
        #if __has_include("RCTReloadCommand.h")
            RCTReloadCommandSetBundleURL([[self class] bundleURL]);
            RCTTriggerReloadCommandListeners(reason);
        #else
            [self.bridge reload];
        #endif
    });
}

- (void)performUpdate:(PushyType)type options:(NSDictionary *)options callback:(void (^)(NSError *error))callback
{
    NSString *updateUrl = PushyOptionString(options, @"updateUrl");
    NSString *hash = PushyOptionString(options, @"hash");

    if (PushyStringIsBlank(updateUrl) || !PushyIsSafePathComponent(hash)) {
        callback(PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }
    NSString *originHash = PushyOptionString(options, @"originHash");
    if (type == PushyTypePatchFromPpk && !PushyIsSafePathComponent(originHash)) {
        callback(PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }
    
    NSString *dir = [RCTPushy downloadDir];
    BOOL success = [self ensureDirectoryExistsAtPath:dir];
    if (!success) {
        callback(PushyErrorWithCode(pushy::error_codes::kFileOperationFailed, ERROR_FILE_OPERATION));
        return;
    }

    NSString *zipFilePath = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@%@",hash, [self zipExtension:type]]];

    // On failure, remove the partial version directory like Android/Harmony
    // do: a half-unzipped/half-patched dir leaks disk and could later be
    // mistaken for a complete version. hash is validated non-blank above, so
    // this can never resolve to the download root itself.
    NSString *unzipDir = [dir stringByAppendingPathComponent:hash];
    void (^completion)(NSError *) = ^(NSError *error) {
        if (error != nil) {
            dispatch_async(self->_fileQueue, ^{
                [[NSFileManager defaultManager] removeItemAtPath:unzipDir error:nil];
            });
        }
        callback(error);
    };

    RCTLogInfo(@"RCTPushy -- download file %@", updateUrl);
    [RCTPushyDownloader download:updateUrl savePath:zipFilePath progressHandler:^(long long receivedBytes, long long totalBytes) {
        if (self->hasListeners) {
            [self sendEventWithName:EVENT_PROGRESS_DOWNLOAD body:@{
                PARAM_PROGRESS_HASH:hash,
                PARAM_PROGRESS_RECEIVED:[NSNumber numberWithLongLong:receivedBytes],
                PARAM_PROGRESS_TOTAL:[NSNumber numberWithLongLong:totalBytes]
            }];
        }
    } completionHandler:^(NSString *path, NSError *error) {
        if (error != nil) {
            completion(error);
            return;
        }
        [self unzipDownloadedPackage:zipFilePath
                                hash:hash
                                type:type
                          originHash:originHash
                            callback:completion];
    }];
}

- (void)unzipDownloadedPackage:(NSString *)zipFilePath
                          hash:(NSString *)hash
                          type:(PushyType)type
                    originHash:(NSString *)originHash
                      callback:(void (^)(NSError *error))callback
{
    RCTLogInfo(@"RCTPushy -- unzip file %@", zipFilePath);
    NSString *unzipFilePath = [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
    [self unzipFileAtPath:zipFilePath
            toDestination:unzipFilePath
        completionHandler:^(NSError *error) {
        dispatch_async(self->_fileQueue, ^{
            if (error != nil) {
                callback(error);
                return;
            }
            [self finishDownloadedPackage:hash type:type originHash:originHash callback:callback];
        });
    }];
}

- (void)finishDownloadedPackage:(NSString *)hash
                           type:(PushyType)type
                     originHash:(NSString *)originHash
                       callback:(void (^)(NSError *error))callback
{
    switch (type) {
        case PushyTypePatchFromPackage:
            [self applyPatchForHash:hash
                               type:type
                         fromBundle:[[RCTPushy binaryBundleURL] path]
                             source:[[NSBundle mainBundle] resourcePath]
                           callback:callback];
            return;
        case PushyTypePatchFromPpk: {
            NSString *lastVersionDir = [[RCTPushy downloadDir] stringByAppendingPathComponent:originHash];
            [self applyPatchForHash:hash
                               type:type
                         fromBundle:[lastVersionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME]
                             source:lastVersionDir
                           callback:callback];
            return;
        }
        case PushyTypeFullDownload:
            callback(nil);
            return;
    }
}

- (void)applyPatchForHash:(NSString *)hash
                     type:(PushyType)type
               fromBundle:(NSString *)bundleOrigin
                   source:(NSString *)sourceOrigin
                 callback:(void (^)(NSError *error))callback
{
    NSString *unzipDir = [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
    NSString *sourcePatch = [unzipDir stringByAppendingPathComponent:SOURCE_PATCH_NAME];
    NSString *bundlePatch = [unzipDir stringByAppendingPathComponent:BUNDLE_PATCH_NAME];
    
    NSString *destination = [unzipDir stringByAppendingPathComponent:BUNDLE_FILE_NAME];
    NSData *data = [NSData dataWithContentsOfFile:sourcePatch];
    if (data == nil) {
        callback(PushyErrorWithCode(pushy::error_codes::kPatchFailed, @"missing patch manifest"));
        return;
    }

    NSError *error = nil;
    id jsonObject = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingAllowFragments error:&error];
    if (error != nil) {
        // Classify as a patch failure like the sibling manifest branches;
        // unclassified errors would otherwise be tagged DOWNLOAD_FAILED by the
        // downloadUpdate fallback even though the download itself succeeded.
        callback(PushyErrorWithCode(pushy::error_codes::kPatchFailed, error.localizedDescription));
        return;
    }
    if (![jsonObject isKindOfClass:[NSDictionary class]]) {
        callback(PushyErrorWithCode(pushy::error_codes::kPatchFailed, @"invalid patch manifest"));
        return;
    }
    NSDictionary *json = (NSDictionary *)jsonObject;

    std::vector<std::string> entryNames;
    if ([[NSFileManager defaultManager] fileExistsAtPath:sourcePatch isDirectory:NULL]) {
        entryNames.push_back(PushyToStdString(SOURCE_PATCH_NAME));
    }
    if ([[NSFileManager defaultManager] fileExistsAtPath:bundlePatch isDirectory:NULL]) {
        entryNames.push_back(PushyToStdString(BUNDLE_PATCH_NAME));
    }

    pushy::archive_patch::ArchivePatchPlan plan;
    pushy::patch::Status planStatus = pushy::archive_patch::BuildArchivePatchPlan(
        type == PushyTypePatchFromPackage
            ? pushy::archive_patch::ArchivePatchType::kPatchFromPackage
            : pushy::archive_patch::ArchivePatchType::kPatchFromPpk,
        PushyPatchManifestFromJson(json),
        entryNames,
        &plan
    );
    if (!planStatus.ok) {
        callback(PushyNSErrorFromStatus(planStatus));
        return;
    }

    pushy::patch::FileSourcePatchOptions options;
    pushy::patch::Status optionStatus = pushy::archive_patch::BuildFileSourcePatchOptions(
        plan,
        PushyToStdString(sourceOrigin),
        PushyToStdString(unzipDir),
        PushyToStdString(bundleOrigin),
        PushyToStdString(bundlePatch),
        PushyToStdString(destination),
        &options
    );
    if (!optionStatus.ok) {
        callback(PushyNSErrorFromStatus(optionStatus));
        return;
    }

    // __diff.json 的 hbcTransform 元数据(HBC 变换域 patch,hdiffv2 轨道):
    // 存在时透传给 patch 内核执行 T(origin) → hpatch → T⁻¹;缺失走现状路径。
    NSDictionary *hbcTransform = json[@"hbcTransform"];
    if ([hbcTransform isKindOfClass:[NSDictionary class]]) {
        NSDictionary *meta = hbcTransform[BUNDLE_PATCH_NAME];
        if ([meta isKindOfClass:[NSDictionary class]]) {
            NSError *metaError = nil;
            NSData *metaData = [NSJSONSerialization dataWithJSONObject:meta options:0 error:&metaError];
            if (metaData != nil && metaError == nil) {
                NSString *metaString = [[NSString alloc] initWithData:metaData encoding:NSUTF8StringEncoding];
                options.bundle_hbc_transform_meta = PushyToStdString(metaString);
            }
        }
    }

    pushy::patch::Status status = pushy::patch::ApplyPatchFromFileSource(options);
    if (!status.ok) {
        callback(PushyNSErrorFromStatus(status));
        return;
    }

    callback(nil);
}

- (BOOL)switchVersion:(NSString *)hash error:(NSError **)error
{
    if (!PushyIsSafePathComponent(hash)) {
        if (error != NULL) {
            *error = PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS);
        }
        return NO;
    }

    PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();
        pushy::state::State next = pushy::state::SwitchVersion(
            PushyStateFromDefaults(defaults),
            PushyToStdString(hash)
        );
        PushyApplyStateToDefaults(defaults, next);
        // Re-enable first-load consumption and rollback checks for the newly selected bundle.
        ignoreRollback = false;
    });
    return YES;
}

- (BOOL)ensureDirectoryExistsAtPath:(NSString *)path
{
    // No _fileQueue hop here: that queue also runs multi-second unzip/patch
    // work, and a dispatch_sync onto it would block the whole module method
    // queue for the duration. createDirectoryAtPath is idempotent and
    // thread-safe, so checking inline is fine.
    NSFileManager *fileManager = [NSFileManager defaultManager];
    BOOL isDirectory = NO;
    if ([fileManager fileExistsAtPath:path isDirectory:&isDirectory]) {
        if (isDirectory) {
            // Directories created by older versions never got the flag.
            [RCTPushy excludeFromBackup:path];
        }
        return isDirectory;
    }

    NSError *error = nil;
    BOOL success = [fileManager createDirectoryAtPath:path
                          withIntermediateDirectories:YES
                                           attributes:nil
                                                error:&error];
    if (!success && error != nil) {
        RCTLogWarn(@"Pushy create directory error: %@", error.localizedDescription);
    }
    if (success) {
        [RCTPushy excludeFromBackup:path];
    }

    return success;
}

// Everything under rctpushy is re-downloadable, and Application Support is
// backed up to iCloud by default — Apple requires such content to be
// excluded from backups.
+ (void)excludeFromBackup:(NSString *)path
{
    NSURL *url = [NSURL fileURLWithPath:path isDirectory:YES];
    NSError *error = nil;
    if (![url setResourceValue:@YES
                        forKey:NSURLIsExcludedFromBackupKey
                         error:&error]) {
        RCTLogWarn(@"Pushy exclude from backup error: %@", error.localizedDescription);
    }
}

- (void)unzipFileAtPath:(NSString *)path
          toDestination:(NSString *)destination
      completionHandler:(void (^)(NSError *error))completionHandler
{
    dispatch_async(_fileQueue, ^{
        NSFileManager *fileManager = [NSFileManager defaultManager];
        if ([fileManager fileExistsAtPath:destination]) {
            [fileManager removeItemAtPath:destination error:nil];
        }

        [SSZipArchive unzipFileAtPath:path
                        toDestination:destination
                      progressHandler:nil
                    completionHandler:^(NSString *archivePath, BOOL succeeded, NSError *error) {
            [fileManager removeItemAtPath:archivePath error:nil];
            if (completionHandler == nil) {
                return;
            }

            NSError *unzipError = error;
            if (!succeeded && unzipError == nil) {
                unzipError = PushyErrorWithCode(pushy::error_codes::kPatchFailed, @"unzip failed");
            } else if (unzipError != nil && unzipError.userInfo[PushyErrorCodeKey] == nil) {
                // SSZipArchive's own NSError (corrupt zip, bad magic, ...) has
                // no stable code; without one, downloadUpdate's fallback would
                // classify it as DOWNLOAD_FAILED even though the download
                // succeeded — keep the classification deterministic.
                unzipError = PushyErrorWithCode(pushy::error_codes::kPatchFailed,
                                                unzipError.localizedDescription ?: @"unzip failed");
            }
            completionHandler(unzipError);
        }];
    });
}

- (void)clearInvalidFiles
{
    dispatch_async(_fileQueue, ^{
        // Snapshot the state under the lock, but run the (slow) filesystem
        // cleanup outside of it so state operations are not blocked.
        __block pushy::state::State state;
        PushyWithStateLock(^{
            state = PushyStateFromDefaults(PushyDefaults());
        });
        NSString *downloadDir = [RCTPushy downloadDir];
        pushy::patch::Status status = pushy::patch::CleanupOldEntries(
            PushyToStdString(downloadDir),
            state.current_version,
            state.last_version,
            3
        );
        if (!status.ok) {
            RCTLogWarn(@"Pushy cleanup error: %s", status.message.c_str());
        }
    });
}

- (NSString *)zipExtension:(PushyType)type
{
    switch (type) {
        case PushyTypeFullDownload:
            return @".ppk";
        case PushyTypePatchFromPackage:
            return @".ipa.patch";
        case PushyTypePatchFromPpk:
            return @".ppk.patch";
        default:
            return @"";
    }
}

+ (NSString *)downloadDir
{
    NSString *directory = [NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES) firstObject];
    return [directory stringByAppendingPathComponent:@"rctpushy"];
}

+ (NSURL *)binaryBundleURL
{
    return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
}

+ (NSString *)packageVersion
{
    static NSString *version = nil;

    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSDictionary *infoDictionary = [[NSBundle mainBundle] infoDictionary];
        version = [infoDictionary objectForKey:@"CFBundleShortVersionString"];
    });
    return version;
}

+ (NSString *)buildTime
{
#if DEBUG
    return @"0";
#else
    static NSString *buildTime;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
      NSString *buildTimePath = [[NSBundle mainBundle] pathForResource:@"pushy_build_time" ofType:@"txt"];
      buildTime = [[NSString stringWithContentsOfFile:buildTimePath encoding:NSUTF8StringEncoding error:nil]
                 stringByTrimmingCharactersInSet:[NSCharacterSet newlineCharacterSet]];
    });
    return buildTime;
#endif
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativePushySpecJSI>(params);
}
#endif

@end

#pragma mark - native cold-start check orchestration

// Blocking JSON HTTP round-trip on the orchestrator's utility thread. Returns
// the response body on 2xx, nil on any failure. The semaphore timeout is a
// backstop over the request's own timeoutInterval.
static NSString *PushyHttpRequest(NSString *urlString, NSString *method,
                                  NSString *body, NSTimeInterval timeout) {
    NSURL *url = [NSURL URLWithString:urlString];
    if (url == nil) {
        return nil;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = method;
    request.timeoutInterval = timeout;
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    if (body != nil) {
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
        request.HTTPBody = [body dataUsingEncoding:NSUTF8StringEncoding];
    }
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSString *result = nil;
    [[[NSURLSession sharedSession] dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            NSInteger status = [(NSHTTPURLResponse *)response statusCode];
            if (error == nil && status >= 200 && status < 300 && data != nil) {
                result = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            }
            dispatch_semaphore_signal(sem);
        }] resume];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW,
                                               (int64_t)((timeout + 5) * NSEC_PER_SEC)));
    return result;
}

@implementation RCTPushyOrchestrator

+ (void)scheduleFromColdStart {
#if !DEBUG
    // Once per process; a few seconds of delay keeps the check away from the
    // cold-start critical path (§7 R5) — its result targets the NEXT launch.
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)),
                       dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            @try {
                [self runOnce];
            } @catch (NSException *exception) {
                // The rescue path must never take the app down with it.
                RCTLogWarn(@"RCTPushy -- native check crashed: %@", exception.reason);
            }
        });
    });
#endif
}

// A bare module instance drives the existing download/patch pipeline without
// a bridge: the file queue is process-global and progress events are gated on
// hasListeners (never set without a bridge).
+ (RCTPushy *)engine {
    static RCTPushy *engine;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        engine = [[RCTPushy alloc] init];
    });
    return engine;
}

+ (void)runOnce {
    NSUserDefaults *defaults = PushyDefaults();
    NSString *configJson = [defaults stringForKey:keyNativeConfig];
    if (configJson.length == 0) {
        // No persisted config (old integration / first ever launch): the
        // native check silently does not run — this is the rollout gate.
        return;
    }
    bool ok = false;
    flowjson::Value config = flowjson::Parse(PushyToStdString(configJson), &ok);
    if (!ok || !config.IsObject() || config.Get("disabled").Truthy()) {
        return;
    }
    NSString *appKey = PushyFromStdString(config.Get("appKey").AsString());
    if (appKey.length == 0) {
        return;
    }

    __block NSString *currentVersion = nil;
    __block NSString *rolledBackVersion = nil;
    PushyWithStateLock(^{
        pushy::state::State state = PushyStateFromDefaults(PushyDefaults());
        currentVersion = PushyFromStdString(state.current_version);
        rolledBackVersion = PushyFromStdString(state.rolled_back_version);
    });
    NSString *uuid = [defaults stringForKey:keyUuid] ?: @"";

    flowjson::Value identity = flowjson::Value::Object();
    identity.Set("packageVersion",
                 flowjson::Value::String(PushyToStdString([RCTPushy packageVersion])));
    if (currentVersion != nil) {
        identity.Set("currentVersion",
                     flowjson::Value::String(PushyToStdString(currentVersion)));
    }
    identity.Set("uuid", flowjson::Value::String(PushyToStdString(uuid)));
    if (rolledBackVersion != nil) {
        identity.Set("rolledBackVersion",
                     flowjson::Value::String(PushyToStdString(rolledBackVersion)));
    }

    flowjson::Value cInfo = flowjson::Value::Object();
    cInfo.Set("rnu", config.Get("rnu"));
    cInfo.Set("rn", config.Get("rn"));
    cInfo.Set("os", flowjson::Value::String(PushyToStdString([NSString
        stringWithFormat:@"ios %@", [[UIDevice currentDevice] systemVersion]])));
    cInfo.Set("uuid", flowjson::Value::String(PushyToStdString(uuid)));

    flowjson::Value input = flowjson::Value::Object();
    input.Set("packageVersion", identity.Get("packageVersion"));
    if (currentVersion != nil) {
        input.Set("currentVersion", identity.Get("currentVersion"));
    }
    input.Set("buildTime",
              flowjson::Value::String(PushyToStdString([RCTPushy buildTime])));
    input.Set("cInfo", cInfo);
    input.Set("supportedDiffVersion",
              flowjson::Value::Number(pushy::hbc::kSupportedDiffVersion));
    input.Set("bundleHash",
              flowjson::Value::String(PushyToStdString(PushyBundleHashSync())));

    std::string bodyJson =
        flowjson::Stringify(updateflow::BuildCheckRequestBody(input));
    NSString *body = [NSString stringWithUTF8String:bodyJson.c_str()];

    NSString *responseText = [self runCheckRequest:config appKey:appKey body:body];
    if (responseText == nil) {
        RCTLogInfo(@"RCTPushy -- native check: no endpoint reachable, giving up until next launch");
        return;
    }

    // Persist the raw response for the JS side to reuse (§10.3), regardless
    // of what the decision turns out to be.
    NSDictionary *cacheEntry = @{
        @"ts": @((long long)[[NSDate date] timeIntervalSince1970]),
        @"body": responseText,
    };
    NSData *cacheData = [NSJSONSerialization dataWithJSONObject:cacheEntry options:0 error:nil];
    if (cacheData != nil) {
        [defaults setObject:[[NSString alloc] initWithData:cacheData encoding:NSUTF8StringEncoding]
                     forKey:keyNativeCheckCache];
    }

    flowjson::Value decision = updateflow::HandleCheckResponse(
        PushyToStdString(responseText), identity, false,
        config.Get("afterDownload").AsString());
    if (decision.Get("action").AsString() != "download") {
        RCTLogInfo(@"RCTPushy -- native check: nothing to do (%s)",
                   decision.Get("reason").AsString().c_str());
        return;
    }
    NSString *hash = PushyFromStdString(decision.Get("hash").AsString());
    if (!PushyIsSafePathComponent(hash)) {
        return;
    }

    NSString *bundlePath = [[[RCTPushy downloadDir]
        stringByAppendingPathComponent:hash]
        stringByAppendingPathComponent:BUNDLE_FILE_NAME];
    BOOL downloaded = [[NSFileManager defaultManager] fileExistsAtPath:bundlePath];
    if (!downloaded) {
        downloaded = [self performAttempts:decision.Get("attempts")
                                      hash:hash
                                originHash:currentVersion];
    }
    if (!downloaded) {
        return;
    }

    // Persist name/description/metaInfo alongside the version, mirroring the
    // JS side's setLocalHashInfo after a successful download.
    const flowjson::Value &info = decision.Get("info");
    flowjson::Value hashInfo = flowjson::Value::Object();
    for (const char *key : {"name", "description", "metaInfo"}) {
        if (info.Get(key).IsString()) {
            hashInfo.Set(key, info.Get(key));
        }
    }
    [defaults setObject:[NSString stringWithUTF8String:flowjson::Stringify(hashInfo).c_str()]
                 forKey:PushyHashInfoKey(hash)];

    if (decision.Get("activate").Truthy()) {
        // Silent strategies or a server-marked forceBoot version (per-version
        // remote override — the brick rescue): activate for the next launch.
        // Otherwise activation stays with the JS side (§6/§10.1).
        NSError *error = nil;
        if ([[self engine] switchVersion:hash error:&error]) {
            RCTLogInfo(@"RCTPushy -- native check: downloaded %@ and set for next launch", hash);
        } else {
            RCTLogWarn(@"RCTPushy -- native check: switchVersion failed: %@",
                       error.localizedDescription);
        }
    } else {
        RCTLogInfo(@"RCTPushy -- native check: downloaded %@, activation left to JS", hash);
    }
}

// Sequential fallback over the ordered candidates (§5.1): one request at a
// time with its own timeout; after the configured round fails, queryUrls
// discovery merges remote candidates (excluding the already-tried) for one
// more round. No hedged race on purpose — this path is latency-insensitive.
+ (NSString *)runCheckRequest:(const flowjson::Value &)config
                       appKey:(NSString *)appKey
                         body:(NSString *)body {
    double sample = arc4random() / 4294967296.0;
    flowjson::Value ordered =
        updateflow::OrderEndpointCandidates(config.Get("endpoints"), sample);
    NSMutableSet<NSString *> *tried = [NSMutableSet set];
    for (const auto &endpoint : ordered.elements()) {
        NSString *base = PushyFromStdString(endpoint.AsString());
        if (base == nil) {
            continue;
        }
        [tried addObject:base];
        NSString *response = PushyHttpRequest(
            [NSString stringWithFormat:@"%@/checkUpdate/%@", base, appKey],
            @"POST", body, 10);
        if (response != nil) {
            return response;
        }
    }
    for (const auto &queryUrl : config.Get("queryUrls").elements()) {
        NSString *listUrl = PushyFromStdString(queryUrl.AsString());
        if (listUrl == nil) {
            continue;
        }
        NSString *listText = PushyHttpRequest(listUrl, @"GET", nil, 10);
        if (listText == nil) {
            continue;
        }
        bool ok = false;
        flowjson::Value remote = flowjson::Parse(PushyToStdString(listText), &ok);
        if (!ok || !remote.IsArray()) {
            continue;
        }
        for (const auto &endpoint : remote.elements()) {
            NSString *base = PushyFromStdString(endpoint.AsString());
            if (base == nil || [tried containsObject:base]) {
                continue;
            }
            [tried addObject:base];
            NSString *response = PushyHttpRequest(
                [NSString stringWithFormat:@"%@/checkUpdate/%@", base, appKey],
                @"POST", body, 10);
            if (response != nil) {
                return response;
            }
        }
        break;  // one successfully fetched remote list is enough
    }
    return nil;
}

+ (BOOL)performAttempts:(const flowjson::Value &)attempts
                   hash:(NSString *)hash
             originHash:(NSString *)originHash {
    RCTPushy *engine = [self engine];
    for (const auto &attempt : attempts.elements()) {
        const std::string &type = attempt.Get("type").AsString();
        PushyType pushyType = type == "diff" ? PushyTypePatchFromPpk
                            : type == "pdiff" ? PushyTypePatchFromPackage
                                              : PushyTypeFullDownload;
        if (pushyType == PushyTypePatchFromPpk && originHash.length == 0) {
            continue;  // diff patches from the running version; none running
        }
        for (const auto &urlValue : attempt.Get("urls").elements()) {
            NSString *url = PushyFromStdString(urlValue.AsString());
            if (url == nil) {
                continue;
            }
            NSMutableDictionary *options =
                [@{@"updateUrl": url, @"hash": hash} mutableCopy];
            if (pushyType == PushyTypePatchFromPpk) {
                options[@"originHash"] = originHash;
            }
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            __block NSError *resultError = nil;
            [engine performUpdate:pushyType options:options callback:^(NSError *error) {
                resultError = error;
                dispatch_semaphore_signal(sem);
            }];
            // Backstop only — the downloader and patch pipeline carry their
            // own timeouts/failures.
            if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW,
                    (int64_t)(600 * NSEC_PER_SEC))) != 0) {
                RCTLogWarn(@"RCTPushy -- native check: %s attempt timed out", type.c_str());
                return NO;
            }
            if (resultError == nil) {
                return YES;
            }
            RCTLogInfo(@"RCTPushy -- native check: %s attempt failed: %@",
                       type.c_str(), resultError.localizedDescription);
        }
    }
    return NO;
}

@end
