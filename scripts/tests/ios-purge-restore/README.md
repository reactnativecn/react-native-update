# Deterministic native purge-restore ordering tests

Follow-up to #646. These tests exercise the tvOS Release branch of the real
`RCTPushy.mm` startup/commit/reset code in a macOS Foundation-only executable.
There are no production code changes, React Native mocks to install, CocoaPods,
simulator builds, network requests, or sleeps.

## Run

On macOS with Xcode command-line tools and Python 3.10+:

```sh
bash scripts/test-ios-purge-restore.sh
SANITIZE=1 VERIFY_REGRESSIONS=1 bash scripts/test-ios-purge-restore.sh
# Run just one ordering:
bash scripts/test-ios-purge-restore.sh reset_wins
```

The `test` workflow runs the sanitized suite and negative controls on macOS.
The extractor's own tests also run independently on Linux/macOS:

```sh
python3 -m unittest discover -s scripts/tests/ios-purge-restore -p test_extract.py
```

## Production code, not a second state machine

`extract.py` reads the checkout's `ios/RCTPushy/RCTPushy.mm` on every build. It
copies the exact definitions (with `#line` locations) of `bundleURL`,
`resolveLaunchBundleURL`, `restorePurgedLaunch`, `commitRoundWithGeneration`,
`resetToPackagedBundle`, their state/defaults helpers, and the relevant globals
into build-only `.inc` files. These are compiled unchanged with the actual
`cpp/patch_core/state_core.cpp`.

Extraction ignores braces in comments and literals, skips forward declarations,
and rejects missing or duplicate definitions. No generated implementation is
checked in. A source change that no longer fits the test host fails extraction
or compilation instead of silently testing a stale copy.

The host replaces only collaborators: React Native export/logging plumbing,
application paths/configuration, defaults storage, network round delivery,
cold-start scheduling, the launch wait's return value/completion delivery, and
post-reset filesystem cleanup. Bundle-existence checks use real temporary files.
The production state lock is real; every defaults mutation asserts ownership of
that same `os_unfair_lock`.

## Orderings

| Test | Enforced ordering | Assertions |
| --- | --- | --- |
| `late_commit` | Request captures generation; wait times out and closes window; only then release response/commit | Packaged bundle stays selected; round may cache its response/metadata for JS but cannot activate B or add `purgeRestore` |
| `commit_before_signal` | Commit activates B; completion signal is held; wait reports timeout; launch re-resolves; release signal | B actually launches; state/URL/running identity agree; first-load protection is armed and `purgeRestore` is recorded |
| `reset_wins` | Pause reset inside the real state lock; start stale commit; release reset | Old generation rejects **all** commit writes: no current/last version, version metadata or response cache; install UUID survives |
| `commit_wins` | Pause commit inside the real state lock; start reset; release commit | Earlier commit succeeds, then reset clears its state, metadata and cache; a delayed done signal cannot restore it |
| `complete_in_time` | Commit and done signal both arrive before wait returns | Normal successful restore still launches B with first-load protection |

A real GCD worker captures the request generation and blocks at a controlled
response boundary. Semaphores establish each ordering. Reset races are exercised
in both legal lock orders, with one operation paused while it owns the lock and
the competing operation started on another thread. Five-second waits are only
fail-fast deadlock guards, never timing assumptions. The launch wait itself is
injected, so the tests do not spend 12 seconds per case. They still assert that
production requests a 12-second (not 13-second) wait budget.

## Negative controls

`VERIFY_REGRESSIONS=1` additionally compiles three generated-only mutants:

- Remove the closed-window activation veto: `late_commit` must fail.
- Return `NO` after timeout instead of re-resolving: `commit_before_signal` must fail.
- Remove the reset-generation guard: `reset_wins` must fail.

Each mutant must compile and fail its specific state assertion; unrelated
compiler errors, crashes or deadlock-guard failures do not count as detection.
The mutants never modify the checkout's production source.

## Scope

These are native orchestration regression tests, not tvOS device E2E tests. They
do not validate NSURLSession idle-timeout behavior, actual cache purging, update
download/unzip/diff pipelines, React Native bridge creation, or physical-device
watchdog limits. Existing E2E tests and device validation remain complementary.
