#include "../archive_patch_core.h"
#include "../digest.h"
#include "../patch_core.h"
#include "../state_core.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>
#include <vector>

extern "C" {
#include "patch.h"  // HDiffPatch: getSingleCompressedDiffInfo / mem_as_hStreamInput
}

namespace {

using pushy::patch::ApplyPatchFromFileSource;
using pushy::patch::BundlePatcher;
using pushy::patch::CleanupOldEntries;
using pushy::patch::CopyOperation;
using pushy::patch::FileSourcePatchOptions;
using pushy::patch::PatchManifest;
using pushy::patch::Status;
using pushy::state::BinaryVersionSyncResult;
using pushy::state::LaunchDecision;
using pushy::state::MarkSuccessResult;
using pushy::state::State;

void EnsureDirectory(const std::string& path);

class FakeBundlePatcher final : public BundlePatcher {
 public:
  mutable int calls = 0;
  std::string output;

  explicit FakeBundlePatcher(std::string output_value)
      : output(std::move(output_value)) {}

  Status Apply(
      const std::string&,
      const std::string&,
      const std::string& destination_bundle_path) const override {
    ++calls;
    size_t slash = destination_bundle_path.find_last_of('/');
    if (slash != std::string::npos) {
      EnsureDirectory(destination_bundle_path.substr(0, slash));
    }
    std::ofstream out(destination_bundle_path, std::ios::binary);
    out << output;
    return out.good() ? Status::Ok() : Status::Error("Failed to write fake bundle");
  }
};

struct TempDir {
  std::string path;

  TempDir() {
    char templ[] = "/tmp/pushy-patch-core-XXXXXX";
    char* created = mkdtemp(templ);
    if (!created) {
      throw std::runtime_error("Failed to create temp dir");
    }
    path = created;
  }

  ~TempDir() {
    if (!path.empty()) {
      std::string command = "rm -rf \"" + path + "\"";
      std::system(command.c_str());
    }
  }
};

std::string JoinPath(const std::string& base, const std::string& relative) {
  if (base.empty()) {
    return relative;
  }
  if (relative.empty()) {
    return base;
  }
  return base + "/" + relative;
}

void EnsureDirectory(const std::string& path) {
  if (path.empty()) {
    return;
  }

  size_t slash = path.find_last_of('/');
  if (slash != std::string::npos) {
    EnsureDirectory(path.substr(0, slash));
  }
  mkdir(path.c_str(), 0755);
}

void WriteFile(const std::string& path, const std::string& content) {
  EnsureDirectory(path.substr(0, path.find_last_of('/')));
  std::ofstream out(path, std::ios::binary);
  out << content;
}

std::string ReadFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream stream;
  stream << in.rdbuf();
  return stream.str();
}

bool Exists(const std::string& path) {
  struct stat st;
  return stat(path.c_str(), &st) == 0;
}

void SetMtime(const std::string& path, std::time_t value) {
  struct timeval times[2];
  times[0].tv_sec = value;
  times[0].tv_usec = 0;
  times[1].tv_sec = value;
  times[1].tv_usec = 0;
  if (utimes(path.c_str(), times) != 0) {
    throw std::runtime_error("Failed to set mtime");
  }
}

void Expect(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void ExpectEq(const std::string& left, const std::string& right, const std::string& message) {
  if (left != right) {
    throw std::runtime_error(message + ": expected [" + right + "] got [" + left + "]");
  }
}

std::string g_fixtures_dir = "cpp/patch_core/tests/fixtures";

// 变换域 bundle patch 端到端:真实 hpatch + wire 元数据 → T(origin) →
// hpatch → T⁻¹,结果必须与新 bundle 逐字节一致(fixtures 由 CLI 的 JS
// 实现生成,同时充当跨实现 golden)。
void TestApplyPatchWithHbcTransform() {
  TempDir temp;
  const std::string origin = JoinPath(g_fixtures_dir, "v96.hbc");
  const std::string patch = JoinPath(g_fixtures_dir, "v96.tpatch.bin");
  const std::string expected = ReadFile(JoinPath(g_fixtures_dir, "v96b.hbc"));
  const std::string meta = ReadFile(JoinPath(g_fixtures_dir, "v96.meta.json"));
  Expect(!expected.empty() && !meta.empty(), "hbc fixtures must exist");

  FileSourcePatchOptions options;
  options.source_root = JoinPath(temp.path, "src");
  options.target_root = JoinPath(temp.path, "dst");
  options.origin_bundle_path = origin;
  options.bundle_patch_path = patch;
  options.bundle_output_path = JoinPath(temp.path, "out/index.bundlejs");
  options.enable_merge = false;
  options.bundle_hbc_transform_meta = meta;

  Status status = ApplyPatchFromFileSource(options);
  Expect(status.ok, "hbc transform patch should succeed: " + status.message);
  ExpectEq(
      ReadFile(options.bundle_output_path).size() == expected.size()
          ? std::string("same-size")
          : std::string("size-mismatch"),
      "same-size",
      "restored bundle size");
  Expect(
      ReadFile(options.bundle_output_path) == expected,
      "restored bundle must equal new bundle byte-for-byte");

  // 临时文件必须被清理
  Expect(
      !Exists(options.bundle_output_path + ".hbct-origin") &&
          !Exists(options.bundle_output_path + ".hbct-patched"),
      "hbc transform temp files must be removed");
}

void TestApplyPatchWithHbcTransformRejectsBadMeta() {
  TempDir temp;
  FileSourcePatchOptions options;
  options.source_root = JoinPath(temp.path, "src");
  options.target_root = JoinPath(temp.path, "dst");
  options.origin_bundle_path = JoinPath(g_fixtures_dir, "v96.hbc");
  options.bundle_patch_path = JoinPath(g_fixtures_dir, "v96.tpatch.bin");
  options.bundle_output_path = JoinPath(temp.path, "out/index.bundlejs");
  options.enable_merge = false;

  // 不可解析的元数据 → 失败(绝不能忽略元数据直接 hpatch)
  options.bundle_hbc_transform_meta = "not json";
  Expect(
      !ApplyPatchFromFileSource(options).ok,
      "malformed hbcTransform metadata must fail");
  Expect(!Exists(options.bundle_output_path), "no output on failure");

  // 不支持的变换规范版本 → 失败(调用方回退整包)
  std::string meta = ReadFile(JoinPath(g_fixtures_dir, "v96.meta.json"));
  const std::string needle = "\"v\":1";
  const size_t pos = meta.find(needle);
  Expect(pos != std::string::npos, "meta fixture must contain v:1");
  meta.replace(pos, needle.size(), "\"v\":9");
  options.bundle_hbc_transform_meta = meta;
  Status status = ApplyPatchFromFileSource(options);
  Expect(!status.ok, "unsupported hbcTransform version must fail");
  Expect(
      status.message.find("Unsupported hbcTransform version") !=
          std::string::npos,
      "error should identify unsupported version: " + status.message);
}

// HDIFF13(diffStream)格式:hpatch_by_file 按 magic 自动分派,
// v2 轨道的大 bundle patch 走此路径。fixtures 由 node-hdiffpatch 生成并
// 已在 JS 侧验证过 round-trip。
void TestApplyStreamFormatBundlePatch() {
  TempDir temp;
  FileSourcePatchOptions options;
  options.source_root = JoinPath(temp.path, "src");
  options.target_root = JoinPath(temp.path, "dst");
  options.origin_bundle_path = JoinPath(g_fixtures_dir, "v96.hbc");
  options.bundle_patch_path = JoinPath(g_fixtures_dir, "v96.streampatch.bin");
  options.bundle_output_path = JoinPath(temp.path, "out/index.bundlejs");
  options.enable_merge = false;

  Status status = ApplyPatchFromFileSource(options);
  Expect(status.ok, "stream-format patch should apply: " + status.message);
  Expect(
      ReadFile(options.bundle_output_path) ==
          ReadFile(JoinPath(g_fixtures_dir, "v96b.hbc")),
      "stream-format restored bundle must equal new bundle");
}

void TestApplyStreamFormatWithHbcTransform() {
  TempDir temp;
  FileSourcePatchOptions options;
  options.source_root = JoinPath(temp.path, "src");
  options.target_root = JoinPath(temp.path, "dst");
  options.origin_bundle_path = JoinPath(g_fixtures_dir, "v96.hbc");
  options.bundle_patch_path = JoinPath(g_fixtures_dir, "v96.tstreampatch.bin");
  options.bundle_output_path = JoinPath(temp.path, "out/index.bundlejs");
  options.enable_merge = false;
  options.bundle_hbc_transform_meta =
      ReadFile(JoinPath(g_fixtures_dir, "v96.meta.json"));

  Status status = ApplyPatchFromFileSource(options);
  Expect(
      status.ok,
      "transform + stream-format patch should apply: " + status.message);
  Expect(
      ReadFile(options.bundle_output_path) ==
          ReadFile(JoinPath(g_fixtures_dir, "v96b.hbc")),
      "transform+stream restored bundle must equal new bundle");
}

// HDIFFSF20 允许 compressedSize==0 表示 diff payload 为 RAW。node-hdiffpatch
// 2.x 的 v5 writer 在这种小 diff 上仍会保留 lzma2 标签,客户端必须按
// compressedSize 判定是否解压,不能只看 compressType。
void TestApplySingleFormatRawStoredWithLzma2Label() {
  TempDir temp;
  FileSourcePatchOptions options;
  options.source_root = JoinPath(temp.path, "src");
  options.target_root = JoinPath(temp.path, "dst");
  options.origin_bundle_path = JoinPath(g_fixtures_dir, "rawstored.old.bin");
  options.bundle_patch_path =
      JoinPath(g_fixtures_dir, "rawstored.lzma2label.patch.bin");
  options.bundle_output_path = JoinPath(temp.path, "out/index.bundlejs");
  options.enable_merge = false;

  Status status = ApplyPatchFromFileSource(options);
  Expect(
      status.ok,
      "raw-stored single-format patch should apply: " + status.message);
  Expect(
      ReadFile(options.bundle_output_path) ==
          ReadFile(JoinPath(g_fixtures_dir, "rawstored.new.bin")),
      "raw-stored single-format restored bundle must equal new bundle");
}

void TestApplyPatchFromFileSourceMergesAndCopies() {
  TempDir temp;
  const std::string source = JoinPath(temp.path, "origin");
  const std::string target = JoinPath(temp.path, "target");
  const std::string patch = JoinPath(temp.path, "bundle.patch");

  WriteFile(JoinPath(source, "index.bundlejs"), "old bundle");
  WriteFile(JoinPath(source, "assets/keep.txt"), "keep");
  WriteFile(JoinPath(source, "assets/delete.txt"), "delete");
  WriteFile(JoinPath(source, "assets/from.txt"), "rename");
  WriteFile(JoinPath(source, "config.json"), "config");

  WriteFile(JoinPath(target, "assets/new.txt"), "new");
  WriteFile(patch, "unused patch");

  FakeBundlePatcher patcher("patched bundle");
  FileSourcePatchOptions options;
  options.source_root = source;
  options.target_root = target;
  options.origin_bundle_path = JoinPath(source, "index.bundlejs");
  options.bundle_patch_path = patch;
  options.bundle_output_path = JoinPath(target, "index.bundlejs");
  options.merge_source_subdir = "";
  options.manifest.copies.push_back(CopyOperation{"assets/from.txt", "assets/renamed.txt"});
  options.manifest.deletes.push_back("assets/delete.txt");

  Status status = ApplyPatchFromFileSource(options, patcher);
  Expect(status.ok, status.message);
  Expect(patcher.calls == 1, "bundle patcher should run exactly once");

  ExpectEq(ReadFile(JoinPath(target, "index.bundlejs")), "patched bundle", "bundle output mismatch");
  ExpectEq(ReadFile(JoinPath(target, "assets/keep.txt")), "keep", "merged asset mismatch");
  ExpectEq(ReadFile(JoinPath(target, "assets/renamed.txt")), "rename", "copied asset mismatch");
  ExpectEq(ReadFile(JoinPath(target, "assets/new.txt")), "new", "existing unzip file should be preserved");
  ExpectEq(ReadFile(JoinPath(target, "config.json")), "config", "root file should be merged");
  Expect(!Exists(JoinPath(target, "assets/delete.txt")), "deleted asset should not be copied");
}

void TestApplyPatchMergeHardLinksUnchangedFiles() {
  TempDir temp;
  const std::string source = JoinPath(temp.path, "origin");
  const std::string target = JoinPath(temp.path, "target");
  const std::string patch = JoinPath(temp.path, "bundle.patch");

  WriteFile(JoinPath(source, "index.bundlejs"), "old bundle");
  WriteFile(JoinPath(source, "assets/keep.txt"), "keep");
  WriteFile(patch, "unused patch");

  FakeBundlePatcher patcher("patched bundle");
  FileSourcePatchOptions options;
  options.source_root = source;
  options.target_root = target;
  options.origin_bundle_path = JoinPath(source, "index.bundlejs");
  options.bundle_patch_path = patch;
  options.bundle_output_path = JoinPath(target, "index.bundlejs");
  options.manifest.copies.push_back(CopyOperation{"assets/keep.txt", "assets/copied.txt"});

  Status status = ApplyPatchFromFileSource(options, patcher);
  Expect(status.ok, status.message);

  // Unchanged files must share the source inode (hard link) instead of being
  // byte-copied: same filesystem, so the fast path has to kick in.
  struct stat source_stat;
  struct stat merged_stat;
  struct stat copied_stat;
  Expect(stat(JoinPath(source, "assets/keep.txt").c_str(), &source_stat) == 0, "stat source");
  Expect(stat(JoinPath(target, "assets/keep.txt").c_str(), &merged_stat) == 0, "stat merged");
  Expect(stat(JoinPath(target, "assets/copied.txt").c_str(), &copied_stat) == 0, "stat copied");
  Expect(merged_stat.st_ino == source_stat.st_ino, "merged file should hard-link the source");
  Expect(copied_stat.st_ino == source_stat.st_ino, "manifest copy should hard-link the source");
  Expect(source_stat.st_nlink >= 3, "source should have three names");
  ExpectEq(ReadFile(JoinPath(target, "assets/keep.txt")), "keep", "merged content mismatch");

  // The patched bundle must be a fresh file, never a link into the source dir.
  struct stat bundle_stat;
  struct stat origin_stat;
  Expect(stat(JoinPath(target, "index.bundlejs").c_str(), &bundle_stat) == 0, "stat bundle");
  Expect(stat(JoinPath(source, "index.bundlejs").c_str(), &origin_stat) == 0, "stat origin bundle");
  Expect(bundle_stat.st_ino != origin_stat.st_ino, "patched bundle must not link the origin");
}

void TestApplyPatchMergeFallsBackToByteCopy() {
  TempDir temp;
  const std::string source = JoinPath(temp.path, "origin");
  const std::string target = JoinPath(temp.path, "target");
  const std::string patch = JoinPath(temp.path, "bundle.patch");

  WriteFile(JoinPath(source, "index.bundlejs"), "old bundle");
  WriteFile(JoinPath(source, "assets/keep.txt"), "keep");
  WriteFile(patch, "unused patch");

  FakeBundlePatcher patcher("patched bundle");
  FileSourcePatchOptions options;
  options.source_root = source;
  options.target_root = target;
  options.origin_bundle_path = JoinPath(source, "index.bundlejs");
  options.bundle_patch_path = patch;
  options.bundle_output_path = JoinPath(target, "index.bundlejs");

  pushy::patch::internal::g_disable_hard_links = true;
  Status status = ApplyPatchFromFileSource(options, patcher);
  pushy::patch::internal::g_disable_hard_links = false;
  Expect(status.ok, status.message);

  struct stat source_stat;
  struct stat merged_stat;
  Expect(stat(JoinPath(source, "assets/keep.txt").c_str(), &source_stat) == 0, "stat source");
  Expect(stat(JoinPath(target, "assets/keep.txt").c_str(), &merged_stat) == 0, "stat merged");
  Expect(merged_stat.st_ino != source_stat.st_ino, "fallback should produce an independent copy");
  Expect(merged_stat.st_nlink == 1, "fallback copy should have a single name");
  ExpectEq(ReadFile(JoinPath(target, "assets/keep.txt")), "keep", "fallback content mismatch");
}

void TestApplyPatchFromFileSourceCanLimitMergeSubdir() {
  TempDir temp;
  const std::string source = JoinPath(temp.path, "origin");
  const std::string target = JoinPath(temp.path, "target");
  const std::string patch = JoinPath(temp.path, "bundle.patch");

  WriteFile(JoinPath(source, "index.bundlejs"), "old bundle");
  WriteFile(JoinPath(source, "assets/keep.txt"), "keep");
  WriteFile(JoinPath(source, "config.json"), "config");
  WriteFile(patch, "unused patch");

  FakeBundlePatcher patcher("patched bundle");
  FileSourcePatchOptions options;
  options.source_root = source;
  options.target_root = target;
  options.origin_bundle_path = JoinPath(source, "index.bundlejs");
  options.bundle_patch_path = patch;
  options.bundle_output_path = JoinPath(target, "index.bundlejs");
  options.merge_source_subdir = "assets";

  Status status = ApplyPatchFromFileSource(options, patcher);
  Expect(status.ok, status.message);

  ExpectEq(ReadFile(JoinPath(target, "assets/keep.txt")), "keep", "assets merge mismatch");
  Expect(!Exists(JoinPath(target, "config.json")), "non-assets root file should not be merged");
}

void TestApplyPatchFromFileSourceRejectsUnsafePaths() {
  TempDir temp;
  const std::string source = JoinPath(temp.path, "origin");
  const std::string target = JoinPath(temp.path, "target");
  const std::string patch = JoinPath(temp.path, "bundle.patch");

  WriteFile(JoinPath(source, "index.bundlejs"), "old bundle");
  WriteFile(JoinPath(source, "assets/file.txt"), "content");
  WriteFile(patch, "unused patch");

  FakeBundlePatcher patcher("patched bundle");
  FileSourcePatchOptions options;
  options.source_root = source;
  options.target_root = target;
  options.origin_bundle_path = JoinPath(source, "index.bundlejs");
  options.bundle_patch_path = patch;
  options.bundle_output_path = JoinPath(target, "index.bundlejs");
  options.merge_source_subdir = "";
  options.manifest.copies.push_back(CopyOperation{"assets/file.txt", "../escape.txt"});

  Status status = ApplyPatchFromFileSource(options, patcher);
  Expect(!status.ok, "unsafe path should fail");
  Expect(patcher.calls == 0, "bundle patcher should not run when validation fails");
}

// Manifest paths are attacker-controlled. Every c_str() consumer downstream
// truncates at NUL, so "..\0x" (which compares unequal to "..") would resolve
// to the parent directory; other control bytes have no legitimate use either.
void TestIsSafeRelativePathRejectsControlBytes() {
  using pushy::patch::IsSafeRelativePath;
  Expect(IsSafeRelativePath("assets/a.png"), "plain relative path is safe");
  Expect(
      IsSafeRelativePath("assets/\xe5\x9b\xbe.png"),
      "non-ASCII UTF-8 stays allowed");
  Expect(
      !IsSafeRelativePath(std::string("..\0x", 4)),
      "embedded NUL after .. must be rejected");
  Expect(
      !IsSafeRelativePath(std::string("assets/a\0.png", 13)),
      "embedded NUL inside a segment must be rejected");
  Expect(!IsSafeRelativePath("assets/a\x01" "b"), "control byte must be rejected");
  Expect(!IsSafeRelativePath("assets/a\tb"), "tab must be rejected");
  Expect(!IsSafeRelativePath("a\nb"), "newline must be rejected");
  Expect(!IsSafeRelativePath("assets/a\x7f"), "DEL must be rejected");

  PatchManifest manifest;
  manifest.copies.push_back(CopyOperation{"assets/a.png", std::string("..\0x", 4)});
  Expect(
      !pushy::patch::ValidateManifest(manifest).ok,
      "manifest with a NUL-bearing target must be rejected");
  manifest.copies.clear();
  manifest.deletes.push_back(std::string("assets/\0..", 10));
  Expect(
      !pushy::patch::ValidateManifest(manifest).ok,
      "manifest with a NUL-bearing delete must be rejected");
}

// Builds `levels` nested directories under `base` and returns the deepest.
std::string MakeDeepTree(const std::string& base, int levels) {
  std::string deep = base;
  EnsureDirectory(deep);
  for (int i = 0; i < levels; ++i) {
    deep = JoinPath(deep, "d");
    mkdir(deep.c_str(), 0755);
  }
  WriteFile(JoinPath(deep, "leaf.txt"), "leaf");
  return deep;
}

// The recursive walkers (cleanup removal, merge) stop at 64 levels with an
// error instead of overflowing the stack on a hostile deeply nested archive.
void TestDirectoryWalkersBoundNestingDepth() {
  TempDir temp;
  const std::time_t now = 1'700'000'000;
  const std::time_t old_time = now - (9 * 24 * 60 * 60);

  // Realistic nesting is fine.
  const std::string shallow_root = JoinPath(temp.path, "shallow");
  MakeDeepTree(JoinPath(shallow_root, "stale"), 10);
  SetMtime(JoinPath(shallow_root, "stale"), old_time);
  Status shallow_status = CleanupOldEntries(
      shallow_root, std::vector<std::string>{"keep"}, 7, now);
  Expect(shallow_status.ok, shallow_status.message);
  Expect(!Exists(JoinPath(shallow_root, "stale")), "10-deep stale tree is removed");

  // Beyond the cap: a clean error, tree left in place.
  const std::string deep_root = JoinPath(temp.path, "deep");
  const std::string deepest = MakeDeepTree(JoinPath(deep_root, "stale"), 80);
  SetMtime(JoinPath(deep_root, "stale"), old_time);
  Status deep_status = CleanupOldEntries(
      deep_root, std::vector<std::string>{"keep"}, 7, now);
  Expect(
      !deep_status.ok && deep_status.message.find("too deep") != std::string::npos,
      "removing an over-deep tree must fail cleanly: " + deep_status.message);
  Expect(Exists(JoinPath(deepest, "leaf.txt")), "over-deep tree is left in place");

  // The merge walker applies the same bound.
  const std::string source = JoinPath(temp.path, "origin");
  const std::string target = JoinPath(temp.path, "target");
  WriteFile(JoinPath(source, "index.bundlejs"), "old bundle");
  MakeDeepTree(JoinPath(source, "assets"), 80);
  WriteFile(JoinPath(temp.path, "bundle.patch"), "unused patch");

  FakeBundlePatcher patcher("patched bundle");
  FileSourcePatchOptions options;
  options.source_root = source;
  options.target_root = target;
  options.origin_bundle_path = JoinPath(source, "index.bundlejs");
  options.bundle_patch_path = JoinPath(temp.path, "bundle.patch");
  options.bundle_output_path = JoinPath(target, "index.bundlejs");
  options.merge_source_subdir = "";
  Status merge_status = ApplyPatchFromFileSource(options, patcher);
  Expect(
      !merge_status.ok && merge_status.message.find("too deep") != std::string::npos,
      "merging an over-deep tree must fail cleanly: " + merge_status.message);
}

// A patch stream that declares a 4 GB LZMA2 dictionary must be refused before
// the decoder allocates it (hpatch.c caps the dictionary; without the cap the
// decoder happily allocates and the patch even applies on 64-bit hosts).
void TestHpatchRejectsOversizedLzmaDictionary() {
  TempDir temp;
  std::string patch = ReadFile(JoinPath(g_fixtures_dir, "v96.tpatch.bin"));
  Expect(!patch.empty(), "hbc patch fixture must exist");

  hpatch_TStreamInput stream;
  const unsigned char* bytes = reinterpret_cast<const unsigned char*>(patch.data());
  mem_as_hStreamInput(&stream, bytes, bytes + patch.size());
  hpatch_singleCompressedDiffInfo info;
  Expect(
      getSingleCompressedDiffInfo(&info, &stream, 0),
      "fixture must be a single-compressed diff");
  Expect(
      std::string(info.compressType) == "lzma2" && info.compressedSize > 0,
      "fixture must be lzma2-compressed");
  // The LZMA2 property byte leads the compressed stream; 40 declares 4 GB.
  patch[static_cast<size_t>(info.diffDataPos)] = static_cast<char>(40);
  const std::string tampered = JoinPath(temp.path, "tampered.patch");
  WriteFile(tampered, patch);

  FileSourcePatchOptions options;
  options.source_root = JoinPath(temp.path, "src");
  options.target_root = JoinPath(temp.path, "dst");
  options.origin_bundle_path = JoinPath(g_fixtures_dir, "v96.hbc");
  options.bundle_patch_path = tampered;
  options.bundle_output_path = JoinPath(temp.path, "out/index.bundlejs");
  options.enable_merge = false;
  options.bundle_hbc_transform_meta = ReadFile(JoinPath(g_fixtures_dir, "v96.meta.json"));

  Status status = ApplyPatchFromFileSource(options);
  Expect(!status.ok, "a patch declaring a 4 GB LZMA dictionary must be refused");
  Expect(
      status.message.find("hpatch error") != std::string::npos,
      "refusal surfaces as an hpatch error: " + status.message);
  Expect(!Exists(options.bundle_output_path), "no output on failure");
  Expect(
      !Exists(options.bundle_output_path + ".hbct-origin") &&
          !Exists(options.bundle_output_path + ".hbct-patched"),
      "temp files are removed on failure");
}

void TestCleanupOldEntriesRemovesOnlyExpiredPaths() {
  TempDir temp;
  const std::string root = JoinPath(temp.path, "cleanup");
  EnsureDirectory(root);

  WriteFile(JoinPath(root, "current/index.bundlejs"), "current");
  WriteFile(JoinPath(root, "previous/index.bundlejs"), "previous");
  WriteFile(JoinPath(root, "stale/index.bundlejs"), "stale");
  WriteFile(JoinPath(root, "recent/index.bundlejs"), "recent");
  WriteFile(JoinPath(root, "old.tmp"), "old");
  WriteFile(JoinPath(root, ".hidden"), "hidden");

  const std::time_t now = 1'700'000'000;
  const std::time_t old_time = now - (9 * 24 * 60 * 60);
  const std::time_t recent_time = now - (2 * 24 * 60 * 60);

  SetMtime(JoinPath(root, "current"), old_time);
  SetMtime(JoinPath(root, "previous"), old_time);
  SetMtime(JoinPath(root, "stale"), old_time);
  SetMtime(JoinPath(root, "recent"), recent_time);
  SetMtime(JoinPath(root, "old.tmp"), old_time);
  SetMtime(JoinPath(root, ".hidden"), old_time);

  Status status = CleanupOldEntries(root, "current", "previous", 7, now);
  Expect(status.ok, status.message);

  Expect(Exists(JoinPath(root, "current")), "current entry should be kept");
  Expect(Exists(JoinPath(root, "previous")), "previous entry should be kept");
  Expect(!Exists(JoinPath(root, "stale")), "stale directory should be removed");
  Expect(!Exists(JoinPath(root, "old.tmp")), "stale file should be removed");
  Expect(Exists(JoinPath(root, "recent")), "recent entry should be kept");
  Expect(Exists(JoinPath(root, ".hidden")), "hidden entry should be kept");
}

void TestStateCoreSyncBinaryVersionResetsUpdates() {
  State state;
  state.package_version = "1.0.0";
  state.build_time = "100";
  state.current_version = "current";
  state.last_version = "last";
  state.first_time = true;
  state.first_time_ok = false;
  state.rolled_back_version = "rolled";

  BinaryVersionSyncResult result =
      pushy::state::SyncBinaryVersion(state, "1.1.0", "200");
  Expect(result.changed, "binary version sync should detect changes");
  ExpectEq(result.state.package_version, "1.1.0", "package version mismatch");
  ExpectEq(result.state.build_time, "200", "build time mismatch");
  Expect(result.state.current_version.empty(), "current version should reset");
  Expect(result.state.last_version.empty(), "last version should reset");
  Expect(!result.state.first_time, "first_time should reset");
  Expect(result.state.first_time_ok, "first_time_ok should reset");
  Expect(result.state.rolled_back_version.empty(), "rolled_back_version should reset");
}

void TestStateCoreSwitchVersionAndMarkSuccess() {
  State state;
  state.package_version = "1.0.0";
  state.build_time = "100";
  state.current_version = "old";
  state.last_version = "older";
  state.first_time_ok = true;

  State switched = pushy::state::SwitchVersion(state, "new");
  ExpectEq(switched.current_version, "new", "current version mismatch");
  ExpectEq(switched.last_version, "old", "last version mismatch");
  Expect(switched.first_time, "first_time should be set");
  Expect(!switched.first_time_ok, "first_time_ok should be false");

  MarkSuccessResult success = pushy::state::MarkSuccess(switched);
  ExpectEq(success.state.current_version, "new", "markSuccess current version mismatch");
  Expect(success.state.last_version.empty(), "last version should be cleared");
  ExpectEq(success.stale_version_to_delete, "old", "stale version mismatch");
  Expect(!success.state.first_time, "first_time should clear after success");
  Expect(success.state.first_time_ok, "first_time_ok should be true after success");
}

void TestStateCoreResolveLaunchStateAndRollback() {
  State state;
  state.current_version = "current";
  state.last_version = "previous";
  state.first_time = false;
  state.first_time_ok = false;

  LaunchDecision rollback =
      pushy::state::ResolveLaunchState(state, false, true);
  Expect(rollback.did_rollback, "launch decision should roll back");
  ExpectEq(rollback.load_version, "previous", "rollback load version mismatch");
  ExpectEq(rollback.state.current_version, "previous", "rollback current version mismatch");
  ExpectEq(rollback.state.rolled_back_version, "current", "rolled back version mismatch");

  State first_load;
  first_load.current_version = "fresh";
  first_load.first_time = true;
  first_load.first_time_ok = false;
  LaunchDecision consume =
      pushy::state::ResolveLaunchState(first_load, false, true);
  Expect(!consume.did_rollback, "first load should not roll back");
  Expect(consume.consumed_first_time, "first load should be consumed");
  ExpectEq(consume.load_version, "fresh", "first load version mismatch");
  Expect(!consume.state.first_time, "first_time should clear when consumed");

  LaunchDecision preserve =
      pushy::state::ResolveLaunchState(first_load, false, false);
  Expect(!preserve.consumed_first_time, "first load should not be consumed when disabled");
  Expect(preserve.state.first_time, "first_time should be preserved when not consumed");
}

void TestStateCoreCanClearMarkers() {
  State state;
  state.current_version = "current";
  state.first_time = true;
  state.rolled_back_version = "rolled";

  State clear_first_time = pushy::state::ClearFirstTime(state);
  Expect(!clear_first_time.first_time, "clearFirstTime should clear first_time");
  ExpectEq(
      clear_first_time.rolled_back_version,
      "rolled",
      "clearFirstTime should preserve rollback marker");

  State clear_rollback = pushy::state::ClearRollbackMark(state);
  Expect(
      clear_rollback.rolled_back_version.empty(),
      "clearRollbackMark should clear rollback marker");
  Expect(clear_rollback.first_time, "clearRollbackMark should preserve first_time");
}

void TestArchivePatchCoreBuildPlanAndCopyGroups() {
  PatchManifest manifest;
  manifest.copies.push_back(CopyOperation{"assets/a.png", "assets/x.png"});
  manifest.copies.push_back(CopyOperation{"assets/a.png", "assets/y.png"});
  manifest.deletes.push_back("assets/old.png");

  pushy::archive_patch::ArchivePatchPlan plan;
  Status status = pushy::archive_patch::BuildArchivePatchPlan(
      pushy::archive_patch::ArchivePatchType::kPatchFromPpk,
      manifest,
      {"__diff.json", "index.bundlejs.patch", "assets/new.png"},
      &plan);
  Expect(status.ok, status.message);
  Expect(plan.enable_merge, "ppk plan should enable merge");
  ExpectEq(plan.merge_source_subdir, "", "ppk merge subdir mismatch");

  std::vector<pushy::archive_patch::CopyGroup> groups;
  status = pushy::archive_patch::BuildCopyGroups(manifest, &groups);
  Expect(status.ok, status.message);
  Expect(groups.size() == 1, "copy groups should merge identical sources");
  ExpectEq(groups[0].from, "assets/a.png", "copy group source mismatch");
  Expect(groups[0].to_paths.size() == 2, "copy group target count mismatch");

  FileSourcePatchOptions options;
  status = pushy::archive_patch::BuildFileSourcePatchOptions(
      plan,
      "/tmp/source",
      "/tmp/target",
      "/tmp/source/index.bundlejs",
      "/tmp/target/index.bundlejs.patch",
      "/tmp/target/index.bundlejs",
      &options);
  Expect(status.ok, status.message);
  ExpectEq(options.source_root, "/tmp/source", "file source root mismatch");
  ExpectEq(options.target_root, "/tmp/target", "file target root mismatch");
  ExpectEq(options.merge_source_subdir, "", "file patch merge subdir mismatch");
}

void TestArchivePatchCoreRejectsMissingEntries() {
  PatchManifest manifest;
  Status status = pushy::archive_patch::BuildArchivePatchPlan(
      pushy::archive_patch::ArchivePatchType::kPatchFromPackage,
      manifest,
      {"index.bundlejs.patch"},
      nullptr);
  Expect(!status.ok, "null output plan should fail");

  pushy::archive_patch::ArchivePatchPlan plan;
  status = pushy::archive_patch::BuildArchivePatchPlan(
      pushy::archive_patch::ArchivePatchType::kPatchFromPackage,
      manifest,
      {"__diff.json"},
      &plan);
  Expect(!status.ok, "missing bundle patch should fail");

  status = pushy::archive_patch::BuildArchivePatchPlan(
      pushy::archive_patch::ArchivePatchType::kPatchFromPackage,
      manifest,
      {"__diff.json", "index.bundlejs.patch"},
      &plan);
  Expect(status.ok, status.message);
  ExpectEq(plan.merge_source_subdir, "assets", "package merge subdir mismatch");
  Expect(plan.enable_merge, "package plan should enable merge");
  Expect(
      pushy::archive_patch::ClassifyEntry(
          pushy::archive_patch::ArchivePatchType::kPatchFromPackage,
          "__diff.json") == pushy::archive_patch::EntryAction::kSkip,
      "manifest entry should be skipped");
}

void TestTryParseArchivePatchType() {
  pushy::archive_patch::ArchivePatchType type;
  Expect(
      pushy::archive_patch::TryParseArchivePatchType(1, &type) &&
          type == pushy::archive_patch::ArchivePatchType::kFull,
      "1 should parse to kFull");
  Expect(
      pushy::archive_patch::TryParseArchivePatchType(2, &type) &&
          type == pushy::archive_patch::ArchivePatchType::kPatchFromPackage,
      "2 should parse to kPatchFromPackage");
  Expect(
      pushy::archive_patch::TryParseArchivePatchType(3, &type) &&
          type == pushy::archive_patch::ArchivePatchType::kPatchFromPpk,
      "3 should parse to kPatchFromPpk");
  Expect(
      !pushy::archive_patch::TryParseArchivePatchType(0, &type),
      "0 should be rejected");
  Expect(
      !pushy::archive_patch::TryParseArchivePatchType(4, &type),
      "unknown type should be rejected, not silently coerced to kFull");
}

void TestArchivePatchCoreSupportsCustomBundlePatchEntry() {
  PatchManifest manifest;
  manifest.copies.push_back(CopyOperation{"assets/a.png", "assets/a.png"});

  pushy::archive_patch::ArchivePatchPlan plan;
  Status status = pushy::archive_patch::BuildArchivePatchPlan(
      pushy::archive_patch::ArchivePatchType::kPatchFromPpk,
      manifest,
      {"__diff.json", "bundle.harmony.js.patch"},
      &plan,
      "bundle.harmony.js.patch");
  Expect(status.ok, status.message);
  Expect(plan.enable_merge, "custom bundle patch plan should enable merge");
  ExpectEq(plan.merge_source_subdir, "", "custom bundle patch merge subdir mismatch");
}

void TestArchivePatchCoreHarmonyBundlePatchFromPackage() {
  PatchManifest manifest;
  manifest.copies.push_back(CopyOperation{"assets/a.png", "assets/b.png"});

  pushy::archive_patch::ArchivePatchPlan plan;
  Status status = pushy::archive_patch::BuildArchivePatchPlan(
      pushy::archive_patch::ArchivePatchType::kPatchFromPackage,
      manifest,
      {"__diff.json", "bundle.harmony.js.patch", "assets/new.png"},
      &plan,
      "bundle.harmony.js.patch");
  Expect(status.ok, status.message);
  Expect(plan.enable_merge, "harmony package plan should enable merge");
  ExpectEq(plan.merge_source_subdir, "assets", "harmony package merge subdir should be assets");

  // ppk variant uses empty merge subdir
  pushy::archive_patch::ArchivePatchPlan ppk_plan;
  status = pushy::archive_patch::BuildArchivePatchPlan(
      pushy::archive_patch::ArchivePatchType::kPatchFromPpk,
      manifest,
      {"__diff.json", "bundle.harmony.js.patch", "assets/new.png"},
      &ppk_plan,
      "bundle.harmony.js.patch");
  Expect(status.ok, status.message);
  Expect(ppk_plan.enable_merge, "harmony ppk plan should enable merge");
  ExpectEq(ppk_plan.merge_source_subdir, "", "harmony ppk merge subdir should be empty");
}

void TestStateCoreRollbackToEmptyVersion() {
  State state;
  state.current_version = "current";
  state.last_version = "";
  state.first_time = false;
  state.first_time_ok = true;

  State rolled = pushy::state::Rollback(state);
  Expect(rolled.current_version.empty(), "rollback with empty last should clear current");
  Expect(rolled.last_version.empty(), "last_version should remain empty");
  ExpectEq(rolled.rolled_back_version, "current", "rolled_back_version should record original");
  Expect(!rolled.first_time, "first_time should be false after rollback");
  Expect(rolled.first_time_ok, "first_time_ok should be true after rollback");
}

void TestStateCoreResolveLaunchNoCurrentVersion() {
  State state;
  state.current_version = "";
  state.first_time = false;
  state.first_time_ok = true;

  LaunchDecision decision = pushy::state::ResolveLaunchState(state, false, true);
  Expect(decision.load_version.empty(), "empty current should yield empty load_version");
  Expect(!decision.did_rollback, "should not rollback when no current version");
  Expect(!decision.consumed_first_time, "should not consume first_time when no current version");
}

void TestStateCoreSwitchToSameVersion() {
  State state;
  state.package_version = "1.0.0";
  state.current_version = "same_hash";
  state.last_version = "old_hash";

  State switched = pushy::state::SwitchVersion(state, "same_hash");
  ExpectEq(switched.current_version, "same_hash", "current should remain same_hash");
  ExpectEq(switched.last_version, "old_hash", "last_version should not change when switching to same");
  Expect(switched.first_time, "first_time should be set even when switching to same");
  Expect(!switched.first_time_ok, "first_time_ok should be false");
}

// NIST FIPS 180-4 vectors. These anchor the C++ implementation (iOS/Harmony)
// and, by transitivity, Android's java.security.MessageDigest and the CLI's
// node:crypto to the same standard — the bundleHash produced on any of them
// must be byte-identical for the same input.
void TestSha256KnownVectors() {
  {
    pushy::digest::Sha256 hasher;
    ExpectEq(
        hasher.HexDigest(),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "sha256 of empty input");
  }
  {
    pushy::digest::Sha256 hasher;
    const char* input = "abc";
    hasher.Update(reinterpret_cast<const uint8_t*>(input), 3);
    ExpectEq(
        hasher.HexDigest(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "sha256 of \"abc\"");
  }
  {
    pushy::digest::Sha256 hasher;
    const std::string input =
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    hasher.Update(
        reinterpret_cast<const uint8_t*>(input.data()), input.size());
    ExpectEq(
        hasher.HexDigest(),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        "sha256 of NIST two-block message");
  }
}

void TestSha256StreamingMatchesOneShot() {
  // One million 'a' (NIST long vector), fed in deliberately awkward chunk
  // sizes to cross every buffer boundary case in Update.
  const std::string chunk(4096 + 37, 'a');
  size_t remaining = 1000000;
  pushy::digest::Sha256 hasher;
  while (remaining > 0) {
    const size_t take = remaining < chunk.size() ? remaining : chunk.size();
    hasher.Update(reinterpret_cast<const uint8_t*>(chunk.data()), take);
    remaining -= take;
  }
  ExpectEq(
      hasher.HexDigest(),
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
      "sha256 of one million 'a' fed in odd-sized chunks");
}

void TestSha256File() {
  TempDir temp;
  const std::string dir = temp.path;
  const std::string path = dir + "/input.bin";
  WriteFile(path, "abc");
  ExpectEq(
      pushy::digest::Sha256File(path),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "Sha256File over a small file");
  ExpectEq(
      pushy::digest::Sha256File(dir + "/missing.bin"),
      "",
      "Sha256File over a missing file returns empty");
}

void TestCrc32KnownVectors() {
  {
    pushy::digest::Crc32 crc;
    Expect(crc.Value() == 0x00000000u, "crc32 of empty input");
  }
  {
    // The classic check value: crc32("123456789") == 0xCBF43926.
    pushy::digest::Crc32 crc;
    const char* input = "123456789";
    crc.Update(reinterpret_cast<const uint8_t*>(input), 9);
    Expect(crc.Value() == 0xCBF43926u, "crc32 check value of \"123456789\"");
  }
  {
    // Streaming in awkward chunks must match the one-shot value.
    const std::string input(100000, 'a');
    pushy::digest::Crc32 one_shot;
    one_shot.Update(
        reinterpret_cast<const uint8_t*>(input.data()), input.size());
    pushy::digest::Crc32 streamed;
    size_t offset = 0;
    size_t chunk = 1;
    while (offset < input.size()) {
      const size_t take =
          offset + chunk > input.size() ? input.size() - offset : chunk;
      streamed.Update(
          reinterpret_cast<const uint8_t*>(input.data()) + offset, take);
      offset += take;
      chunk = chunk * 2 + 1;
    }
    Expect(
        streamed.Value() == one_shot.Value(),
        "crc32 streaming matches one-shot");
  }
}

void TestCrc32File() {
  TempDir temp;
  const std::string dir = temp.path;
  const std::string path = dir + "/input.bin";
  WriteFile(path, "123456789");
  uint32_t value = 0;
  Expect(pushy::digest::Crc32File(path, &value), "Crc32File should read");
  Expect(value == 0xCBF43926u, "Crc32File check value");
  Expect(
      !pushy::digest::Crc32File(dir + "/missing.bin", &value),
      "Crc32File over a missing file returns false");
}

void TestApplyPatchCopiesVerifyExpectedCrc() {
  TempDir temp;
  const std::string source = JoinPath(temp.path, "origin");
  const std::string target = JoinPath(temp.path, "target");
  const std::string patch = JoinPath(temp.path, "bundle.patch");

  WriteFile(JoinPath(source, "index.bundlejs"), "old bundle");
  WriteFile(JoinPath(source, "assets/keep.txt"), "123456789");
  WriteFile(patch, "unused patch");

  FakeBundlePatcher patcher("patched bundle");
  FileSourcePatchOptions options;
  options.source_root = source;
  options.target_root = target;
  options.origin_bundle_path = JoinPath(source, "index.bundlejs");
  options.bundle_patch_path = patch;
  options.bundle_output_path = JoinPath(target, "index.bundlejs");
  options.enable_merge = false;
  CopyOperation copy;
  copy.from = "assets/keep.txt";
  copy.to = "assets/keep.txt";
  copy.has_expected_crc = true;
  copy.expected_crc = 0xCBF43926u;  // crc32("123456789")
  options.manifest.copies.push_back(copy);

  Status status = ApplyPatchFromFileSource(options, patcher);
  Expect(status.ok, status.message);
  ExpectEq(
      ReadFile(JoinPath(target, "assets/keep.txt")),
      "123456789",
      "verified copy content");

  // Same manifest applied on a "rebuilt" source whose file drifted: the copy
  // must fail the whole patch (caller falls back to full), not copy silently.
  WriteFile(JoinPath(source, "assets/keep.txt"), "drifted-bytes");
  const std::string target2 = JoinPath(temp.path, "target2");
  options.target_root = target2;
  options.bundle_output_path = JoinPath(target2, "index.bundlejs");
  Status mismatch = ApplyPatchFromFileSource(options, patcher);
  Expect(!mismatch.ok, "drifted copy source must fail the patch");
  Expect(
      mismatch.message.find("crc32") != std::string::npos,
      "mismatch error should mention crc32");
  Expect(
      !Exists(JoinPath(target2, "assets/keep.txt")),
      "drifted content must not be copied");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc > 1) {
    g_fixtures_dir = argv[1];
  }
  const std::vector<std::pair<std::string, void (*)()>> tests = {
      {"ApplyStreamFormatBundlePatch", TestApplyStreamFormatBundlePatch},
      {"ApplyStreamFormatWithHbcTransform", TestApplyStreamFormatWithHbcTransform},
      {"ApplySingleFormatRawStoredWithLzma2Label",
       TestApplySingleFormatRawStoredWithLzma2Label},
      {"ApplyPatchWithHbcTransform", TestApplyPatchWithHbcTransform},
      {"ApplyPatchWithHbcTransformRejectsBadMeta", TestApplyPatchWithHbcTransformRejectsBadMeta},
      {"ApplyPatchFromFileSourceMergesAndCopies", TestApplyPatchFromFileSourceMergesAndCopies},
      {"ApplyPatchMergeHardLinksUnchangedFiles", TestApplyPatchMergeHardLinksUnchangedFiles},
      {"ApplyPatchMergeFallsBackToByteCopy", TestApplyPatchMergeFallsBackToByteCopy},
      {"ApplyPatchFromFileSourceCanLimitMergeSubdir", TestApplyPatchFromFileSourceCanLimitMergeSubdir},
      {"ApplyPatchFromFileSourceRejectsUnsafePaths", TestApplyPatchFromFileSourceRejectsUnsafePaths},
      {"IsSafeRelativePathRejectsControlBytes", TestIsSafeRelativePathRejectsControlBytes},
      {"DirectoryWalkersBoundNestingDepth", TestDirectoryWalkersBoundNestingDepth},
      {"HpatchRejectsOversizedLzmaDictionary", TestHpatchRejectsOversizedLzmaDictionary},
      {"CleanupOldEntriesRemovesOnlyExpiredPaths", TestCleanupOldEntriesRemovesOnlyExpiredPaths},
      {"StateCoreSyncBinaryVersionResetsUpdates", TestStateCoreSyncBinaryVersionResetsUpdates},
      {"StateCoreSwitchVersionAndMarkSuccess", TestStateCoreSwitchVersionAndMarkSuccess},
      {"StateCoreResolveLaunchStateAndRollback", TestStateCoreResolveLaunchStateAndRollback},
      {"StateCoreCanClearMarkers", TestStateCoreCanClearMarkers},
      {"ArchivePatchCoreBuildPlanAndCopyGroups", TestArchivePatchCoreBuildPlanAndCopyGroups},
      {"ArchivePatchCoreRejectsMissingEntries", TestArchivePatchCoreRejectsMissingEntries},
      {"TryParseArchivePatchType", TestTryParseArchivePatchType},
      {"ArchivePatchCoreSupportsCustomBundlePatchEntry", TestArchivePatchCoreSupportsCustomBundlePatchEntry},
      {"ArchivePatchCoreHarmonyBundlePatchFromPackage", TestArchivePatchCoreHarmonyBundlePatchFromPackage},
      {"StateCoreRollbackToEmptyVersion", TestStateCoreRollbackToEmptyVersion},
      {"StateCoreResolveLaunchNoCurrentVersion", TestStateCoreResolveLaunchNoCurrentVersion},
      {"StateCoreSwitchToSameVersion", TestStateCoreSwitchToSameVersion},
      {"Sha256KnownVectors", TestSha256KnownVectors},
      {"Sha256StreamingMatchesOneShot", TestSha256StreamingMatchesOneShot},
      {"Sha256File", TestSha256File},
      {"Crc32KnownVectors", TestCrc32KnownVectors},
      {"Crc32File", TestCrc32File},
      {"ApplyPatchCopiesVerifyExpectedCrc", TestApplyPatchCopiesVerifyExpectedCrc},
  };

  int failures = 0;
  for (const auto& test : tests) {
    try {
      test.second();
      std::fprintf(stdout, "[PASS] %s\n", test.first.c_str());
    } catch (const std::exception& error) {
      std::fprintf(stderr, "[FAIL] %s: %s\n", test.first.c_str(), error.what());
      ++failures;
    }
  }

  std::fprintf(
      stdout,
      "\n%zu tests, %d passed, %d failed\n",
      tests.size(),
      static_cast<int>(tests.size()) - failures,
      failures);
  return failures == 0 ? 0 : 1;
}
