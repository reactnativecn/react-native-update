#ifndef PUSHY_PATCH_CORE_JNI_NATIVES_H_
#define PUSHY_PATCH_CORE_JNI_NATIVES_H_

#include <jni.h>

// Android native methods. They are registered by name from JNI_OnLoad
// (jni_registration.cpp) instead of being exported as Java_* symbols, so the
// shared library's dynamic symbol table carries no class or method names.
namespace pushy {
namespace jni_natives {

jint SupportedDiffVersion(JNIEnv*, jclass);
jobject SyncStateWithBinaryVersion(JNIEnv* env, jclass, jstring package_version, jstring build_time, jobject state_result);
jobject RunStateCore(JNIEnv* env, jclass, jint operation, jobject state_result, jstring string_arg, jboolean flag_a, jboolean flag_b);
jobject BuildArchivePlan(JNIEnv* env, jclass, jint patch_type, jobjectArray entry_names, jobjectArray copy_froms, jobjectArray copy_tos, jobjectArray deletes);
jobjectArray BuildCopyGroups(JNIEnv* env, jclass, jobjectArray copy_froms, jobjectArray copy_tos);
void ApplyDeltaFromSource(JNIEnv* env, jclass, jstring source_root, jstring target_root, jstring origin_bundle_path, jstring bundle_patch_path, jstring bundle_output_path, jstring merge_source_subdir, jboolean enable_merge, jobjectArray copy_froms, jobjectArray copy_tos, jobjectArray deletes, jstring hbc_transform_meta);
void CleanupOldEntries(JNIEnv* env, jclass, jstring root_dir, jstring keep_current, jstring keep_previous, jint max_age_days);
jstring FlowBuildRequestBody(JNIEnv* env, jclass, jstring inputJson);
jstring FlowOrderEndpointCandidates(JNIEnv* env, jclass, jstring endpointsJson, jdouble randomSample);
jboolean FlowIsValidResponse(JNIEnv* env, jclass, jstring responseText);
jstring FlowHandleResponse(JNIEnv* env, jclass, jstring responseText, jstring identityJson, jstring afterDownload);

}  // namespace jni_natives
}  // namespace pushy

#endif  // PUSHY_PATCH_CORE_JNI_NATIVES_H_
