#include <napi/native_api.h>
#include <js_native_api.h>
#include <js_native_api_types.h>

#include <string>
#include <vector>

#include "archive_patch_core.h"
#include "hbc_transform_wire.h"
#include "patch_core.h"
#include "state_core.h"
#include "state_ops.h"

extern "C" {
}

namespace {

using pushy::state_ops::StateOperation;

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

  // length + 1 so NAPI's terminating '\0' lands inside owned storage instead
  // of the string's past-the-end terminator slot (formally UB to write).
  std::string result(length + 1, '\0');
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
  pushy::archive_patch::ArchivePatchType archive_type;
  if (!pushy::archive_patch::TryParseArchivePatchType(patch_type, &archive_type)) {
    ThrowError(env, "Unknown archive patch type");
    return nullptr;
  }
  pushy::archive_patch::ArchivePatchPlan plan;
  const pushy::patch::Status status = pushy::archive_patch::BuildArchivePatchPlan(
      archive_type,
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

// ---------------------------------------------------------------------------
// Async work plumbing for the heavy patch operations.
//
// applyPatchFromFileSource and cleanupOldEntries run hdiff / recursive file IO
// that can take hundreds of ms to seconds. The Pushy TurboModule executes on
// the UI thread, so running these synchronously froze the UI. These are now
// wrapped in napi_create_async_work: arguments are parsed on the JS thread, the
// heavy work runs on a libuv worker thread, and the returned Promise is settled
// back on the JS thread.
// ---------------------------------------------------------------------------

// Reject an already-created deferred with an Error(message). Used when async
// work fails to be created/queued, so the Promise never hangs pending.
void RejectDeferredWithMessage(
    napi_env env,
    napi_deferred deferred,
    const char* message) {
  napi_value error = nullptr;
  napi_value message_value = nullptr;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  napi_create_error(env, nullptr, message_value, &error);
  napi_reject_deferred(env, deferred, error);
}

struct ApplyPatchWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  pushy::patch::FileSourcePatchOptions options;
  pushy::patch::Status status{false, ""};
};

struct CleanupWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string root_dir;
  std::string keep_current;
  std::string keep_previous;
  int32_t max_age_days = 0;
  pushy::patch::Status status{false, ""};
};

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
  std::string bundle_hbc_transform_meta;
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
      !GetOptionalStringProperty(
          env, args[0], "bundleHbcTransformMeta", &bundle_hbc_transform_meta) ||
      !GetOptionalBoolProperty(env, args[0], "enableMerge", true, &enable_merge)) {
    return nullptr;
  }
  if (copy_froms.size() != copy_tos.size()) {
    ThrowError(env, "copyFroms and copyTos length mismatch");
    return nullptr;
  }

  auto* work_data = new ApplyPatchWork();
  work_data->options.manifest = BuildManifest(copy_froms, copy_tos, deletes);
  work_data->options.source_root = source_root;
  work_data->options.target_root = target_root;
  work_data->options.origin_bundle_path = origin_bundle_path;
  work_data->options.bundle_patch_path = bundle_patch_path;
  work_data->options.bundle_output_path = bundle_output_path;
  work_data->options.merge_source_subdir = merge_source_subdir;
  work_data->options.bundle_hbc_transform_meta = bundle_hbc_transform_meta;
  work_data->options.enable_merge = enable_merge;

  napi_value promise = nullptr;
  if (napi_create_promise(env, &work_data->deferred, &promise) != napi_ok) {
    delete work_data;
    ThrowError(env, "Unable to create promise");
    return nullptr;
  }

  napi_value resource_name = nullptr;
  napi_create_string_utf8(
      env, "applyPatchFromFileSource", NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_async_work(
          env,
          nullptr,
          resource_name,
          [](napi_env, void* data) {
            auto* w = static_cast<ApplyPatchWork*>(data);
            w->status = pushy::patch::ApplyPatchFromFileSource(w->options);
          },
          [](napi_env cb_env, napi_status status, void* data) {
            auto* w = static_cast<ApplyPatchWork*>(data);
            if (status != napi_ok) {
              // Cancelled/aborted before execute ran: w->status is
              // meaningless; still settle the promise so it never hangs.
              RejectDeferredWithMessage(cb_env, w->deferred, "async work aborted");
            } else if (w->status.ok) {
              napi_value undefined_value = nullptr;
              napi_get_undefined(cb_env, &undefined_value);
              napi_resolve_deferred(cb_env, w->deferred, undefined_value);
            } else {
              napi_value error = nullptr;
              napi_value message = nullptr;
              napi_create_string_utf8(
                  cb_env, w->status.message.c_str(), NAPI_AUTO_LENGTH, &message);
              napi_create_error(cb_env, nullptr, message, &error);
              napi_reject_deferred(cb_env, w->deferred, error);
            }
            napi_delete_async_work(cb_env, w->work);
            delete w;
          },
          work_data,
          &work_data->work) != napi_ok) {
    // Work was never created: settle the promise and free the data so it does
    // not leak / hang pending forever.
    RejectDeferredWithMessage(
        env, work_data->deferred, "Unable to create async work");
    delete work_data;
    return promise;
  }
  if (napi_queue_async_work(env, work_data->work) != napi_ok) {
    // Queued failed: the complete callback will never run, so clean up here.
    napi_delete_async_work(env, work_data->work);
    RejectDeferredWithMessage(
        env, work_data->deferred, "Unable to queue async work");
    delete work_data;
    return promise;
  }
  return promise;
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

  auto* work_data = new CleanupWork();
  work_data->root_dir = root_dir;
  work_data->keep_current = keep_current;
  work_data->keep_previous = keep_previous;
  work_data->max_age_days = max_age_days;

  napi_value promise = nullptr;
  if (napi_create_promise(env, &work_data->deferred, &promise) != napi_ok) {
    delete work_data;
    ThrowError(env, "Unable to create promise");
    return nullptr;
  }

  napi_value resource_name = nullptr;
  napi_create_string_utf8(
      env, "cleanupOldEntries", NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_async_work(
          env,
          nullptr,
          resource_name,
          [](napi_env, void* data) {
            auto* w = static_cast<CleanupWork*>(data);
            w->status = pushy::patch::CleanupOldEntries(
                w->root_dir, w->keep_current, w->keep_previous, w->max_age_days);
          },
          [](napi_env cb_env, napi_status status, void* data) {
            auto* w = static_cast<CleanupWork*>(data);
            if (status != napi_ok) {
              RejectDeferredWithMessage(cb_env, w->deferred, "async work aborted");
            } else if (w->status.ok) {
              napi_value undefined_value = nullptr;
              napi_get_undefined(cb_env, &undefined_value);
              napi_resolve_deferred(cb_env, w->deferred, undefined_value);
            } else {
              napi_value error = nullptr;
              napi_value message = nullptr;
              napi_create_string_utf8(
                  cb_env, w->status.message.c_str(), NAPI_AUTO_LENGTH, &message);
              napi_create_error(cb_env, nullptr, message, &error);
              napi_reject_deferred(cb_env, w->deferred, error);
            }
            napi_delete_async_work(cb_env, w->work);
            delete w;
          },
          work_data,
          &work_data->work) != napi_ok) {
    RejectDeferredWithMessage(
        env, work_data->deferred, "Unable to create async work");
    delete work_data;
    return promise;
  }
  if (napi_queue_async_work(env, work_data->work) != napi_ok) {
    napi_delete_async_work(env, work_data->work);
    RejectDeferredWithMessage(
        env, work_data->deferred, "Unable to queue async work");
    delete work_data;
    return promise;
  }
  return promise;
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


// 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道)
static napi_value GetSupportedDiffVersion(napi_env env, napi_callback_info) {
  napi_value result = nullptr;
  napi_create_uint32(
      env,
      static_cast<uint32_t>(pushy::hbc::kSupportedDiffVersion),
      &result);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  if (!ExportFunction(env, exports, "syncStateWithBinaryVersion", SyncStateWithBinaryVersion) ||
      !ExportFunction(env, exports, "runStateCore", RunStateCore) ||
      !ExportFunction(env, exports, "buildArchivePatchPlan", BuildArchivePatchPlan) ||
      !ExportFunction(env, exports, "buildCopyGroups", BuildCopyGroups) ||
      !ExportFunction(env, exports, "applyPatchFromFileSource", ApplyPatchFromFileSource) ||
      !ExportFunction(env, exports, "cleanupOldEntries", CleanupOldEntries) ||
      !ExportFunction(env, exports, "getSupportedDiffVersion", GetSupportedDiffVersion)) {
    return nullptr;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
