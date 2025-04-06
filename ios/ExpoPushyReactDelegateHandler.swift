// Copyright 2018-present 650 Industries. All rights reserved.

import ExpoModulesCore

/**
 * Manages and controls the auto-setup behavior of expo-updates in applicable environments.
 *
 * In order to deal with the asynchronous nature of updates startup, this class creates dummy
 * RCTBridge and RCTRootView objects to return to the ReactDelegate, replacing them with the real
 * objects when expo-updates is ready.
 */
public final class ExpoPushyReactDelegateHandler: ExpoReactDelegateHandler {
  private weak var reactDelegate: ExpoReactDelegate?

  public override func bundleURL(reactDelegate: ExpoReactDelegate) -> URL? {
    // let bundleUrl = AppController.sharedInstance.launchAssetUrl()
    let bundleUrl = URL(string: "http://localhost:8081/index.bundle?platform=ios&dev=true&minify=false")
    print("😁bundleUrl: \(bundleUrl)")
    return bundleUrl
  }
}
