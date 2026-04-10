#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>


@interface RCTPushy : RCTEventEmitter<RCTBridgeModule>

+ (NSURL *)bundleURL;

@end
