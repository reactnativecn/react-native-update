#pragma once

// Single source of truth for the state-machine operation codes shared across
// the platform glue layers (Android JNI in update_core_android.cpp and
// HarmonyOS NAPI in pushy.cpp). The integer values MUST stay in sync with the
// callers on each platform:
//   - Android:  UpdateContext.java (STATE_OP_* constants)
//   - HarmonyOS: UpdateContext.ts  (StateOperation usage)
// Do not renumber existing entries; only append new ones.

namespace pushy {
namespace state_ops {

enum class StateOperation {
  kSwitchVersion = 1,
  kMarkSuccess = 2,
  kRollback = 3,
  kClearFirstTime = 4,
  kClearRollbackMark = 5,
  kResolveLaunch = 6,
};

}  // namespace state_ops
}  // namespace pushy
