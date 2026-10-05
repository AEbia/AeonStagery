---
status: accepted
---

# Stable External Library Mount References

Scene source must not persist machine-local absolute paths. External libraries remain read-only local resources, but a scene refers to them through a stable registered-root-relative string:

```text
@mount/<mount-id>/<root-relative-path>
```

For example:

```text
@mount/example/figure/model.json
```

The user settings registry owns the local mapping from stable mount id to absolute root path. Replacing the path of an existing mount preserves its id, so scenes do not change when a library moves. Existing `externalLibraryPaths: string[]` settings are migrated once to descriptors shaped as `{ id, path }`; raw paths are not retained as a second source of truth.

## Decision

`ProjectResourceService` is the deep Module that owns mounted reference syntax and resolution. Its Interface accepts project-relative references, mounted references, and transient absolute picker results:

- storage normalization converts a registered external absolute path to `@mount/<id>/<relative-path>`;
- read/runtime resolution expands a mounted reference through the exact registered id and fails clearly when that id is unavailable;
- project-relative references retain the existing project-first lookup behavior;
- arbitrary or unregistered absolute paths are rejected for storage;
- collaboration preparation copies external assets into the active project and converts mounted references to project-relative transfer references before manifest/upload processing; Live2D entrypoints use the existing bundle-closure copy path.

Collaboration projection stores detached copies beneath the matching standard asset root, using `external/<mount-id>/...` as a visible namespace. For example, a mounted `background/room.png` becomes `background/external/<mount-id>/room.png`. Keeping the mount id in the project-relative transfer path prevents assets from different libraries with the same root-relative path from overwriting each other or project-authored files. Live2D bundle-relative paths remain unchanged beneath the namespace.

`SceneAssetService` remains an Adapter at the scene asset Seam. It must not undo storage normalization by restoring the picker absolute path. `SceneStatementCompiler` may inherit a character model reference from `meta.characters`, but it treats the reference as opaque source data. `RuntimeAssetPreparer` and `ProjectResourceService` remain responsible for producing the machine-local runtime URI.

The source codec validates mounted references as portable strings. It does not read user settings or the filesystem. Missing mount registration and missing files are readiness/runtime resolution errors, not source parser guesses.

## Compatibility And Migration

- Existing settings path arrays are deterministically assigned mount ids and rewritten in the canonical settings shape on the next settings save.
- Existing absolute character metadata references under a registered external root are normalized to mounted references when detached semantic source normalization runs. Absolute statement asset fields remain codec errors and require the explicit migration path because source validation runs before compilation.
- Existing absolute references outside the project and registered mounts fail with an actionable error; runtime does not keep a permanent absolute-path compatibility layer.
- Explicit `copy` import continues to projectize assets and stores ordinary project-relative references.

ADR-0014 continues to govern collaborative scene references. Mounted references are a local authoring source form, not a collaborative transfer path: collaboration preparation first copies every external asset into the active project, then creates a detached project-relative document before manifest construction and publishes that document with the existing project-relative manifest/source form. Live2D models copy their complete bundle closure. The local authoring document keeps its mounted references. This ADR narrows ADR-0014 only for non-collaborative local source authoring.

## Consequences

- Moving or rebinding a library changes one user setting instead of every scene.
- Two libraries containing the same relative path no longer depend on root search order for mounted references.
- A collaborator or second machine receives a precise missing mount id instead of a stale username or drive path.
- Mount ids become persistent identities. Removing and recreating a mount with a different id is a source-visible change; replacing its path is not.
- Project-level mount declarations may be added later, but only through an explicit project metadata authoring Seam. `ProjectResourceService` must not silently write `project.json` behind `ProjectSession`.
