#pragma once

#include <ctime>
#include <string>
#include <vector>

namespace pushy {
namespace patch {

struct Status {
  bool ok;
  std::string message;

  explicit operator bool() const { return ok; }

  static Status Ok();
  static Status Error(const std::string& message);
};

struct CopyOperation {
  std::string from;
  std::string to;
};

struct PatchManifest {
  std::vector<CopyOperation> copies;
  std::vector<std::string> deletes;
};

struct FileSourcePatchOptions {
  PatchManifest manifest;
  std::string source_root;
  std::string target_root;
  std::string origin_bundle_path;
  std::string bundle_patch_path;
  std::string bundle_output_path;
  std::string merge_source_subdir;
  bool enable_merge = true;
};

class BundlePatcher {
 public:
  virtual ~BundlePatcher() = default;
  virtual Status Apply(
      const std::string& origin_bundle_path,
      const std::string& bundle_patch_path,
      const std::string& destination_bundle_path) const = 0;
};

const BundlePatcher& DefaultBundlePatcher();

Status ApplyPatchFromFileSource(
    const FileSourcePatchOptions& options,
    const BundlePatcher& bundle_patcher = DefaultBundlePatcher());

Status CleanupOldEntries(
    const std::string& root_dir,
    const std::string& keep_current,
    const std::string& keep_previous,
    int max_age_days,
    std::time_t now = 0);

bool IsSafeRelativePath(const std::string& path);

}  // namespace patch
}  // namespace pushy
