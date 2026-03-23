#include "../patch_core.h"

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

namespace {

using pushy::patch::ApplyPatchFromFileSource;
using pushy::patch::BundlePatcher;
using pushy::patch::CleanupOldEntries;
using pushy::patch::CopyOperation;
using pushy::patch::FileSourcePatchOptions;
using pushy::patch::PatchManifest;
using pushy::patch::Status;

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

}  // namespace

int main() {
  const std::vector<std::pair<std::string, void (*)()>> tests = {
      {"ApplyPatchFromFileSourceMergesAndCopies", TestApplyPatchFromFileSourceMergesAndCopies},
      {"ApplyPatchFromFileSourceCanLimitMergeSubdir", TestApplyPatchFromFileSourceCanLimitMergeSubdir},
      {"ApplyPatchFromFileSourceRejectsUnsafePaths", TestApplyPatchFromFileSourceRejectsUnsafePaths},
      {"CleanupOldEntriesRemovesOnlyExpiredPaths", TestCleanupOldEntriesRemovesOnlyExpiredPaths},
  };

  for (const auto& test : tests) {
    try {
      test.second();
      std::fprintf(stdout, "[PASS] %s\n", test.first.c_str());
    } catch (const std::exception& error) {
      std::fprintf(stderr, "[FAIL] %s: %s\n", test.first.c_str(), error.what());
      return 1;
    }
  }

  return 0;
}
