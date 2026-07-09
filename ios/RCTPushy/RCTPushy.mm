#import "RCTPushy.h"
#import "RCTPushyDownloader.h"
#import "ZipArchive.h"
#include "../../cpp/patch_core/archive_patch_core.h"
#include "../../cpp/patch_core/hbc_transform_wire.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/patch_core.h"
#include "../../cpp/patch_core/state_core.h"

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
    for (NSString *to in copies) {
        NSString *from = copies[to];
        if (from.length <= 0) {
            from = to;
        }
        manifest.copies.push_back(pushy::patch::CopyOperation{
            PushyToStdString(from),
            PushyToStdString(to),
        });
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
- (void)unzipFileAtPath:(NSString *)path
          toDestination:(NSString *)destination
      completionHandler:(void (^)(NSError *error))completionHandler;
@end

@implementation RCTPushy {
    dispatch_queue_t _fileQueue;
    bool hasListeners;
}

RCT_EXPORT_MODULE(RCTPushy);

+ (NSURL *)bundleURL
{
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

    if (PushyStringIsBlank(updateUrl) || PushyStringIsBlank(hash)) {
        callback(PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }
    NSString *originHash = PushyOptionString(options, @"originHash");
    if (type == PushyTypePatchFromPpk && PushyStringIsBlank(originHash)) {
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
    if (PushyStringIsBlank(hash)) {
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

    return success;
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
