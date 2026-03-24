LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)

LOCAL_MODULE := rnupdate
LOCAL_CPPFLAGS += -std=c++17
LOCAL_LDFLAGS += -Wl,--exclude-libs,ALL
LOCAL_C_INCLUDES := \
	$(LOCAL_PATH) \
	$(LOCAL_PATH)/HDiffPatch \
	$(LOCAL_PATH)/HDiffPatch/libHDiffPatch/HPatch \
	$(LOCAL_PATH)/lzma/C \
	$(LOCAL_PATH)/../../cpp/patch_core

Hdp_Files := \
	hpatch.c \
    HDiffPatch/libHDiffPatch/HPatch/patch.c \
	HDiffPatch/file_for_patch.c \
	lzma/C/LzmaDec.c \
    lzma/C/Lzma2Dec.c

LOCAL_SRC_FILES := \
	DownloadTask.c \
	../../cpp/patch_core/archive_patch_core.cpp \
	../../cpp/patch_core/patch_core.cpp \
	../../cpp/patch_core/patch_core_android.cpp \
	../../cpp/patch_core/state_core.cpp \
	../../cpp/patch_core/update_core_android.cpp \
	$(Hdp_Files)

include $(BUILD_SHARED_LIBRARY)
