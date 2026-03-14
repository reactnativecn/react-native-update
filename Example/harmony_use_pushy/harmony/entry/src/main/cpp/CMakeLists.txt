cmake_minimum_required(VERSION 3.16)
project(rnapp)
set(RNOH_APP_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
set(NODE_MODULES "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../node_modules")
set(OH_MODULE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../oh_modules")
set(RNOH_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../oh_modules/@rnoh/react-native-openharmony/src/main/cpp")
set(OH_MODULES "${CMAKE_CURRENT_SOURCE_DIR}/../../../oh_modules")
set(LOG_VERBOSITY_LEVEL 1)
set(CMAKE_ASM_FLAGS "-Wno-error=unused-command-line-argument -Qunused-arguments")
set(CMAKE_CXX_FLAGS "-fstack-protector-strong -Wl,-z,relro,-z,now,-z,noexecstack -s -fPIE -pie")
set(OH_MODULES "${CMAKE_CURRENT_SOURCE_DIR}/../../../oh_modules")
set(WITH_HITRACE_SYSTRACE 1) # for other CMakeLists.txt files to use
add_compile_definitions(WITH_HITRACE_SYSTRACE)

set(PUSHY_CPP_DIR "${NODE_MODULES}/react-native-update/harmony/pushy/src/main/cpp")
if(NOT EXISTS "${PUSHY_CPP_DIR}/PushyTurboModule.cpp")
    message(FATAL_ERROR "Cannot find Pushy glue sources in node_modules: ${PUSHY_CPP_DIR}")
endif()
add_subdirectory("${RNOH_CPP_DIR}" ./rn)

file(GLOB PUSHY_GLUE_CPP CONFIGURE_DEPENDS "${PUSHY_CPP_DIR}/*.cpp")
add_library(rnoh_pushy SHARED ${PUSHY_GLUE_CPP})
target_include_directories(rnoh_pushy PUBLIC "${PUSHY_CPP_DIR}")
target_link_libraries(rnoh_pushy PUBLIC rnoh)

file(GLOB GENERATED_CPP_FILES "${CMAKE_CURRENT_SOURCE_DIR}/generated/*.cpp") # this line is needed by codegen v1

add_library(rnoh_app SHARED
    ${GENERATED_CPP_FILES}
    "./PackageProvider.cpp"
    "${RNOH_CPP_DIR}/RNOHAppNapiBridge.cpp"
)
target_include_directories(rnoh_app PRIVATE "${PUSHY_CPP_DIR}")
target_link_libraries(rnoh_app PUBLIC rnoh)
target_link_libraries(rnoh_app PUBLIC rnoh_pushy)
