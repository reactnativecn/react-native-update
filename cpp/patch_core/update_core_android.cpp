#include <jni.h>

#include <string>
#include <vector>

#include "archive_patch_core.h"
#include "state_core.h"

namespace {

enum class StateOperation {
  kSwitchVersion = 1,
  kMarkSuccess = 2,
  kRollback = 3,
  kClearFirstTime = 4,
  kClearRollbackMark = 5,
  kResolveLaunch = 6,
};

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
  for (jsize index = 0; index < size; ++index) {
    auto* item = static_cast<jstring>(env->GetObjectArrayElement(values, index));
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

void SetStringField(
    JNIEnv* env,
    jobject target,
    jclass target_class,
    const char* field_name,
    const std::string& value) {
  jfieldID field =
      env->GetFieldID(target_class, field_name, "Ljava/lang/String;");
  if (field == nullptr) {
    return;
  }
  if (value.empty()) {
    env->SetObjectField(target, field, nullptr);
    return;
  }

  jstring java_value = env->NewStringUTF(value.c_str());
  env->SetObjectField(target, field, java_value);
  env->DeleteLocalRef(java_value);
}

void SetBooleanField(
    JNIEnv* env,
    jobject target,
    jclass target_class,
    const char* field_name,
    bool value) {
  jfieldID field = env->GetFieldID(target_class, field_name, "Z");
  if (field != nullptr) {
    env->SetBooleanField(target, field, value ? JNI_TRUE : JNI_FALSE);
  }
}

std::string GetStringField(
    JNIEnv* env,
    jobject target,
    jclass target_class,
    const char* field_name) {
  jfieldID field =
      env->GetFieldID(target_class, field_name, "Ljava/lang/String;");
  if (field == nullptr) {
    return std::string();
  }
  auto* value = static_cast<jstring>(env->GetObjectField(target, field));
  std::string result = JStringToString(env, value);
  if (value != nullptr) {
    env->DeleteLocalRef(value);
  }
  return result;
}

bool GetBooleanField(
    JNIEnv* env,
    jobject target,
    jclass target_class,
    const char* field_name) {
  jfieldID field = env->GetFieldID(target_class, field_name, "Z");
  return field != nullptr && env->GetBooleanField(target, field) == JNI_TRUE;
}

pushy::state::State ReadState(
    const std::string& package_version,
    const std::string& build_time,
    const std::string& current_version,
    const std::string& last_version,
    bool first_time,
    bool first_time_ok,
    const std::string& rolled_back_version) {
  pushy::state::State state;
  state.package_version = package_version;
  state.build_time = build_time;
  state.current_version = current_version;
  state.last_version = last_version;
  state.first_time = first_time;
  state.first_time_ok = first_time_ok;
  state.rolled_back_version = rolled_back_version;
  return state;
}

pushy::state::State ReadStateFromResult(JNIEnv* env, jobject state_result) {
  if (state_result == nullptr) {
    return pushy::state::State();
  }

  jclass state_class = env->GetObjectClass(state_result);
  if (state_class == nullptr) {
    return pushy::state::State();
  }

  pushy::state::State state = ReadState(
      GetStringField(env, state_result, state_class, "packageVersion"),
      GetStringField(env, state_result, state_class, "buildTime"),
      GetStringField(env, state_result, state_class, "currentVersion"),
      GetStringField(env, state_result, state_class, "lastVersion"),
      GetBooleanField(env, state_result, state_class, "firstTime"),
      GetBooleanField(env, state_result, state_class, "firstTimeOk"),
      GetStringField(env, state_result, state_class, "rolledBackVersion"));
  env->DeleteLocalRef(state_class);
  return state;
}

jobject NewStateCoreResult(
    JNIEnv* env,
    const pushy::state::State& state,
    bool changed,
    const std::string& stale_version_to_delete,
    const std::string& load_version,
    bool did_rollback,
    bool consumed_first_time) {
  jclass result_class =
      env->FindClass("cn/reactnative/modules/update/StateCoreResult");
  if (result_class == nullptr) {
    return nullptr;
  }

  jmethodID constructor = env->GetMethodID(result_class, "<init>", "()V");
  if (constructor == nullptr) {
    return nullptr;
  }

  jobject result = env->NewObject(result_class, constructor);
  if (result == nullptr) {
    return nullptr;
  }

  SetStringField(env, result, result_class, "packageVersion", state.package_version);
  SetStringField(env, result, result_class, "buildTime", state.build_time);
  SetStringField(env, result, result_class, "currentVersion", state.current_version);
  SetStringField(env, result, result_class, "lastVersion", state.last_version);
  SetBooleanField(env, result, result_class, "firstTime", state.first_time);
  SetBooleanField(env, result, result_class, "firstTimeOk", state.first_time_ok);
  SetStringField(
      env,
      result,
      result_class,
      "rolledBackVersion",
      state.rolled_back_version);
  SetBooleanField(env, result, result_class, "changed", changed);
  SetStringField(
      env,
      result,
      result_class,
      "staleVersionToDelete",
      stale_version_to_delete);
  SetStringField(env, result, result_class, "loadVersion", load_version);
  SetBooleanField(env, result, result_class, "didRollback", did_rollback);
  SetBooleanField(
      env,
      result,
      result_class,
      "consumedFirstTime",
      consumed_first_time);
  return result;
}

jobject NewArchivePatchPlanResult(
    JNIEnv* env,
    const pushy::archive_patch::ArchivePatchPlan& plan) {
  jclass result_class =
      env->FindClass("cn/reactnative/modules/update/ArchivePatchPlanResult");
  if (result_class == nullptr) {
    return nullptr;
  }

  jmethodID constructor = env->GetMethodID(result_class, "<init>", "()V");
  if (constructor == nullptr) {
    return nullptr;
  }

  jobject result = env->NewObject(result_class, constructor);
  if (result == nullptr) {
    return nullptr;
  }

  SetStringField(
      env,
      result,
      result_class,
      "mergeSourceSubdir",
      plan.merge_source_subdir);
  SetBooleanField(env, result, result_class, "enableMerge", plan.enable_merge);
  return result;
}

jobject NewCopyGroupResult(
    JNIEnv* env,
    const pushy::archive_patch::CopyGroup& group) {
  jclass result_class =
      env->FindClass("cn/reactnative/modules/update/CopyGroupResult");
  if (result_class == nullptr) {
    return nullptr;
  }

  jmethodID constructor = env->GetMethodID(result_class, "<init>", "()V");
  if (constructor == nullptr) {
    return nullptr;
  }

  jobject result = env->NewObject(result_class, constructor);
  if (result == nullptr) {
    return nullptr;
  }

  SetStringField(env, result, result_class, "from", group.from);
  jfieldID to_paths_field =
      env->GetFieldID(result_class, "toPaths", "[Ljava/lang/String;");
  if (to_paths_field != nullptr) {
    jclass string_class = env->FindClass("java/lang/String");
    jobjectArray to_paths = env->NewObjectArray(
        static_cast<jsize>(group.to_paths.size()), string_class, nullptr);
    if (to_paths != nullptr) {
      for (jsize index = 0; index < static_cast<jsize>(group.to_paths.size());
           ++index) {
        jstring value = env->NewStringUTF(group.to_paths[index].c_str());
        env->SetObjectArrayElement(to_paths, index, value);
        env->DeleteLocalRef(value);
      }
      env->SetObjectField(result, to_paths_field, to_paths);
      env->DeleteLocalRef(to_paths);
    }
  }

  return result;
}

pushy::archive_patch::ArchivePatchType ToArchivePatchType(jint patch_type) {
  switch (patch_type) {
    case 1:
      return pushy::archive_patch::ArchivePatchType::kFull;
    case 2:
      return pushy::archive_patch::ArchivePatchType::kPatchFromPackage;
    case 3:
      return pushy::archive_patch::ArchivePatchType::kPatchFromPpk;
    default:
      return pushy::archive_patch::ArchivePatchType::kFull;
  }
}

pushy::patch::PatchManifest BuildManifest(
    const std::vector<std::string>& copy_froms,
    const std::vector<std::string>& copy_tos,
    const std::vector<std::string>& deletes) {
  pushy::patch::PatchManifest manifest;
  for (size_t index = 0; index < copy_froms.size(); ++index) {
    manifest.copies.push_back(
        pushy::patch::CopyOperation{copy_froms[index], copy_tos[index]});
  }
  manifest.deletes = deletes;
  return manifest;
}

jobject MakeStateResult(
    JNIEnv* env,
    const pushy::state::State& state,
    bool changed = false,
    const std::string& stale_version_to_delete = std::string(),
    const std::string& load_version = std::string(),
    bool did_rollback = false,
    bool consumed_first_time = false) {
  return NewStateCoreResult(
      env,
      state,
      changed,
      stale_version_to_delete,
      load_version,
      did_rollback,
      consumed_first_time);
}

}  // namespace

extern "C" JNIEXPORT jobject JNICALL
Java_cn_reactnative_modules_update_UpdateContext_syncStateWithBinaryVersion(
    JNIEnv* env,
    jclass,
    jstring package_version,
    jstring build_time,
    jobject state_result) {
  pushy::state::State state = ReadStateFromResult(env, state_result);
  pushy::state::BinaryVersionSyncResult result = pushy::state::SyncBinaryVersion(
      state,
      JStringToString(env, package_version),
      JStringToString(env, build_time));
  return MakeStateResult(env, result.state, result.changed);
}

extern "C" JNIEXPORT jobject JNICALL
Java_cn_reactnative_modules_update_UpdateContext_runStateCore(
    JNIEnv* env,
    jclass,
    jint operation,
    jobject state_result,
    jstring string_arg,
    jboolean flag_a,
    jboolean flag_b) {
  const pushy::state::State state = ReadStateFromResult(env, state_result);
  switch (static_cast<StateOperation>(operation)) {
    case StateOperation::kSwitchVersion:
      return MakeStateResult(
          env,
          pushy::state::SwitchVersion(state, JStringToString(env, string_arg)));
    case StateOperation::kMarkSuccess: {
      const pushy::state::MarkSuccessResult result =
          pushy::state::MarkSuccess(state);
      return MakeStateResult(
          env,
          result.state,
          false,
          result.stale_version_to_delete);
    }
    case StateOperation::kRollback: {
      const pushy::state::State next = pushy::state::Rollback(state);
      return MakeStateResult(
          env, next, false, std::string(), next.current_version, true);
    }
    case StateOperation::kClearFirstTime:
      return MakeStateResult(env, pushy::state::ClearFirstTime(state));
    case StateOperation::kClearRollbackMark:
      return MakeStateResult(env, pushy::state::ClearRollbackMark(state));
    case StateOperation::kResolveLaunch: {
      const pushy::state::LaunchDecision decision =
          pushy::state::ResolveLaunchState(
              state, flag_a == JNI_TRUE, flag_b == JNI_TRUE);
      return MakeStateResult(
          env,
          decision.state,
          false,
          std::string(),
          decision.load_version,
          decision.did_rollback,
          decision.consumed_first_time);
    }
  }

  ThrowRuntimeException(env, "Unknown state operation");
  return nullptr;
}

extern "C" JNIEXPORT jobject JNICALL
Java_cn_reactnative_modules_update_DownloadTask_buildArchivePatchPlan(
    JNIEnv* env,
    jclass,
    jint patch_type,
    jobjectArray entry_names,
    jobjectArray copy_froms,
    jobjectArray copy_tos,
    jobjectArray deletes) {
  const std::vector<std::string> from_values = JArrayToVector(env, copy_froms);
  const std::vector<std::string> to_values = JArrayToVector(env, copy_tos);
  if (from_values.size() != to_values.size()) {
    ThrowRuntimeException(env, "copy_froms and copy_tos length mismatch");
    return nullptr;
  }

  pushy::patch::PatchManifest manifest =
      BuildManifest(from_values, to_values, JArrayToVector(env, deletes));
  pushy::archive_patch::ArchivePatchPlan plan;
  pushy::patch::Status status = pushy::archive_patch::BuildArchivePatchPlan(
      ToArchivePatchType(patch_type),
      manifest,
      JArrayToVector(env, entry_names),
      &plan);
  if (!status.ok) {
    ThrowRuntimeException(env, status.message);
    return nullptr;
  }

  return NewArchivePatchPlanResult(env, plan);
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_cn_reactnative_modules_update_DownloadTask_buildCopyGroups(
    JNIEnv* env,
    jclass,
    jobjectArray copy_froms,
    jobjectArray copy_tos) {
  const std::vector<std::string> from_values = JArrayToVector(env, copy_froms);
  const std::vector<std::string> to_values = JArrayToVector(env, copy_tos);
  if (from_values.size() != to_values.size()) {
    ThrowRuntimeException(env, "copy_froms and copy_tos length mismatch");
    return nullptr;
  }

  pushy::patch::PatchManifest manifest = BuildManifest(
      from_values, to_values, std::vector<std::string>());
  std::vector<pushy::archive_patch::CopyGroup> groups;
  pushy::patch::Status status =
      pushy::archive_patch::BuildCopyGroups(manifest, &groups);
  if (!status.ok) {
    ThrowRuntimeException(env, status.message);
    return nullptr;
  }

  jclass result_class =
      env->FindClass("cn/reactnative/modules/update/CopyGroupResult");
  if (result_class == nullptr) {
    return nullptr;
  }

  jobjectArray result = env->NewObjectArray(
      static_cast<jsize>(groups.size()), result_class, nullptr);
  if (result == nullptr) {
    return nullptr;
  }

  for (jsize index = 0; index < static_cast<jsize>(groups.size()); ++index) {
    jobject group = NewCopyGroupResult(env, groups[index]);
    env->SetObjectArrayElement(result, index, group);
    env->DeleteLocalRef(group);
  }
  return result;
}
