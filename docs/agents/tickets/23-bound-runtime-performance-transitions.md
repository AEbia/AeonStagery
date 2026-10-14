# 23 — Transition performances and restore Seek through runtime behaviors

**What to build:** Stage, motion and Seek orchestration request complete performance transitions, frame submission and restoration without SDK clock/replay/focus internals.

**Blocked by:** 20 — Initialize and reset borrowed models through bound behaviors.

**Status:** done

Follow the parent specification in local ticket 19 and accepted ADR-0019 behavior-interface migration.

- [x] Bound performance transition owns preload, queue reset, handoff injection, expression intent and replay; checks current operation before mutations after awaits.
- [x] Runtime owns one shared Cubism 2 clock coordination mechanism; previews, restores, sampling and future Bake batches can use it without recursively acquiring the lock.
- [x] Bound frame input and custom-motion behaviors preserve writer ordering, injected ownership, lip-sync exclusion and one geometry commit per batch.
- [x] Runtime focus stop/pause/resume restores its updater while stage transform/container/rim tweens remain orchestration-owned.
- [x] Seek and snapshots preserve native Cubism 3+ offsets and zero-delta pose commit plus existing Cubism 2 no-clock and fixed-step guarantees.
- [x] Motion/Seek/custom-motion/focus/cancellation behaviors pass with the combined test and TypeScript check.

Verification: `npm run check` passed: 514 test files, 5,631 tests, and TypeScript. Focused runtime, seek, frame, focus, cancellation, expression-preview and motion suites passed: 12 files, 211 tests.

Implementation report: `.superpowers/sdd/live2d-performance-transitions-report.md` (workspace-only; do not commit).
