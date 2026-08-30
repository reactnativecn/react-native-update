#import "RCTPushy.h"
#import "RCTPushyDownloader.h"
#import "ZipArchive.h"
#include "../../cpp/patch_core/archive_limits.h"
#include "../../cpp/patch_core/archive_patch_core.h"
#include "../../cpp/patch_core/digest.h"
#include "../../cpp/patch_core/hbc_transform_wire.h"
#include "../../cpp/patch_core/install_record.h"
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
// to reuse (§10.3), scoped to the request and config that produced it.
static NSString *const keyNativeCheckCache = @"REACTNATIVECN_PUSHY_NATIVE_CHECK_RESP_KEY";
// Set when a native check round starts, cleared when it ends (§11.4). Residue
// on the next launch means the previous process died mid-round (a crash
// rescue was truncated): that launch resumes immediately instead of waiting.
static NSString *const keyNativeCheckIncomplete = @"REACTNATIVECN_PUSHY_NATIVE_CHECK_INCOMPLETE_KEY";
static NSString *const PushyErrorDomain = @"cn.reactnative.pushy";

// file def
static NSString * const BUNDLE_FILE_NAME = @"index.bundlejs";
static NSString * const SOURCE_PATCH_NAME = @"__diff.json";
static NSString * const BUNDLE_PATCH_NAME = @"index.bundlejs.patch";
#define VERSION_COMPLETE_FILE_NAME_LITERAL ".pushy-complete"
static NSString * const VERSION_COMPLETE_FILE_NAME = @VERSION_COMPLETE_FILE_NAME_LITERAL;

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

static NSTimeInterval PushyMonotonicNow(void) {
    return [NSProcessInfo processInfo].systemUptime;
}

static std::string PushyToStdString(NSString *value);

static NSString *PushyStagingDirForVersionDir(NSString *versionDir) {
    return [versionDir stringByAppendingString:@(pushy::install_record::kStagingSuffix)];
}

// Parsed completion record (cpp/patch_core/install_record.h): nil when the
// file is absent or malformed; an empty dictionary for the legacy empty
// marker written by SDK < 10.53.
static NSDictionary *PushyReadInstallRecord(NSString *versionDir) {
    NSString *path = [versionDir stringByAppendingPathComponent:VERSION_COMPLETE_FILE_NAME];
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (data == nil) {
        return nil;
    }
    if (data.length == 0) {
        return @{};
    }
    if (data.length > 64 * 1024) {
        return nil;
    }
    id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [object isKindOfClass:[NSDictionary class]] ? (NSDictionary *)object : nil;
}

// Presence check (launch / dedup paths, no digest work): bundle present and
// the record exists and, unless legacy-empty, names this version.
static BOOL PushyHasCompletedVersionAtPath(NSString *versionDir, NSString *hash) {
    NSString *bundlePath = [versionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME];
    if (![[NSFileManager defaultManager] fileExistsAtPath:bundlePath]) {
        return NO;
    }
    NSDictionary *record = PushyReadInstallRecord(versionDir);
    if (record == nil) {
        return NO;
    }
    if (record.count == 0) {
        return YES;
    }
    return [record[@"schema"] isKindOfClass:[NSNumber class]]
        && [record[@"schema"] intValue] == pushy::install_record::kSchema
        && [record[@"versionHash"] isKindOfClass:[NSString class]]
        && [record[@"versionHash"] isEqualToString:hash];
}

// Activation check: re-hashes the bundle when the record carries a digest.
// Returns nil when the directory may be activated, the reason otherwise.
static NSString *PushyVerifyInstallForActivation(NSString *versionDir, NSString *hash) {
    NSDictionary *record = PushyReadInstallRecord(versionDir);
    if (record == nil) {
        return [NSString stringWithFormat:@"Bundle version %@ has no valid completion record.", hash];
    }
    if (record.count == 0) {
        return nil;
    }
    if (![record[@"schema"] isKindOfClass:[NSNumber class]]
        || [record[@"schema"] intValue] != pushy::install_record::kSchema
        || ![record[@"versionHash"] isKindOfClass:[NSString class]]
        || ![record[@"versionHash"] isEqualToString:hash]) {
        return [NSString stringWithFormat:@"Bundle version %@ completion record mismatch.", hash];
    }
    NSString *expected = record[@"bundleSha256"];
    if (![expected isKindOfClass:[NSString class]] || expected.length == 0) {
        return nil;
    }
    std::string actual = pushy::digest::Sha256File(
        PushyToStdString([versionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME]));
    if ([[expected lowercaseString] isEqualToString:[NSString stringWithUTF8String:actual.c_str()]]) {
        return nil;
    }
    return [NSString stringWithFormat:@"Bundle version %@ bundle digest mismatch.", hash];
}

// SHA-256 of each in-flight download's archive, keyed by hash; consumed by
// the completion record write. Guarded by @synchronized on the table.
static NSMutableDictionary<NSString *, NSString *> *PushyArtifactDigests(void) {
    static NSMutableDictionary *table;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        table = [NSMutableDictionary dictionary];
    });
    return table;
}

static NSError *PushyErrorWithCode(const char *code, NSString *message);

static long long PushyFileSizeAtPath(NSString *path) {
    NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    NSNumber *size = attributes[NSFileSize];
    return size == nil ? -1 : size.longLongValue;
}

// Free space on the volume holding `path` (walks up to an existing ancestor);
// -1 when unknown.
static long long PushyFreeDiskSpaceForPath(NSString *path) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSString *probe = path;
    while (probe.length > 1 && ![fileManager fileExistsAtPath:probe]) {
        probe = [probe stringByDeletingLastPathComponent];
    }
    NSDictionary *attributes = [fileManager attributesOfFileSystemForPath:probe error:nil];
    NSNumber *free = attributes[NSFileSystemFreeSize];
    return free == nil ? -1 : free.longLongValue;
}

// nil when the volume can take `bytesToWrite` plus the safety margin (or the
// free space is unknown); an error otherwise.
static NSError *PushyEnsureFreeSpace(NSString *path, long long bytesToWrite) {
    long long free = PushyFreeDiskSpaceForPath(path);
    if (free < 0) {
        return nil;
    }
    long long needed = MAX(0LL, bytesToWrite) + pushy::archive_limits::kFreeDiskMarginBytes;
    if (free < needed) {
        return PushyErrorWithCode(
            pushy::error_codes::kPatchFailed,
            [NSString stringWithFormat:@"insufficient disk space: need %lld bytes, have %lld",
                needed, free]);
    }
    return nil;
}

// SSZipArchive delegate enforcing cpp/patch_core/archive_limits.h while the
// archive is walked: entry count, per-entry size, total size, compression
// ratio. SSZipArchive silently skips an entry the delegate refuses, so the
// first violation is recorded and turned into a hard failure afterwards.
@interface PushyUnzipGuard : NSObject <SSZipArchiveDelegate>
@property (nonatomic, copy) NSString *violation;
@property (nonatomic, assign) long long totalUncompressed;
@end

@implementation PushyUnzipGuard

- (void)zipArchiveWillUnzipArchiveAtPath:(NSString *)path zipInfo:(unz_global_info)zipInfo {
    if ((long long)zipInfo.number_entry > pushy::archive_limits::kMaxEntries) {
        self.violation = [NSString stringWithFormat:@"archive has too many entries (%lu)",
                          (unsigned long)zipInfo.number_entry];
    }
}

- (BOOL)zipArchiveShouldUnzipFileAtIndex:(NSInteger)fileIndex
                              totalFiles:(NSInteger)totalFiles
                             archivePath:(NSString *)archivePath
                                fileInfo:(unz_file_info)fileInfo {
    if (self.violation != nil) {
        return NO;
    }
    long long size = (long long)fileInfo.uncompressed_size;
    long long compressed = (long long)fileInfo.compressed_size;
    if (size > pushy::archive_limits::kMaxEntryBytes) {
        self.violation = [NSString stringWithFormat:@"archive entry #%ld too large (%lld bytes)",
                          (long)fileIndex, size];
        return NO;
    }
    self.totalUncompressed += size;
    if (self.totalUncompressed > pushy::archive_limits::kMaxTotalUncompressedBytes) {
        self.violation = [NSString stringWithFormat:@"archive expands beyond %lld bytes",
                          pushy::archive_limits::kMaxTotalUncompressedBytes];
        return NO;
    }
    if (compressed > 0 && size > pushy::archive_limits::kRatioCheckMinBytes
        && size / compressed > pushy::archive_limits::kMaxCompressionRatio) {
        self.violation = [NSString stringWithFormat:@"archive entry #%ld compression ratio too high",
                          (long)fileIndex];
        return NO;
    }
    return YES;
}

@end

static NSError *PushyDownloadDeadlineExpiredError(void) {
    return [NSError errorWithDomain:PushyErrorDomain
                               code:-1
                           userInfo:@{
        NSLocalizedDescriptionKey: @"download deadline expired before start",
        PushyErrorCodeKey: PushyCode(pushy::error_codes::kDownloadFailed),
    }];
}


typedef NS_ENUM(NSInteger, PushyType) {
    PushyTypeFullDownload = 1,
    PushyTypePatchFromPackage = 2,
    PushyTypePatchFromPpk = 3,
    //TASK_TYPE_PLAIN_DOWNLOAD=4?
};

static std::atomic<bool> ignoreRollback{false};
// Bumped by resetToPackagedBundle. The cold-start check runs for minutes and
// may already hold a decision when the app resets to the packaged bundle; it
// samples this counter and abandons activation (and its response cache) when
// the value moved, so an in-flight rescue can never resurrect the version the
// app just reset away from.
static std::atomic<uint64_t> pushyResetGeneration{0};
// The version whose bundle this process actually loaded (resolved in
// +bundleURL). resetToPackagedBundle must not delete its directory: update
// assets (images/fonts) are read from it on demand at runtime, so wiping it
// under a silent (no-restart) reset would break every image the running app
// has not loaded yet. Guarded by the state lock.
static NSString *pushyLaunchVersion = nil;

// JS and the bridge-free cold-start engine use different RCTPushy instances,
// but they must still share one download per target hash. Without this
// process-wide registry two NSURLSessionDownloadTasks race over the same
// archive path and the later unzip can delete the first task's valid output.
static NSMutableDictionary<NSString *, NSMutableDictionary *> *PushyInFlightDownloads(void) {
    static NSMutableDictionary<NSString *, NSMutableDictionary *> *downloads;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        downloads = [NSMutableDictionary dictionary];
    });
    return downloads;
}

typedef NS_ENUM(NSInteger, PushyDownloadRegistration) {
    PushyDownloadRegistrationOwner,
    PushyDownloadRegistrationJoined,
    PushyDownloadRegistrationDeferred,
};

static PushyDownloadRegistration PushyRegisterDownload(
    NSString *hash,
    NSInteger type,
    NSTimeInterval deadlineUptime,
    void (^callback)(NSError *),
    void (^progress)(long long, long long),
    void (^deferredStart)(void)
) {
    NSMutableDictionary *downloads = PushyInFlightDownloads();
    @synchronized (downloads) {
        NSMutableDictionary *entry = downloads[hash];
        if (entry != nil) {
            if ([entry[@"type"] integerValue] == type) {
                NSTimeInterval ownerDeadline = [entry[@"deadlineUptime"] doubleValue];
                // A caller with substantially more time must not inherit an
                // owner's nearly-exhausted timeout: it observes the current
                // transfer and restarts after the owner settles (the
                // completion-marker preflight makes a successful owner free).
                // The comparison is on remaining budget, not on the absolute
                // deadline: a JS caller always computes now+600 a few seconds
                // after the owner did, so a strict `>` would defer every
                // second caller and turn the shared download back into
                // serialized re-downloads. Only a genuinely starved owner
                // (less than half the newcomer's budget left) defers.
                const NSTimeInterval now = PushyMonotonicNow();
                if (2 * (ownerDeadline - now) < (deadlineUptime - now)) {
                    if (progress != nil) {
                        [entry[@"progress"] addObject:[progress copy]];
                    }
                    [entry[@"deferred"] addObject:[deferredStart copy]];
                    return PushyDownloadRegistrationDeferred;
                }
                [entry[@"callbacks"] addObject:[callback copy]];
                if (progress != nil) {
                    [entry[@"progress"] addObject:[progress copy]];
                }
                return PushyDownloadRegistrationJoined;
            }
            // A diff failure must not settle a joined full request. Queue the
            // different artifact type behind the owner; once restarted it
            // registers normally (and re-checks the completion marker).
            if (progress != nil) {
                // The artifact type differs, but it still installs the same
                // target hash. Keep the waiting JS UI moving while its own
                // transfer is queued behind the current owner.
                [entry[@"progress"] addObject:[progress copy]];
            }
            [entry[@"deferred"] addObject:[deferredStart copy]];
            return PushyDownloadRegistrationDeferred;
        }
        NSMutableArray *progressHandlers = [NSMutableArray array];
        if (progress != nil) {
            [progressHandlers addObject:[progress copy]];
        }
        downloads[hash] = [@{
            @"type": @(type),
            @"deadlineUptime": @(deadlineUptime),
            @"callbacks": [NSMutableArray arrayWithObject:[callback copy]],
            @"progress": progressHandlers,
            @"deferred": [NSMutableArray array],
        } mutableCopy];
        return PushyDownloadRegistrationOwner;
    }
}

static void PushyReportDownloadProgress(
    NSString *hash, long long received, long long total
) {
    NSMutableDictionary *downloads = PushyInFlightDownloads();
    NSArray *handlers = nil;
    @synchronized (downloads) {
        handlers = [downloads[hash][@"progress"] copy];
    }
    for (id value in handlers) {
        void (^handler)(long long, long long) =
            (void (^)(long long, long long))value;
        handler(received, total);
    }
}

static void PushyFinishDownload(NSString *hash, NSError *error) {
    NSMutableDictionary *downloads = PushyInFlightDownloads();
    NSArray *callbacks = nil;
    NSArray *deferred = nil;
    @synchronized (downloads) {
        callbacks = [downloads[hash][@"callbacks"] copy];
        deferred = [downloads[hash][@"deferred"] copy];
        [downloads removeObjectForKey:hash];
    }
    // Establish the next (different-type) owner before waking the completed
    // owner's callbacks; otherwise its strategy loop could race the waiter.
    for (id value in deferred) {
        void (^start)(void) = (void (^)(void))value;
        start();
    }
    for (id value in callbacks) {
        void (^callback)(NSError *) = (void (^)(NSError *))value;
        callback(error);
    }
}

// Serializes every read-modify-write of the persisted update state. The state
// machine itself is a pure function (state_core), but callers run on different
// threads (main thread bundleURL, module method queue, _fileQueue), so the
// read→transform→write sequence must be atomic to avoid e.g. markSuccess being
// overwritten by a concurrent bundleURL and the version being rolled back.
static os_unfair_lock pushyStateLock = OS_UNFAIR_LOCK_INIT;

static void PushyWithStateLock(void (NS_NOESCAPE ^block)(void)) {
    os_unfair_lock_lock(&pushyStateLock);
    @try {
        block();
    } @finally {
        os_unfair_lock_unlock(&pushyStateLock);
    }
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

// Version switch without acquiring the state lock: the caller must already
// hold it. Lets the cold-start check commit its whole result (version info,
// switch, response cache) inside one lock acquisition, so resetToPackagedBundle
// can never interleave between the generation check and the writes.
static void PushySwitchVersionLocked(NSString *hash) {
    NSUserDefaults *defaults = PushyDefaults();
    pushy::state::State next = pushy::state::SwitchVersion(
        PushyStateFromDefaults(defaults),
        PushyToStdString(hash)
    );
    PushyApplyStateToDefaults(defaults, next);
    // Re-enable first-load consumption and rollback checks for the newly selected bundle.
    ignoreRollback = false;
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
+ (void)scheduleFromColdStart:(NSString *)launchRolledBackVersion;
+ (void)markJsCheckCompleted:(NSString *)config;
+ (void)startRoundWithDeadline:(NSTimeInterval)deadlineUptime;
+ (void)runOnce:(NSString *)launchRolledBackVersion deadline:(NSTimeInterval)deadlineUptime;
+ (void)runRescueWithDeadline:(NSTimeInterval)deadlineUptime;
+ (BOOL)commitRoundWithGeneration:(uint64_t)generation
                         hashInfo:(NSDictionary *)hashInfoEntry
                         activate:(NSString *)hashToActivate
                     responseText:(NSString *)responseText
                          request:(NSString *)requestBody
                           config:(NSString *)configJson
                       responseAt:(long long)responseAtSeconds;
@end

// One round per process, whoever starts it first — the delayed cold-start
// path or the crash-rescue thread (§11.3). The semaphore lets the rescue
// wait out an in-flight round instead of racing it.
static std::atomic<bool> pushyRoundStarted{false};
static std::atomic<bool> pushyRoundCompleted{false};
// Flipped the moment a crash is being held. JS is dead from that point on,
// so there is no second decision maker: the round force-activates whatever
// it downloads (§11.3).
static std::atomic<bool> pushyCrashRescueActive{false};
static std::atomic<bool> pushyRescueAttempted{false};
static dispatch_semaphore_t pushyRoundDone;
static NSString *pushyLaunchRolledBackForRescue = nil;
// A version this process downloaded but left for JS to activate. If the
// process then crashes, JS will never activate it — the crash handler
// activates it directly (bounded local work, no network). The generation is
// the one the round committed under: a reset that lands afterwards bumps it,
// and the late activation must lose to that reset exactly like the round
// itself would. Guarded by @synchronized (RCTPushyOrchestrator class).
static NSString *pushyUnactivatedHash = nil;
static uint64_t pushyUnactivatedGeneration = 0;
static NSUncaughtExceptionHandler *pushyPreviousExceptionHandler = NULL;
// ≈ process start: scheduleFromColdStart runs during the first bundleURL.
static NSTimeInterval pushyProcessAnchorUptime = 0;
// Config JSON for which JS reported a completed check in this process
// (markJsCheckCompleted). Process-scoped by design. Guarded by
// @synchronized (RCTPushyOrchestrator class).
static NSString *pushyJsCompletedConfig = nil;

static const NSTimeInterval kPushyRescueTriggerUptime = 60;
static const NSTimeInterval kPushyRescueBudgetBackgroundThread = 10;
// A held main thread freezes UI teardown; stay well under the watchdog.
static const NSTimeInterval kPushyRescueBudgetMainThread = 3.5;

static void PushyMaybeHoldForRescue(void) {
    // Once per process; a second crashing thread passes straight through
    // instead of waiting behind the first (§11.3: prefer under-rescuing over
    // wedging the teardown).
    bool expected = false;
    if (!pushyRescueAttempted.compare_exchange_strong(expected, true)) {
        return;
    }
    NSTimeInterval uptime = PushyMonotonicNow() - pushyProcessAnchorUptime;
    bool roundInFlight = pushyRoundStarted.load() && !pushyRoundCompleted.load();
    // Early crashes are the brick signature; a crash with an in-flight round
    // is worth finishing regardless of uptime. Everything else is an ordinary
    // crash whose UX must not be delayed.
    if (uptime >= kPushyRescueTriggerUptime && !roundInFlight) {
        return;
    }
    NSTimeInterval budget = [NSThread isMainThread]
        ? kPushyRescueBudgetMainThread
        : kPushyRescueBudgetBackgroundThread;
    NSTimeInterval deadline = PushyMonotonicNow() + budget;
    NSLog(@"RCTPushy -- crash rescue: holding process for up to %.1fs "
          @"(uptime %.1fs)", budget, uptime);

    // The rescue runs on its own queue and the dying thread only waits with a
    // hard timeout: even a deadlocked rescue (a thread that died holding a
    // lock — uncaught ObjC exceptions skip @finally) can only delay the
    // process death, never prevent it.
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @try {
            [RCTPushyOrchestrator runRescueWithDeadline:deadline];
        } @catch (NSException *exception) {
            NSLog(@"RCTPushy -- crash rescue failed: %@", exception.reason);
        }
        dispatch_semaphore_signal(done);
    });
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW,
            (int64_t)(budget * NSEC_PER_SEC))) != 0) {
        NSLog(@"RCTPushy -- crash rescue: budget exhausted, letting go");
    }
}

// Crash-moment brick rescue (§11): when the app is dying of an uncaught
// exception during startup (RCTFatal raises NSException in release), the
// process is still alive and JS will never run again — a natural,
// false-positive-free window to finish the cold-start check. The previous
// handler (crash reporters chain the same way) always runs afterwards.
static void PushyCrashRescueExceptionHandler(NSException *exception) {
    @try {
        PushyMaybeHoldForRescue();
    } @catch (NSException *inner) {
        // The dying process owes the previous handler its turn no matter
        // what the rescue did.
    }
    if (pushyPreviousExceptionHandler != NULL) {
        pushyPreviousExceptionHandler(exception);
    }
}

static void PushyInstallCrashRescueHandler(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        pushyPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
        NSSetUncaughtExceptionHandler(&PushyCrashRescueExceptionHandler);
    });
}

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
    __block NSURL *resolvedURL = nil;
    __block NSString *launchRolledBackVersion = nil;
    @try {
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
                    break;
                } else {
                    RCTLogError(@"RCTPushy -- bundle version %@ not found, rolling back", loadVersion);
                    state = pushy::state::Rollback(state);
                    PushyApplyStateToDefaults(defaults, state);
                    loadVersion = PushyFromStdString(state.current_version);
                }
            }
        }
        // Capture before constantsToExport consumes this one-shot marker.
        // The delayed native check must never forceBoot the version that this
        // launch just rolled back.
            launchRolledBackVersion = PushyFromStdString(state.rolled_back_version);
        });
        return resolvedURL ?: [RCTPushy binaryBundleURL];
    } @finally {
        // State corruption is exactly when the rescue path matters most. If
        // resolution throws before a snapshot exists, nil safely omits only
        // this launch's rollback guard instead of disabling the check.
        [RCTPushyOrchestrator scheduleFromColdStart:launchRolledBackVersion];
    }
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
            // bundleSha256 from the install record, for crash-report attribution.
            NSString *bundleSha256 = @"";
            if (PushyIsSafePathComponent(currentVersion)) {
                NSDictionary *record = PushyReadInstallRecord(
                    [[RCTPushy downloadDir] stringByAppendingPathComponent:currentVersion]);
                if ([record[@"bundleSha256"] isKindOfClass:[NSString class]]) {
                    bundleSha256 = record[@"bundleSha256"];
                }
            }
            ret[@"currentBundleSha256"] = bundleSha256;
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

RCT_EXPORT_METHOD(markJsCheckCompleted:(NSString *)config
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (PushyStringIsBlank(config)) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }
    [RCTPushyOrchestrator markJsCheckCompleted:config];
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
        // Invalidate any in-flight cold-start round before clearing state, so
        // a round that commits under this same lock afterwards always sees the
        // new generation and drops its result.
        pushyResetGeneration.fetch_add(1);
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
        // A cached response still advertises the version this reset just
        // removed; dropping it stops the JS side from reusing that answer.
        [defaults removeObjectForKey:keyNativeCheckCache];
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

    NSString *unzipDir = [dir stringByAppendingPathComponent:hash];
    if (PushyHasCompletedVersionAtPath(unzipDir, hash)) {
        callback(nil);
        return;
    }

    NSTimeInterval deadlineUptime = PushyMonotonicNow() + 600;
    NSNumber *configuredDeadline = options[@"deadlineUptime"];
    if ([configuredDeadline isKindOfClass:[NSNumber class]]) {
        deadlineUptime = configuredDeadline.doubleValue;
    }
    if (deadlineUptime <= PushyMonotonicNow()) {
        callback(PushyDownloadDeadlineExpiredError());
        return;
    }

    void (^progress)(long long, long long) = ^(long long receivedBytes, long long totalBytes) {
        if (self->hasListeners) {
            [self sendEventWithName:EVENT_PROGRESS_DOWNLOAD body:@{
                PARAM_PROGRESS_HASH:hash,
                PARAM_PROGRESS_RECEIVED:@(receivedBytes),
                PARAM_PROGRESS_TOTAL:@(totalBytes),
            }];
        }
    };
    void (^deferredStart)(void) = ^{
        [self performUpdate:type options:options callback:callback];
    };
    PushyDownloadRegistration registration = PushyRegisterDownload(
        hash, type, deadlineUptime, callback, progress, deferredStart);
    if (registration != PushyDownloadRegistrationOwner) {
        RCTLogInfo(
            @"RCTPushy -- %@ in-flight download for %@",
            registration == PushyDownloadRegistrationJoined ? @"join" : @"defer",
            hash);
        return;
    }

    NSString *zipFilePath = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@%@",hash, [self zipExtension:type]]];

    // On failure, remove the partial version directory like Android/Harmony
    // do: a half-unzipped/half-patched dir leaks disk and could later be
    // mistaken for a complete version. hash is validated non-blank above, so
    // this can never resolve to the download root itself.
    void (^completion)(NSError *) = ^(NSError *error) {
        // Settle every JS/native waiter only after cleanup or the atomic
        // completion marker write has run on the process-wide file queue.
        dispatch_async(self->_fileQueue, ^{
            NSError *finalError = error;
            NSFileManager *fileManager = [NSFileManager defaultManager];
            NSString *staging = PushyStagingDirForVersionDir(unzipDir);
            NSString *artifactSha256 = nil;
            @synchronized (PushyArtifactDigests()) {
                artifactSha256 = PushyArtifactDigests()[hash];
                [PushyArtifactDigests() removeObjectForKey:hash];
            }
            if (finalError == nil) {
                // Two-phase install (cpp/patch_core/install_record.h): the
                // completion record with the final bundle's digest goes into
                // the staging directory, which is then renamed over the
                // version directory in one atomic step.
                NSString *bundlePath = [staging stringByAppendingPathComponent:BUNDLE_FILE_NAME];
                if (![fileManager fileExistsAtPath:bundlePath]) {
                    finalError = PushyErrorWithCode(pushy::error_codes::kPatchFailed,
                                                    @"bundle missing after install");
                } else {
                    std::string bundleSha256 = pushy::digest::Sha256File(PushyToStdString(bundlePath));
                    NSMutableDictionary *record = [NSMutableDictionary dictionary];
                    record[@"schema"] = @(pushy::install_record::kSchema);
                    record[@"versionHash"] = hash;
                    if (!bundleSha256.empty()) {
                        record[@"bundleSha256"] = [NSString stringWithUTF8String:bundleSha256.c_str()];
                    }
                    if (artifactSha256.length > 0) {
                        record[@"artifactSha256"] = artifactSha256;
                    }
                    NSError *recordError = nil;
                    NSData *recordData = [NSJSONSerialization dataWithJSONObject:record options:0 error:&recordError];
                    NSString *marker = [staging stringByAppendingPathComponent:VERSION_COMPLETE_FILE_NAME];
                    if (recordData == nil || ![recordData writeToFile:marker
                                                               options:NSDataWritingAtomic
                                                                 error:&recordError]) {
                        finalError = recordError ?: PushyErrorWithCode(
                            pushy::error_codes::kFileOperationFailed,
                            @"failed to write completion record");
                    } else {
                        if ([fileManager fileExistsAtPath:unzipDir]) {
                            [fileManager removeItemAtPath:unzipDir error:nil];
                        }
                        NSError *moveError = nil;
                        if (![fileManager moveItemAtPath:staging toPath:unzipDir error:&moveError]) {
                            finalError = moveError ?: PushyErrorWithCode(
                                pushy::error_codes::kFileOperationFailed,
                                @"failed to promote staging directory");
                        }
                    }
                }
            }
            if (finalError != nil) {
                // Only the staging directory is ours to drop: the final
                // version directory is never touched by a failed install.
                [fileManager removeItemAtPath:staging error:nil];
            }
            PushyFinishDownload(hash, finalError);
        });
    };

    RCTLogInfo(@"RCTPushy -- download file %@", updateUrl);
    NSTimeInterval timeoutSeconds = deadlineUptime - PushyMonotonicNow();
    if (timeoutSeconds <= 0) {
        completion(PushyDownloadDeadlineExpiredError());
        return;
    }
    [RCTPushyDownloader download:updateUrl
                            savePath:zipFilePath
                     timeoutInterval:timeoutSeconds
                     progressHandler:^(long long receivedBytes, long long totalBytes) {
        PushyReportDownloadProgress(hash, receivedBytes, totalBytes);
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
    // Everything lands in <hash>.staging; the completion block promotes it.
    NSString *unzipFilePath = PushyStagingDirForVersionDir(
        [[RCTPushy downloadDir] stringByAppendingPathComponent:hash]);
    dispatch_async(_fileQueue, ^{
        // Archive digest for the completion record, taken before the unzip
        // consumes the file (same serial queue, so it runs first).
        std::string digest = pushy::digest::Sha256File(PushyToStdString(zipFilePath));
        @synchronized (PushyArtifactDigests()) {
            PushyArtifactDigests()[hash] = [NSString stringWithUTF8String:digest.c_str()];
        }
    });
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
    // Patch work happens in the staging directory (two-phase install).
    NSString *unzipDir = PushyStagingDirForVersionDir(
        [[RCTPushy downloadDir] stringByAppendingPathComponent:hash]);
    NSString *sourcePatch = [unzipDir stringByAppendingPathComponent:SOURCE_PATCH_NAME];
    NSString *bundlePatch = [unzipDir stringByAppendingPathComponent:BUNDLE_PATCH_NAME];
    
    NSString *destination = [unzipDir stringByAppendingPathComponent:BUNDLE_FILE_NAME];
    long long manifestBytes = PushyFileSizeAtPath(sourcePatch);
    if (manifestBytes > pushy::archive_limits::kMaxManifestBytes) {
        callback(PushyErrorWithCode(pushy::error_codes::kPatchFailed,
            [NSString stringWithFormat:@"patch manifest too large: %lld bytes", manifestBytes]));
        return;
    }
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

    __block NSError *switchError = nil;
    PushyWithStateLock(^{
        // Same rule as Android: only a version this SDK recorded as completely
        // installed (bundle + marker) may be activated. Versions activated
        // before markers existed are grandfathered through current/last
        // state; any other markerless directory may be a crash-left partial
        // install or a directory something else put there.
        NSString *versionDir = [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
        pushy::state::State state = PushyStateFromDefaults(PushyDefaults());
        std::string hashStd = PushyToStdString(hash);
        BOOL legacyActivated = state.current_version == hashStd || state.last_version == hashStd;
        if (!PushyHasCompletedVersionAtPath(versionDir, hash) && !legacyActivated) {
            BOOL hasBundle = [[NSFileManager defaultManager] fileExistsAtPath:
                [versionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME]];
            switchError = PushyErrorWithCode(
                pushy::error_codes::kSwitchVersionFailed,
                [NSString stringWithFormat:@"Bundle version %@ %@", hash,
                    hasBundle ? @"is incomplete." : @"not found."]);
            return;
        }
        if (!legacyActivated) {
            // The record's bundle digest must match the bytes on disk before
            // the next launch is pointed at them.
            NSString *reason = PushyVerifyInstallForActivation(versionDir, hash);
            if (reason != nil) {
                switchError = PushyErrorWithCode(pushy::error_codes::kSwitchVersionFailed, reason);
                return;
            }
        }
        PushySwitchVersionLocked(hash);
    });
    if (switchError != nil) {
        if (error != NULL) {
            *error = switchError;
        }
        return NO;
    }
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

        // Resource caps before the first byte is extracted
        // (cpp/patch_core/archive_limits.h). The central directory is not
        // readable up front through SSZipArchive, so the disk check uses a
        // 2x-archive heuristic; the delegate below enforces the exact caps
        // entry by entry.
        long long archiveBytes = PushyFileSizeAtPath(path);
        NSError *preflight = nil;
        if (archiveBytes > pushy::archive_limits::kMaxArchiveBytes) {
            preflight = PushyErrorWithCode(pushy::error_codes::kPatchFailed,
                [NSString stringWithFormat:@"archive too large: %lld bytes", archiveBytes]);
        } else {
            preflight = PushyEnsureFreeSpace(destination, MAX(0LL, archiveBytes) * 2);
        }
        if (preflight != nil) {
            [fileManager removeItemAtPath:path error:nil];
            [fileManager removeItemAtPath:[path stringByAppendingString:@".resume"] error:nil];
            if (completionHandler != nil) {
                completionHandler(preflight);
            }
            return;
        }

        PushyUnzipGuard *guard = [PushyUnzipGuard new];
        [SSZipArchive unzipFileAtPath:path
                        toDestination:destination
                   preserveAttributes:YES
                            overwrite:YES
                       nestedZipLevel:0
                             password:nil
                                error:nil
                             delegate:guard
                      progressHandler:nil
                    completionHandler:^(NSString *archivePath, BOOL succeeded, NSError *error) {
            [fileManager removeItemAtPath:archivePath error:nil];
            // The resume sidecar dies with its archive (§11.4): whether the
            // unzip consumed it or classified it as poisoned, nothing must
            // survive to vouch for bytes that are gone.
            [fileManager removeItemAtPath:[archivePath stringByAppendingString:@".resume"]
                                    error:nil];
            if (completionHandler == nil) {
                return;
            }

            NSError *unzipError = error;
            if (guard.violation != nil) {
                unzipError = PushyErrorWithCode(pushy::error_codes::kPatchFailed, guard.violation);
            } else if (!succeeded && unzipError == nil) {
                unzipError = PushyErrorWithCode(pushy::error_codes::kPatchFailed, @"unzip failed");
            } else if (succeeded && unzipError == nil
                       && [fileManager fileExistsAtPath:
                           [destination stringByAppendingPathComponent:VERSION_COMPLETE_FILE_NAME]]) {
                // The completion marker is written by this SDK only, after the
                // whole install succeeded. An archive that ships its own would
                // be trusted as a finished install even if the patch step
                // that follows fails — reject the package outright (the
                // caller removes the half-unpacked directory).
                unzipError = PushyErrorWithCode(pushy::error_codes::kPatchFailed,
                                                @"archive contains reserved entry " VERSION_COMPLETE_FILE_NAME_LITERAL);
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
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            NSHTTPURLResponse *httpResponse =
                [response isKindOfClass:[NSHTTPURLResponse class]]
                    ? (NSHTTPURLResponse *)response
                    : nil;
            NSInteger status = httpResponse.statusCode;
            // The shared session follows redirects; an https endpoint that
            // ended up on plaintext http is a failed endpoint, same as the
            // artifact download.
            BOOL downgraded = [[url.scheme lowercaseString] isEqualToString:@"https"]
                && [[httpResponse.URL.scheme lowercaseString] isEqualToString:@"http"];
            if (error == nil && httpResponse != nil && !downgraded && status >= 200 &&
                status < 300 && data != nil) {
                result = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            }
            dispatch_semaphore_signal(sem);
        }];
    [task resume];
    if (dispatch_semaphore_wait(
            sem, dispatch_time(DISPATCH_TIME_NOW,
                               (int64_t)((timeout + 5) * NSEC_PER_SEC))) != 0) {
        [task cancel];
        return nil;
    }
    return result;
}

static NSString *PushyNormalizeEndpointBase(NSString *base) {
    while ([base hasSuffix:@"/"]) {
        base = [base substringToIndex:base.length - 1];
    }
    return base;
}

static BOOL PushyIsValidCheckResponse(NSString *responseText) {
    if (responseText == nil) {
        return NO;
    }
    // Shared schema rule (update_flow_core::IsValidCheckResponse): a 200 with
    // `{"error": ...}` is a failed endpoint, not a verdict.
    return updateflow::IsValidCheckResponse(PushyToStdString(responseText)) ? YES : NO;
}

@implementation RCTPushyOrchestrator

+ (void)scheduleFromColdStart:(NSString *)launchRolledBackVersion {
#if !DEBUG
    // Once per process; a few seconds of delay keeps the check away from the
    // cold-start critical path (§7 R5) — its result targets the NEXT launch.
    // Unless the previous process died mid-round (residual incomplete
    // marker), in which case every launch second counts (§11.4).
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        pushyRoundDone = dispatch_semaphore_create(0);
        pushyProcessAnchorUptime = PushyMonotonicNow();
        pushyLaunchRolledBackForRescue = [launchRolledBackVersion copy];
        NSUserDefaults *defaults = PushyDefaults();
        // The crash-hold rescue shares the orchestrator's rollout gate: no
        // persisted config, no handler (§11.3).
        if ([defaults stringForKey:keyNativeConfig].length > 0) {
            PushyInstallCrashRescueHandler();
        }
        int64_t delaySeconds =
            [defaults objectForKey:keyNativeCheckIncomplete] != nil ? 0 : 5;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delaySeconds * NSEC_PER_SEC),
                       dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            if ([self isJsCheckCompleted]) {
                // Not consuming the round: a later crash rescue may still
                // need it.
                NSLog(@"RCTPushy -- native check skipped: JS check completed in this process");
                return;
            }
            [self startRoundWithDeadline:0];
        });
    });
#endif
}

+ (void)markJsCheckCompleted:(NSString *)config {
    @synchronized (RCTPushyOrchestrator.class) {
        pushyJsCompletedConfig = [config copy];
    }
}

// True when JS already obtained a valid response in this process for the
// exact config the native round would use (§10.3): the delayed round is
// then a duplicate request. Only the scheduled round asks — the crash-rescue
// path still runs, JS is dead by then.
+ (BOOL)isJsCheckCompleted {
    NSString *jsConfig;
    @synchronized (RCTPushyOrchestrator.class) {
        jsConfig = pushyJsCompletedConfig;
    }
    if (jsConfig == nil) {
        return NO;
    }
    NSString *persisted = [PushyDefaults() stringForKey:keyNativeConfig];
    return persisted != nil && [persisted isEqualToString:jsConfig];
}

// Runs the process's single round on the calling thread if nobody has
// started it yet. deadlineUptime > 0 (crash rescue) caps every HTTP call and
// download phase to the remaining budget.
+ (void)startRoundWithDeadline:(NSTimeInterval)deadlineUptime {
    bool expected = false;
    if (!pushyRoundStarted.compare_exchange_strong(expected, true)) {
        return;
    }
    @try {
        [self runOnce:pushyLaunchRolledBackForRescue deadline:deadlineUptime];
    } @catch (NSException *exception) {
        // The rescue path must never take the app down with it.
        RCTLogWarn(@"RCTPushy -- native check crashed: %@", exception.reason);
    } @finally {
        pushyRoundCompleted.store(true);
        dispatch_semaphore_signal(pushyRoundDone);
    }
}

// Crash-rescue entry (§11.3), called from the handler's worker queue while
// the uncaught-exception handler holds the dying process. Ensures this
// process's round runs to completion within the budget, then activates a
// downloaded-but-unactivated version if one exists — the last chance before
// the process is gone.
+ (void)runRescueWithDeadline:(NSTimeInterval)deadlineUptime {
    pushyCrashRescueActive.store(true);
    [self startRoundWithDeadline:deadlineUptime];
    if (!pushyRoundCompleted.load()) {
        NSTimeInterval remaining = deadlineUptime - PushyMonotonicNow();
        if (remaining > 0) {
            dispatch_semaphore_wait(pushyRoundDone, dispatch_time(DISPATCH_TIME_NOW,
                (int64_t)(remaining * NSEC_PER_SEC)));
        }
    }
    [self activatePendingVersion];
}

// The alert-strategy variant of the §10.7 hole: the round downloaded a fix
// but deferred activation to JS, and JS is now dead. Activation is local and
// bounded (a state switch under the commit lock).
+ (void)activatePendingVersion {
    NSString *hash = nil;
    uint64_t generation = 0;
    @synchronized (self) {
        hash = pushyUnactivatedHash;
        generation = pushyUnactivatedGeneration;
    }
    if (hash == nil) {
        return;
    }
    // Unlike Android's switchVersion, PushySwitchVersionLocked does not
    // validate the version directory; never point the next launch at bytes
    // that are gone (e.g. wiped by a reset whose generation bump we would
    // catch below anyway, or by cleanup).
    NSString *versionDir = [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
    if (!PushyHasCompletedVersionAtPath(versionDir, hash)) {
        NSLog(@"RCTPushy -- crash rescue: version %@ no longer on disk, dropping activation", hash);
        return;
    }
    NSDictionary *hashInfoEntry = nil;
    NSString *existingInfo = [PushyDefaults() stringForKey:PushyHashInfoKey(hash)];
    NSData *existingData = [existingInfo dataUsingEncoding:NSUTF8StringEncoding];
    id parsed = existingData == nil ? nil :
        [NSJSONSerialization JSONObjectWithData:existingData options:0 error:nil];
    if ([parsed isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *merged = [parsed mutableCopy];
        merged[@"crashRescue"] = @YES;
        hashInfoEntry = @{@"hash": hash, @"info": merged};
    }
    BOOL committed = [self commitRoundWithGeneration:generation
                                            hashInfo:hashInfoEntry
                                            activate:hash
                                        responseText:nil
                                             request:nil
                                              config:nil
                                          responseAt:0];
    if (committed) {
        @synchronized (self) {
            pushyUnactivatedHash = nil;
        }
        NSLog(@"RCTPushy -- crash rescue: activated downloaded version %@", hash);
    } else {
        NSLog(@"RCTPushy -- crash rescue: reset since download, dropping activation");
    }
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

+ (void)runOnce:(NSString *)launchRolledBackVersion deadline:(NSTimeInterval)deadlineUptime {
    // Sampled before any IO: resetToPackagedBundle bumps it, and a reset that
    // lands while this round is running must win over the round's decision.
    const uint64_t resetGeneration = pushyResetGeneration.load();
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
    // From here on the round does real work: leave the breadcrumb that the
    // next launch reads to skip its 5s delay if we die mid-round (§11.4).
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

+ (void)runConfiguredRound:(const flowjson::Value &)config
                configJson:(NSString *)configJson
                    appKey:(NSString *)appKey
   launchRolledBackVersion:(NSString *)launchRolledBackVersion
           resetGeneration:(uint64_t)resetGeneration
                  deadline:(NSTimeInterval)deadlineUptime {
    NSUserDefaults *defaults = PushyDefaults();
    NSString *packageVersion =
        PushyFromStdString(config.Get("packageVersion").AsString());
    if (packageVersion.length == 0) {
        packageVersion = [RCTPushy packageVersion];
    }

    __block NSString *currentVersion = nil;
    PushyWithStateLock(^{
        pushy::state::State state = PushyStateFromDefaults(PushyDefaults());
        currentVersion = PushyFromStdString(state.current_version);
    });
    NSString *rolledBackVersion = launchRolledBackVersion;
    NSString *uuid = [defaults stringForKey:keyUuid] ?: @"";

    flowjson::Value identity = flowjson::Value::Object();
    identity.Set("packageVersion",
                 flowjson::Value::String(PushyToStdString(packageVersion)));
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
    if (body == nil) {
        RCTLogWarn(@"RCTPushy -- native check: request body is not valid UTF-8");
        return;
    }

    NSString *responseText = [self runCheckRequest:config
                                            appKey:appKey
                                              body:body
                                          deadline:deadlineUptime];
    if (responseText == nil) {
        RCTLogInfo(@"RCTPushy -- native check: no endpoint reachable, giving up until next launch");
        return;
    }
    long long responseAtSeconds = (long long)[[NSDate date] timeIntervalSince1970];

    flowjson::Value decision = updateflow::HandleCheckResponse(
        PushyToStdString(responseText), identity, false,
        config.Get("afterDownload").AsString());
    if (decision.Get("action").AsString() != "download") {
        [self commitRoundWithGeneration:resetGeneration
                               hashInfo:nil
                               activate:nil
                           responseText:responseText
                                request:body
                                 config:configJson
                             responseAt:responseAtSeconds];
        RCTLogInfo(@"RCTPushy -- native check: nothing to do (%s)",
                   decision.Get("reason").AsString().c_str());
        return;
    }
    NSString *hash = PushyFromStdString(decision.Get("hash").AsString());
    if (!PushyIsSafePathComponent(hash)) {
        return;
    }

    NSString *versionDir = [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
    BOOL downloaded = PushyHasCompletedVersionAtPath(versionDir, hash);
    if (!downloaded) {
        downloaded = [self performAttempts:decision.Get("attempts")
                                      hash:hash
                                originHash:currentVersion
                                  deadline:deadlineUptime];
    }
    if (!downloaded) {
        [self commitRoundWithGeneration:resetGeneration
                               hashInfo:nil
                               activate:nil
                           responseText:responseText
                                request:body
                                 config:configJson
                             responseAt:responseAtSeconds];
        return;
    }

    // Persist name/description/metaInfo alongside the version, mirroring the
    // JS side's setLocalHashInfo after a successful download.
    const flowjson::Value &info = decision.Get("info");
    NSMutableDictionary *versionInfo = [NSMutableDictionary dictionary];
    for (const char *key : {"name", "description", "metaInfo"}) {
        if (info.Get(key).IsString()) {
            versionInfo[@(key)] = PushyFromStdString(info.Get(key).AsString()) ?: @"";
        }
    }
    // A forceBoot activation is the brick-rescue path: mark it in the
    // persisted info so JS can report force_boot_rescue when this version
    // survives to markSuccess. Only the server-sent directive counts — a
    // silent-strategy activation is ordinary delivery.
    if (info.Get("config").Get("forceBoot").Truthy()) {
        versionInfo[@"forceBootRescue"] = @YES;
    }
    if (pushyCrashRescueActive.load()) {
        versionInfo[@"crashRescue"] = @YES;
    }
    // Silent strategies or a server-marked forceBoot version (per-version
    // remote override — the brick rescue) activate for the next launch;
    // otherwise activation stays with the JS side (§6/§10.1). Unless a crash
    // is being held: JS is dead, deferring to it would leave the fix on disk
    // forever (§11.3).
    BOOL activate = decision.Get("activate").Truthy() || pushyCrashRescueActive.load();
    BOOL committed = [self commitRoundWithGeneration:resetGeneration
                                            hashInfo:@{@"hash": hash, @"info": versionInfo}
                                            activate:activate ? hash : nil
                                        responseText:responseText
                                             request:body
                                              config:configJson
                                          responseAt:responseAtSeconds];
    if (!committed) {
        RCTLogInfo(@"RCTPushy -- native check: reset during round, dropping result");
    } else if (activate) {
        @synchronized (self) {
            pushyUnactivatedHash = nil;
        }
        RCTLogInfo(@"RCTPushy -- native check: downloaded %@ and set for next launch", hash);
    } else {
        // Remembered so a crash later in this process can still activate it
        // (activatePendingVersion) — JS never will.
        @synchronized (self) {
            pushyUnactivatedHash = [hash copy];
            pushyUnactivatedGeneration = resetGeneration;
        }
        RCTLogInfo(@"RCTPushy -- native check: downloaded %@, activation left to JS", hash);
    }
}

// Everything a round persists — version info, the activation, the response
// cache — is written inside ONE state-lock acquisition that first re-checks the
// reset generation. resetToPackagedBundle bumps that generation under the same
// lock, so there is no compare-and-act window: either the whole round commits,
// or the reset wins and none of it does.
+ (BOOL)commitRoundWithGeneration:(uint64_t)generation
                         hashInfo:(NSDictionary *)hashInfoEntry
                         activate:(NSString *)hashToActivate
                     responseText:(NSString *)responseText
                          request:(NSString *)requestBody
                           config:(NSString *)configJson
                       responseAt:(long long)responseAtSeconds {
    // responseText is nil for the crash handler's activation-only commit
    // (activatePendingVersion): no round ran, so there is no cache to write.
    NSData *cacheData = nil;
    if (responseText != nil) {
        NSDictionary *cacheEntry = @{
            @"ts": @(responseAtSeconds),
            @"body": responseText,
            @"request": requestBody,
            @"config": configJson,
        };
        cacheData = [NSJSONSerialization dataWithJSONObject:cacheEntry options:0 error:nil];
    }
    __block BOOL committed = NO;
    PushyWithStateLock(^{
        if (pushyResetGeneration.load() != generation) {
            return;
        }
        NSUserDefaults *defaults = PushyDefaults();
        if (hashInfoEntry != nil) {
            NSData *infoData = [NSJSONSerialization dataWithJSONObject:hashInfoEntry[@"info"]
                                                              options:0
                                                                error:nil];
            if (infoData != nil) {
                [defaults setObject:[[NSString alloc] initWithData:infoData encoding:NSUTF8StringEncoding]
                             forKey:PushyHashInfoKey(hashInfoEntry[@"hash"])];
            }
        }
        if (hashToActivate != nil) {
            PushySwitchVersionLocked(hashToActivate);
        }
        if (cacheData != nil) {
            [defaults setObject:[[NSString alloc] initWithData:cacheData encoding:NSUTF8StringEncoding]
                         forKey:keyNativeCheckCache];
        }
        committed = YES;
    });
    return committed;
}

// Sequential fallback over the ordered candidates (§5.1): one request at a
// time with its own timeout; after the configured round fails, queryUrls
// discovery merges remote candidates (excluding the already-tried) for one
// more round. No hedged race on purpose — this path is latency-insensitive.
// Per-request timeout, capped to the crash-rescue budget when one is active.
// <= 0 means the budget is gone and the round must stop issuing requests.
static NSTimeInterval PushyCheckRequestTimeout(NSTimeInterval deadlineUptime) {
    if (deadlineUptime <= 0) {
        return 10;
    }
    return MIN(10, deadlineUptime - PushyMonotonicNow());
}

+ (NSString *)runCheckRequest:(const flowjson::Value &)config
                       appKey:(NSString *)appKey
                         body:(NSString *)body
                     deadline:(NSTimeInterval)deadlineUptime {
    double sample = arc4random() / 4294967296.0;
    flowjson::Value ordered =
        updateflow::OrderEndpointCandidates(config.Get("endpoints"), sample);
    NSMutableSet<NSString *> *tried = [NSMutableSet set];
    const NSUInteger maxHttpAttempts = 8;
    NSUInteger httpAttempts = 0;
    for (const auto &endpoint : ordered.elements()) {
        NSString *base = PushyNormalizeEndpointBase(
            PushyFromStdString(endpoint.AsString()));
        if (base.length == 0 || [tried containsObject:base]) {
            continue;
        }
        if (httpAttempts++ >= maxHttpAttempts) {
            return nil;
        }
        [tried addObject:base];
        NSTimeInterval timeout = PushyCheckRequestTimeout(deadlineUptime);
        if (timeout <= 0) {
            return nil;
        }
        NSString *response = PushyHttpRequest(
            [NSString stringWithFormat:@"%@/checkUpdate/%@", base, appKey],
            @"POST", body, timeout);
        if (PushyIsValidCheckResponse(response)) {
            return response;
        }
    }
    for (const auto &queryUrl : config.Get("queryUrls").elements()) {
        NSString *listUrl = PushyFromStdString(queryUrl.AsString());
        if (listUrl == nil) {
            continue;
        }
        if (httpAttempts++ >= maxHttpAttempts) {
            return nil;
        }
        NSTimeInterval listTimeout = PushyCheckRequestTimeout(deadlineUptime);
        if (listTimeout <= 0) {
            return nil;
        }
        NSString *listText = PushyHttpRequest(listUrl, @"GET", nil, listTimeout);
        if (listText == nil) {
            continue;
        }
        bool ok = false;
        flowjson::Value remote = flowjson::Parse(PushyToStdString(listText), &ok);
        if (!ok || !remote.IsArray()) {
            continue;
        }
        for (const auto &endpoint : remote.elements()) {
            NSString *base = PushyNormalizeEndpointBase(
                PushyFromStdString(endpoint.AsString()));
            if (base.length == 0 || [tried containsObject:base]) {
                continue;
            }
            if (httpAttempts++ >= maxHttpAttempts) {
                return nil;
            }
            [tried addObject:base];
            NSTimeInterval timeout = PushyCheckRequestTimeout(deadlineUptime);
            if (timeout <= 0) {
                return nil;
            }
            NSString *response = PushyHttpRequest(
                [NSString stringWithFormat:@"%@/checkUpdate/%@", base, appKey],
                @"POST", body, timeout);
            if (PushyIsValidCheckResponse(response)) {
                return response;
            }
        }
        break;  // one successfully fetched remote list is enough
    }
    return nil;
}

+ (BOOL)performAttempts:(const flowjson::Value &)attempts
                   hash:(NSString *)hash
             originHash:(NSString *)originHash
               deadline:(NSTimeInterval)rescueDeadline {
    RCTPushy *engine = [self engine];
    // Crash-rescue budget caps every phase; 0 keeps the normal 10min windows.
    NSTimeInterval incrementalDeadline = PushyMonotonicNow() + 600;
    if (rescueDeadline > 0) {
        incrementalDeadline = MIN(incrementalDeadline, rescueDeadline);
    }
    NSTimeInterval fullDeadline = 0;
    for (const auto &attempt : attempts.elements()) {
        const std::string &type = attempt.Get("type").AsString();
        PushyType pushyType = type == "diff" ? PushyTypePatchFromPpk
                            : type == "pdiff" ? PushyTypePatchFromPackage
                                              : PushyTypeFullDownload;
        if (pushyType == PushyTypePatchFromPpk && originHash.length == 0) {
            continue;  // diff patches from the running version; none running
        }
        BOOL isFullAttempt = pushyType == PushyTypeFullDownload;
        if (isFullAttempt && fullDeadline == 0) {
            // diff/pdiff cannot starve the last-resort full download.
            fullDeadline = PushyMonotonicNow() + 600;
            if (rescueDeadline > 0) {
                fullDeadline = MIN(fullDeadline, rescueDeadline);
            }
        }
        NSTimeInterval deadline = isFullAttempt ? fullDeadline : incrementalDeadline;
        for (const auto &urlValue : attempt.Get("urls").elements()) {
            NSString *url = PushyFromStdString(urlValue.AsString());
            if (url == nil) {
                continue;
            }
            NSTimeInterval remaining = deadline - PushyMonotonicNow();
            if (remaining <= 0) {
                if (isFullAttempt) {
                    return NO;
                }
                break;
            }
            NSMutableDictionary *options =
                [@{
                    @"updateUrl": url,
                    @"hash": hash,
                    @"deadlineUptime": @(deadline),
                } mutableCopy];
            if (pushyType == PushyTypePatchFromPpk) {
                options[@"originHash"] = originHash;
            }
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            __block NSError *resultError = nil;
            [engine performUpdate:pushyType options:options callback:^(NSError *error) {
                resultError = error;
                dispatch_semaphore_signal(sem);
            }];
            if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW,
                    (int64_t)(remaining * NSEC_PER_SEC))) != 0) {
                RCTLogWarn(@"RCTPushy -- native check: %s attempt timed out", type.c_str());
                if (isFullAttempt) {
                    return NO;
                }
                break;
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
