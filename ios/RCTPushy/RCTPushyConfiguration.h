#import <Foundation/Foundation.h>

// Validates and snapshots host options without changing any update state.
FOUNDATION_EXPORT NSString * _Nullable RCTPushyNormalizeConfiguration(
    NSDictionary * _Nonnull options, NSError * _Nullable * _Nullable error);

// Decodes text produced by scripts/encode-native-text.ts (byte i XORed with
// (0x5A + 0x1D * i) & 0xFF), keeping service addresses and paths out of static
// string scans of the binary. Not a secret.
FOUNDATION_EXPORT NSString * _Nonnull RCTPushyRevealText(const char * _Nonnull hex);

// Request path appended to an endpoint base.
FOUNDATION_EXPORT NSString * _Nonnull RCTPushyQueryPath(void);
