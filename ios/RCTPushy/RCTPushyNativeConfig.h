#import <Foundation/Foundation.h>

// Validates and snapshots host options without changing any update state.
FOUNDATION_EXPORT NSString * _Nullable RCTPushyNormalizeNativeConfig(
    NSDictionary * _Nonnull options, NSError * _Nullable * _Nullable error);
