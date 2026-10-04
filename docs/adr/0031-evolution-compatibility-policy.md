---
status: accepted
last_verified: 2026-08-18
implementation_status: implemented
---

# Evolution Compatibility Policy

AeonStagery currently versions each persisted surface independently. Scene loading is a strict v4 contract with one explicit v3-to-v4 migration, template manifests require v2 and scene v4, collaboration requires an exact wire/schema match, while `project.json` has a `projectVersion` field without a canonical validation or migration policy. This ADR develops one product-level compatibility policy across those surfaces without treating today's strict loaders as the intended end state.

This decision records the compatibility design confirmed during the design session. Until it is implemented, the current loader contracts in KSM-0001, KSM-0003, and the collaboration ADRs remain authoritative.

## Confirmed Language

**Evolution Compatibility (演进兼容)**:
The product-level ability to evolve persisted authoring formats without unexpectedly making durable user work unavailable or silently destroying information. It is the umbrella policy; it must not be used as a synonym for either read direction.

**Backward Read Compatibility (向后读取兼容)**:
A newer reader can consume data written against an older contract, either directly or through a supported migration.

**Forward Read Compatibility (向前读取兼容)**:
An older reader can safely admit data written against a newer contract. Admission does not imply that it can execute or edit every newer construct.

**Unknown-Data Round-Trip Fidelity (未知数据往返保真)**:
A reader that does not understand part of an admitted document can write the document again without silently deleting or rewriting that unknown information. This promises semantic data preservation, not yet byte-for-byte JSON preservation.

**Durable Authoring Asset (持久化创作资产)**:
User-authored project metadata, semantic scene source, user resources, and the stable references that connect them. These are the compatibility promise's primary protected assets because a user cannot reliably reconstruct them from caches or runtime projections.

_Avoid_: using cache, generated runtime state, or every internal persistence record as though it carried the same product compatibility promise.

**Schema Epoch**:
A version interval within which additive format evolution may remain mutually admissible. A new reader supports deterministic migration from the immediately preceding epoch; older epochs may require chained offline migration.

_Avoid_: release version, application version

**Artifact Contract**:
The independently versioned persisted contract owned by one durable artifact, such as project metadata or a Scene Document. Its schema and compatibility requirements evolve with the facts it owns rather than with the application release.

**Project Compatibility Envelope**:
A project-level projection that summarizes the Artifact Contracts and compatibility requirements needed for fast admission checks. It is never authoritative and must be reproducible from the artifacts it describes.

**Unknown Field**:
A property name that the current reader does not recognize inside an otherwise recognized construct. A known discriminator property carrying an unknown value is not an Unknown Field; it is an Unknown Discriminator.

**Unknown Discriminator**:
An unrecognized value in a property that selects a construct's family, mode, or shape. It cannot be reduced to an ignorable field because the reader does not know which contract governs the selected construct.

**Compatibility Source**:
The complete JSON value tree retained for a durable artifact, including Unknown Fields. It is the authoritative persistence fact used for round-trip serialization.

**Typed Projection**:
The validated, understood view derived from a Compatibility Source and consumed by authoring, compilation, and runtime preparation. For scenes, this is the role currently filled by `SceneDocumentV4`; it does not independently own Unknown Fields.

**Compatibility Coordinator**:
The shared deep module that owns artifact admission, migration workflow, backup gating, and compatibility outcomes without knowing any artifact's concrete schema.

**Artifact Compatibility Adapter**:
An adapter at the Compatibility Coordinator seam that owns one Artifact Contract's parse, Typed Projection, reconciliation, canonical writing, and migration knowledge.

**Compatible Artifact Session**:
The editing-session state that keeps a Compatibility Source, its Typed Projection, and their history together. `CompatibleSceneSession` is the scene-specific instance; `DocumentStore` remains a typed read model rather than the owner of persistence facts.

**Compatibility Outcome**:
The Compatibility Coordinator's discriminated result: `ready`, `migration_required`, `incompatible`, or `invalid`. Expected compatibility states are data for callers to handle, not string exceptions.

## Confirmed Product Boundary

- The first consumer is the desktop application opening local projects across releases.
- The primary protected set is durable authoring assets. AI drafts and Agent journals may have migrations but do not receive an indefinite product guarantee; caches are excluded. External-tool contracts and mixed-version collaboration are governed separately.
- The compatibility window combines additive evolution within one schema epoch with new-reader migration from the immediately preceding epoch. It does not promise that every old application can directly edit every future construct.
- When compatibility goals conflict, the priority is: no silent loss of unknown authored data, then ability to open the project, then editability, then exact rendering equivalence.
- A reader may degrade capability rather than invent semantics, except that same-epoch Unknown Fields are deliberately allowed to affect behavior without a warning when an old reader ignores them.
- Each durable artifact owns its Artifact Contract. A Project Compatibility Envelope may summarize those contracts for preflight, but it is a validated projection rather than a second version authority.
- The product does not promise export to an older epoch or compatibility profile. Evolution compatibility is provided by admission, preservation, and supported new-reader migration rather than downgrade generation.
- Within one Schema Epoch, readers admit Unknown Fields, omit them from the understood typed view, and preserve them for round-trip output instead of requiring exact schema equality. The artifact remains editable and executable, and ignored fields do not produce a compatibility warning even when a newer writer intended them to affect behavior.
- An unknown statement family or Unknown Discriminator is a hard incompatibility: the application rejects opening the Scene Document rather than preserving it as an opaque node or exposing a partial read-only view.
- Ordinary edits retain the document's existing minimum compatible shape. Saving does not emit newly available fields or defaults unless the user's edit actually requires that newer construct.
- Each admitted artifact retains its complete Compatibility Source. Its Typed Projection is derived for known authoring and runtime behavior; serialization reconciles known changes back into the Compatibility Source instead of reconstructing the artifact solely from the projection.
- An Unknown Field follows its owning source entity. Known-field edits, movement, and reordering preserve it; deletion removes it with its owner; duplication copies it; changing an entity to another family removes the prior family's unknown subtree.
- A change to observable compilation or runtime semantics for an unchanged JSON shape requires a new Schema Epoch. This proposal does not introduce a separate semantic-profile version axis.
- Compatibility workflow is centralized in a Compatibility Coordinator with artifact-specific Artifact Compatibility Adapters. Schema knowledge does not accumulate in the coordinator, and loaders do not independently reimplement compatibility policy.
- A Compatible Artifact Session owns both compatibility and typed state across authoring transactions, undo, redo, and save. File services do not retain a hidden source sidecar, and save does not reread the original file to reconstruct unknown data.
- Raw Script replacement replaces the complete Compatibility Source. Unknown Fields explicitly removed there stay removed; only typed authoring automatically preserves fields outside its understood projection.
- Canonical writers emit the minimum fields needed to express a newly authored intent. They do not serialize every current default or persist an application-version target.
- A missing or stale Project Compatibility Envelope is rebuilt from the authoritative artifacts and refreshed on the next project save. Staleness alone is not project corruption.
- `ProjectMetadata.projectVersion` is the Project Metadata Schema Epoch. It is not an application release, a user-visible content revision, or an optimistic-concurrency counter; project metadata loading must validate and route on it.
- Compatibility Coordinator inspection returns a Compatibility Outcome. `migration_required` carries an available migration plan, `incompatible` identifies a well-formed unsupported contract, and `invalid` identifies malformed data; callers do not recover those distinctions from error text.
- A scene whose Compatibility Source contains any Unknown Field cannot enter the current exact-version collaboration system. Collaboration requires a fully canonical scene until a separate wire design can preserve the Compatibility Source end to end.
- Because Project Metadata changes infrequently, a supported Project Metadata Schema Epoch migration is automatic rather than gated by the scene migration confirmation flow.
- The Project Compatibility Envelope is persisted as `project.json.compatibility`. It remains a projection: loaders validate it against the referenced artifacts, rebuild it when missing or stale, and refresh it on project save.
- Saves retain the existing last-writer-wins file behavior. Compatible Artifact Sessions do not hash or reread files before writing and do not merge external modifications; the no-silent-loss guarantee excludes changes made by another process after the session opened its Compatibility Source.
- A supported Project Metadata migration runs against a detached copy, validates the result, and then immediately overwrites `project.json` without a backup or user confirmation. A failed migration or validation leaves the file untouched.
- A missing `projectVersion` enters automatic migration only when an adapter recognizes a specific legacy shape. A known older epoch enters automatic migration, a future epoch is `incompatible`, and a malformed version or structure is `invalid`; loaders never assume that a missing value means the current epoch.
- `project.json.compatibility` contains its own `schemaVersion` and, for each scene, the path, scene Schema Epoch, source hash, and Unknown Field presence. The hash detects a stale envelope during project admission; it is not an optimistic write precondition.
- Scene v5 is the first compatibility-aware Scene Document epoch. All v5 readers must implement Unknown Field preservation and the admission behavior in this ADR; v4 readers remain governed by KSM-0003's strict contract.
- The v5 cutover makes one explicit exception to the general immediate-previous-epoch window: the product supports automatic migration from both scene v4 and the development-era scene v3. This exception is limited to the v5 cutover; v1, v2, and unversioned scenes still require offline migration.
- Project Metadata v2 is the first compatibility-aware Project Metadata contract. Existing `projectVersion: 1` metadata is automatically migrated under the policy above.
- Collaboration wire v3 is paired with scene v5 and requires `sceneSchemaVersion = 5`. Wire v2 remains the exact scene v4 contract; changing its embedded scene version in place is forbidden.
- Template manifests remain at manifest schema v2. A v5 reader accepts semantic template payloads targeting scene v4 or v5, strictly validates v4 payloads, and materializes them as canonical v5 facts. Legacy action payloads remain unsupported.
- Collaboration v3 servers do not migrate persisted v2 rooms. An administrator must use the v2 system to export a scene v4 snapshot, migrate that snapshot through the normal v4-to-v5 scene flow, and seed a new v3 room. The original v2 room remains untouched; collaborative order/tombstone history beyond the materialized scene is not carried into v3.

## Confirmed Scene Migration Experience

When opening a Scene Document that requires a supported migration, the application first creates a backup of that scene. It then asks the user to confirm an in-place upgrade. Declining the upgrade leaves the original scene unchanged and cancels opening it.

Compatibility migration backups contain the affected Scene Documents only. A compatibility migration is therefore a pure `Scene Document -> Scene Document` transformation and must not mutate project metadata, resources, or resource references through side effects. Changes to those other artifacts require an independently governed operation.

The v3-to-v5 path composes the existing deterministic v3-to-v4 transform with the new v4-to-v5 transform. The coordinator backs up the original v3 scene once, asks for confirmation once, validates every detached stage, aggregates warnings from both stages, and writes only the final v5 scene. Failure at either stage leaves the original file untouched.

## Current Implementation Baseline

This is evidence about the starting point, not the target policy:

- `SceneDocumentCodec` accepts scene v4, explicitly migrates v3, and otherwise strictly rejects future versions, unknown keys, and unknown statement families.
- Template manifest v2 requires scene schema v4, but its treatment of unknown fields is not uniformly as strict as the scene codec.
- Collaboration wire v2 and scene v4 require exact matching; mixed-version collaboration is rejected.
- `ProjectMetadata.projectVersion` is normalized and persisted but does not currently select a validator or migrator.
- Historical scene/template converters under `scripts/migrations` are offline tools, not a runtime compatibility layer.

## Implementation And Acceptance

Implementation proceeds as two vertical slices. The scene slice first proves Compatibility Source retention, Typed Projection, reconciliation, scene migration, and the `CompatibleSceneSession` interface. The project metadata slice then proves `projectVersion` routing and Project Compatibility Envelope rebuilding. Only after both concrete adapters exist are their genuinely shared admission and migration responsibilities extracted into the Compatibility Coordinator.

Compatibility is accepted through contract tests at module interfaces rather than through implementation-level unit tests. The required matrix covers Unknown Fields at the scene root, metadata, statement, params, companion, and nested recognized constructs; known-field edit, move, reorder, deletion, duplication, family replacement, undo, redo, Raw Script replacement, and save; every Compatibility Outcome; migration failure without disk mutation; project envelope rebuilding; and rejection at the collaboration gate. Assertions compare serialized artifact facts. A focused UI e2e test covers scene backup, confirmation, in-place upgrade, and decline-to-cancel-open.

## Relationship To KSM-0003

KSM-0003's "Reopened Compatibility Design" proposes source-derived capabilities, syntax revisions, and semantic profiles, but explicitly marks that section unaccepted. This decision does not adopt capability-based same-epoch admission: scene v5 uses Unknown Field tolerance for recognized constructs and hard rejection for unknown families or discriminator values. Until this ADR is implemented, KSM-0003's strict scene v4 and exact-match rules remain the implemented contract.

KSM-0003's statement that `SceneDocumentV4` is the sole source fact remains true inside semantic authoring and compilation: no compiled or prepared runtime state may write back into it. This ADR adds a persistence-level Compatibility Source around that typed semantic projection solely to retain fields the current reader cannot represent. It does not restore `decompile()` or make runtime state authoritative.
