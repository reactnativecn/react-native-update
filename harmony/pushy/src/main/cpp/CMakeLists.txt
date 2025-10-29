cmake_minimum_required(VERSION 3.13)
project(rnupdate)

# Point to android/jni directory for shared source code
set(ANDROID_JNI_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../node_modules/react-native-update/android/jni)
set(HDIFFPATCH_DIR ${ANDROID_JNI_DIR}/HDiffPatch)
set(LZMA_DIR ${ANDROID_JNI_DIR}/lzma)
set(HDP_SOURCES
     ${CMAKE_CURRENT_SOURCE_DIR}/pushy.c
     ${ANDROID_JNI_DIR}/hpatch.c
     ${HDIFFPATCH_DIR}/libHDiffPatch/HPatch/patch.c
     ${HDIFFPATCH_DIR}/file_for_patch.c
     ${LZMA_DIR}/C/LzmaDec.c
     ${LZMA_DIR}/C/Lzma2Dec.c
)
set(CMAKE_VERBOSE_MAKEFILE on)


add_library(rnupdate SHARED
    ${HDP_SOURCES}
)

target_include_directories(rnupdate PRIVATE
     ${CMAKE_CURRENT_SOURCE_DIR}
     ${ANDROID_JNI_DIR}
     ${HDIFFPATCH_DIR}
     ${HDIFFPATCH_DIR}/libHDiffPatch/HPatch
     ${LZMA_DIR}/C
)

target_link_libraries(rnupdate PUBLIC
    libace_napi.z.so
)

file(GLOB rnoh_pushy_SRC CONFIGURE_DEPENDS *.cpp)
add_library(rnoh_pushy SHARED ${rnoh_pushy_SRC})
target_include_directories(rnoh_pushy PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(rnoh_pushy PUBLIC rnoh)

