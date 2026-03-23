#include "state_core.h"

namespace pushy {
namespace state {

BinaryVersionSyncResult SyncBinaryVersion(
    const State& state,
    const std::string& package_version,
    const std::string& build_time) {
  BinaryVersionSyncResult result;
  result.state = state;
  result.changed =
      state.package_version != package_version || state.build_time != build_time;
  if (!result.changed) {
    return result;
  }

  result.state.package_version = package_version;
  result.state.build_time = build_time;
  result.state.current_version.clear();
  result.state.last_version.clear();
  result.state.first_time = false;
  result.state.first_time_ok = true;
  result.state.rolled_back_version.clear();
  return result;
}

State SwitchVersion(const State& state, const std::string& hash) {
  State next = state;
  if (!state.current_version.empty() && state.current_version != hash) {
    next.last_version = state.current_version;
  }
  next.current_version = hash;
  next.first_time = true;
  next.first_time_ok = false;
  next.rolled_back_version.clear();
  return next;
}

MarkSuccessResult MarkSuccess(const State& state) {
  MarkSuccessResult result;
  result.state = state;
  result.state.first_time = false;
  result.state.first_time_ok = true;
  if (!state.last_version.empty() && state.last_version != state.current_version) {
    result.stale_version_to_delete = state.last_version;
    result.state.last_version.clear();
  }
  return result;
}

State ClearFirstTime(const State& state) {
  State next = state;
  next.first_time = false;
  return next;
}

State ClearRollbackMark(const State& state) {
  State next = state;
  next.rolled_back_version.clear();
  return next;
}

State Rollback(const State& state) {
  State next = state;
  const std::string rolled_back_version = state.current_version;
  if (state.last_version.empty()) {
    next.current_version.clear();
  } else {
    next.current_version = state.last_version;
    next.last_version.clear();
  }
  next.first_time = false;
  next.first_time_ok = true;
  next.rolled_back_version = rolled_back_version;
  return next;
}

bool ShouldRollbackForBrokenFirstLoad(const State& state) {
  return !state.first_time && !state.first_time_ok;
}

LaunchDecision ResolveLaunchState(
    const State& state,
    bool ignore_rollback,
    bool consume_first_time_on_launch) {
  LaunchDecision decision;
  decision.state = state;
  decision.load_version = state.current_version;
  if (decision.load_version.empty()) {
    return decision;
  }

  if (!ignore_rollback && ShouldRollbackForBrokenFirstLoad(decision.state)) {
    decision.state = Rollback(decision.state);
    decision.load_version = decision.state.current_version;
    decision.did_rollback = true;
    return decision;
  }

  if (!ignore_rollback && consume_first_time_on_launch && decision.state.first_time) {
    decision.state.first_time = false;
    decision.consumed_first_time = true;
  }

  return decision;
}

}  // namespace state
}  // namespace pushy
