#include "pushy.h"
#include "hpatch.h"
#include <napi/native_api.h>
#include <js_native_api.h>
#include <js_native_api_types.h>

#define _check(v,errInfo) do { \
    if (!(v)) { \
        _isError = hpatch_TRUE; \
        _errInfo = errInfo; \
        goto _clear; \
    } \
} while(0)

napi_value HdiffPatch(napi_env env, napi_callback_info info) {
    napi_status status;
    size_t argc = 2;
    napi_value args[2];
    hpatch_BOOL _isError = hpatch_FALSE;
    const char* _errInfo = "";

    // 获取参数
    status = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (status != napi_ok || argc < 2) {
        napi_throw_error(env, NULL, "Wrong number of arguments");
        return NULL;
    }

    // 获取origin buffer
    bool isTypedArray;
    status = napi_is_typedarray(env, args[0], &isTypedArray);
    if (status != napi_ok || !isTypedArray) {
        napi_throw_error(env, NULL, "First argument must be a TypedArray");
        return NULL;
    }

    uint8_t* originPtr;
    size_t originLength;
    status = napi_get_typedarray_info(env, args[0], NULL, &originLength, 
                                     (void**)&originPtr, NULL, NULL);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Failed to get origin buffer");
        return NULL;
    }

    // 获取patch buffer
    status = napi_is_typedarray(env, args[1], &isTypedArray);
    if (status != napi_ok || !isTypedArray) {
        napi_throw_error(env, NULL, "Second argument must be a TypedArray");
        return NULL;
    }

    uint8_t* patchPtr;
    size_t patchLength;
    status = napi_get_typedarray_info(env, args[1], NULL, &patchLength, 
                                     (void**)&patchPtr, NULL, NULL);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Failed to get patch buffer");
        return NULL;
    }

    // 执行patch操作
    hpatch_singleCompressedDiffInfo patInfo;
    
    _check(((originLength==0)||originPtr) && patchPtr && (patchLength>0), "Corrupt patch");
    _check(kHPatch_ok==hpatch_getInfo_by_mem(&patInfo, patchPtr, patchLength), "Error info in hpatch");
    _check(originLength==patInfo.oldDataSize, "Error oldDataSize in hpatch");
    size_t newsize = (size_t)patInfo.newDataSize;
    if (sizeof(size_t)!=sizeof(hpatch_StreamPos_t))
        _check(newsize==patInfo.newDataSize, "Error newDataSize in hpatch");

    // 创建结果buffer
    napi_value resultBuffer;
    uint8_t* outPtr;
    void* data;

    status = napi_create_arraybuffer(env, newsize, &data, &resultBuffer);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Failed to create result buffer");
        return NULL;
    }
    outPtr = (uint8_t*)data;

    // 执行patch
    _check(kHPatch_ok==hpatch_by_mem(originPtr, originLength, outPtr, newsize,
                                    patchPtr, patchLength, &patInfo), "hpatch");
    return resultBuffer;

_clear:
    if (_isError) {
        napi_throw_error(env, NULL, _errInfo);
        return NULL;
    }
    return NULL;
}

// 模块初始化
napi_value Init(napi_env env, napi_value exports) {
    napi_status status;
    napi_value fn;

    status = napi_create_function(env, NULL, 0, HdiffPatch, NULL, &fn);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Unable to wrap native function");
        return NULL;
    }

    status = napi_set_named_property(env, exports, "hdiffPatch", fn);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Unable to populate exports");
        return NULL;
    }

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)