#include "../archive_patch_core.h"
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

}  // namespace

int main() {
  const std::vector<std::pair<std::string, void (*)()>> tests = {
      {"ApplyPatchFromFileSourceMergesAndCopies", TestApplyPatchFromFileSourceMergesAndCopies},
      {"ApplyPatchFromFileSourceCanLimitMergeSubdir", TestApplyPatchFromFileSourceCanLimitMergeSubdir},
      {"ApplyPatchFromFileSourceRejectsUnsafePaths", TestApplyPatchFromFileSourceRejectsUnsafePaths},
      {"CleanupOldEntriesRemovesOnlyExpiredPaths", TestCleanupOldEntriesRemovesOnlyExpiredPaths},
      {"StateCoreSyncBinaryVersionResetsUpdates", TestStateCoreSyncBinaryVersionResetsUpdates},
      {"StateCoreSwitchVersionAndMarkSuccess", TestStateCoreSwitchVersionAndMarkSuccess},
      {"StateCoreResolveLaunchStateAndRollback", TestStateCoreResolveLaunchStateAndRollback},
      {"StateCoreCanClearMarkers", TestStateCoreCanClearMarkers},
      {"ArchivePatchCoreBuildPlanAndCopyGroups", TestArchivePatchCoreBuildPlanAndCopyGroups},
      {"ArchivePatchCoreRejectsMissingEntries", TestArchivePatchCoreRejectsMissingEntries},
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
