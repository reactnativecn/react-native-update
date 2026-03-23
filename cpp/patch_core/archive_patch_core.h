#pragma once

#include <string>
#include <vector>

#include "patch_core.h"

namespace pushy {
namespace archive_patch {

enum class ArchivePatchType {
  kFull = 1,
  kPatchFromPackage = 2,
  kPatchFromPpk = 3,
};

enum class EntryAction {
  kSkip = 0,
  kExtract = 1,
};

struct CopyGroup {
  std::string from;
  std::vector<std::string> to_paths;
};

struct ArchivePatchPlan {
  ArchivePatchType type = ArchivePatchType::kFull;
  patch::PatchManifest manifest;
  std::string merge_source_subdir;
  bool enable_merge = false;
};

EntryAction ClassifyEntry(
    ArchivePatchType type,
    const std::string& entry_name);

patch::Status BuildArchivePatchPlan(
    ArchivePatchType type,
    const patch::PatchManifest& manifest,
    const std::vector<std::string>& entry_names,
    ArchivePatchPlan* out_plan);

patch::Status BuildCopyGroups(
    const patch::PatchManifest& manifest,
    std::vector<CopyGroup>* out_groups);

patch::Status BuildFileSourcePatchOptions(
    const ArchivePatchPlan& plan,
    const std::string& source_root,
    const std::string& target_root,
    const std::string& origin_bundle_path,
    const std::string& bundle_patch_path,
    const std::string& bundle_output_path,
    patch::FileSourcePatchOptions* out_options);

}  // namespace archive_patch
}  // namespace pushy
