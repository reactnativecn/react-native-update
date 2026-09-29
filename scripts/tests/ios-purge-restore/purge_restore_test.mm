// Foundation-only host for the UNMODIFIED production methods extracted at build
// time. The state lock, defaults transitions, launch resolution, restore window,
// commit and reset bodies all come from RCTPushy.mm; see README.md for the seams.
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <os/lock.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include "cpp/patch_core/state_core.h"
#include "cpp/patch_core/patch_core.h"
#include "cpp/patch_core/error_codes.h"
#include "ios/RCTPushy/RCTPushyConfiguration.h"

#undef TARGET_OS_TV
#define TARGET_OS_TV 1
#undef DEBUG
#define DEBUG 0

typedef void (^RCTPromiseResolveBlock)(id);
typedef void (^RCTPromiseRejectBlock)(NSString *, NSString *, NSError *);
#define RCT_EXPORT_METHOD(method) - (void)method
static void TestLog(NSString *, ...) {}
#define RCTLogInfo TestLog
#define RCTLogWarn TestLog
#define RCTLogError TestLog

#include "globals.inc"

static const char *testName = "setup";
static void Expect(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "[FAIL] %s: %s\n", testName, message);
        std::fflush(stderr);
        std::_Exit(1);
    }
}

// These timeouts are deadlock guards, NOT scheduling delays. Every ordering is
// established by a semaphore handshake; there are no sleeps/network requests.
static void Signal(dispatch_semaphore_t gate) { dispatch_semaphore_signal(gate); }
static void Await(dispatch_semaphore_t gate, const char *description) {
    Expect(dispatch_semaphore_wait(gate, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0,
           description);
}

enum class Actor { None, Commit, Reset };
enum class Order { CloseFirst, CommitBeforeSignal, ResetFirst, CommitFirst, CompleteInTime };
static thread_local Actor actor = Actor::None;
static std::atomic<Actor> pausedActor{Actor::None};
static std::atomic<bool> pauseNextWrite{false};
static dispatch_semaphore_t writeLocked, releaseWrite;
static dispatch_semaphore_t requestStarted, allowCommit, commitAttempted, commitFinished;
static dispatch_semaphore_t signalAttempted, allowSignal, workerSettled;
static dispatch_semaphore_t resetAttempted, resetFinished;
static Order order;
static uint64_t requestGeneration;
static BOOL roundCommitted, roundActivated;
static BOOL resetResolved;
static int scheduleCount;
static int64_t waitBudget;
static NSString *root;

// In-memory collaborator, deliberately NOT an NSUserDefaults subclass: inherited
// accessors could otherwise reach real preferences without ObserveWrite(). Only
// explicitly modelled selectors are supported. Every mutation still holds the
// REAL production lock; pausing one write fixes the competing operation's order.
@interface TestDefaults : NSObject {
    NSMutableDictionary<NSString *, id> *_values;
}
- (void)setObject:(id)value forKey:(NSString *)key;
- (void)removeObjectForKey:(NSString *)key;
- (id)objectForKey:(NSString *)key;
- (NSString *)stringForKey:(NSString *)key;
- (NSDictionary *)dictionaryForKey:(NSString *)key;
- (NSDictionary<NSString *, id> *)dictionaryRepresentation;
@end

static void ObserveWrite(void) {
    os_unfair_lock_assert_owner(&pushyStateLock);
    if (actor == pausedActor.load() && pauseNextWrite.exchange(false)) {
        Signal(writeLocked);
        Await(releaseWrite, "release a paused state write");
    }
}

@implementation TestDefaults
- (instancetype)init {
    self = [super init];
    if (self) { _values = [NSMutableDictionary new]; }
    return self;
}
- (void)setObject:(id)value forKey:(NSString *)key { ObserveWrite(); _values[key] = value; }
- (void)removeObjectForKey:(NSString *)key { ObserveWrite(); [_values removeObjectForKey:key]; }
- (id)objectForKey:(NSString *)key { return _values[key]; }
- (NSString *)stringForKey:(NSString *)key {
    id value = _values[key];
    return [value isKindOfClass:NSString.class] ? value : nil;
}
- (NSDictionary *)dictionaryForKey:(NSString *)key {
    id value = _values[key];
    return [value isKindOfClass:NSDictionary.class] ? value : nil;
}
- (NSDictionary<NSString *, id> *)dictionaryRepresentation { return [_values copy]; }
- (void)doesNotRecognizeSelector:(SEL)selector {
    // Fail even if product code catches Objective-C exceptions. Dynamic sends
    // must not fall through to a real defaults domain or turn into a passed test.
    std::string message = "unsupported TestDefaults selector: ";
    message += NSStringFromSelector(selector).UTF8String;
    Expect(false, message.c_str());
}
@end

// Type substitution is confined to this test translation unit, AFTER Foundation
// is imported. The extracted bodies stay unchanged, but a newly used defaults
// selector must be explicitly implemented here rather than inherited silently.
#define NSUserDefaults TestDefaults

// Compile-only contract probes, enabled individually by the runner. Ordinary
// warnings must remain non-fatal; unmodelled selectors must fail compilation.
#if defined(TEST_DEFAULTS_READ_PROBE)
static BOOL DefaultsReadProbe(NSUserDefaults *defaults) {
    return [defaults boolForKey:@"probe"];
}
#elif defined(TEST_DEFAULTS_WRITE_PROBE)
static void DefaultsWriteProbe(NSUserDefaults *defaults) {
    [defaults setBool:YES forKey:@"probe"];
}
#elif defined(TEST_HARMLESS_WARNING_PROBE)
#warning PUSHY_TEST_HARMLESS_WARNING
#endif

static TestDefaults *testDefaults;
static NSUserDefaults *PushyDefaults(void) { return testDefaults; }
static NSTimeInterval PushyMonotonicNow(void) { return 100; }
static NSError *PushyErrorWithCode(const char *code, NSString *message) {
    return [NSError errorWithDomain:@(code) code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}
static void PushyRejectError(RCTPromiseRejectBlock reject, NSError *error) {
    reject(error.domain, error.localizedDescription, error);
}

// Filesystem cleanup is not under test. Keep the real declaration/return type;
// the real reset body (including its asynchronous completion) still executes.
namespace pushy { namespace delta {
Status CleanupOldEntries(const std::string&, const std::vector<std::string>&,
                         int max_age_days, std::time_t) {
    Expect(max_age_days == 0, "reset requests a full cleanup");
    return {true, ""};
}
}}

@interface RCTPushy : NSObject {
    dispatch_queue_t _fileQueue;
}
+ (NSURL *)bundleURL;
+ (NSURL *)resolveLaunchBundleURL:(NSString **)rolledBack purgedVersion:(NSString **)purged;
+ (NSURL *)binaryBundleURL;
+ (NSString *)packageVersion;
+ (NSString *)buildTime;
+ (NSString *)downloadDir;
- (void)resetToPackagedBundle:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
@end

@interface RCTPushyOrchestrator : NSObject
+ (void)prepareProcess:(NSString *)rolledBack;
+ (BOOL)hasRunnableConfig;
+ (void)scheduleFromColdStart:(NSString *)rolledBack;
+ (void)startRoundWithDeadline:(NSTimeInterval)deadline;
+ (BOOL)restorePurgedLaunch:(NSString *)purged rolledBack:(NSString *)rolledBack;
+ (BOOL)commitRoundWithGeneration:(uint64_t)generation
                         hashInfo:(NSDictionary *)hashInfo
                         activate:(NSString *)hash
                     responseText:(NSString *)response
                          request:(NSString *)request
                           config:(NSString *)config
                       responseAt:(long long)responseAt
                        activated:(BOOL *)activated;
@end

#include "helpers.inc"

static RCTPushy *engine;

static void StartReset(void) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            actor = Actor::Reset;
            Signal(resetAttempted);
            [engine resetToPackagedBundle:^(id result) {
                resetResolved = [result boolValue];
                Signal(resetFinished);
            } rejecter:^(NSString *, NSString *message, NSError *) {
                std::fprintf(stderr, "reset rejected: %s\n", message.UTF8String);
                Expect(false, "reset must resolve successfully");
            }];
            actor = Actor::None;
        }
    });
}

// Only the restore method's launch wait is replaced. Its dispatch_async remains
// real: the worker captures its generation, blocks at the response boundary, and
// eventually calls the real commit method on a DIFFERENT thread.
static long TestLaunchWait(dispatch_semaphore_t done, dispatch_time_t) {
    Await(requestStarted, "round captured its generation before the launch wait");
    switch (order) {
        case Order::CloseFirst:
            return 1;  // timeout while the response is still held
        case Order::CommitBeforeSignal:
            Signal(allowCommit);
            break;
        case Order::ResetFirst:
            pausedActor.store(Actor::Reset);
            pauseNextWrite.store(true);
            StartReset();
            Await(writeLocked, "reset owns the state lock");
            Signal(allowCommit);
            Await(commitAttempted, "stale commit starts while reset holds the lock");
            Signal(releaseWrite);
            Await(resetFinished, "reset finished");
            break;
        case Order::CommitFirst:
            pausedActor.store(Actor::Commit);
            pauseNextWrite.store(true);
            Signal(allowCommit);
            Await(writeLocked, "commit owns the state lock");
            StartReset();
            Await(resetAttempted, "reset starts while commit holds the lock");
            Signal(releaseWrite);
            Await(resetFinished, "reset finished after the commit");
            break;
        case Order::CompleteInTime:
            Signal(allowCommit);
            Signal(allowSignal);
            Await(done, "restore completion delivered before timeout");
            return 0;
    }
    Await(commitFinished, "commit finished before synthetic timeout");
    Await(signalAttempted, "worker reached, but has not delivered, the done signal");
    return 1;
}

static long TestCompletionSignal(dispatch_semaphore_t done) {
    Signal(signalAttempted);
    Await(allowSignal, "release the deliberately delayed completion signal");
    long result = dispatch_semaphore_signal(done);
    Signal(workerSettled);
    return result;
}

static dispatch_time_t TestLaunchDeadline(dispatch_time_t when, int64_t delta) {
    Expect(when == DISPATCH_TIME_NOW, "launch wait uses a relative budget");
    waitBudget = delta;
    return dispatch_time(when, delta);
}

@implementation RCTPushy
- (instancetype)init {
    self = [super init];
    if (self) { _fileQueue = dispatch_queue_create("pushy.test.files", DISPATCH_QUEUE_SERIAL); }
    return self;
}
+ (NSURL *)binaryBundleURL { return [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"packaged.bundle"]]; }
+ (NSString *)packageVersion { return @"1.0"; }
+ (NSString *)buildTime { return @"123"; }
+ (NSString *)downloadDir { return [root stringByAppendingPathComponent:@"updates"]; }
#include "pushy.inc"
@end

@implementation RCTPushyOrchestrator
+ (void)prepareProcess:(NSString *)rolledBack { (void)rolledBack; }
+ (BOOL)hasRunnableConfig { return YES; }
+ (void)scheduleFromColdStart:(NSString *)rolledBack { (void)rolledBack; ++scheduleCount; }
+ (void)startRoundWithDeadline:(NSTimeInterval)deadline {
    @autoreleasepool {
        actor = Actor::Commit;
        Expect(deadline == 100 + kPushyPurgeRestoreBudget, "round receives the launch deadline");
        requestGeneration = pushyResetGeneration.load();
        Signal(requestStarted);
        Await(allowCommit, "release the native check response");
        Signal(commitAttempted);
        // B represents an already-complete on-disk download. Do not reproduce
        // the activation policy here: the production commit must enforce it.
        roundCommitted = [self commitRoundWithGeneration:requestGeneration
            hashInfo:@{@"hash": @"B", @"info": @{@"name": @"B", @"forceBootRescue": @YES}}
            activate:@"B" responseText:@"{\"update\":true,\"hash\":\"B\"}"
            request:@"request" config:@"config" responseAt:123 activated:&roundActivated];
        pushyHostRoundResult = @{@"status": @"test", @"reason": @"", @"hash": @"B"};
        Signal(commitFinished);
        actor = Actor::None;
    }
}
#define dispatch_semaphore_wait TestLaunchWait
#define dispatch_semaphore_signal TestCompletionSignal
#define dispatch_time TestLaunchDeadline
#include "orchestrator.inc"
#undef dispatch_time
#undef dispatch_semaphore_signal
#undef dispatch_semaphore_wait
@end

static void SetUp(Order selected) {
    order = selected;
    actor = Actor::None;
    pausedActor.store(Actor::None);
    pauseNextWrite.store(false);
    writeLocked = dispatch_semaphore_create(0);
    releaseWrite = dispatch_semaphore_create(0);
    requestStarted = dispatch_semaphore_create(0);
    allowCommit = dispatch_semaphore_create(0);
    commitAttempted = dispatch_semaphore_create(0);
    commitFinished = dispatch_semaphore_create(0);
    signalAttempted = dispatch_semaphore_create(0);
    allowSignal = dispatch_semaphore_create(0);
    workerSettled = dispatch_semaphore_create(0);
    resetAttempted = dispatch_semaphore_create(0);
    resetFinished = dispatch_semaphore_create(0);
    roundCommitted = NO;
    roundActivated = YES;  // rejected commits must explicitly overwrite this
    resetResolved = NO;
    scheduleCount = 0;
    waitBudget = 0;
    testDefaults = [TestDefaults new];
    engine = [RCTPushy new];
    root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString *versionDir = [[RCTPushy downloadDir] stringByAppendingPathComponent:@"B"];
    Expect([[NSFileManager defaultManager] createDirectoryAtPath:versionDir
         withIntermediateDirectories:YES attributes:nil error:NULL], "create B fixture directory");
    Expect([@"B" writeToFile:[versionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME]
         atomically:YES encoding:NSUTF8StringEncoding error:NULL], "create B fixture bundle");
    Expect([@"packaged" writeToURL:[RCTPushy binaryBundleURL]
         atomically:YES encoding:NSUTF8StringEncoding error:NULL], "create packaged fixture bundle");
    PushyWithStateLock(^{
        pushyResetGeneration.store(0);
        ignoreRollback.store(false);
        pushyIsUsingBundleUrl.store(false);
        pushyLaunchVersion = nil;
        pushyCrashHoldActive.store(false);
        pushyPurgeRestoreActive.store(false);
        pushyPurgeRestoreWindowOpen = false;
        pushyHostRoundResult = nil;
        pushy::state::State state;
        state.package_version = "1.0";
        state.build_time = "123";
        state.current_version = "A";  // A is purged; B remains complete on disk
        PushyApplyStateToDefaults(testDefaults, state);
        [testDefaults setObject:@"installation-uuid" forKey:keyUuid];
    });
}

static pushy::state::State State(void) {
    __block pushy::state::State state;
    PushyWithStateLock(^{ state = PushyStateFromDefaults(testDefaults); });
    return state;
}

static id Value(NSString *key) {
    __block id value;
    PushyWithStateLock(^{ value = [testDefaults objectForKey:key]; });
    return value;
}

static NSDictionary *Info(void) {
    NSString *json = Value(PushyHashInfoKey(@"B"));
    return json == nil ? nil : [NSJSONSerialization JSONObjectWithData:
        [json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
}

static void ExpectPackaged(NSURL *url) {
    Expect([url isEqual:[RCTPushy binaryBundleURL]], "launch must use packaged bundle");
    auto state = State();
    Expect(state.current_version.empty(), "packaged launch must not select B");
    Expect(state.last_version.empty(), "packaged launch must have no stale last version");
    Expect(!state.first_time && state.first_time_ok, "packaged launch must not arm first load");
    Expect(state.rolled_back_version.empty(), "purge must not add a rollback mark");
    Expect(Value(keyFirstLoadMarked) == nil, "packaged launch must not report isFirstTime");
    Expect(pushyLaunchVersion == nil, "packaged launch must not claim B ran");
}

static void ExpectRestored(NSURL *url) {
    Expect([url.path isEqualToString:[[[RCTPushy downloadDir] stringByAppendingPathComponent:@"B"]
        stringByAppendingPathComponent:BUNDLE_FILE_NAME]], "must re-resolve B even when done signal is late");
    auto state = State();
    Expect(state.current_version == "B", "state must select the launched B");
    Expect(!state.first_time && !state.first_time_ok, "B first load must be consumed but not acknowledged");
    Expect([Value(keyFirstLoadMarked) boolValue], "B launch must report isFirstTime");
    Expect([pushyLaunchVersion isEqualToString:@"B"], "running bundle identity must be B");
    Expect([Info()[@"purgeRestore"] boolValue], "in-window activation must record purgeRestore");
    Expect([Info()[@"forceBootRescue"] boolValue], "other metadata must survive the commit");
    Expect(Value(keyNativeCheckCache) != nil, "successful round must cache its response");
}

static void Finish(void) {
    if (order != Order::CompleteInTime) { Signal(allowSignal); }
    Await(workerSettled, "worker's delayed signal delivered before teardown");
    Expect(waitBudget == (int64_t)(12 * NSEC_PER_SEC), "launch wait must stay at 12 seconds, not 13");
    Expect(scheduleCount == 1, "bundleURL must retain its finally scheduling path");
    Expect(!pushyPurgeRestoreWindowOpen, "every completed launch must close its restore window");
    Expect([[NSFileManager defaultManager] removeItemAtPath:root error:NULL], "remove fixture files");
}

static void LateCommit(void) {
    SetUp(Order::CloseFirst);
    NSURL *url = [RCTPushy bundleURL];
    ExpectPackaged(url);
    Signal(allowCommit);
    Await(commitFinished, "late response committed");
    Await(signalAttempted, "late round reached its done signal");
    Expect(roundCommitted && !roundActivated, "late round may persist its response but must not activate");
    ExpectPackaged(url);
    Expect(Value(keyNativeCheckCache) != nil, "late response remains available to JS");
    Expect(Info() != nil && Info()[@"purgeRestore"] == nil, "non-activation must not claim purgeRestore");
    Finish();
}

static void CommitBeforeSignal(void) {
    SetUp(Order::CommitBeforeSignal);
    NSURL *url = [RCTPushy bundleURL];
    Expect(roundCommitted && roundActivated, "commit won the restore window");
    ExpectRestored(url);
    Finish();
}

static void ResetOrdering(Order selected) {
    SetUp(selected);
    NSURL *url = [RCTPushy bundleURL];
    Expect(resetResolved, "reset promise must resolve after its file queue work");
    Expect(pushyResetGeneration.load() == 1 && requestGeneration == 0, "reset must invalidate the captured generation");
    if (selected == Order::ResetFirst) {
        Expect(!roundCommitted && !roundActivated, "stale generation must reject ALL commit writes");
    } else {
        Expect(roundCommitted && roundActivated, "earlier commit must succeed before reset clears it");
    }
    ExpectPackaged(url);
    Expect(Value(PushyHashInfoKey(@"B")) == nil, "reset must leave no version metadata");
    Expect(Value(keyNativeCheckCache) == nil, "reset must leave no response cache");
    Expect([Value(keyUuid) isEqual:@"installation-uuid"], "reset must preserve install identity");
    Finish();
}

static void CompleteInTime(void) {
    SetUp(Order::CompleteInTime);
    ExpectRestored([RCTPushy bundleURL]);
    Expect(roundCommitted && roundActivated, "ordinary in-window restore must still activate");
    Finish();
}

// This contract test deliberately does not call SetUp: a new collaborator must
// start empty on its own, not only because the fixture reset some known keys.
static void DefaultsIsolation(void) {
    TestDefaults *first = [TestDefaults new];
    TestDefaults *second = [TestDefaults new];
    Expect(![first isKindOfClass:NSClassFromString(@"NSUserDefaults")],
           "test defaults must not inherit real preferences storage");
    PushyWithStateLock(^{
        [first setObject:@"value" forKey:@"key"];
        [first setObject:@{@"nested": @YES} forKey:@"dictionary"];
        Expect([[first stringForKey:@"key"] isEqual:@"value"], "string accessor uses memory");
        Expect([[first dictionaryForKey:@"dictionary"][@"nested"] boolValue],
               "dictionary accessor uses memory");
        NSDictionary *snapshot = [first dictionaryRepresentation];
        [first removeObjectForKey:@"key"];
        Expect([first objectForKey:@"key"] == nil, "remove accessor uses memory");
        Expect([snapshot[@"key"] isEqual:@"value"], "dictionary snapshot is independent");
        Expect([second dictionaryRepresentation].count == 0, "instances must not share defaults");
    });
}

int main(int argc, char **argv) {
    @autoreleasepool {
        // These intentional failures run in separate processes. Erasing the
        // static type also checks the runtime backstop, not just the compiler.
        if (argc > 1 && (std::string(argv[1]) == "unsupported_defaults_read" ||
                         std::string(argv[1]) == "unsupported_defaults_write")) {
            testName = argv[1];
            id defaults = [TestDefaults new];
            if (std::string(argv[1]) == "unsupported_defaults_read") {
                (void)[defaults boolForKey:@"probe"];
            } else {
                PushyWithStateLock(^{ [defaults setBool:YES forKey:@"probe"]; });
            }
            Expect(false, "unsupported defaults call unexpectedly returned");
        }
        testName = "defaults_isolation";
        DefaultsIsolation();
        std::printf("[PASS] defaults_isolation\n");
        struct Case { const char *name; void (*run)(); };
        const Case cases[] = {
            {"late_commit", LateCommit},
            {"commit_before_signal", CommitBeforeSignal},
            {"reset_wins", [] { ResetOrdering(Order::ResetFirst); }},
            {"commit_wins", [] { ResetOrdering(Order::CommitFirst); }},
            {"complete_in_time", CompleteInTime},
        };
        int ran = 0;
        for (const auto &test : cases) {
            if (argc > 1 && std::string(argv[1]) != test.name) { continue; }
            testName = test.name;
            test.run();
            ++ran;
            std::printf("[PASS] %s\n", test.name);
        }
        Expect(ran > 0, "unknown test case");
        std::printf("%d native purge-restore ordering tests passed\n", ran);
    }
    return 0;
}
