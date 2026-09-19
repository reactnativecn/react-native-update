#import "RCTPushyNativeConfig.h"

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

NSString *RCTPushyNormalizeNativeConfig(NSDictionary *options, NSError **error) {
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
            : @[@"https://update.react-native.cn/api", @"https://update.reactnative.cn/api"],
            @"endpoints", YES);
        NSArray *queryUrls = PushyConfigUrls(options[@"queryUrls"] ?: (customEndpoints ? @[]
            : @[@"https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json",
                @"https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json"]),
            @"queryUrls", NO);
        NSString *afterDownload = options[@"afterDownload"]
            ? PushyConfigString(options[@"afterDownload"], @"afterDownload", NO) : @"none";
        if (![@[@"none", @"setNeedUpdate"] containsObject:afterDownload]) {
            PushyConfigInvalid(@"afterDownload must be none or setNeedUpdate");
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
