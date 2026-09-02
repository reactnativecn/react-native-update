// JNI surface of the update-flow decision layer for the Android orchestrator
// (NativeCheckOrchestrator.java). Pure string-in/string-out: every payload is
// JSON, matching the decision layer's own boundary. A null return means
// "input did not parse" and the caller skips the check round; a C++ exception
// (bad_alloc/length_error from an oversized body) maps onto that same path —
// it must never unwind through the JNI boundary.
#include <jni.h>

#include <cstdint>
#include <exception>
#include <limits>
#include <string>
#include <vector>

#include "../patch_core/jni_util.h"
#include "flow_json.h"
#include "update_flow_core.h"

namespace {

jstring ToJString(JNIEnv* env, const std::string& value) {
  // flow_json emits standard UTF-8, while NewStringUTF expects JNI's modified
  // UTF-8 and corrupts supplementary code points. Decode explicitly and pass
  // UTF-16 code units to NewString. Accept encoded surrogate code points too:
  // strings originating in Java may have entered through modified UTF-8.
  std::vector<jchar> utf16;
  utf16.reserve(value.size());
  size_t i = 0;
  while (i < value.size()) {
    const unsigned char first = static_cast<unsigned char>(value[i]);
    uint32_t codePoint = 0xfffd;
    size_t width = 1;
    if (first < 0x80) {
      codePoint = first;
    } else if (first >= 0xc2 && first <= 0xdf && i + 1 < value.size()) {
      const unsigned char b1 = static_cast<unsigned char>(value[i + 1]);
      if ((b1 & 0xc0) == 0x80) {
        codePoint = ((first & 0x1f) << 6) | (b1 & 0x3f);
        width = 2;
      }
    } else if (first == 0xc0 && i + 1 < value.size() &&
               static_cast<unsigned char>(value[i + 1]) == 0x80) {
      codePoint = 0;  // modified UTF-8 encoding of U+0000
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef && i + 2 < value.size()) {
      const unsigned char b1 = static_cast<unsigned char>(value[i + 1]);
      const unsigned char b2 = static_cast<unsigned char>(value[i + 2]);
      if ((b1 & 0xc0) == 0x80 && (b2 & 0xc0) == 0x80 &&
          !(first == 0xe0 && b1 < 0xa0)) {
        codePoint = ((first & 0x0f) << 12) | ((b1 & 0x3f) << 6) |
                    (b2 & 0x3f);
        width = 3;
      }
    } else if (first >= 0xf0 && first <= 0xf4 && i + 3 < value.size()) {
      const unsigned char b1 = static_cast<unsigned char>(value[i + 1]);
      const unsigned char b2 = static_cast<unsigned char>(value[i + 2]);
      const unsigned char b3 = static_cast<unsigned char>(value[i + 3]);
      if ((b1 & 0xc0) == 0x80 && (b2 & 0xc0) == 0x80 &&
          (b3 & 0xc0) == 0x80 && !(first == 0xf0 && b1 < 0x90) &&
          !(first == 0xf4 && b1 > 0x8f)) {
        codePoint = ((first & 0x07) << 18) | ((b1 & 0x3f) << 12) |
                    ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        width = 4;
      }
    }
    i += width;
    if (codePoint <= 0xffff) {
      utf16.push_back(static_cast<jchar>(codePoint));
    } else {
      codePoint -= 0x10000;
      utf16.push_back(static_cast<jchar>(0xd800 + (codePoint >> 10)));
      utf16.push_back(static_cast<jchar>(0xdc00 + (codePoint & 0x3ff)));
    }
  }
  if (utf16.size() > static_cast<size_t>(std::numeric_limits<jsize>::max())) {
    return nullptr;
  }
  return env->NewString(utf16.empty() ? nullptr : utf16.data(),
                        static_cast<jsize>(utf16.size()));
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_cn_reactnative_modules_update_NativeUpdateFlow_buildCheckRequestBody(
    JNIEnv* env, jclass, jstring inputJson) {
  try {
    bool ok = false;
    flowjson::Value input = flowjson::Parse(
        pushy::jni_util::JStringToString(env, inputJson), &ok);
    if (!ok || !input.IsObject()) {
      return nullptr;
    }
    return ToJString(
        env, flowjson::Stringify(updateflow::BuildCheckRequestBody(input)));
  } catch (...) {
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_reactnative_modules_update_NativeUpdateFlow_orderEndpointCandidates(
    JNIEnv* env, jclass, jstring endpointsJson, jdouble randomSample) {
  try {
    bool ok = false;
    flowjson::Value endpoints = flowjson::Parse(
        pushy::jni_util::JStringToString(env, endpointsJson), &ok);
    if (!ok || !endpoints.IsArray()) {
      return nullptr;
    }
    return ToJString(env, flowjson::Stringify(updateflow::OrderEndpointCandidates(
                              endpoints, randomSample)));
  } catch (...) {
    return nullptr;
  }
}

extern "C" JNIEXPORT jboolean JNICALL
Java_cn_reactnative_modules_update_NativeUpdateFlow_isValidCheckResponse(
    JNIEnv* env, jclass, jstring responseText) {
  if (responseText == nullptr) {
    return JNI_FALSE;
  }
  try {
    return updateflow::IsValidCheckResponse(
               pushy::jni_util::JStringToString(env, responseText))
               ? JNI_TRUE
               : JNI_FALSE;
  } catch (...) {
    return JNI_FALSE;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_reactnative_modules_update_NativeUpdateFlow_handleCheckResponse(
    JNIEnv* env, jclass, jstring responseText, jstring identityJson,
    jstring afterDownload) {
  try {
    bool ok = false;
    flowjson::Value identity = flowjson::Parse(
        pushy::jni_util::JStringToString(env, identityJson), &ok);
    if (!ok || !identity.IsObject()) {
      return nullptr;
    }
    return ToJString(env, flowjson::Stringify(updateflow::HandleCheckResponse(
                              pushy::jni_util::JStringToString(env, responseText),
                              identity, false,
                              pushy::jni_util::JStringToString(env, afterDownload))));
  } catch (...) {
    return nullptr;
  }
}
