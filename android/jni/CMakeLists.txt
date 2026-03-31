cmake_minimum_required(VERSION 3.18.1)

project(rnupdate LANGUAGES C CXX)

add_library(
  rnupdate
  SHARED
  DownloadTask.c
  ../../cpp/patch_core/archive_patch_core.cpp
  ../../cpp/patch_core/patch_core.cpp
  ../../cpp/patch_core/patch_core_android.cpp
  ../../cpp/patch_core/state_core.cpp
  ../../cpp/patch_core/update_core_android.cpp
  HDiffPatch/file_for_patch.c
  HDiffPatch/libHDiffPatch/HPatch/patch.c
  hpatch.c
  lzma/C/Lzma2Dec.c
  lzma/C/LzmaDec.c
)

target_include_directories(
  rnupdate
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/../../cpp/patch_core
    ${CMAKE_CURRENT_SOURCE_DIR}/HDiffPatch
    ${CMAKE_CURRENT_SOURCE_DIR}/HDiffPatch/libHDiffPatch/HPatch
    ${CMAKE_CURRENT_SOURCE_DIR}/lzma/C
)

target_compile_features(rnupdate PRIVATE cxx_std_17)

set_target_properties(
  rnupdate
  PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED YES
    C_EXTENSIONS YES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED YES
    CXX_EXTENSIONS NO
    C_VISIBILITY_PRESET hidden
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES
)

target_compile_options(
  rnupdate
  PRIVATE
    -ffunction-sections
    -fdata-sections
    -fno-unwind-tables
    -fno-asynchronous-unwind-tables
    -Oz
    $<$<COMPILE_LANGUAGE:C>:-Wno-error=format-security>
    $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>
    $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
)

target_link_options(
  rnupdate
  PRIVATE
    -Wl,--gc-sections
    -Wl,--exclude-libs,ALL
)
