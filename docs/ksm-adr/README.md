# KSM Architecture Decision Index

| ADR | Status | Decision |
|---|---|---|
| [KSM-0001](./ksm-0001-unified-template-system.md) | accepted | Versioned template packages and semantic preset payloads |
| [KSM-0003](./ksm-0003-semantic-scene-statements.md) | accepted | Semantic scene source, one-way compilation, and source-backed timeline authoring |
| [KSM-0004](./ksm-0004-contextual-short-resource-names.md) | draft | Contextual resource discovery, picker identity, and authoring-time materialization |
| [KSM-0005](./ksm-0005-live2d-performance-resources-and-parameter-curves.md) | draft | External Live2D performance resources and deterministic parameter curves |

`TODO.md` records intentionally deferred work. Historical scene/template conversion belongs to explicit scripts under `scripts/migrations`; ordinary product loaders only accept current versioned contracts.

## Notes And Archived Drafts

- [KSM-0002 Template UI Entry Points Draft](./ksm-0002-template-ui-entry-points-draft.md): archived first-pass product direction. Current implemented contract lives in `docs/en/template-system.md`, `docs/cn/template-system.md`, and KSM-0001.
- [Timeline Lifecycle Pairing Notes](./timeline-lifecycle-pairing-notes.md): current lightweight lifecycle start/end pairing notes related to KSM-0003. This file is intentionally not numbered as an ADR.
- [Timeline State-Span UX Notes](./timeline-state-span-ux-notes.md): obsolete historical State Span UX notes superseded by the lifecycle pairing notes. This file is intentionally not numbered as an ADR.
