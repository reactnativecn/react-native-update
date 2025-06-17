
#include "PushyTurboModule.h"

using namespace rnoh;
using namespace facebook;

static jsi::Value _hostFunction_PushyTurboModule_getConstants(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"getConstants", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_setLocalHashInfo(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"setLocalHashInfo", args, count));
    }
    
static jsi::Value _hostFunction_PushyTurboModule_getLocalHashInfo(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"getLocalHashInfo", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_setUuid(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"setUuid", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_reloadUpdate(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"reloadUpdate", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_setNeedUpdate(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"setNeedUpdate", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_markSuccess(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"markSuccess", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_downloadPatchFromPpk(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).callAsync(rt,"downloadPatchFromPpk", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_downloadPatchFromPackage(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).callAsync(rt,"downloadPatchFromPackage", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_downloadFullUpdate(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).callAsync(rt,"downloadFullUpdate", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_downloadAndInstallApk(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).callAsync(rt,"downloadAndInstallApk", args, count));
    }



static jsi::Value _hostFunction_PushyTurboModule_addListener(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"addListener", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_removeListeners(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"removeListeners", args, count));
    }

PushyTurboModule::PushyTurboModule(const ArkTSTurboModule::Context ctx, const std::string name)
    : ArkTSTurboModule(ctx,name)
{
    methodMap_["getConstants"]= MethodMetadata{1, _hostFunction_PushyTurboModule_getConstants};
    methodMap_["setLocalHashInfo"]= MethodMetadata{2, _hostFunction_PushyTurboModule_setLocalHashInfo};
    methodMap_["getLocalHashInfo"]= MethodMetadata{3, _hostFunction_PushyTurboModule_getLocalHashInfo};
    methodMap_["setUuid"]= MethodMetadata{1, _hostFunction_PushyTurboModule_setUuid};
    methodMap_["reloadUpdate"]= MethodMetadata{0, _hostFunction_PushyTurboModule_reloadUpdate};
    methodMap_["setNeedUpdate"]= MethodMetadata{0, _hostFunction_PushyTurboModule_setNeedUpdate};
    methodMap_["markSuccess"]= MethodMetadata{0, _hostFunction_PushyTurboModule_markSuccess};
    methodMap_["downloadPatchFromPpk"]= MethodMetadata{0, _hostFunction_PushyTurboModule_downloadPatchFromPpk};
    methodMap_["downloadPatchFromPackage"]= MethodMetadata{0, _hostFunction_PushyTurboModule_downloadPatchFromPackage};
    methodMap_["downloadFullUpdate"]= MethodMetadata{0, _hostFunction_PushyTurboModule_downloadFullUpdate};
    methodMap_["downloadAndInstallApk"]= MethodMetadata{0, _hostFunction_PushyTurboModule_downloadAndInstallApk};
    methodMap_["addListener"]= MethodMetadata{1, _hostFunction_PushyTurboModule_addListener};
    methodMap_["removeListeners"]= MethodMetadata{1, _hostFunction_PushyTurboModule_removeListeners};
}