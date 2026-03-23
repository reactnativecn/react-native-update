#import "RCTPushy.h"
#import "RCTPushyDownloader.h"
#import "RCTPushyManager.h"
#include "../../cpp/patch_core/archive_patch_core.h"
#include "../../cpp/patch_core/patch_core.h"
#include "../../cpp/patch_core/state_core.h"

#if __has_include("RCTReloadCommand.h")
#import "RCTReloadCommand.h"
#endif
// Thanks to this guard, we won't import this header when we build for the old architecture.
#ifdef RCT_NEW_ARCH_ENABLED
#import "RCTPushySpec.h"
#endif

#import <React/RCTConvert.h>
#import <React/RCTLog.h>
// #import <React/RCTReloadCommand.h>

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

// app info
static NSString * const AppVersionKey = @"appVersion";
static NSString * const BuildVersionKey = @"buildVersion";

// file def
static NSString * const BUNDLE_FILE_NAME = @"index.bundlejs";
static NSString * const SOURCE_PATCH_NAME = @"__diff.json";
static NSString * const BUNDLE_PATCH_NAME = @"index.bundlejs.patch";

// error def
static NSString * const ERROR_OPTIONS = @"options error";
static NSString * const ERROR_HDIFFPATCH = @"hdiffpatch error";
static NSString * const ERROR_FILE_OPERATION = @"file operation error";

// event def
static NSString * const EVENT_PROGRESS_DOWNLOAD = @"RCTPushyDownloadProgress";
// static NSString * const EVENT_PROGRESS_UNZIP = @"RCTPushyUnzipProgress";
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
    return [NSError errorWithDomain:@"cn.reactnative.pushy"
                               code:-1
                           userInfo:@{ NSLocalizedDescriptionKey: [NSString stringWithUTF8String:status.message.c_str()] }];
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
- (void)_dopatch:(NSString *)hash
            type:(PushyType)type
      fromBundle:(NSString *)bundleOrigin
          source:(NSString *)sourceOrigin
        callback:(void (^)(NSError *error))callback;
- (void)patch:(NSString *)hash
         type:(PushyType)type
   fromBundle:(NSString *)bundleOrigin
       source:(NSString *)sourceOrigin
     callback:(void (^)(NSError *error))callback;
@end

@implementation RCTPushy {
    RCTPushyManager *_fileManager;
    bool hasListeners;
}

@synthesize methodQueue = _methodQueue;

RCT_EXPORT_MODULE(RCTPushy);

+ (NSURL *)bundleURL
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    
    // Check for version changes first 
    NSString *curPackageVersion = [RCTPushy packageVersion];
    NSString *curBuildTime = [RCTPushy buildTime];
    NSString *storedPackageVersion = [defaults stringForKey:paramPackageVersion];
    NSString *storedBuildTime = [defaults stringForKey:paramBuildTime];
    
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
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    pushy::state::State state = pushy::state::Rollback(PushyStateFromDefaults(defaults));
    PushyApplyStateToDefaults(defaults, state);
    return PushyFromStdString(state.current_version);
}

+ (BOOL)requiresMainQueueSetup {
    // only set to YES if your module initialization relies on calling UIKit!
	return NO;
}

- (NSDictionary *)constantsToExport
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    
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
        ret[@"currentVersionInfo"] = [defaults objectForKey:[keyHashInfo stringByAppendingString:currentVersion]];
    }
    
    // clear isFirstTimemarked
    if (ret[@"isFirstTime"]) {
        [defaults setObject:nil forKey:keyFirstLoadMarked];
    }
    
    // clear rolledbackmark
    if (ret[@"rolledBackVersion"] != nil) {
        [defaults setObject:nil forKey:keyRolledBackMarked];
        [self clearInvalidFiles];
    }
    
    // clear packageupdatemarked
    if ([[defaults objectForKey:KeyPackageUpdatedMarked] boolValue]) {
        [defaults setObject:nil forKey:KeyPackageUpdatedMarked];
        [self clearInvalidFiles];
    }
    

    return ret;
}

- (instancetype)init
{
    self = [super init];
    if (self) {
        _fileManager = [RCTPushyManager new];
    }
    return self;
}

RCT_EXPORT_METHOD(setUuid:(NSString *)uuid  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    @try {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults setObject:uuid forKey:keyUuid];
        
        resolve(@true);
    }
    @catch (NSException *exception) {
        reject(@"json格式校验报错", nil, nil);
    }
}

RCT_EXPORT_METHOD(setLocalHashInfo:(NSString *)hash
                  value:(NSString *)value resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (object && [object isKindOfClass:[NSDictionary class]]) {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults setObject:value forKey:[keyHashInfo stringByAppendingString:hash]];
        
        resolve(@true);
    } else {
        reject(@"json格式校验报错", nil, nil);
    }
}


RCT_EXPORT_METHOD(getLocalHashInfo:(NSString *)hash
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    resolve([defaults stringForKey:[keyHashInfo stringByAppendingString:hash]]);
}

RCT_EXPORT_METHOD(downloadFullUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self doPushy:PushyTypeFullDownload options:options callback:^(NSError *error) {
        if (error) {
            reject([NSString stringWithFormat: @"%lu", (long)error.code], error.localizedDescription, error);
        }
        else {
            resolve(nil);
        }
    }];
}

RCT_EXPORT_METHOD(downloadPatchFromPackage:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self doPushy:PushyTypePatchFromPackage options:options callback:^(NSError *error) {
        if (error) {
            reject([NSString stringWithFormat: @"%lu", (long)error.code], error.localizedDescription, error);
        }
        else {
            resolve(nil);
        }
    }];
}

RCT_EXPORT_METHOD(downloadPatchFromPpk:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self doPushy:PushyTypePatchFromPpk options:options callback:^(NSError *error) {
        if (error) {
            reject([NSString stringWithFormat: @"%lu", (long)error.code], error.localizedDescription, error);
        }
        else {
            resolve(nil);
        }
    }];
}

RCT_EXPORT_METHOD(setNeedUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSString *hash = options[@"hash"];
    
    if (hash.length) {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        pushy::state::State next = pushy::state::SwitchVersion(
            PushyStateFromDefaults(defaults),
            PushyToStdString(hash)
        );
        PushyApplyStateToDefaults(defaults, next);
        resolve(@true);
    } else {
        reject(@"执行报错", nil, nil);
    }
}

RCT_EXPORT_METHOD(reloadUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    @try {
        NSString *hash = options[@"hash"];
        if (hash.length) {
            // 只在 setNeedUpdate 成功后 resolve
            [self setNeedUpdate:options resolver:^(id result) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    #if __has_include("RCTReloadCommand.h")
                        // reload 0.62+
                        RCTReloadCommandSetBundleURL([[self class] bundleURL]);
                        RCTTriggerReloadCommandListeners(@"pushy reloadUpdate");
                    #else
                        [self.bridge reload];
                    #endif
                });
                resolve(@true);
            } rejecter:^(NSString *code, NSString *message, NSError *error) {
                reject(code, message, error);
            }];
        } else {
            reject(@"执行报错", nil, nil);
        }
    }
    @catch (NSException *exception) {
        reject(@"执行报错", nil, nil);
    }
}

RCT_EXPORT_METHOD(restartApp:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    @try {
        dispatch_async(dispatch_get_main_queue(), ^{
            #if __has_include("RCTReloadCommand.h")
                // reload 0.62+
                RCTReloadCommandSetBundleURL([[self class] bundleURL]);
                RCTTriggerReloadCommandListeners(@"pushy restartApp");
            #else
                [self.bridge reload];
            #endif
        });

        resolve(@true);
    }
    @catch (NSException *exception) {
        reject(@"执行报错", exception.reason, nil);
    }
}

RCT_EXPORT_METHOD(markSuccess:(RCTPromiseResolveBlock)resolve
                                    rejecter:(RCTPromiseRejectBlock)reject)
{
    #if DEBUG
    resolve(@true);
    #else
    
    @try {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        pushy::state::MarkSuccessResult result =
            pushy::state::MarkSuccess(PushyStateFromDefaults(defaults));
        if (!result.stale_version_to_delete.empty()) {
            [defaults removeObjectForKey:[keyHashInfo stringByAppendingString:PushyFromStdString(result.stale_version_to_delete)]];
        }
        PushyApplyStateToDefaults(defaults, result.state);
        
        // clear other package dir
        [self clearInvalidFiles];
        resolve(@true);
    }
    @catch (NSException *exception) {
        reject(@"执行报错", nil, nil);
    }
    #endif
}



#pragma mark - private
- (NSArray<NSString *> *)supportedEvents
{
  return @[
      EVENT_PROGRESS_DOWNLOAD, 
    //   EVENT_PROGRESS_UNZIP
      ];
}

// Will be called when this module's first listener is added.
-(void)startObserving {
    hasListeners = YES;
    // Set up any upstream listeners or background tasks as necessary
}

// Will be called when this module's last listener is removed, or on dealloc.
-(void)stopObserving {
    hasListeners = NO;
    // Remove upstream listeners, stop unnecessary background tasks
}

- (BOOL) isBlankString:(NSString *)string {
    if (string == nil || string == NULL) {
        return YES;
    }
    if ([string isKindOfClass:[NSNull class]]) {
        return YES;
    }
    if ([[string stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] length]==0) {
        return YES;
    }
    return NO;
}


- (void)doPushy:(PushyType)type options:(NSDictionary *)options callback:(void (^)(NSError *error))callback
{
    NSString *updateUrl = [RCTConvert NSString:options[@"updateUrl"]];
    NSString *hash = [RCTConvert NSString:options[@"hash"]];

    if (updateUrl.length <= 0 || hash.length <= 0) {
        callback([self errorWithMessage:ERROR_OPTIONS]);
        return;
    }
    NSString *originHash = [RCTConvert NSString:options[@"originHash"]];
    if (type == PushyTypePatchFromPpk && [self isBlankString:originHash]) {
        callback([self errorWithMessage:ERROR_OPTIONS]);
        return;
    }
    
    NSString *dir = [RCTPushy downloadDir];
    BOOL success = [_fileManager createDir:dir];
    if (!success) {
        callback([self errorWithMessage:ERROR_FILE_OPERATION]);
        return;
    }

    NSString *zipFilePath = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@%@",hash, [self zipExtension:type]]];
//    NSString *unzipDir = [dir stringByAppendingPathComponent:hash];

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
        if (error) {
            callback(error);
        }
        else {
            RCTLogInfo(@"RCTPushy -- unzip file %@", zipFilePath);
            NSString *unzipFilePath = [dir stringByAppendingPathComponent:hash];
            [self->_fileManager unzipFileAtPath:zipFilePath toDestination:unzipFilePath progressHandler:^(NSString *entry,long entryNumber, long total) {
                // if (self->hasListeners) {
                //     [self sendEventWithName:EVENT_PROGRESS_UNZIP
                //                        body:@{
                //                            PARAM_PROGRESS_HASH:hash,
                //                            PARAM_PROGRESS_RECEIVED:[NSNumber numberWithLong:entryNumber],
                //                            PARAM_PROGRESS_TOTAL:[NSNumber numberWithLong:total]
                //                        }];
                // }
                
            } completionHandler:^(NSString *path, BOOL succeeded, NSError *error) {
                dispatch_async(self->_methodQueue, ^{
                    if (error) {
                        callback(error);
                    }
                    else {
                        switch (type) {
                            case PushyTypePatchFromPackage:
                            {
                                NSString *sourceOrigin = [[NSBundle mainBundle] resourcePath];
                                NSString *bundleOrigin = [[RCTPushy binaryBundleURL] path];
                                [self patch:hash type:type fromBundle:bundleOrigin source:sourceOrigin callback:callback];
                            }
                                break;
                            case PushyTypePatchFromPpk:
                            {
                                NSString *lastVersionDir = [dir stringByAppendingPathComponent:originHash];
                                
                                NSString *sourceOrigin = lastVersionDir;
                                NSString *bundleOrigin = [lastVersionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME];
                                [self patch:hash type:type fromBundle:bundleOrigin source:sourceOrigin callback:callback];
                            }
                                break;
                            default:
                                callback(nil);
                                break;
                        }
                    }
                });
            }];
        }
    }];
}

- (void)_dopatch:(NSString *)hash
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
    NSError *error = nil;
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingAllowFragments error:&error];
    if (error) {
        callback(error);
        return;
    }

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

- (void)patch:(NSString *)hash
         type:(PushyType)type
   fromBundle:(NSString *)bundleOrigin
       source:(NSString *)sourceOrigin
     callback:(void (^)(NSError *error))callback
{
    [self _dopatch:hash type:type fromBundle:bundleOrigin source:sourceOrigin callback:callback];
}

- (void)clearInvalidFiles
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    pushy::state::State state = PushyStateFromDefaults(defaults);
    
    NSString *downloadDir = [RCTPushy downloadDir];
    pushy::patch::Status status = pushy::patch::CleanupOldEntries(
        PushyToStdString(downloadDir),
        state.current_version,
        state.last_version,
        7
    );
    if (!status.ok) {
        NSLog(@"Pushy cleanup error: %s", status.message.c_str());
    }
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
            break;
    }
}

- (NSError *)errorWithMessage:(NSString *)errorMessage
{
    return [NSError errorWithDomain:@"cn.reactnative.pushy"
                               code:-1
                           userInfo:@{ NSLocalizedDescriptionKey: errorMessage}];
}

+ (NSString *)downloadDir
{
    NSString *directory = [NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES) firstObject];
    NSString *downloadDir = [directory stringByAppendingPathComponent:@"rctpushy"];
    
    return downloadDir;
}

+ (NSURL *)binaryBundleURL
{
    NSURL *url = [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
    return url;
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

// Thanks to this guard, we won't compile this code when we build for the old architecture.
#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativePushySpecJSI>(params);
}
#endif

@end
