cmake_minimum_required(VERSION 3.13)
project(rnupdate)

set(HDIFFPATCH_DIR ${CMAKE_CURRENT_SOURCE_DIR}/HDiffPatch)
set(LZMA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/lzma)
set(HDP_SOURCES
     ${CMAKE_CURRENT_SOURCE_DIR}/pushy.c
     ${CMAKE_CURRENT_SOURCE_DIR}/hpatch.c
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

