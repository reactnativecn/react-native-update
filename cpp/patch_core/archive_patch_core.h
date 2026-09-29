#pragma once

#include <string>
#include <vector>

#include "patch_core.h"

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

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
  delta::PatchManifest manifest;
  std::string merge_source_subdir;
  bool enable_merge = false;
};

EntryAction ClassifyEntry(
    ArchivePatchType type,
    const std::string& entry_name);

// Convert a platform-supplied integer to an ArchivePatchType. Returns false for
// unknown values so callers can fail loudly instead of silently treating an
// incremental patch as a full package (which would skip validation).
bool TryParseArchivePatchType(int value, ArchivePatchType* out);

// Name of the bundle delta entry inside a patch archive (index.bundlejs.patch),
// stored encoded (see obscured_text.h).
const std::string& DefaultBundleDeltaEntryName();

delta::Status BuildArchivePatchPlan(
    ArchivePatchType type,
    const delta::PatchManifest& manifest,
    const std::vector<std::string>& entry_names,
    ArchivePatchPlan* out_plan,
    const std::string& bundle_patch_entry_name = DefaultBundleDeltaEntryName());

delta::Status BuildCopyGroups(
    const delta::PatchManifest& manifest,
    std::vector<CopyGroup>* out_groups);

delta::Status BuildFileSourcePatchOptions(
    const ArchivePatchPlan& plan,
    const std::string& source_root,
    const std::string& target_root,
    const std::string& origin_bundle_path,
    const std::string& bundle_patch_path,
    const std::string& bundle_output_path,
    delta::FileSourcePatchOptions* out_options);

}  // namespace archive_patch
}  // namespace pushy

#pragma GCC visibility pop
