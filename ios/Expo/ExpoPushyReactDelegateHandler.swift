import ExpoModulesCore
import React

public final class ExpoPushyReactDelegateHandler: ExpoReactDelegateHandler {

    #if EXPO_SUPPORTS_BUNDLEURL
    // This code block compiles only if EXPO_SUPPORTS_BUNDLEURL is defined
    // For expo-modules-core >= 1.12.0

    // Override bundleURL, which is the primary mechanism for these versions.
    // Expo's default createBridge implementation should respect this.
    override public func bundleURL(reactDelegate: ExpoReactDelegate) -> URL? {
      let bundleURL = RCTPushy.bundleURL()
      print("PushyHandler: Using bundleURL: \(bundleURL?.absoluteString ?? "nil")")
      return bundleURL
    }

    // No createBridge override needed here, rely on default behavior using the bundleURL override.

    #else
    // This code block compiles only if EXPO_SUPPORTS_BUNDLEURL is NOT defined
    // For expo-modules-core < 1.12.0

    // No bundleURL override possible here.

    // createBridge is the mechanism to customize the URL here.
    // We completely override it and do not call super.
    override public func createBridge(reactDelegate: ExpoReactDelegate, bridgeDelegate: RCTBridgeDelegate, launchOptions: [AnyHashable: Any]?) -> RCTBridge? {
      let bundleURL = RCTPushy.bundleURL()
      // Print the URL being provided to the initializer
      print("PushyHandler: createBridge bundleURL: \(bundleURL?.absoluteString ?? "nil")")

      // Directly create the bridge using the bundleURL initializer.
      // Pass nil for moduleProvider, assuming default behavior is sufficient.
      // WARNING: If bundleURL is nil, this initialization might fail silently or crash.
      return RCTBridge(bundleURL: bundleURL, moduleProvider: nil, launchOptions: launchOptions)
    }

    #endif // EXPO_SUPPORTS_BUNDLEURL
}
