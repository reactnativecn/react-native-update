#pragma once

#include <string>

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace state {

struct State {
  std::string package_version;
  std::string build_time;
  std::string current_version;
  std::string last_version;
  bool first_time = false;
  bool first_time_ok = true;
  std::string rolled_back_version;
};

struct BinaryVersionSyncResult {
  State state;
  bool changed = false;
};

struct MarkSuccessResult {
  State state;
  std::string stale_version_to_delete;
};

struct LaunchDecision {
  State state;
  std::string load_version;
  bool did_rollback = false;
  bool consumed_first_time = false;
};

BinaryVersionSyncResult SyncBinaryVersion(
    const State& state,
    const std::string& package_version,
    const std::string& build_time);

State SwitchVersion(const State& state, const std::string& hash);

MarkSuccessResult MarkSuccess(const State& state);

State ClearFirstTime(const State& state);

State ClearRollbackMark(const State& state);

State Rollback(const State& state);

// The OS deleted the installed versions' files (tvOS purges Caches while the
// app is not running): they were not rejected, so unlike Rollback this leaves
// no rolled-back mark that would make the next check skip reinstalling them.
// An existing mark (a rollback earlier in this launch) is kept.
State ForgetPurgedVersions(const State& state);

bool ShouldRollbackForBrokenFirstLoad(const State& state);

LaunchDecision ResolveLaunchState(
    const State& state,
    bool ignore_rollback,
    bool consume_first_time_on_launch);

}  // namespace state
}  // namespace pushy

#pragma GCC visibility pop
