APP_PLATFORM := android-21
APP_CFLAGS += -Wno-error=format-security
APP_CFLAGS += -fvisibility=hidden -fvisibility-inlines-hidden
APP_CFLAGS += -ffunction-sections -fdata-sections
APP_CFLAGS += -Oz -fno-unwind-tables -fno-asynchronous-unwind-tables
# -fexceptions (ndk-build defaults to -fno-exceptions): the cpp/ cores allocate
# proportionally to untrusted input, and without exceptions a bad_alloc /
# length_error would std::terminate the process instead of surfacing as a Java
# exception (every JNI entry point catches and rethrows). Unwind tables are
# still emitted for throwing frames.
APP_CPPFLAGS += -std=c++17 -Oz -fexceptions -fno-rtti -fno-unwind-tables -fno-asynchronous-unwind-tables
APP_LDFLAGS += -Wl,--gc-sections -Wl,--exclude-libs,ALL
APP_LDFLAGS += -Wl,--icf=all
APP_BUILD_SCRIPT := Android.mk
APP_ABI := armeabi-v7a arm64-v8a x86 x86_64
APP_STL := c++_static
