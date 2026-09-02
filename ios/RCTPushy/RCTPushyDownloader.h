#import <Foundation/Foundation.h>

// Path of the resume sidecar that records what a partial download at
// `savePath` belongs to (url + validators + total). Shared with the unzip
// step, which must drop it together with the archive it vouches for.
FOUNDATION_EXPORT NSString *RCTPushyResumeSidecarPath(NSString *savePath);

// Size of the file at `path` in bytes; -1 when it cannot be read.
FOUNDATION_EXPORT long long RCTPushyFileSize(NSString *path);

// nil when the volume holding `path` can take `bytesToWrite` plus the
// cpp/patch_core/archive_limits.h safety margin (or the free space is
// unknown); the reason otherwise. `path` need not exist yet — the check walks
// up to an existing ancestor.
FOUNDATION_EXPORT NSString *RCTPushyFreeSpaceShortfall(NSString *path, long long bytesToWrite);

@interface RCTPushyDownloader : NSObject

+ (void)download:(NSString *)downloadPath savePath:(NSString *)savePath
    timeoutInterval:(NSTimeInterval)timeoutInterval
    progressHandler:(void (^)(long long, long long))progressHandler
completionHandler:(void (^)(NSString *path, NSError *error))completionHandler;

@end
