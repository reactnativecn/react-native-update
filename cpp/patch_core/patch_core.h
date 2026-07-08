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
  // __diff.json 中该 bundle patch 条目的 hbcTransform 元数据(原始 JSON)。
  // 非空时 patch 走变换域:T(origin) → hpatch → T⁻¹。元数据不可解析或
  // 变换规范版本不受支持时返回错误(调用方回退整包),绝不忽略元数据
  // 直接应用——那会产出损坏的 bundle。
  std::string bundle_hbc_transform_meta;
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

Status ValidateManifest(const PatchManifest& manifest);

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

namespace internal {
// Test-only escape hatch: forces file copies to take the byte-copy fallback
// instead of hard-linking, so tests can cover both paths on one filesystem.
extern bool g_disable_hard_links;
}  // namespace internal

}  // namespace patch
}  // namespace pushy
