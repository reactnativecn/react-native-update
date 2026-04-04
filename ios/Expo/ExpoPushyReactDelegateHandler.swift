import ExpoModulesCore
import React

public final class ExpoPushyReactDelegateHandler: ExpoReactDelegateHandler {
    private func resolvedBundleURL() -> URL? {
      RCTPushy.bundleURL()
    }

    #if EXPO_SUPPORTS_BUNDLEURL
    override public func bundleURL(reactDelegate: ExpoReactDelegate) -> URL? {
      resolvedBundleURL()
    }

    #else
    override public func createBridge(reactDelegate: ExpoReactDelegate, bridgeDelegate: RCTBridgeDelegate, launchOptions: [AnyHashable: Any]?) -> RCTBridge? {
      RCTBridge(bundleURL: resolvedBundleURL(), moduleProvider: nil, launchOptions: launchOptions)
    }

    #endif
}
