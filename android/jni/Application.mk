APP_PLATFORM := android-21
APP_CFLAGS += -Wno-error=format-security
APP_CFLAGS += -fvisibility=hidden -fvisibility-inlines-hidden
APP_CFLAGS += -ffunction-sections -fdata-sections
APP_CFLAGS += -Oz -fno-unwind-tables -fno-asynchronous-unwind-tables
APP_CPPFLAGS += -std=c++17 -Oz -fno-exceptions -fno-rtti -fno-unwind-tables -fno-asynchronous-unwind-tables
APP_LDFLAGS += -Wl,--gc-sections -Wl,--exclude-libs,ALL
APP_BUILD_SCRIPT := Android.mk
APP_ABI := armeabi-v7a arm64-v8a x86 x86_64
APP_STL := c++_static
