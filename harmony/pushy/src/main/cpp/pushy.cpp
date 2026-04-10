#include <napi/native_api.h>
#include <js_native_api.h>
#include <js_native_api_types.h>

#include <string>
#include <vector>

#include "archive_patch_core.h"
#include "patch_core.h"
#include "state_core.h"

extern "C" {
#include "hpatch.h"
}

namespace {

enum class StateOperation {
  kSwitchVersion = 1,
  kMarkSuccess = 2,
  kRollback = 3,
  kClearFirstTime = 4,
  kClearRollbackMark = 5,
  kResolveLaunch = 6,
};

constexpr const char* kDefaultBundlePatchEntryName = "index.bundlejs.patch";

void ThrowError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

bool GetArgCount(
    napi_env env,
    napi_callback_info info,
    size_t* argc,
    napi_value* args) {
  return napi_get_cb_info(env, info, argc, args, nullptr, nullptr) == napi_ok;
}

bool GetValueType(
    napi_env env,
    napi_value value,
    napi_valuetype* out_type) {
  return napi_typeof(env, value, out_type) == napi_ok;
}

bool IsNullOrUndefined(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type)) {
    return true;
  }
  return type == napi_undefined || type == napi_null;
}

std::string GetString(napi_env env, napi_value value, bool* ok) {
  if (ok != nullptr) {
    *ok = false;
  }
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    if (ok != nullptr) {
      *ok = true;
    }
    return std::string();
  }

  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type) || type != napi_string) {
    ThrowError(env, "Expected string");
    return std::string();
  }

  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    ThrowError(env, "Failed to read string");
    return std::string();
  }

  std::string result(length, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(
          env, value, result.data(), length + 1, &written) != napi_ok) {
    ThrowError(env, "Failed to read string");
    return std::string();
  }
  result.resize(written);
  if (ok != nullptr) {
    *ok = true;
  }
  return result;
}

bool GetInt32(napi_env env, napi_value value, int32_t* out_value) {
  if (value == nullptr || out_value == nullptr) {
    ThrowError(env, "Expected number");
    return false;
  }
  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type) || type != napi_number) {
    ThrowError(env, "Expected number");
    return false;
  }
  if (napi_get_value_int32(env, value, out_value) != napi_ok) {
    ThrowError(env, "Failed to read number");
    return false;
  }
  return true;
}

bool GetBoolean(napi_env env, napi_value value, bool* out_value) {
  if (out_value == nullptr) {
    ThrowError(env, "Expected boolean");
    return false;
  }
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    *out_value = false;
    return true;
  }
  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type) || type != napi_boolean) {
    ThrowError(env, "Expected boolean");
    return false;
  }
  bool result = false;
  if (napi_get_value_bool(env, value, &result) != napi_ok) {
    ThrowError(env, "Failed to read boolean");
    return false;
  }
  *out_value = result;
  return true;
}

bool HasNamedProperty(napi_env env, napi_value object, const char* name, bool* out_has) {
  if (out_has == nullptr) {
    ThrowError(env, "Internal error");
    return false;
  }
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok) {
    ThrowError(env, std::string("Failed to read property ") + name);
    return false;
  }
  *out_has = has;
  return true;
}

bool GetNamedProperty(
    napi_env env,
    napi_value object,
    const char* name,
    napi_value* out_value) {
  if (out_value == nullptr) {
    ThrowError(env, "Internal error");
    return false;
  }
  if (napi_get_named_property(env, object, name, out_value) != napi_ok) {
    ThrowError(env, std::string("Failed to read property ") + name);
    return false;
  }
  return true;
}

bool GetOptionalStringProperty(
    napi_env env,
    napi_value object,
    const char* name,
    std::string* out_value) {
  bool has = false;
  if (!HasNamedProperty(env, object, name, &has)) {
    return false;
  }
  if (!has) {
    out_value->clear();
    return true;
  }

  napi_value property = nullptr;
  if (!GetNamedProperty(env, object, name, &property)) {
    return false;
  }

  bool ok = false;
  *out_value = GetString(env, property, &ok);
  return ok;
}

bool GetOptionalBoolProperty(
    napi_env env,
    napi_value object,
    const char* name,
    bool default_value,
    bool* out_value) {
  bool has = false;
  if (!HasNamedProperty(env, object, name, &has)) {
    return false;
  }
  if (!has) {
    *out_value = default_value;
    return true;
  }

  napi_value property = nullptr;
  if (!GetNamedProperty(env, object, name, &property)) {
    return false;
  }
  return GetBoolean(env, property, out_value);
}

bool GetStringArray(
    napi_env env,
    napi_value value,
    std::vector<std::string>* out_values) {
  out_values->clear();
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    return true;
  }

  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    ThrowError(env, "Expected string array");
    return false;
  }

  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok) {
    ThrowError(env, "Failed to read array length");
    return false;
  }

  out_values->reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item = nullptr;
    if (napi_get_element(env, value, index, &item) != napi_ok) {
      ThrowError(env, "Failed to read array item");
      return false;
    }
    bool ok = false;
    out_values->push_back(GetString(env, item, &ok));
    if (!ok) {
      return false;
    }
  }
  return true;
}

bool GetOptionalStringArrayProperty(
    napi_env env,
    napi_value object,
    const char* name,
    std::vector<std::string>* out_values) {
  bool has = false;
  if (!HasNamedProperty(env, object, name, &has)) {
    return false;
  }
  if (!has) {
    out_values->clear();
    return true;
  }

  napi_value property = nullptr;
  if (!GetNamedProperty(env, object, name, &property)) {
    return false;
  }
  return GetStringArray(env, property, out_values);
}

bool GetObject(napi_env env, napi_value value) {
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    return true;
  }
  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type) || type != napi_object) {
    ThrowError(env, "Expected object");
    return false;
  }
  return true;
}

pushy::state::State ReadState(napi_env env, napi_value value, bool* ok) {
  if (ok != nullptr) {
    *ok = false;
  }
  pushy::state::State state;
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    if (ok != nullptr) {
      *ok = true;
    }
    return state;
  }
  if (!GetObject(env, value)) {
    return state;
  }

  if (!GetOptionalStringProperty(env, value, "packageVersion", &state.package_version) ||
      !GetOptionalStringProperty(env, value, "buildTime", &state.build_time) ||
      !GetOptionalStringProperty(env, value, "currentVersion", &state.current_version) ||
      !GetOptionalStringProperty(env, value, "lastVersion", &state.last_version) ||
      !GetOptionalBoolProperty(env, value, "firstTime", false, &state.first_time) ||
      !GetOptionalBoolProperty(env, value, "firstTimeOk", true, &state.first_time_ok) ||
      !GetOptionalStringProperty(env, value, "rolledBackVersion", &state.rolled_back_version)) {
    return state;
  }

  if (ok != nullptr) {
    *ok = true;
  }
  return state;
}

napi_value NewBoolean(napi_env env, bool value) {
  napi_value result = nullptr;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value NewString(napi_env env, const std::string& value) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

void SetStringProperty(
    napi_env env,
    napi_value object,
    const char* name,
    const std::string& value) {
  if (value.empty()) {
    return;
  }
  napi_set_named_property(env, object, name, NewString(env, value));
}

void SetBoolProperty(
    napi_env env,
    napi_value object,
    const char* name,
    bool value) {
  napi_set_named_property(env, object, name, NewBoolean(env, value));
}

napi_value NewStateResult(
    napi_env env,
    const pushy::state::State& state,
    bool changed,
    const std::string& stale_version_to_delete,
    const std::string& load_version,
    bool did_rollback,
    bool consumed_first_time) {
  napi_value result = nullptr;
  napi_create_object(env, &result);

  SetStringProperty(env, result, "packageVersion", state.package_version);
  SetStringProperty(env, result, "buildTime", state.build_time);
  SetStringProperty(env, result, "currentVersion", state.current_version);
  SetStringProperty(env, result, "lastVersion", state.last_version);
  SetBoolProperty(env, result, "firstTime", state.first_time);
  SetBoolProperty(env, result, "firstTimeOk", state.first_time_ok);
  SetStringProperty(env, result, "rolledBackVersion", state.rolled_back_version);
  SetBoolProperty(env, result, "changed", changed);
  SetStringProperty(env, result, "staleVersionToDelete", stale_version_to_delete);
  SetStringProperty(env, result, "loadVersion", load_version);
  SetBoolProperty(env, result, "didRollback", did_rollback);
  SetBoolProperty(env, result, "consumedFirstTime", consumed_first_time);
  return result;
}

napi_value NewArchivePatchPlanResult(
    napi_env env,
    const pushy::archive_patch::ArchivePatchPlan& plan) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  SetStringProperty(env, result, "mergeSourceSubdir", plan.merge_source_subdir);
  SetBoolProperty(env, result, "enableMerge", plan.enable_merge);
  return result;
}

napi_value NewCopyGroupArray(
    napi_env env,
    const std::vector<pushy::archive_patch::CopyGroup>& groups) {
  napi_value result = nullptr;
  napi_create_array_with_length(env, groups.size(), &result);
  for (size_t index = 0; index < groups.size(); ++index) {
    napi_value group = nullptr;
    napi_create_object(env, &group);
    SetStringProperty(env, group, "from", groups[index].from);

    napi_value to_paths = nullptr;
    napi_create_array_with_length(env, groups[index].to_paths.size(), &to_paths);
    for (size_t target_index = 0; target_index < groups[index].to_paths.size();
         ++target_index) {
      napi_set_element(
          env,
          to_paths,
          target_index,
          NewString(env, groups[index].to_paths[target_index]));
    }
    napi_set_named_property(env, group, "toPaths", to_paths);
    napi_set_element(env, result, index, group);
  }
  return result;
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

napi_value HdiffPatch(napi_env env, napi_callback_info info) {
  napi_value args[2] = {nullptr, nullptr};
  size_t argc = 2;
  if (!GetArgCount(env, info, &argc, args) || argc < 2) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  bool is_typed_array = false;
  if (napi_is_typedarray(env, args[0], &is_typed_array) != napi_ok || !is_typed_array) {
    ThrowError(env, "First argument must be a TypedArray");
    return nullptr;
  }

  uint8_t* origin_ptr = nullptr;
  size_t origin_length = 0;
  if (napi_get_typedarray_info(
          env,
          args[0],
          nullptr,
          &origin_length,
          reinterpret_cast<void**>(&origin_ptr),
          nullptr,
          nullptr) != napi_ok) {
    ThrowError(env, "Failed to get origin buffer");
    return nullptr;
  }

  if (napi_is_typedarray(env, args[1], &is_typed_array) != napi_ok || !is_typed_array) {
    ThrowError(env, "Second argument must be a TypedArray");
    return nullptr;
  }

  uint8_t* patch_ptr = nullptr;
  size_t patch_length = 0;
  if (napi_get_typedarray_info(
          env,
          args[1],
          nullptr,
          &patch_length,
          reinterpret_cast<void**>(&patch_ptr),
          nullptr,
          nullptr) != napi_ok) {
    ThrowError(env, "Failed to get patch buffer");
    return nullptr;
  }

  hpatch_singleCompressedDiffInfo patch_info;
  if (!((origin_length == 0) || origin_ptr) || !patch_ptr || patch_length == 0) {
    ThrowError(env, "Corrupt patch");
    return nullptr;
  }
  if (kHPatch_ok != hpatch_getInfo_by_mem(&patch_info, patch_ptr, patch_length)) {
    ThrowError(env, "Error info in hpatch");
    return nullptr;
  }
  if (origin_length != patch_info.oldDataSize) {
    ThrowError(env, "Error oldDataSize in hpatch");
    return nullptr;
  }

  size_t new_size = static_cast<size_t>(patch_info.newDataSize);
  if (sizeof(size_t) != sizeof(hpatch_StreamPos_t) &&
      new_size != patch_info.newDataSize) {
    ThrowError(env, "Error newDataSize in hpatch");
    return nullptr;
  }

  void* output_data = nullptr;
  napi_value result = nullptr;
  if (napi_create_arraybuffer(env, new_size, &output_data, &result) != napi_ok) {
    ThrowError(env, "Failed to create result buffer");
    return nullptr;
  }

  if (kHPatch_ok != hpatch_by_mem(
                       origin_ptr,
                       origin_length,
                       static_cast<uint8_t*>(output_data),
                       new_size,
                       patch_ptr,
                       patch_length,
                       &patch_info)) {
    ThrowError(env, "hpatch");
    return nullptr;
  }

  return result;
}

napi_value SyncStateWithBinaryVersion(napi_env env, napi_callback_info info) {
  napi_value args[3] = {nullptr, nullptr, nullptr};
  size_t argc = 3;
  if (!GetArgCount(env, info, &argc, args) || argc < 3) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  bool ok = false;
  const std::string package_version = GetString(env, args[0], &ok);
  if (!ok) {
    return nullptr;
  }
  const std::string build_time = GetString(env, args[1], &ok);
  if (!ok) {
    return nullptr;
  }
  const pushy::state::State state = ReadState(env, args[2], &ok);
  if (!ok) {
    return nullptr;
  }

  const pushy::state::BinaryVersionSyncResult result =
      pushy::state::SyncBinaryVersion(state, package_version, build_time);
  return NewStateResult(env, result.state, result.changed, std::string(), std::string(), false, false);
}

napi_value RunStateCore(napi_env env, napi_callback_info info) {
  napi_value args[5] = {nullptr, nullptr, nullptr, nullptr, nullptr};
  size_t argc = 5;
  if (!GetArgCount(env, info, &argc, args) || argc < 2) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  int32_t operation = 0;
  if (!GetInt32(env, args[0], &operation)) {
    return nullptr;
  }

  bool ok = false;
  const pushy::state::State state = ReadState(env, args[1], &ok);
  if (!ok) {
    return nullptr;
  }

  std::string string_arg;
  if (argc >= 3) {
    string_arg = GetString(env, args[2], &ok);
    if (!ok) {
      return nullptr;
    }
  }

  bool flag_a = false;
  bool flag_b = false;
  if (argc >= 4 && !GetBoolean(env, args[3], &flag_a)) {
    return nullptr;
  }
  if (argc >= 5 && !GetBoolean(env, args[4], &flag_b)) {
    return nullptr;
  }

  switch (static_cast<StateOperation>(operation)) {
    case StateOperation::kSwitchVersion:
      return NewStateResult(
          env,
          pushy::state::SwitchVersion(state, string_arg),
          false,
          std::string(),
          std::string(),
          false,
          false);
    case StateOperation::kMarkSuccess: {
      const pushy::state::MarkSuccessResult result = pushy::state::MarkSuccess(state);
      return NewStateResult(
          env,
          result.state,
          false,
          result.stale_version_to_delete,
          std::string(),
          false,
          false);
    }
    case StateOperation::kRollback: {
      const pushy::state::State next = pushy::state::Rollback(state);
      return NewStateResult(
          env, next, false, std::string(), next.current_version, true, false);
    }
    case StateOperation::kClearFirstTime:
      return NewStateResult(
          env,
          pushy::state::ClearFirstTime(state),
          false,
          std::string(),
          std::string(),
          false,
          false);
    case StateOperation::kClearRollbackMark:
      return NewStateResult(
          env,
          pushy::state::ClearRollbackMark(state),
          false,
          std::string(),
          std::string(),
          false,
          false);
    case StateOperation::kResolveLaunch: {
      const pushy::state::LaunchDecision decision =
          pushy::state::ResolveLaunchState(state, flag_a, flag_b);
      return NewStateResult(
          env,
          decision.state,
          false,
          std::string(),
          decision.load_version,
          decision.did_rollback,
          decision.consumed_first_time);
    }
  }

  ThrowError(env, "Unknown state operation");
  return nullptr;
}

napi_value BuildArchivePatchPlan(napi_env env, napi_callback_info info) {
  napi_value args[6] = {nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
  size_t argc = 6;
  if (!GetArgCount(env, info, &argc, args) || argc < 5) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  int32_t patch_type = 0;
  if (!GetInt32(env, args[0], &patch_type)) {
    return nullptr;
  }

  std::vector<std::string> entry_names;
  std::vector<std::string> copy_froms;
  std::vector<std::string> copy_tos;
  std::vector<std::string> deletes;
  if (!GetStringArray(env, args[1], &entry_names) ||
      !GetStringArray(env, args[2], &copy_froms) ||
      !GetStringArray(env, args[3], &copy_tos) ||
      !GetStringArray(env, args[4], &deletes)) {
    return nullptr;
  }
  if (copy_froms.size() != copy_tos.size()) {
    ThrowError(env, "copyFroms and copyTos length mismatch");
    return nullptr;
  }

  std::string bundle_patch_entry_name = kDefaultBundlePatchEntryName;
  if (argc >= 6) {
    bool ok = false;
    const std::string candidate = GetString(env, args[5], &ok);
    if (!ok) {
      return nullptr;
    }
    if (!candidate.empty()) {
      bundle_patch_entry_name = candidate;
    }
  }

  const pushy::patch::PatchManifest manifest =
      BuildManifest(copy_froms, copy_tos, deletes);
  pushy::archive_patch::ArchivePatchPlan plan;
  const pushy::patch::Status status = pushy::archive_patch::BuildArchivePatchPlan(
      static_cast<pushy::archive_patch::ArchivePatchType>(patch_type),
      manifest,
      entry_names,
      &plan,
      bundle_patch_entry_name);
  if (!status.ok) {
    ThrowError(env, status.message);
    return nullptr;
  }

  return NewArchivePatchPlanResult(env, plan);
}

napi_value BuildCopyGroups(napi_env env, napi_callback_info info) {
  napi_value args[2] = {nullptr, nullptr};
  size_t argc = 2;
  if (!GetArgCount(env, info, &argc, args) || argc < 2) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  std::vector<std::string> copy_froms;
  std::vector<std::string> copy_tos;
  if (!GetStringArray(env, args[0], &copy_froms) ||
      !GetStringArray(env, args[1], &copy_tos)) {
    return nullptr;
  }
  if (copy_froms.size() != copy_tos.size()) {
    ThrowError(env, "copyFroms and copyTos length mismatch");
    return nullptr;
  }

  const pushy::patch::PatchManifest manifest =
      BuildManifest(copy_froms, copy_tos, std::vector<std::string>());
  std::vector<pushy::archive_patch::CopyGroup> groups;
  const pushy::patch::Status status =
      pushy::archive_patch::BuildCopyGroups(manifest, &groups);
  if (!status.ok) {
    ThrowError(env, status.message);
    return nullptr;
  }

  return NewCopyGroupArray(env, groups);
}

napi_value ApplyPatchFromFileSource(napi_env env, napi_callback_info info) {
  napi_value args[1] = {nullptr};
  size_t argc = 1;
  if (!GetArgCount(env, info, &argc, args) || argc < 1) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }
  if (!GetObject(env, args[0])) {
    return nullptr;
  }

  std::vector<std::string> copy_froms;
  std::vector<std::string> copy_tos;
  std::vector<std::string> deletes;
  std::string source_root;
  std::string target_root;
  std::string origin_bundle_path;
  std::string bundle_patch_path;
  std::string bundle_output_path;
  std::string merge_source_subdir;
  bool enable_merge = true;

  if (!GetOptionalStringArrayProperty(env, args[0], "copyFroms", &copy_froms) ||
      !GetOptionalStringArrayProperty(env, args[0], "copyTos", &copy_tos) ||
      !GetOptionalStringArrayProperty(env, args[0], "deletes", &deletes) ||
      !GetOptionalStringProperty(env, args[0], "sourceRoot", &source_root) ||
      !GetOptionalStringProperty(env, args[0], "targetRoot", &target_root) ||
      !GetOptionalStringProperty(env, args[0], "originBundlePath", &origin_bundle_path) ||
      !GetOptionalStringProperty(env, args[0], "bundlePatchPath", &bundle_patch_path) ||
      !GetOptionalStringProperty(env, args[0], "bundleOutputPath", &bundle_output_path) ||
      !GetOptionalStringProperty(env, args[0], "mergeSourceSubdir", &merge_source_subdir) ||
      !GetOptionalBoolProperty(env, args[0], "enableMerge", true, &enable_merge)) {
    return nullptr;
  }
  if (copy_froms.size() != copy_tos.size()) {
    ThrowError(env, "copyFroms and copyTos length mismatch");
    return nullptr;
  }

  pushy::patch::FileSourcePatchOptions options;
  options.manifest = BuildManifest(copy_froms, copy_tos, deletes);
  options.source_root = source_root;
  options.target_root = target_root;
  options.origin_bundle_path = origin_bundle_path;
  options.bundle_patch_path = bundle_patch_path;
  options.bundle_output_path = bundle_output_path;
  options.merge_source_subdir = merge_source_subdir;
  options.enable_merge = enable_merge;

  const pushy::patch::Status status =
      pushy::patch::ApplyPatchFromFileSource(options);
  if (!status.ok) {
    ThrowError(env, status.message);
    return nullptr;
  }

  napi_value undefined_value = nullptr;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

napi_value CleanupOldEntries(napi_env env, napi_callback_info info) {
  napi_value args[4] = {nullptr, nullptr, nullptr, nullptr};
  size_t argc = 4;
  if (!GetArgCount(env, info, &argc, args) || argc < 4) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  bool ok = false;
  const std::string root_dir = GetString(env, args[0], &ok);
  if (!ok) {
    return nullptr;
  }
  const std::string keep_current = GetString(env, args[1], &ok);
  if (!ok) {
    return nullptr;
  }
  const std::string keep_previous = GetString(env, args[2], &ok);
  if (!ok) {
    return nullptr;
  }
  int32_t max_age_days = 0;
  if (!GetInt32(env, args[3], &max_age_days)) {
    return nullptr;
  }

  const pushy::patch::Status status = pushy::patch::CleanupOldEntries(
      root_dir,
      keep_current,
      keep_previous,
      max_age_days);
  if (!status.ok) {
    ThrowError(env, status.message);
    return nullptr;
  }

  napi_value undefined_value = nullptr;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

bool ExportFunction(
    napi_env env,
    napi_value exports,
    const char* name,
    napi_callback callback) {
  napi_value fn = nullptr;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &fn) !=
      napi_ok) {
    ThrowError(env, std::string("Unable to create function ") + name);
    return false;
  }

  if (napi_set_named_property(env, exports, name, fn) != napi_ok) {
    ThrowError(env, std::string("Unable to export function ") + name);
    return false;
  }
  return true;
}

}  // namespace

napi_value Init(napi_env env, napi_value exports) {
  if (!ExportFunction(env, exports, "hdiffPatch", HdiffPatch) ||
      !ExportFunction(env, exports, "syncStateWithBinaryVersion", SyncStateWithBinaryVersion) ||
      !ExportFunction(env, exports, "runStateCore", RunStateCore) ||
      !ExportFunction(env, exports, "buildArchivePatchPlan", BuildArchivePatchPlan) ||
      !ExportFunction(env, exports, "buildCopyGroups", BuildCopyGroups) ||
      !ExportFunction(env, exports, "applyPatchFromFileSource", ApplyPatchFromFileSource) ||
      !ExportFunction(env, exports, "cleanupOldEntries", CleanupOldEntries)) {
    return nullptr;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
