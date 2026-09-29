#import "RCTPushyConfiguration.h"

// Read through a volatile so the optimizer cannot fold the decode of a constant
// argument back into a plain string in the binary.
static volatile unsigned char PushyTextKeyBase = 0x5A;

NSString *RCTPushyRevealText(const char *hex) {
    size_t length = strlen(hex) / 2;
    NSMutableString *text = [NSMutableString stringWithCapacity:length];
    unsigned char base = PushyTextKeyBase;
    for (size_t i = 0; i < length; i++) {
        char pair[3] = {hex[i * 2], hex[i * 2 + 1], 0};
        unsigned char byte = (unsigned char)strtoul(pair, NULL, 16);
        [text appendFormat:@"%c", (char)(byte ^ (unsigned char)(base + 0x1D * i))];
    }
    return text;
}

NSString *RCTPushyQueryPath(void) {
    static NSString *path;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        path = RCTPushyRevealText("7514fcd4ad805d55263e08fc99");
    });
    return path;
}

static void PushyConfigInvalid(NSString *message) {
    @throw [NSException exceptionWithName:NSInvalidArgumentException
        reason:[@"Invalid native configuration: " stringByAppendingString:message]
        userInfo:nil];
}

static NSString *PushyConfigString(id value, NSString *name, BOOL allowEmpty) {
    if (![value isKindOfClass:NSString.class]
        || (!allowEmpty && [[value stringByTrimmingCharactersInSet:
            NSCharacterSet.whitespaceAndNewlineCharacterSet] length] == 0)) {
        PushyConfigInvalid([NSString stringWithFormat:@"%@ must be a string%@",
            name, allowEmpty ? @"" : @" and must not be blank"]);
    }
    return value;
}

static NSArray *PushyConfigUrls(id value, NSString *name, BOOL base) {
    if (![value isKindOfClass:NSArray.class] || (base && [value count] == 0)) {
        PushyConfigInvalid([NSString stringWithFormat:@"%@ must be %@ array",
            name, base ? @"a non-empty" : @"an"]);
    }
    NSMutableArray *result = [NSMutableArray array];
    NSRegularExpression *authority = [NSRegularExpression regularExpressionWithPattern:
        @"^https?://(\\[[0-9a-fA-F:]+\\]|[a-zA-Z0-9.-]+)(:[0-9]+)?([/?#]|$)"
        options:0 error:nil];
    for (id item in value) {
        NSString *url = [PushyConfigString(item, name, NO) stringByTrimmingCharactersInSet:
            NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if ([authority firstMatchInString:url options:0 range:NSMakeRange(0, url.length)] == nil
            || [url rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location != NSNotFound
            || [url containsString:@"\\"]
            || (base && ([url containsString:@"?"] || [url containsString:@"#"]))) {
            PushyConfigInvalid([NSString stringWithFormat:
                @"%@ requires absolute HTTP(S) URLs without credentials%@",
                name, base ? @", queries or fragments" : @""]);
        }
        if (base) {
            while ([url hasSuffix:@"/"]) {
                url = [url substringToIndex:url.length - 1];
            }
        }
        if (![result containsObject:url]) {
            [result addObject:url];
        }
    }
    return result;
}

NSString *RCTPushyNormalizeConfiguration(NSDictionary *options, NSError **error) {
    @try {
        if (![options isKindOfClass:NSDictionary.class]) {
            PushyConfigInvalid(@"expected an object");
        }
        NSArray *keys = @[@"appKey", @"endpoints", @"queryUrls", @"afterDownload",
                           @"disabled", @"packageVersion", @"rnu", @"rn"];
        for (id key in options) {
            if (![keys containsObject:key]) {
                PushyConfigInvalid([NSString stringWithFormat:@"unknown option %@", key]);
            }
        }
        NSString *appKey = PushyConfigString(options[@"appKey"], @"appKey", NO);
        BOOL customEndpoints = options[@"endpoints"] != nil;
        NSArray *endpoints = PushyConfigUrls(customEndpoints ? options[@"endpoints"]
            : @[RCTPushyRevealText("3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5b3d5b9817b592947e5cdefbc8a7e"),
                RCTPushyRevealText("3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5f0daac9c644a620ae88ca1ad93")],
            @"endpoints", YES);
        NSArray *queryUrls = PushyConfigUrls(options[@"queryUrls"] ?: (customEndpoints ? @[]
            : @[RCTPushyRevealText("3203e0c1bdd1270a253608fcd3fd9362476817f4f0d5a1996342631be3c2a3a9d779552507fdcde8928a6f512f5ce2ccbdc869404d2f1de79daa826d562c0913eec4fa9b7d4426"),
                RCTPushyRevealText("3203e0c1bdd1270a213b12b7dca09468462e12f3b0d5bd813d482446f4c6a1be8e79552507fdcda68cd06e5c3710e480a4867048483e55e0c2ab8d7d43030d1ce9c3b183214e2601f2f0d5b782601e2719e8ca")]),
            @"queryUrls", NO);
        NSString *afterDownload = options[@"afterDownload"]
            ? PushyConfigString(options[@"afterDownload"], @"afterDownload", NO) : @"none";
        NSString *nextLaunch = RCTPushyRevealText("2912e0ffab8e6c70323b1dedd3");
        if (![@[@"none", nextLaunch] containsObject:afterDownload]) {
            PushyConfigInvalid([@"afterDownload must be none or " stringByAppendingString:nextLaunch]);
        }
        id disabled = options[@"disabled"] ?: @NO;
        if (![disabled isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)disabled) != CFBooleanGetTypeID()) {
            PushyConfigInvalid(@"disabled must be a boolean");
        }
        NSMutableDictionary *result = [@{
            @"appKey": appKey, @"endpoints": endpoints, @"queryUrls": queryUrls,
            @"afterDownload": afterDownload, @"disabled": disabled,
            @"rnu": options[@"rnu"] ? PushyConfigString(options[@"rnu"], @"rnu", YES) : @"",
            @"rn": options[@"rn"] ? PushyConfigString(options[@"rn"], @"rn", YES) : @""
        } mutableCopy];
        if (options[@"packageVersion"] != nil) {
            result[@"packageVersion"] = PushyConfigString(options[@"packageVersion"], @"packageVersion", NO);
        }
        // Stable ordering makes repeated identical configure calls idempotent.
        NSData *data = [NSJSONSerialization dataWithJSONObject:result
            options:NSJSONWritingSortedKeys error:error];
        return data == nil ? nil : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    } @catch (NSException *exception) {
        if (error != NULL) {
            *error = [NSError errorWithDomain:@"cn.reactnative.pushy" code:1 userInfo:@{
                NSLocalizedDescriptionKey: exception.reason ?: @"Invalid native configuration",
                @"PushyErrorCode": @"INVALID_OPTIONS"
            }];
        }
        return nil;
    }
}
