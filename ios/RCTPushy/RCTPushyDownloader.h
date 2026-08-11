#import <Foundation/Foundation.h>

@interface RCTPushyDownloader : NSObject

+ (void)download:(NSString *)downloadPath savePath:(NSString *)savePath
    timeoutInterval:(NSTimeInterval)timeoutInterval
    progressHandler:(void (^)(long long, long long))progressHandler
completionHandler:(void (^)(NSString *path, NSError *error))completionHandler;

@end
