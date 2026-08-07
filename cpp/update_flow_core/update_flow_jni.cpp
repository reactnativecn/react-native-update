// JNI surface of the update-flow decision layer for the Android orchestrator
// (NativeCheckOrchestrator.java). Pure string-in/string-out: every payload is
// JSON, matching the decision layer's own boundary. A null return means
// "input did not parse" and the caller skips the check round.
#include <jni.h>

#include <string>

#include "../patch_core/jni_util.h"
#include "flow_json.h"
#include "update_flow_core.h"

namespace {

jstring ToJString(JNIEnv* env, const std::string& value) {
  return env->NewStringUTF(value.c_str());
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_cn_reactnative_modules_update_NativeUpdateFlow_buildCheckRequestBody(
    JNIEnv* env, jclass, jstring inputJson) {
  bool ok = false;
  flowjson::Value input = flowjson::Parse(
      pushy::jni_util::JStringToString(env, inputJson), &ok);
  if (!ok || !input.IsObject()) {
    return nullptr;
  }
  return ToJString(
      env, flowjson::Stringify(updateflow::BuildCheckRequestBody(input)));
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_reactnative_modules_update_NativeUpdateFlow_orderEndpointCandidates(
    JNIEnv* env, jclass, jstring endpointsJson, jdouble randomSample) {
  bool ok = false;
  flowjson::Value endpoints = flowjson::Parse(
      pushy::jni_util::JStringToString(env, endpointsJson), &ok);
  if (!ok || !endpoints.IsArray()) {
    return nullptr;
  }
  return ToJString(env, flowjson::Stringify(updateflow::OrderEndpointCandidates(
                            endpoints, randomSample)));
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_reactnative_modules_update_NativeUpdateFlow_handleCheckResponse(
    JNIEnv* env, jclass, jstring responseText, jstring identityJson) {
  bool ok = false;
  flowjson::Value identity = flowjson::Parse(
      pushy::jni_util::JStringToString(env, identityJson), &ok);
  if (!ok || !identity.IsObject()) {
    return nullptr;
  }
  return ToJString(env, flowjson::Stringify(updateflow::HandleCheckResponse(
                            pushy::jni_util::JStringToString(env, responseText),
                            identity, false)));
}
