#include "archive_patch_core.h"

#include "obscured_text.h"

namespace pushy {
namespace archive_patch {
namespace {

constexpr const char* kManifestEntryName = "__diff.json";
bool HasEntry(const std::vector<std::string>& entry_names, const std::string& name) {
  for (const std::string& entry_name : entry_names) {
    if (entry_name == name) {
      return true;
    }
  }
  return false;
}

}  // namespace

const std::string& DefaultBundleDeltaEntryName() {
  static const std::string name = text::Reveal("3319f0d4b6c56a502c3b10fcdca0de7d4b3307e9");
  return name;
}

EntryAction ClassifyEntry(
    ArchivePatchType type,
    const std::string& entry_name) {
  if (type == ArchivePatchType::kFull) {
    return EntryAction::kExtract;
  }
  return entry_name == kManifestEntryName ? EntryAction::kSkip : EntryAction::kExtract;
}

bool TryParseArchivePatchType(int value, ArchivePatchType* out) {
  switch (value) {
    case 1:
      *out = ArchivePatchType::kFull;
      return true;
    case 2:
      *out = ArchivePatchType::kPatchFromPackage;
      return true;
    case 3:
      *out = ArchivePatchType::kPatchFromPpk;
      return true;
    default:
      return false;
  }
}

delta::Status BuildArchivePatchPlan(
    ArchivePatchType type,
    const delta::PatchManifest& manifest,
    const std::vector<std::string>& entry_names,
    ArchivePatchPlan* out_plan,
    const std::string& bundle_patch_entry_name) {
  if (out_plan == nullptr) {
    return delta::Status::Error("Archive plan output is required");
  }

  delta::Status manifest_status = delta::ValidateManifest(manifest);
  if (!manifest_status.ok) {
    return manifest_status;
  }

  out_plan->type = type;
  out_plan->manifest = manifest;
  out_plan->merge_source_subdir.clear();
  out_plan->enable_merge = false;

  switch (type) {
    case ArchivePatchType::kFull:
      return delta::Status::Ok();
    case ArchivePatchType::kPatchFromPackage:
    case ArchivePatchType::kPatchFromPpk:
      if (!HasEntry(entry_names, kManifestEntryName)) {
        return delta::Status::Error("diff.json not found");
      }
      if (!HasEntry(entry_names, bundle_patch_entry_name)) {
        return delta::Status::Error("bundle delta not found");
      }
      out_plan->merge_source_subdir =
          type == ArchivePatchType::kPatchFromPackage ? "assets" : "";
      out_plan->enable_merge = true;
      return delta::Status::Ok();
  }

  return delta::Status::Error("Unknown archive delta type");
}

delta::Status BuildCopyGroups(
    const delta::PatchManifest& manifest,
    std::vector<CopyGroup>* out_groups) {
  if (out_groups == nullptr) {
    return delta::Status::Error("Copy groups output is required");
  }

  delta::Status manifest_status = delta::ValidateManifest(manifest);
  if (!manifest_status.ok) {
    return manifest_status;
  }

  out_groups->clear();
  for (const delta::CopyOperation& copy : manifest.copies) {
    bool appended = false;
    for (CopyGroup& group : *out_groups) {
      if (group.from == copy.from) {
        group.to_paths.push_back(copy.to);
        appended = true;
        break;
      }
    }
    if (!appended) {
      CopyGroup group;
      group.from = copy.from;
      group.to_paths.push_back(copy.to);
      out_groups->push_back(group);
    }
  }

  return delta::Status::Ok();
}

delta::Status BuildFileSourcePatchOptions(
    const ArchivePatchPlan& plan,
    const std::string& source_root,
    const std::string& target_root,
    const std::string& origin_bundle_path,
    const std::string& bundle_patch_path,
    const std::string& bundle_output_path,
    delta::FileSourcePatchOptions* out_options) {
  if (out_options == nullptr) {
    return delta::Status::Error("Delta options output is required");
  }

  out_options->manifest = plan.manifest;
  out_options->source_root = source_root;
  out_options->target_root = target_root;
  out_options->origin_bundle_path = origin_bundle_path;
  out_options->bundle_patch_path = bundle_patch_path;
  out_options->bundle_output_path = bundle_output_path;
  out_options->merge_source_subdir = plan.merge_source_subdir;
  out_options->enable_merge = plan.enable_merge;
  return delta::Status::Ok();
}

}  // namespace archive_patch
}  // namespace pushy
