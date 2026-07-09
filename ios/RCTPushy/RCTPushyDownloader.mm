#import "RCTPushyDownloader.h"

static NSString *const RCTPushyDownloaderErrorDomain = @"cn.reactnative.pushy";

@interface RCTPushyDownloader()<NSURLSessionDownloadDelegate>

@property (nonatomic, strong) NSURLSession *session;
@property (copy) void (^progressHandler)(long long, long long);
@property (copy) void (^completionHandler)(NSString*, NSError*);
@property (copy) NSString *savePath;
@property (nonatomic, strong) NSError *fileError;
@property (nonatomic, assign) BOOL finished;
@property (nonatomic, assign) int lastReportedPercentage;
@property (nonatomic, assign) long long lastReportedBytes;
@end

@implementation RCTPushyDownloader

+ (void)download:(NSString *)downloadPath savePath:(NSString *)savePath
progressHandler:(void (^)(long long receivedBytes, long long totalBytes))progressHandler
completionHandler:(void (^)(NSString *path, NSError *error))completionHandler
{
    NSAssert(downloadPath, @"no download path");
    NSAssert(savePath, @"no save path");

    RCTPushyDownloader *downloader = [RCTPushyDownloader new];
    downloader.progressHandler = progressHandler;
    downloader.completionHandler = completionHandler;
    downloader.savePath = savePath;

    [downloader startDownload:downloadPath];
}

- (void)startDownload:(NSString *)path
{
    NSURL *url = [NSURL URLWithString:path];
    if (url == nil) {
        [self completeWithError:[NSError errorWithDomain:RCTPushyDownloaderErrorDomain
                                                    code:-1
                                                userInfo:@{
                                                    NSLocalizedDescriptionKey: @"invalid download url",
                                                }]];
        return;
    }

    NSURLSessionConfiguration *sessionConfig = [NSURLSessionConfiguration defaultSessionConfiguration];
    // Avoid hanging forever on a stalled connection (default resource timeout
    // is 7 days). The 30s idle timeout matches Android's readTimeout and is
    // what actually catches a stalled transfer; the total-duration cap matches
    // Android's 10min callTimeout — 300s made a 30MB full package on a slow
    // (<100KB/s) network fail on iOS while succeeding on Android.
    sessionConfig.timeoutIntervalForRequest = 30;
    sessionConfig.timeoutIntervalForResource = 600;
    self.session = [NSURLSession sessionWithConfiguration:sessionConfig
                                                 delegate:self
                                            delegateQueue:nil];

    NSURLSessionDownloadTask *task = [self.session downloadTaskWithURL:url];
    [task resume];
}

- (void)completeWithError:(NSError *)error
{
    if (self.finished) {
        return;
    }
    self.finished = YES;

    void (^completionHandler)(NSString *, NSError *) = self.completionHandler;
    self.progressHandler = nil;
    self.completionHandler = nil;
    self.fileError = nil;

    [self.session finishTasksAndInvalidate];
    self.session = nil;

    if (completionHandler) {
        completionHandler(error == nil ? self.savePath : nil, error);
    }
}

#pragma mark - session delegate

- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask
      didWriteData:(int64_t)bytesWritten
 totalBytesWritten:(int64_t)totalBytesWritten
totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite
{
    if (!self.progressHandler) {
        return;
    }
    // Normalize an unknown total (NSURLSessionTransferSizeUnknown == -1) to 0 so
    // the JS side does not compute a negative/NaN percentage.
    long long total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : 0;
    if (totalBytesWritten > total) {
        // Encoded responses (gzip): the expected total counts compressed bytes
        // while written counts decompressed ones, so the percentage would run
        // past 100%. Treat the total as unknown instead.
        total = 0;
    }
    if (total > 0) {
        int percentage = (int)((totalBytesWritten * 100.0 / total) + 0.5);
        if (percentage <= self.lastReportedPercentage) {
            return;
        }
        self.lastReportedPercentage = percentage;
    } else {
        // Total unknown: throttle by bytes to avoid flooding the bridge.
        if (totalBytesWritten - self.lastReportedBytes < 256 * 1024) {
            return;
        }
        self.lastReportedBytes = totalBytesWritten;
    }
    self.progressHandler(totalBytesWritten, total);
}

- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask
didFinishDownloadingToURL:(NSURL *)location
{
    // A completed transfer does not imply success: 404/500 pages, CDN error
    // bodies and captive-portal HTML all arrive here. Reject non-2xx responses
    // before touching savePath so an existing valid package is not destroyed.
    NSURLResponse *response = downloadTask.response;
    if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        NSInteger statusCode = httpResponse.statusCode;
        if (statusCode < 200 || statusCode >= 300) {
            self.fileError = [NSError errorWithDomain:RCTPushyDownloaderErrorDomain
                                                 code:statusCode
                                             userInfo:@{
                NSLocalizedDescriptionKey: [NSString stringWithFormat:@"unexpected http status code %ld", (long)statusCode],
            }];
            return;
        }

        // Reject truncated transfers like Android/Harmony do. Skip the check
        // for encoded responses (e.g. gzip): NSURLSession decompresses them
        // transparently, so the on-disk size legitimately differs from the
        // Content-Length of the encoded body.
        NSString *contentEncoding = [httpResponse.allHeaderFields[@"Content-Encoding"] lowercaseString];
        BOOL isEncodedBody = contentEncoding.length > 0 && ![contentEncoding isEqualToString:@"identity"];
        long long expectedLength = httpResponse.expectedContentLength;
        if (!isEncodedBody && expectedLength > 0) {
            NSNumber *fileSize = [[NSFileManager defaultManager] attributesOfItemAtPath:location.path
                                                                                  error:nil][NSFileSize];
            if (fileSize != nil && fileSize.longLongValue != expectedLength) {
                self.fileError = [NSError errorWithDomain:RCTPushyDownloaderErrorDomain
                                                     code:-1
                                                 userInfo:@{
                    NSLocalizedDescriptionKey: [NSString stringWithFormat:@"download incomplete: expected %lld bytes, got %lld", expectedLength, fileSize.longLongValue],
                }];
                return;
            }
        }
    }

    NSFileManager *fileManager = [NSFileManager defaultManager];
    [fileManager removeItemAtPath:self.savePath error:nil];

    NSError *fileError = nil;
    [fileManager moveItemAtURL:location
                         toURL:[NSURL fileURLWithPath:self.savePath]
                         error:&fileError];
    if (fileError != nil) {
        self.fileError = fileError;
    }
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error
{
    [self completeWithError:error ?: self.fileError];
}

@end
