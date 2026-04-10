cmake_minimum_required(VERSION 3.13)
project(rnupdate LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(PUSHY_MODULE_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../..)
set(PUSHY_ABI ${CMAKE_OHOS_ARCH_ABI})
if(NOT PUSHY_ABI)
    set(PUSHY_ABI ${OHOS_ARCH})
endif()
set(PREBUILT_RNUPDATE_PATH ${PUSHY_MODULE_ROOT}/libs/${PUSHY_ABI}/librnupdate.so)
set(CMAKE_VERBOSE_MAKEFILE on)

set(REPO_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../)
set(STAGED_NATIVE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/android-generated)
set(ANDROID_JNI_DIR ${REPO_ROOT}/android/jni)
if(NOT EXISTS ${ANDROID_JNI_DIR}/hpatch.c)
    set(ANDROID_JNI_DIR ${STAGED_NATIVE_DIR}/jni)
endif()
set(PATCH_CORE_DIR ${REPO_ROOT}/cpp/patch_core)
if(NOT EXISTS ${PATCH_CORE_DIR}/patch_core.cpp)
    set(PATCH_CORE_DIR ${STAGED_NATIVE_DIR}/patch_core)
endif()

if(EXISTS ${PREBUILT_RNUPDATE_PATH})
    add_library(rnupdate SHARED IMPORTED GLOBAL)
    set_target_properties(rnupdate PROPERTIES IMPORTED_LOCATION ${PREBUILT_RNUPDATE_PATH})
else()
    # When building the HAR itself, native sources are compiled from the repo checkout.
    set(HDIFFPATCH_DIR ${ANDROID_JNI_DIR}/HDiffPatch)
    set(LZMA_DIR ${ANDROID_JNI_DIR}/lzma)
    set(HDP_SOURCES
         ${CMAKE_CURRENT_SOURCE_DIR}/pushy.cpp
         ${PATCH_CORE_DIR}/archive_patch_core.cpp
         ${PATCH_CORE_DIR}/patch_core.cpp
         ${PATCH_CORE_DIR}/sha256_util.cpp
         ${PATCH_CORE_DIR}/state_core.cpp
         ${ANDROID_JNI_DIR}/hpatch.c
         ${LZMA_DIR}/C/Sha256.c
         ${HDIFFPATCH_DIR}/libHDiffPatch/HPatch/patch.c
         ${HDIFFPATCH_DIR}/file_for_patch.c
         ${LZMA_DIR}/C/LzmaDec.c
         ${LZMA_DIR}/C/Lzma2Dec.c
    )

    add_library(rnupdate SHARED
        ${HDP_SOURCES}
    )

    target_include_directories(rnupdate PRIVATE
         ${CMAKE_CURRENT_SOURCE_DIR}
         ${PATCH_CORE_DIR}
         ${ANDROID_JNI_DIR}
         ${HDIFFPATCH_DIR}
         ${HDIFFPATCH_DIR}/libHDiffPatch/HPatch
         ${LZMA_DIR}/C
    )

    target_link_libraries(rnupdate PUBLIC
        libace_napi.z.so
    )
endif()

if(TARGET rnoh)
    add_library(rnoh_pushy SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/PushyTurboModule.cpp
    )
    target_include_directories(rnoh_pushy PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(rnoh_pushy PUBLIC rnoh)
endif()
