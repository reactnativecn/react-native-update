#include "patch_core.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <set>
#include <sstream>
#include <vector>

extern "C" {
#include "hpatch.h"
}

namespace pushy {
namespace patch {
namespace {

constexpr size_t kCopyBufferSize = 16 * 1024;

class HdiffBundlePatcher final : public BundlePatcher {
 public:
  Status Apply(
      const std::string& origin_bundle_path,
      const std::string& bundle_patch_path,
      const std::string& destination_bundle_path) const override;
};

Status MakeErrnoStatus(const std::string& message, int err = errno) {
  std::ostringstream stream;
  stream << message;
  if (err != 0) {
    stream << ": " << std::strerror(err);
  }
  return Status::Error(stream.str());
}

bool EndsWithSlash(const std::string& path) {
  return !path.empty() && path[path.size() - 1] == '/';
}

std::string TrimTrailingSlash(const std::string& path) {
  if (path.empty()) {
    return path;
  }

  size_t end = path.size();
  while (end > 0 && path[end - 1] == '/') {
    --end;
  }
  return path.substr(0, end);
}

std::vector<std::string> SplitPath(const std::string& path) {
  std::vector<std::string> segments;
  std::string current;

  for (char ch : path) {
    if (ch == '/') {
      segments.push_back(current);
      current.clear();
    } else {
      current.push_back(ch);
    }
  }
  segments.push_back(current);
  return segments;
}

std::string JoinPath(const std::string& base, const std::string& relative) {
  if (base.empty()) {
    return relative;
  }
  if (relative.empty()) {
    return base;
  }
  if (base[base.size() - 1] == '/') {
    return base + relative;
  }
  return base + "/" + relative;
}

std::string Dirname(const std::string& path) {
  size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) {
    return std::string();
  }
  return path.substr(0, slash);
}

bool PathExists(const std::string& path) {
  struct stat st;
  return stat(path.c_str(), &st) == 0;
}

bool IsDirectory(const std::string& path) {
  struct stat st;
  if (stat(path.c_str(), &st) != 0) {
    return false;
  }
  return S_ISDIR(st.st_mode);
}

Status EnsureDirectory(const std::string& path) {
  if (path.empty()) {
    return Status::Ok();
  }
  if (PathExists(path)) {
    if (IsDirectory(path)) {
      return Status::Ok();
    }
    return Status::Error("Expected directory path: " + path);
  }

  const std::string parent = Dirname(path);
  if (!parent.empty()) {
    Status parent_status = EnsureDirectory(parent);
    if (!parent_status) {
      return parent_status;
    }
  }

  if (mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) {
    return MakeErrnoStatus("Failed to create directory " + path);
  }
  return Status::Ok();
}

Status RemovePathRecursively(const std::string& path) {
  struct stat st;
  if (lstat(path.c_str(), &st) != 0) {
    if (errno == ENOENT) {
      return Status::Ok();
    }
    return MakeErrnoStatus("Failed to stat path " + path);
  }

  if (S_ISDIR(st.st_mode)) {
    DIR* dir = opendir(path.c_str());
    if (!dir) {
      return MakeErrnoStatus("Failed to open directory " + path);
    }

    struct dirent* entry = nullptr;
    while ((entry = readdir(dir)) != nullptr) {
      const std::string name = entry->d_name;
      if (name == "." || name == "..") {
        continue;
      }
      Status remove_status = RemovePathRecursively(JoinPath(path, name));
      if (!remove_status) {
        closedir(dir);
        return remove_status;
      }
    }
    closedir(dir);

    if (rmdir(path.c_str()) != 0) {
      return MakeErrnoStatus("Failed to remove directory " + path);
    }
    return Status::Ok();
  }

  if (unlink(path.c_str()) != 0) {
    return MakeErrnoStatus("Failed to remove file " + path);
  }
  return Status::Ok();
}

Status CopyFile(const std::string& from, const std::string& to, bool overwrite) {
  struct stat st;
  if (stat(from.c_str(), &st) != 0) {
    return MakeErrnoStatus("Failed to stat source file " + from);
  }
  if (!S_ISREG(st.st_mode)) {
    return Status::Error("Source is not a regular file: " + from);
  }

  const std::string parent = Dirname(to);
  Status dir_status = EnsureDirectory(parent);
  if (!dir_status) {
    return dir_status;
  }

  if (PathExists(to)) {
    if (!overwrite) {
      return Status::Ok();
    }
    Status remove_status = RemovePathRecursively(to);
    if (!remove_status) {
      return remove_status;
    }
  }

  FILE* source = std::fopen(from.c_str(), "rb");
  if (!source) {
    return MakeErrnoStatus("Failed to open source file " + from);
  }

  FILE* destination = std::fopen(to.c_str(), "wb");
  if (!destination) {
    std::fclose(source);
    return MakeErrnoStatus("Failed to open destination file " + to);
  }

  std::vector<unsigned char> buffer(kCopyBufferSize);
  while (true) {
    size_t bytes_read = std::fread(buffer.data(), 1, buffer.size(), source);
    if (bytes_read > 0) {
      size_t bytes_written = std::fwrite(buffer.data(), 1, bytes_read, destination);
      if (bytes_written != bytes_read) {
        std::fclose(source);
        std::fclose(destination);
        return MakeErrnoStatus("Failed to write destination file " + to);
      }
    }

    if (bytes_read < buffer.size()) {
      if (std::ferror(source)) {
        std::fclose(source);
        std::fclose(destination);
        return MakeErrnoStatus("Failed to read source file " + from);
      }
      break;
    }
  }

  std::fclose(source);
  if (std::fclose(destination) != 0) {
    return MakeErrnoStatus("Failed to close destination file " + to);
  }
  return Status::Ok();
}

struct DeleteRule {
  std::string path;
  bool directory_hint;
};

class DeleteMatcher {
 public:
  explicit DeleteMatcher(const std::vector<std::string>& deletes) {
    for (const std::string& raw : deletes) {
      rules_.push_back(DeleteRule{TrimTrailingSlash(raw), EndsWithSlash(raw)});
    }
  }

  bool Matches(const std::string& relative_path) const {
    const std::string trimmed = TrimTrailingSlash(relative_path);
    for (const DeleteRule& rule : rules_) {
      if (rule.path.empty()) {
        continue;
      }
      if (trimmed == rule.path) {
        return true;
      }
      if (rule.directory_hint &&
          trimmed.size() > rule.path.size() &&
          trimmed.compare(0, rule.path.size(), rule.path) == 0 &&
          trimmed[rule.path.size()] == '/') {
        return true;
      }
    }
    return false;
  }

 private:
  std::vector<DeleteRule> rules_;
};

Status ValidateManifestImpl(const PatchManifest& manifest) {
  for (const CopyOperation& copy : manifest.copies) {
    if (!IsSafeRelativePath(copy.from)) {
      return Status::Error("Unsafe copy source path: " + copy.from);
    }
    if (!IsSafeRelativePath(copy.to)) {
      return Status::Error("Unsafe copy target path: " + copy.to);
    }
  }

  for (const std::string& deleted : manifest.deletes) {
    const std::string trimmed = TrimTrailingSlash(deleted);
    if (trimmed.empty() || !IsSafeRelativePath(trimmed)) {
      return Status::Error("Unsafe deleted path: " + deleted);
    }
  }

  return Status::Ok();
}

Status MergeDirectoryRecursively(
    const std::string& source_root,
    const std::string& target_root,
    const std::string& relative_root,
    const DeleteMatcher& deletes) {
  DIR* dir = opendir(source_root.c_str());
  if (!dir) {
    if (errno == ENOENT) {
      return Status::Ok();
    }
    return MakeErrnoStatus("Failed to open source directory " + source_root);
  }

  struct dirent* entry = nullptr;
  while ((entry = readdir(dir)) != nullptr) {
    const std::string name = entry->d_name;
    if (name == "." || name == "..") {
      continue;
    }

    const std::string source_path = JoinPath(source_root, name);
    const std::string relative_path =
        relative_root.empty() ? name : JoinPath(relative_root, name);

    if (deletes.Matches(relative_path)) {
      continue;
    }

    struct stat st;
    if (stat(source_path.c_str(), &st) != 0) {
      closedir(dir);
      return MakeErrnoStatus("Failed to stat source path " + source_path);
    }

    const std::string target_path = JoinPath(target_root, name);
    if (S_ISDIR(st.st_mode)) {
      Status dir_status = EnsureDirectory(target_path);
      if (!dir_status) {
        closedir(dir);
        return dir_status;
      }

      Status merge_status =
          MergeDirectoryRecursively(source_path, target_path, relative_path, deletes);
      if (!merge_status) {
        closedir(dir);
        return merge_status;
      }
    } else if (S_ISREG(st.st_mode)) {
      Status copy_status = CopyFile(source_path, target_path, false);
      if (!copy_status) {
        closedir(dir);
        return copy_status;
      }
    }
  }

  closedir(dir);
  return Status::Ok();
}

}  // namespace

Status Status::Ok() {
  return Status{true, std::string()};
}

Status Status::Error(const std::string& message) {
  return Status{false, message};
}

Status ValidateManifest(const PatchManifest& manifest) {
  return ValidateManifestImpl(manifest);
}

const BundlePatcher& DefaultBundlePatcher() {
  static const HdiffBundlePatcher kPatcher;
  return kPatcher;
}

Status ApplyPatchFromFileSource(
    const FileSourcePatchOptions& options,
    const BundlePatcher& bundle_patcher) {
  Status manifest_status = ValidateManifest(options.manifest);
  if (!manifest_status) {
    return manifest_status;
  }

  Status bundle_status = bundle_patcher.Apply(
      options.origin_bundle_path,
      options.bundle_patch_path,
      options.bundle_output_path);
  if (!bundle_status) {
    return bundle_status;
  }

  for (const CopyOperation& copy : options.manifest.copies) {
    Status copy_status = CopyFile(
        JoinPath(options.source_root, copy.from),
        JoinPath(options.target_root, copy.to),
        true);
    if (!copy_status) {
      return copy_status;
    }
  }

  if (!options.enable_merge) {
    return Status::Ok();
  }

  const std::string normalized_merge_subdir =
      TrimTrailingSlash(options.merge_source_subdir);
  const std::string merge_source_root =
      normalized_merge_subdir.empty()
          ? options.source_root
          : JoinPath(options.source_root, normalized_merge_subdir);
  const std::string merge_target_root =
      normalized_merge_subdir.empty()
          ? options.target_root
          : JoinPath(options.target_root, normalized_merge_subdir);

  DeleteMatcher deletes(options.manifest.deletes);
  Status dir_status = EnsureDirectory(merge_target_root);
  if (!dir_status) {
    return dir_status;
  }

  return MergeDirectoryRecursively(
      merge_source_root,
      merge_target_root,
      normalized_merge_subdir,
      deletes);
}

Status CleanupOldEntries(
    const std::string& root_dir,
    const std::string& keep_current,
    const std::string& keep_previous,
    int max_age_days,
    std::time_t now) {
  DIR* dir = opendir(root_dir.c_str());
  if (!dir) {
    if (errno == ENOENT) {
      return Status::Ok();
    }
    return MakeErrnoStatus("Failed to open cleanup directory " + root_dir);
  }

  const std::time_t effective_now = now > 0 ? now : std::time(nullptr);
  const std::time_t max_age_seconds =
      static_cast<std::time_t>(max_age_days) * 24 * 60 * 60;

  struct dirent* entry = nullptr;
  while ((entry = readdir(dir)) != nullptr) {
    const std::string name = entry->d_name;
    if (name == "." || name == ".." || (!name.empty() && name[0] == '.')) {
      continue;
    }
    if (name == keep_current || name == keep_previous) {
      continue;
    }

    const std::string entry_path = JoinPath(root_dir, name);
    struct stat st;
    if (stat(entry_path.c_str(), &st) != 0) {
      closedir(dir);
      return MakeErrnoStatus("Failed to stat cleanup path " + entry_path);
    }

    if (effective_now - st.st_mtime < max_age_seconds) {
      continue;
    }

    Status remove_status = RemovePathRecursively(entry_path);
    if (!remove_status) {
      closedir(dir);
      return remove_status;
    }
  }

  closedir(dir);
  return Status::Ok();
}

bool IsSafeRelativePath(const std::string& path) {
  if (path.empty()) {
    return false;
  }
  if (path[0] == '/' || path.find('\\') != std::string::npos) {
    return false;
  }

  const std::vector<std::string> segments = SplitPath(path);
  for (const std::string& segment : segments) {
    if (segment.empty() || segment == "." || segment == "..") {
      return false;
    }
  }
  return true;
}

Status HdiffBundlePatcher::Apply(
    const std::string& origin_bundle_path,
    const std::string& bundle_patch_path,
    const std::string& destination_bundle_path) const {
  if (!PathExists(origin_bundle_path)) {
    return Status::Error("Origin bundle not found: " + origin_bundle_path);
  }
  if (!PathExists(bundle_patch_path)) {
    return Status::Error("Bundle patch not found: " + bundle_patch_path);
  }

  const std::string parent = Dirname(destination_bundle_path);
  Status dir_status = EnsureDirectory(parent);
  if (!dir_status) {
    return dir_status;
  }

  if (PathExists(destination_bundle_path)) {
    Status remove_status = RemovePathRecursively(destination_bundle_path);
    if (!remove_status) {
      return remove_status;
    }
  }

  int result = hpatch_by_file(
      origin_bundle_path.c_str(),
      destination_bundle_path.c_str(),
      bundle_patch_path.c_str());
  if (result != 0) {
    std::ostringstream stream;
    stream << "Failed to apply bundle patch, hpatch error " << result;
    return Status::Error(stream.str());
  }
  return Status::Ok();
}

}  // namespace patch
}  // namespace pushy
