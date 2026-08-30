#import "RCTPushyDownloader.h"

static NSString *const RCTPushyDownloaderErrorDomain = @"cn.reactnative.pushy";

// Cross-launch resumable download (NATIVE_CHECKUPDATE_DESIGN §11.4): the
// archive streams straight into savePath (an NSURLSessionDownloadTask's
// temporary file is discarded on failure, which made every partial byte
// worthless), and a sidecar next to it records what the partial belongs to
// (url + validators + total). A brick gets a few hundred milliseconds per
// launch plus a bounded crash-rescue window, so progress must be monotonic
// across process deaths.

static NSString *RCTPushyResumeSidecarPath(NSString *savePath) {
    return [savePath stringByAppendingString:@".resume"];
}

static NSDictionary *RCTPushyReadResumeMeta(NSString *savePath, NSString *url) {
    NSData *data = [NSData dataWithContentsOfFile:RCTPushyResumeSidecarPath(savePath)];
    if (data == nil) {
        return nil;
    }
    id meta = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![meta isKindOfClass:[NSDictionary class]]) {
        return nil;
    }
    // An archive whose sidecar names another URL is untrusted.
    if (![url isEqualToString:meta[@"url"]]) {
        return nil;
    }
    return meta;
}

static void RCTPushyDeleteResumeSidecar(NSString *savePath) {
    [[NSFileManager defaultManager] removeItemAtPath:RCTPushyResumeSidecarPath(savePath)
                                               error:nil];
}

static long long RCTPushyFileSize(NSString *path) {
    NSDictionary *attributes =
        [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    NSNumber *size = attributes[NSFileSize];
    return size == nil ? -1 : size.longLongValue;
}

// "bytes <start>-<end>/<total>". Returns the total (0 when "*"), or -1 when
// missing/malformed or the start does not match the local partial.
static long long RCTPushyParseContentRange(NSString *header, long long expectedStart) {
    if (![header hasPrefix:@"bytes "]) {
        return -1;
    }
    NSString *range = [[header substringFromIndex:6]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    NSRange slash = [range rangeOfString:@"/"];
    NSRange dash = [range rangeOfString:@"-"];
    if (slash.location == NSNotFound || dash.location == NSNotFound
        || dash.location > slash.location) {
        return -1;
    }
    long long start = [range substringToIndex:dash.location].longLongValue;
    if (start != expectedStart) {
        return -1;
    }
    NSString *totalPart = [range substringFromIndex:slash.location + 1];
    if ([totalPart isEqualToString:@"*"]) {
        return 0;
    }
    long long total = totalPart.longLongValue;
    return total > 0 ? total : -1;
}

@interface RCTPushyDownloader()<NSURLSessionDataDelegate>

@property (nonatomic, strong) NSURLSession *session;
@property (copy) void (^progressHandler)(long long, long long);
@property (copy) void (^completionHandler)(NSString*, NSError*);
@property (copy) NSString *savePath;
@property (copy) NSString *urlString;
@property (nonatomic, assign) NSTimeInterval timeoutInterval;
@property (nonatomic, strong) NSFileHandle *fileHandle;
@property (nonatomic, strong) NSDictionary *resumeMeta;
@property (nonatomic, assign) long long resumeOffset;   // requested Range start
@property (nonatomic, assign) long long baseOffset;     // granted by the response
@property (nonatomic, assign) long long receivedBytes;  // streamed this session
@property (nonatomic, assign) long long contentLength;  // this response's body
@property (nonatomic, assign) long long expectedTotal;  // whole file (0 unknown)
@property (nonatomic, strong) NSError *fileError;
@property (nonatomic, assign) BOOL finished;
@property (nonatomic, assign) BOOL retriedFromZero;
// The server encoded the body itself (Content-Encoding other than identity):
// NSURLSession delivers decoded bytes, so length accounting against the
// encoded Content-Length is meaningless and resume offsets cannot be trusted.
@property (nonatomic, assign) BOOL encodedBody;
@property (nonatomic, assign) int lastReportedPercentage;
@property (nonatomic, assign) long long lastReportedBytes;
@end

@implementation RCTPushyDownloader

+ (void)download:(NSString *)downloadPath savePath:(NSString *)savePath
timeoutInterval:(NSTimeInterval)timeoutInterval
progressHandler:(void (^)(long long receivedBytes, long long totalBytes))progressHandler
completionHandler:(void (^)(NSString *path, NSError *error))completionHandler
{
    NSAssert(downloadPath, @"no download path");
    NSAssert(savePath, @"no save path");

    RCTPushyDownloader *downloader = [RCTPushyDownloader new];
    downloader.progressHandler = progressHandler;
    downloader.completionHandler = completionHandler;
    downloader.savePath = savePath;
    downloader.urlString = downloadPath;
    downloader.timeoutInterval = timeoutInterval;

    [downloader startTransfer];
}

- (void)startTransfer
{
    NSURL *url = [NSURL URLWithString:self.urlString];
    if (url == nil) {
        [self completeWithError:[NSError errorWithDomain:RCTPushyDownloaderErrorDomain
                                                    code:-1
                                                userInfo:@{
                                                    NSLocalizedDescriptionKey: @"invalid download url",
                                                }]];
        return;
    }

    NSFileManager *fileManager = [NSFileManager defaultManager];
    self.resumeMeta = RCTPushyReadResumeMeta(self.savePath, self.urlString);
    self.resumeOffset = 0;
    if (self.resumeMeta != nil) {
        long long size = RCTPushyFileSize(self.savePath);
        long long knownTotal = [self.resumeMeta[@"total"] longLongValue];
        if (size > 0 && knownTotal > 0 && size == knownTotal) {
            // Fully received in a previous attempt (the process died between
            // download end and unzip): nothing left to transfer.
            if (self.progressHandler) {
                self.progressHandler(knownTotal, knownTotal);
            }
            [self completeWithError:nil];
            return;
        }
        if (size > 0 && (knownTotal <= 0 || size < knownTotal)) {
            self.resumeOffset = size;
        }
    }
    if (self.resumeOffset == 0) {
        [fileManager removeItemAtPath:self.savePath error:nil];
        RCTPushyDeleteResumeSidecar(self.savePath);
    }

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    if (self.resumeOffset > 0) {
        // Only resume requests pin the encoding: Range offsets must address
        // the same bytes that are on disk. Fresh downloads keep the system's
        // transparent gzip handling, matching the pre-resume behaviour for
        // servers that compress regardless.
        [request setValue:@"identity" forHTTPHeaderField:@"Accept-Encoding"];
        [request setValue:[NSString stringWithFormat:@"bytes=%lld-", self.resumeOffset]
       forHTTPHeaderField:@"Range"];
        NSString *validator = self.resumeMeta[@"etag"] ?: self.resumeMeta[@"lastModified"];
        if (validator != nil) {
            // With a validator the server falls back to a full 200 when the
            // file changed instead of appending mismatched bytes.
            [request setValue:validator forHTTPHeaderField:@"If-Range"];
        }
    }

    NSURLSessionConfiguration *sessionConfig = [NSURLSessionConfiguration defaultSessionConfiguration];
    // Avoid hanging forever on a stalled connection (default resource timeout
    // is 7 days). The 30s idle timeout matches Android's readTimeout and is
    // what actually catches a stalled transfer; the total-duration cap matches
    // Android's 10min callTimeout — 300s made a 30MB full package on a slow
    // (<100KB/s) network fail on iOS while succeeding on Android.
    sessionConfig.timeoutIntervalForRequest = 30;
    sessionConfig.timeoutIntervalForResource = MAX(1, self.timeoutInterval);
    self.session = [NSURLSession sessionWithConfiguration:sessionConfig
                                                 delegate:self
                                            delegateQueue:nil];

    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request];
    [task resume];
}

- (void)writeResumeMetaWithResponse:(NSHTTPURLResponse *)response total:(long long)total
{
    NSMutableDictionary *meta = [NSMutableDictionary dictionary];
    meta[@"url"] = self.urlString;
    NSString *etag = response.allHeaderFields[@"ETag"] ?: self.resumeMeta[@"etag"];
    NSString *lastModified =
        response.allHeaderFields[@"Last-Modified"] ?: self.resumeMeta[@"lastModified"];
    if (etag != nil) {
        meta[@"etag"] = etag;
    }
    if (lastModified != nil) {
        meta[@"lastModified"] = lastModified;
    }
    if (total > 0) {
        meta[@"total"] = @(total);
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:meta options:0 error:nil];
    if (data != nil) {
        // Non-fatal on failure: without a sidecar the next attempt starts
        // from zero.
        [data writeToFile:RCTPushyResumeSidecarPath(self.savePath) atomically:YES];
    }
}

- (void)completeWithError:(NSError *)error
{
    if (self.finished) {
        return;
    }
    self.finished = YES;

    if (self.fileHandle != nil) {
        @try {
            [self.fileHandle closeFile];
        } @catch (NSException *exception) {
        }
        self.fileHandle = nil;
    }

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

- (void)failWithDescription:(NSString *)description code:(NSInteger)code
{
    self.fileError = [NSError errorWithDomain:RCTPushyDownloaderErrorDomain
                                         code:code
                                     userInfo:@{NSLocalizedDescriptionKey: description}];
}

// Drops the untrusted partial and reissues the whole request from zero, at
// most once per download (the stale-partial 416 case). Delegate callbacks
// from the superseded session are ignored via the session-identity guards.
- (void)restartFromZero
{
    self.retriedFromZero = YES;
    self.resumeMeta = nil;
    self.resumeOffset = 0;
    self.baseOffset = 0;
    self.receivedBytes = 0;
    self.contentLength = 0;
    self.expectedTotal = 0;
    self.encodedBody = NO;
    self.lastReportedPercentage = 0;
    self.lastReportedBytes = 0;
    if (self.fileHandle != nil) {
        @try {
            [self.fileHandle closeFile];
        } @catch (NSException *exception) {
        }
        self.fileHandle = nil;
    }
    [[NSFileManager defaultManager] removeItemAtPath:self.savePath error:nil];
    RCTPushyDeleteResumeSidecar(self.savePath);
    [self.session finishTasksAndInvalidate];
    self.session = nil;
    [self startTransfer];
}

#pragma mark - session delegate

// An https artifact URL must stay on https through every redirect: the
// package is the supply-chain boundary and TLS is what authenticates it.
// Returning nil delivers the 3xx itself as the response, which the status
// check below then rejects with the recorded reason.
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *))completionHandler
{
    if (session != self.session) {
        completionHandler(nil);
        return;
    }
    NSString *originalScheme = [[NSURL URLWithString:self.urlString].scheme lowercaseString];
    NSString *nextScheme = [request.URL.scheme lowercaseString];
    if ([originalScheme isEqualToString:@"https"] && [nextScheme isEqualToString:@"http"]) {
        [self failWithDescription:[NSString stringWithFormat:
            @"https download redirected to plaintext http: %@", request.URL.absoluteString]
                             code:-1];
        completionHandler(nil);
        return;
    }
    completionHandler(request);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler
{
    if (session != self.session) {
        // A superseded session (restartFromZero) still delivering events.
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    NSHTTPURLResponse *httpResponse =
        [response isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)response : nil;
    NSInteger statusCode = httpResponse.statusCode;

    if (self.fileError != nil) {
        // A refused redirect (see willPerformHTTPRedirection) already
        // recorded the real reason; the 3xx being delivered here is not it.
        completionHandler(NSURLSessionResponseCancel);
        [self completeWithError:self.fileError];
        return;
    }
    if (statusCode == 416) {
        long long knownTotal = [self.resumeMeta[@"total"] longLongValue];
        completionHandler(NSURLSessionResponseCancel);
        if (knownTotal > 0 && RCTPushyFileSize(self.savePath) == knownTotal) {
            // The partial is actually the complete file.
            [self completeWithError:nil];
        } else if (!self.retriedFromZero) {
            [self restartFromZero];
        } else {
            [self failWithDescription:@"server rejected the download range" code:statusCode];
            [self completeWithError:self.fileError];
        }
        return;
    }
    if (httpResponse != nil && (statusCode < 200 || statusCode >= 300)) {
        [self failWithDescription:[NSString stringWithFormat:@"unexpected http status code %ld",
                                   (long)statusCode]
                             code:statusCode];
        completionHandler(NSURLSessionResponseCancel);
        [self completeWithError:self.fileError];
        return;
    }

    NSString *contentEncoding =
        [httpResponse.allHeaderFields[@"Content-Encoding"] lowercaseString];
    self.encodedBody =
        contentEncoding.length > 0 && ![contentEncoding isEqualToString:@"identity"];

    BOOL append = statusCode == 206 && self.resumeOffset > 0;
    if (append && (self.encodedBody
        || RCTPushyParseContentRange(httpResponse.allHeaderFields[@"Content-Range"],
                                     self.resumeOffset) < 0)) {
        // Encoded range bytes or a malformed/mismatched Content-Range: the
        // appended bytes could not be trusted. Treat like a stale partial —
        // one clean retry from zero — instead of failing terminally, which
        // would keep the partial and hit the same wall on every attempt.
        completionHandler(NSURLSessionResponseCancel);
        if (!self.retriedFromZero) {
            [self restartFromZero];
        } else {
            [self failWithDescription:@"untrusted resume response" code:-1];
            [self completeWithError:self.fileError];
        }
        return;
    }
    self.baseOffset = append ? self.resumeOffset : 0;
    self.contentLength = response.expectedContentLength;
    if (append) {
        self.expectedTotal = RCTPushyParseContentRange(
            httpResponse.allHeaderFields[@"Content-Range"], self.resumeOffset);
    } else if (self.encodedBody) {
        // Decoded bytes are being written; the encoded lengths say nothing.
        self.expectedTotal = 0;
    } else {
        self.expectedTotal = self.contentLength > 0 ? self.contentLength : 0;
    }

    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (!append) {
        // The server ignored the range (or none was sent): start over.
        [fileManager removeItemAtPath:self.savePath error:nil];
        [fileManager createFileAtPath:self.savePath contents:nil attributes:nil];
    }
    self.fileHandle = [NSFileHandle fileHandleForWritingAtPath:self.savePath];
    if (self.fileHandle == nil) {
        [self failWithDescription:@"cannot open download file for writing" code:-1];
        completionHandler(NSURLSessionResponseCancel);
        [self completeWithError:self.fileError];
        return;
    }
    if (append) {
        @try {
            [self.fileHandle seekToEndOfFile];
        } @catch (NSException *exception) {
            [self failWithDescription:@"cannot seek download file" code:-1];
            completionHandler(NSURLSessionResponseCancel);
            [self completeWithError:self.fileError];
            return;
        }
    }
    if (self.encodedBody) {
        // No resume across an encoded transfer: on-disk bytes are decoded,
        // Range offsets would address the encoded representation.
        RCTPushyDeleteResumeSidecar(self.savePath);
    } else if (httpResponse != nil) {
        // Persist before streaming so a mid-stream crash can resume.
        [self writeResumeMetaWithResponse:httpResponse total:self.expectedTotal];
    }
    completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data
{
    if (session != self.session) {
        return;
    }
    if (self.fileHandle == nil || self.fileError != nil) {
        return;
    }
    @try {
        [self.fileHandle writeData:data];
    } @catch (NSException *exception) {
        [self failWithDescription:[NSString stringWithFormat:@"write failed: %@",
                                   exception.reason]
                             code:-1];
        [dataTask cancel];
        return;
    }
    self.receivedBytes += data.length;

    if (!self.progressHandler) {
        return;
    }
    long long overall = self.baseOffset + self.receivedBytes;
    long long total = self.expectedTotal;
    if (overall > total) {
        // Should not happen with identity encoding; treat as unknown so the
        // JS side never sees percentages past 100.
        total = 0;
    }
    if (total > 0) {
        int percentage = (int)((overall * 100.0 / total) + 0.5);
        if (percentage <= self.lastReportedPercentage) {
            return;
        }
        self.lastReportedPercentage = percentage;
    } else {
        // Total unknown: throttle by bytes to avoid flooding the bridge.
        if (overall - self.lastReportedBytes < 256 * 1024) {
            return;
        }
        self.lastReportedBytes = overall;
    }
    self.progressHandler(overall, total);
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error
{
    if (session != self.session) {
        // A superseded session (restartFromZero) settling its cancelled
        // task; only the current session may decide this download's fate.
        return;
    }
    if (self.finished) {
        return;
    }
    // The locally recorded failure (e.g. a write error that cancelled the
    // task) is the actual cause; the session error would just say
    // "cancelled".
    NSError *finalError = self.fileError ?: error;
    if (finalError == nil && !self.encodedBody) {
        // Reject truncated transfers like Android/Harmony do. Skipped for
        // encoded bodies: the on-disk size is decoded bytes while the
        // expected lengths count encoded ones.
        if (self.contentLength >= 0 && self.receivedBytes != self.contentLength) {
            [self failWithDescription:[NSString stringWithFormat:
                @"download incomplete: expected %lld bytes, got %lld",
                self.contentLength, self.receivedBytes] code:-1];
            finalError = self.fileError;
        } else if (self.expectedTotal > 0
                   && RCTPushyFileSize(self.savePath) != self.expectedTotal) {
            [self failWithDescription:[NSString stringWithFormat:
                @"download incomplete: expected %lld total bytes, got %lld",
                self.expectedTotal, RCTPushyFileSize(self.savePath)] code:-1];
            finalError = self.fileError;
        }
    }
    // On failure the partial + sidecar stay on disk — that is the resume
    // state a later launch (or crash-rescue window) picks up.
    [self completeWithError:finalError];
}

@end
