#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

typedef void (^RCTPushyNativeUpdateCompletion)(NSDictionary<NSString *, id> * _Nonnull result);

@interface RCTPushy : RCTEventEmitter<RCTBridgeModule>

+ (NSURL *)bundleURL;

/**
 * Start, join, or reuse this process's native update round. Call after the
 * host's real bundleURL resolution; this method never resolves the bundle
 * again, reloads React Native, or displays UI. Configuration is the one
 * persisted by the JS SDK. The optional completion runs on the main queue.
 *
 * Result keys: status (skipped/noUpdate/downloaded/failed/cancelled), reason,
 * hash (empty when nothing was installed), activated (selected for NEXT
 * launch, not a reload of the running instance).
 */
+ (void)checkAndUpdateWithCompletion:(RCTPushyNativeUpdateCompletion _Nullable)completion
    NS_SWIFT_NAME(checkAndUpdate(completion:));

@end
