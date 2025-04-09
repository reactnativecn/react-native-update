import ExpoModulesCore
import react_native_update

public final class ExpoPushyReactDelegateHandler: ExpoReactDelegateHandler {
  private weak var reactDelegate: ExpoReactDelegate?

  public override func bundleURL(reactDelegate: ExpoReactDelegate) -> URL? {
    return  RCTPushy.bundleURL()
  }
}
