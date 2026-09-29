#include <jni.h>

#include "jni_natives.h"
#include "obscured_text.h"

#include <exception>
#include <string>
#include <vector>

#include "archive_patch_core.h"
#include "hbc_transform_wire.h"
#include "jni_util.h"
#include "state_core.h"
#include "state_ops.h"

namespace {

using pushy::jni_util::JArrayToVector;
using pushy::jni_util::JStringToString;
using pushy::jni_util::ThrowRuntimeException;
using pushy::state_ops::StateOperation;

void SetStringField(
    JNIEnv* env,
    jobject target,
    jclass target_class,
    const char* field_name,
    const std::string& value) {
  jfieldID field =
      env->GetFieldID(target_class, field_name, "Ljava/lang/String;");
  if (field == nullptr) {
    // Clear the pending NoSuchFieldError so subsequent JNI calls are not
    // executed with an exception pending (undefined behavior / CheckJNI abort).
    env->ExceptionClear();
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
  if (field == nullptr) {
    env->ExceptionClear();
    return;
  }
  env->SetBooleanField(target, field, value ? JNI_TRUE : JNI_FALSE);
}

std::string GetStringField(
    JNIEnv* env,
    jobject target,
    jclass target_class,
    const char* field_name) {
  jfieldID field =
      env->GetFieldID(target_class, field_name, "Ljava/lang/String;");
  if (field == nullptr) {
    env->ExceptionClear();
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
  if (field == nullptr) {
    env->ExceptionClear();
    return false;
  }
  return env->GetBooleanField(target, field) == JNI_TRUE;
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
      env->FindClass(
          pushy::text::Reveal("3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c93a99b63511201f9cd97878c695522").c_str());
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
      env->FindClass(
          pushy::text::Reveal("3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c81af997f5d270bdbc9b181974c55371dc2c8b9926855").c_str());
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
    jclass result_class,
    jclass string_class,
    const pushy::archive_patch::CopyGroup& group) {
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
  } else {
    env->ExceptionClear();
  }

  return result;
}

bool ToArchivePatchType(
    jint patch_type,
    pushy::archive_patch::ArchivePatchType* out) {
  // Delegate to the shared parser so Android and HarmonyOS agree on which
  // integer values are valid and neither silently falls back to kFull.
  return pushy::archive_patch::TryParseArchivePatchType(
      static_cast<int>(patch_type), out);
}

pushy::delta::PatchManifest BuildManifest(
    const std::vector<std::string>& copy_froms,
    const std::vector<std::string>& copy_tos,
    const std::vector<std::string>& deletes) {
  pushy::delta::PatchManifest manifest;
  for (size_t index = 0; index < copy_froms.size(); ++index) {
    manifest.copies.push_back(
        pushy::delta::CopyOperation{copy_froms[index], copy_tos[index]});
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

// 客户端可消费的 diff 轨道版本(能力上报,而非 SDK 版本映射);JS 层经
// getConstants 暴露,随 checkUpdate 以 diffV 上报,服务端据此下发 v2 轨道。
jint pushy::jni_natives::SupportedDiffVersion(
    JNIEnv*,
    jclass) {
  return static_cast<jint>(pushy::hbc::kSupportedDiffVersion);
}

jobject pushy::jni_natives::SyncStateWithBinaryVersion(
    JNIEnv* env,
    jclass,
    jstring package_version,
    jstring build_time,
    jobject state_result) {
  // C++ exceptions (bad_alloc/length_error from input-proportional STL
  // allocations) must not unwind through the JNI boundary: convert them to a
  // Java RuntimeException like every other failure of these entry points.
  try {
    pushy::state::State state = ReadStateFromResult(env, state_result);
    pushy::state::BinaryVersionSyncResult result = pushy::state::SyncBinaryVersion(
        state,
        JStringToString(env, package_version),
        JStringToString(env, build_time));
    return MakeStateResult(env, result.state, result.changed);
  } catch (const std::exception& error) {
    ThrowRuntimeException(env, error.what());
  } catch (...) {
    ThrowRuntimeException(env, "Unexpected native exception in syncStateWithBinaryVersion");
  }
  return nullptr;
}

jobject pushy::jni_natives::RunStateCore(
    JNIEnv* env,
    jclass,
    jint operation,
    jobject state_result,
    jstring string_arg,
    jboolean flag_a,
    jboolean flag_b) {
  try {
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
  } catch (const std::exception& error) {
    ThrowRuntimeException(env, error.what());
  } catch (...) {
    ThrowRuntimeException(env, "Unexpected native exception in runStateCore");
  }
  return nullptr;
}

jobject pushy::jni_natives::BuildArchivePlan(
    JNIEnv* env,
    jclass,
    jint patch_type,
    jobjectArray entry_names,
    jobjectArray copy_froms,
    jobjectArray copy_tos,
    jobjectArray deletes) {
  try {
    const std::vector<std::string> from_values = JArrayToVector(env, copy_froms);
    const std::vector<std::string> to_values = JArrayToVector(env, copy_tos);
    if (from_values.size() != to_values.size()) {
      ThrowRuntimeException(env, "copy_froms and copy_tos length mismatch");
      return nullptr;
    }

    pushy::delta::PatchManifest manifest =
        BuildManifest(from_values, to_values, JArrayToVector(env, deletes));
    pushy::archive_patch::ArchivePatchType archive_type;
    if (!ToArchivePatchType(patch_type, &archive_type)) {
      ThrowRuntimeException(env, "Unknown archive delta type");
      return nullptr;
    }
    pushy::archive_patch::ArchivePatchPlan plan;
    pushy::delta::Status status = pushy::archive_patch::BuildArchivePatchPlan(
        archive_type,
        manifest,
        JArrayToVector(env, entry_names),
        &plan);
    if (!status.ok) {
      ThrowRuntimeException(env, status.message);
      return nullptr;
    }

    return NewArchivePatchPlanResult(env, plan);
  } catch (const std::exception& error) {
    ThrowRuntimeException(env, error.what());
  } catch (...) {
    ThrowRuntimeException(env, "Unexpected native exception while planning archive");
  }
  return nullptr;
}

jobjectArray pushy::jni_natives::BuildCopyGroups(
    JNIEnv* env,
    jclass,
    jobjectArray copy_froms,
    jobjectArray copy_tos) {
  try {
    const std::vector<std::string> from_values = JArrayToVector(env, copy_froms);
    const std::vector<std::string> to_values = JArrayToVector(env, copy_tos);
    if (from_values.size() != to_values.size()) {
      ThrowRuntimeException(env, "copy_froms and copy_tos length mismatch");
      return nullptr;
    }

    pushy::delta::PatchManifest manifest = BuildManifest(
        from_values, to_values, std::vector<std::string>());
    std::vector<pushy::archive_patch::CopyGroup> groups;
    pushy::delta::Status status =
        pushy::archive_patch::BuildCopyGroups(manifest, &groups);
    if (!status.ok) {
      ThrowRuntimeException(env, status.message);
      return nullptr;
    }

    jclass result_class =
        env->FindClass(
          pushy::text::Reveal("3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c83b28a6e732301fed897878c695522").c_str());
    if (result_class == nullptr) {
      return nullptr;
    }

    jclass string_class = env->FindClass("java/lang/String");
    if (string_class == nullptr) {
      return nullptr;
    }

    jobjectArray result = env->NewObjectArray(
        static_cast<jsize>(groups.size()), result_class, nullptr);
    if (result == nullptr) {
      return nullptr;
    }

    for (jsize index = 0; index < static_cast<jsize>(groups.size()); ++index) {
      jobject group = NewCopyGroupResult(env, result_class, string_class, groups[index]);
      env->SetObjectArrayElement(result, index, group);
      env->DeleteLocalRef(group);
    }
    env->DeleteLocalRef(string_class);
    return result;
  } catch (const std::exception& error) {
    ThrowRuntimeException(env, error.what());
  } catch (...) {
    ThrowRuntimeException(env, "Unexpected native exception in buildCopyGroups");
  }
  return nullptr;
}
