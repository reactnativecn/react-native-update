#include "PushyTurboModule.h"

using namespace facebook;
using namespace rnoh;

namespace {

jsi::Value CallSync(
    jsi::Runtime &rt,
    react::TurboModule &turboModule,
    const char *methodName,
    const jsi::Value *args,
    size_t count) {
  return jsi::Value(
      static_cast<ArkTSTurboModule &>(turboModule).call(
          rt, methodName, args, count));
}

jsi::Value CallAsync(
    jsi::Runtime &rt,
    react::TurboModule &turboModule,
    const char *methodName,
    const jsi::Value *args,
    size_t count) {
  return jsi::Value(
      static_cast<ArkTSTurboModule &>(turboModule).callAsync(
          rt, methodName, args, count));
}

#define PUSHY_SYNC_METHOD(method_name)                                   \
  static jsi::Value HostFunction_##method_name(                          \
      jsi::Runtime &rt,                                                  \
      react::TurboModule &turboModule,                                   \
      const jsi::Value *args,                                            \
      size_t count) {                                                    \
    return CallSync(rt, turboModule, #method_name, args, count);         \
  }

#define PUSHY_ASYNC_METHOD(method_name)                                  \
  static jsi::Value HostFunction_##method_name(                          \
      jsi::Runtime &rt,                                                  \
      react::TurboModule &turboModule,                                   \
      const jsi::Value *args,                                            \
      size_t count) {                                                    \
    return CallAsync(rt, turboModule, #method_name, args, count);        \
  }

PUSHY_SYNC_METHOD(getConstants)
PUSHY_SYNC_METHOD(setLocalHashInfo)
PUSHY_SYNC_METHOD(getLocalHashInfo)
PUSHY_SYNC_METHOD(setUuid)
PUSHY_SYNC_METHOD(setNeedUpdate)
PUSHY_SYNC_METHOD(markSuccess)
PUSHY_SYNC_METHOD(addListener)
PUSHY_SYNC_METHOD(removeListeners)

PUSHY_ASYNC_METHOD(reloadUpdate)
PUSHY_ASYNC_METHOD(restartApp)
PUSHY_ASYNC_METHOD(downloadPatchFromPpk)
PUSHY_ASYNC_METHOD(downloadPatchFromPackage)
PUSHY_ASYNC_METHOD(downloadFullUpdate)
PUSHY_ASYNC_METHOD(downloadAndInstallApk)

#undef PUSHY_SYNC_METHOD
#undef PUSHY_ASYNC_METHOD

} // namespace

PushyTurboModule::PushyTurboModule(
    const ArkTSTurboModule::Context ctx,
    const std::string name)
    : ArkTSTurboModule(ctx, name) {
  const auto registerMethod =
      [this](const std::string &methodName,
             size_t argCount,
             auto hostFunction) {
        methodMap_[methodName] = MethodMetadata{argCount, hostFunction};
      };

  registerMethod("getConstants", 0, HostFunction_getConstants);
  registerMethod("setLocalHashInfo", 2, HostFunction_setLocalHashInfo);
  registerMethod("getLocalHashInfo", 1, HostFunction_getLocalHashInfo);
  registerMethod("setUuid", 1, HostFunction_setUuid);
  registerMethod("reloadUpdate", 1, HostFunction_reloadUpdate);
  registerMethod("restartApp", 0, HostFunction_restartApp);
  registerMethod("setNeedUpdate", 1, HostFunction_setNeedUpdate);
  registerMethod("markSuccess", 0, HostFunction_markSuccess);
  registerMethod("downloadPatchFromPpk", 1, HostFunction_downloadPatchFromPpk);
  registerMethod(
      "downloadPatchFromPackage", 1, HostFunction_downloadPatchFromPackage);
  registerMethod("downloadFullUpdate", 1, HostFunction_downloadFullUpdate);
  registerMethod(
      "downloadAndInstallApk", 1, HostFunction_downloadAndInstallApk);
  registerMethod("addListener", 1, HostFunction_addListener);
  registerMethod("removeListeners", 1, HostFunction_removeListeners);
}
