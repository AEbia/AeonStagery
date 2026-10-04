---
status: implementation-notes
related_adr: KSM-0003
last_updated: 2026-07-24
supersedes: docs/ksm-adr/timeline-state-span-ux-notes.md
---

# Timeline Lifecycle Pairing (lightweight)

State Span is **not** a timeline object. Lifecycle enter/exit (set/remove, play/stop, …) remain **ordinary source statements** and **ordinary track blocks**. Pairing exists only for:

- select/hover highlight of the peer statement
- weak relationship line (`pointer-events: none`)
- blank-menu end commands and target binding
- Inspector peer jump

## Pairing algorithm

Module: `src/ui/timeline/lifecyclePairing.ts`

- Group by `lifecycleTypeKey + stateKey`, order by `(time, statementOrder)`.
- Replacement / last-writer with `supersededAt`:
  - A later same-key start supersedes an unpaired earlier start.
  - Ends pair with the latest eligible unpaired start whose window still contains the end.
- Statuses: `paired | open | superseded-open | orphan-end`.

Queries:

| API | Use |
|-----|-----|
| `listEndableLifecyclesAt(T)` | Blank-menu **end** commands only (`open` / `superseded-open` in window) |
| `listActiveLifecycleWindowsAt(T)` | Target binding for transform/modulate (includes **paired** until peer end) |

## Ending a lifecycle

- Entry: blank track context menu at **pointer time** (`BlankContextMenu` + `StatementBlockLibrary`).
- Internal helper: `insertLifecycleEndCommand` / `insertLifecycleEndFromMenu`
  - Emits existing `insert-statement` intents only (no new public authoring intent).
  - Draft = block `createDraft` defaults + materialize target from start.
  - Re-resolves in transaction; stale → no-op + toast.
  - Does **not** move existing ends.
  - Free orphan end inserts are blocked when the block is a lifecycle end command.

## Presentation

- Lifecycle boundaries use PR-style transition band + fixed pixel pad (`lifecycleBoundaryPresentation.ts`).
- Pad is presentation-only (lane/hit footprint); not semantic overlap / scene-end / compiler.
- Body drag moves statement time; transition-edge resize edits transition duration when registry declares a field.
- Timeline scrubber length uses real statement extents only (`timelineMaxTime.ts`) — never derived State Span ends.

## Explicit non-goals

- No Auto | Endpoint | Span preferences
- No derived end / next-state projection bodies
- No aggregate StateSpan selection or cascade dependency ownership
- No scene source schema change

## Related code

- `lifecyclePairing.ts`
- `insertLifecycleEndCommand.ts`
- `lifecycleTargetBinding.ts`
- `lifecycleBoundaryPresentation.ts`
- `timelineMaxTime.ts`
