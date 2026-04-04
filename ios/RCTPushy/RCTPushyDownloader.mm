#import "RCTPushyDownloader.h"

static NSString *const RCTPushyDownloaderErrorDomain = @"cn.reactnative.pushy";

@interface RCTPushyDownloader()<NSURLSessionDownloadDelegate>

@property (nonatomic, strong) NSURLSession *session;
@property (copy) void (^progressHandler)(long long, long long);
@property (copy) void (^completionHandler)(NSString*, NSError*);
@property (copy) NSString *savePath;
@property (nonatomic, strong) NSError *fileError;
@property (nonatomic, assign) BOOL finished;
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
    if (self.progressHandler) {
        self.progressHandler(totalBytesWritten ,totalBytesExpectedToWrite);
    }
}

- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask
didFinishDownloadingToURL:(NSURL *)location
{
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
