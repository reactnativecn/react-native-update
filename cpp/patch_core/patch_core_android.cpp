#include <jni.h>

#include <string>
#include <vector>

#include "patch_core.h"

namespace {

std::string JStringToString(JNIEnv* env, jstring value) {
  if (value == nullptr) {
    return std::string();
  }

  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    return std::string();
  }

  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

std::vector<std::string> JArrayToVector(JNIEnv* env, jobjectArray values) {
  std::vector<std::string> result;
  if (values == nullptr) {
    return result;
  }

  const jsize size = env->GetArrayLength(values);
  result.reserve(static_cast<size_t>(size));
  for (jsize i = 0; i < size; ++i) {
    auto* item = static_cast<jstring>(env->GetObjectArrayElement(values, i));
    result.push_back(JStringToString(env, item));
    env->DeleteLocalRef(item);
  }
  return result;
}

void ThrowRuntimeException(JNIEnv* env, const std::string& message) {
  jclass exception = env->FindClass("java/lang/RuntimeException");
  if (exception != nullptr) {
    env->ThrowNew(exception, message.c_str());
  }
}

}  // namespace

extern "C" JNIEXPORT void JNICALL
Java_cn_reactnative_modules_update_DownloadTask_applyPatchFromFileSource(
    JNIEnv* env,
    jclass,
    jstring source_root,
    jstring target_root,
    jstring origin_bundle_path,
    jstring bundle_patch_path,
    jstring bundle_output_path,
    jstring merge_source_subdir,
    jboolean enable_merge,
    jobjectArray copy_froms,
    jobjectArray copy_tos,
    jobjectArray deletes) {
  const std::vector<std::string> from_values = JArrayToVector(env, copy_froms);
  const std::vector<std::string> to_values = JArrayToVector(env, copy_tos);

  if (from_values.size() != to_values.size()) {
    ThrowRuntimeException(env, "copy_froms and copy_tos length mismatch");
    return;
  }

  pushy::patch::FileSourcePatchOptions options;
  options.source_root = JStringToString(env, source_root);
  options.target_root = JStringToString(env, target_root);
  options.origin_bundle_path = JStringToString(env, origin_bundle_path);
  options.bundle_patch_path = JStringToString(env, bundle_patch_path);
  options.bundle_output_path = JStringToString(env, bundle_output_path);
  options.merge_source_subdir = JStringToString(env, merge_source_subdir);
  options.enable_merge = enable_merge == JNI_TRUE;

  for (size_t index = 0; index < from_values.size(); ++index) {
    options.manifest.copies.push_back(pushy::patch::CopyOperation{
        from_values[index],
        to_values[index],
    });
  }
  options.manifest.deletes = JArrayToVector(env, deletes);

  const pushy::patch::Status status =
      pushy::patch::ApplyPatchFromFileSource(options);
  if (!status.ok) {
    ThrowRuntimeException(env, status.message);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_cn_reactnative_modules_update_DownloadTask_cleanupOldEntries(
    JNIEnv* env,
    jclass,
    jstring root_dir,
    jstring keep_current,
    jstring keep_previous,
    jint max_age_days) {
  const pushy::patch::Status status = pushy::patch::CleanupOldEntries(
      JStringToString(env, root_dir),
      JStringToString(env, keep_current),
      JStringToString(env, keep_previous),
      static_cast<int>(max_age_days));
  if (!status.ok) {
    ThrowRuntimeException(env, status.message);
  }
}
