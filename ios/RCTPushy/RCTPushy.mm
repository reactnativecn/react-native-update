#import "RCTPushy.h"
#import "RCTPushyDownloader.h"
#import "ZipArchive.h"
#include "../../cpp/patch_core/archive_patch_core.h"
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

// error def
static NSString * const ERROR_OPTIONS = @"options error";
static NSString * const ERROR_FILE_OPERATION = @"file operation error";

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

static BOOL ignoreRollback = false;

static std::string PushyToStdString(NSString *value) {
    if (value == nil) {
        return std::string();
    }
    return std::string([value UTF8String]);
}

static NSError *PushyNSErrorFromStatus(const pushy::patch::Status &status) {
    return [NSError errorWithDomain:PushyErrorDomain
                               code:-1
                           userInfo:@{ NSLocalizedDescriptionKey: [NSString stringWithUTF8String:status.message.c_str()] }];
}

static NSUserDefaults *PushyDefaults(void) {
    return [NSUserDefaults standardUserDefaults];
}

static void PushyPersistDefaults(NSUserDefaults *defaults) {
    (void)defaults;
    CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication);
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
    reject([NSString stringWithFormat:@"%ld", (long)error.code], error.localizedDescription, error);
}

static NSError *PushyErrorWithMessage(NSString *message) {
    return [NSError errorWithDomain:PushyErrorDomain
                               code:-1
                           userInfo:@{
                               NSLocalizedDescriptionKey: message ?: @"unknown error",
                           }];
}

static void PushyRejectMessage(RCTPromiseRejectBlock reject, NSString *message) {
    PushyRejectError(reject, PushyErrorWithMessage(message));
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
    PushyPersistDefaults(defaults);
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
        pushy::state::LaunchDecision decision = pushy::state::ResolveLaunchState(
            state,
            ignoreRollback,
            true
        );
        state = decision.state;

        if (decision.did_rollback || decision.consumed_first_time) {
            PushyApplyStateToDefaults(defaults, state);
        }
        if (decision.consumed_first_time) {
            // bundleURL may be called many times, ignore rollbacks before process restarted again.
            ignoreRollback = true;
            [defaults setObject:@(YES) forKey:keyFirstLoadMarked];
            PushyPersistDefaults(defaults);
        }

        NSString *loadVersion = PushyFromStdString(decision.load_version);
        NSString *downloadDir = [RCTPushy downloadDir];
        while (loadVersion.length) {
            NSString *bundlePath = [[downloadDir stringByAppendingPathComponent:loadVersion] stringByAppendingPathComponent:BUNDLE_FILE_NAME];
            if ([[NSFileManager defaultManager] fileExistsAtPath:bundlePath isDirectory:NULL]) {
                NSURL *bundleURL = [NSURL fileURLWithPath:bundlePath];
                return bundleURL;
            } else {
                RCTLogError(@"RCTPushy -- bundle version %@ not found", loadVersion);
                state = pushy::state::Rollback(state);
                PushyApplyStateToDefaults(defaults, state);
                loadVersion = PushyFromStdString(state.current_version);
            }
        }
    }
    
    return [RCTPushy binaryBundleURL];
}

+ (NSString *) rollback {
    NSUserDefaults *defaults = PushyDefaults();
    pushy::state::State state = pushy::state::Rollback(PushyStateFromDefaults(defaults));
    PushyApplyStateToDefaults(defaults, state);
    return PushyFromStdString(state.current_version);
}

+ (BOOL)requiresMainQueueSetup
{
    return NO;
}

- (NSDictionary *)constantsToExport
{
    NSUserDefaults *defaults = PushyDefaults();
    
    NSMutableDictionary *ret = [NSMutableDictionary new];
    ret[@"downloadRootDir"] = [RCTPushy downloadDir];
    ret[@"packageVersion"] = [RCTPushy packageVersion];
    ret[@"buildTime"] = [RCTPushy buildTime];
    ret[@"rolledBackVersion"] = [defaults objectForKey:keyRolledBackMarked];
    ret[@"isFirstTime"] = [defaults objectForKey:keyFirstLoadMarked];
    ret[@"uuid"] = [defaults objectForKey:keyUuid];
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
    PushyPersistDefaults(defaults);

    return ret;
}

- (instancetype)init
{
    self = [super init];
    if (self) {
        _fileQueue = dispatch_queue_create("cn.reactnative.pushy.file", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

RCT_EXPORT_METHOD(setUuid:(NSString *)uuid  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (PushyStringIsBlank(uuid)) {
        PushyRejectError(reject, PushyErrorWithMessage(ERROR_OPTIONS));
        return;
    }

    NSUserDefaults *defaults = PushyDefaults();
    [defaults setObject:uuid forKey:keyUuid];
    PushyPersistDefaults(defaults);
    resolve(@true);
}

RCT_EXPORT_METHOD(setLocalHashInfo:(NSString *)hash
                  value:(NSString *)value resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (PushyStringIsBlank(hash) || PushyStringIsBlank(value)) {
        PushyRejectMessage(reject, ERROR_OPTIONS);
        return;
    }

    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (object && [object isKindOfClass:[NSDictionary class]]) {
        NSUserDefaults *defaults = PushyDefaults();
        [defaults setObject:value forKey:PushyHashInfoKey(hash)];
        PushyPersistDefaults(defaults);
        
        resolve(@true);
    } else {
        PushyRejectError(reject, error ?: PushyErrorWithMessage(@"json格式校验报错"));
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

    NSUserDefaults *defaults = PushyDefaults();
    pushy::state::MarkSuccessResult result =
        pushy::state::MarkSuccess(PushyStateFromDefaults(defaults));
    if (!result.stale_version_to_delete.empty()) {
        [defaults removeObjectForKey:PushyHashInfoKey(PushyFromStdString(result.stale_version_to_delete))];
    }
    PushyApplyStateToDefaults(defaults, result.state);

    [self clearInvalidFiles];
    resolve(@true);
    #endif
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
        callback(PushyErrorWithMessage(ERROR_OPTIONS));
        return;
    }
    NSString *originHash = PushyOptionString(options, @"originHash");
    if (type == PushyTypePatchFromPpk && PushyStringIsBlank(originHash)) {
        callback(PushyErrorWithMessage(ERROR_OPTIONS));
        return;
    }
    
    NSString *dir = [RCTPushy downloadDir];
    BOOL success = [self ensureDirectoryExistsAtPath:dir];
    if (!success) {
        callback(PushyErrorWithMessage(ERROR_FILE_OPERATION));
        return;
    }

    NSString *zipFilePath = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@%@",hash, [self zipExtension:type]]];

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
            callback(error);
            return;
        }
        [self unzipDownloadedPackage:zipFilePath
                                hash:hash
                                type:type
                          originHash:originHash
                            callback:callback];
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
        callback(PushyErrorWithMessage(@"missing patch manifest"));
        return;
    }

    NSError *error = nil;
    id jsonObject = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingAllowFragments error:&error];
    if (error != nil) {
        callback(error);
        return;
    }
    if (![jsonObject isKindOfClass:[NSDictionary class]]) {
        callback(PushyErrorWithMessage(@"invalid patch manifest"));
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
            *error = PushyErrorWithMessage(ERROR_OPTIONS);
        }
        return NO;
    }

    NSUserDefaults *defaults = PushyDefaults();
    pushy::state::State next = pushy::state::SwitchVersion(
        PushyStateFromDefaults(defaults),
        PushyToStdString(hash)
    );
    PushyApplyStateToDefaults(defaults, next);
    // Re-enable first-load consumption and rollback checks for the newly selected bundle.
    ignoreRollback = false;
    return YES;
}

- (BOOL)ensureDirectoryExistsAtPath:(NSString *)path
{
    __block BOOL success = NO;

    dispatch_sync(_fileQueue, ^{
        NSFileManager *fileManager = [NSFileManager defaultManager];
        BOOL isDirectory = NO;
        if ([fileManager fileExistsAtPath:path isDirectory:&isDirectory]) {
            success = isDirectory;
            return;
        }

        NSError *error = nil;
        success = [fileManager createDirectoryAtPath:path
                         withIntermediateDirectories:YES
                                          attributes:nil
                                               error:&error];
        if (!success && error != nil) {
            RCTLogWarn(@"Pushy create directory error: %@", error.localizedDescription);
        }
    });

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
                unzipError = PushyErrorWithMessage(@"unzip failed");
            }
            completionHandler(unzipError);
        }];
    });
}

- (void)clearInvalidFiles
{
    dispatch_async(_fileQueue, ^{
        NSUserDefaults *defaults = PushyDefaults();
        pushy::state::State state = PushyStateFromDefaults(defaults);
        NSString *downloadDir = [RCTPushy downloadDir];
        pushy::patch::Status status = pushy::patch::CleanupOldEntries(
            PushyToStdString(downloadDir),
            state.current_version,
            state.last_version,
            7
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
