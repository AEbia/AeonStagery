---
status: superseded
implementation_status: requirements-reset
superseded_by: ADR-0029
---

# Live2D Parameter Animation Authoring

> Superseded for current product work by
> [Live2D 自定义 Motion 关键帧编辑需求](0029-live2d-custom-motion-keyframe-authoring.md).
> This ADR remains as history for the original post-runtime Parameter Clip design.
> Its runtime metadata, project-relative asset, collaboration-readiness, and schema
> migration constraints remain relevant where the newer requirements do not replace them.
> Superseding the Parameter Clip design does not change Motion import: `.mtn` and
> `.motion3.json` remain ordinary resources until the user explicitly runs “自定义动作”
> on a selected timeline Motion, which creates an editable scene-inline copy.

Custom Live2D action authoring means AeonStagery-authored parameter keyframe animation, not external Cubism motion or expression files. External `.mtn`, `.motion3.json`, `.exp`, and `.exp3.json` files remain resource-reference work and must not be conflated with this feature.

## Decision

Live2D parameter animation is modeled as a reusable or inline animation made of Cubism Parameter tracks:

- `Live2D Parameter Animation`: the authored animation data, containing one track per Cubism Parameter ID.
- `Live2D Parameter Clip`: one timeline instance of an animation, with duration, offset, speed, loop, weight, blend mode, and end behavior.
- `inline` clips live only inside the scene that needs them, for one-off staging such as a wave, touch reaction, or scene-specific interaction.
- `asset` clips reference a project-level animation resource. Existing clips follow the latest asset content by default; future revision pinning requires a separate decision.
- Inline clips can later be promoted to project assets, and asset clips can later be detached into scene-local inline copies.

The feature covers Cubism Parameters only. It does not include PartOpacity, drawable vertices, colors, render order, or external motion/expression file authoring.

Default clip behavior is:

- `endBehavior: "hold"` so the character keeps the final pose after the clip finishes.
- `blendMode: "override"` with `weight: 1`.
- Tracks only write parameters that are present in the custom animation. If a custom track includes a mouth parameter, it overrides lip sync for that parameter; if it omits mouth parameters, lip sync continues normally.
- Seek, preview, bake, and export must use the same pure evaluator so the same scene time produces the same parameter values.

## Runtime Boundary

Parameter enumeration and metadata belong behind the Live2D runtime adapter seam from ADR-0019. UI, source schema, and timeline authoring code must not inspect Cubism 2 private fields directly.

The adapter exposes runtime parameter metadata when available:

- Cubism 3/4/5 adapters should report ID, index, min, max, and default values from official SDK APIs.
- Cubism 2.1 must be supported first-class, but `.model.json` entries do not provide a complete parameter metadata list. Runtime enumeration is preferred. Sidecar metadata is allowed when range/default data cannot be obtained reliably.
- Cubism 2 known defaults may fill `defaultValue` for standard IDs only. The implementation must not invent `0..1` ranges for every parameter.

A local Cubism 2 template corpus was checked only for aggregate structure. Its model entry JSON shape had model, texture, motion, expression, physics, layout, and hit-area data, but no complete top-level parameter list. Do not treat model entry JSON as sufficient proof of "all parameters".

## Schema And Collaboration

The initial pure evaluator, runtime adapter metadata seam, and runtime-only preview session did not change `SCENE_SCHEMA_VERSION`.

Persisting parameter clips in scene JSON changes the source shape and observable compilation semantics, so it is introduced as scene schema v3. A v3 implementation must update:

- source types and strict codec parsing;
- compiler lowering and stable output keys;
- collaboration `sceneSchemaVersion` acceptance;
- template compatibility declarations;
- semantic migration inventory and tests.

Project-level parameter animation assets remain project-relative `animation` resources under ADR-0014 and ADR-0018. Collaboration must continue to use the asset readiness gate and manifest rules; parameter animation assets must not be converted implicitly to `assetId`, content hashes, or skipped short-resource-name aliases.

Project-level animation assets use a strict AeonStagery JSON envelope, not Cubism motion or expression files:

```json
{
  "schemaVersion": 1,
  "kind": "live2d-parameter-animation",
  "animation": {
    "id": "char-d-wave",
    "tracks": [
      {
        "parameterId": "PARAM_ARM_R",
        "keyframes": [{ "time": 0, "value": 0 }]
      }
    ]
  }
}
```

When an `asset` clip omits embedded `animation`, the semantic runtime preparation step reads this project-relative JSON and embeds the validated animation into the prepared runtime clip while keeping `source.path` as the traceable project asset reference.

## Consequences

- Runtime preview can apply a parameter clip without mutating scene source, history, dirty state, autosave, or collaboration state.
- "Apply to scene" or "Add to timeline" is the point where a future schema v3 source statement/field is created in one semantic transaction.
- Bake and export must not call a separate parameter-animation code path from playback.
- WMDL support must resolve which concrete model receives the parameter clip before applying values. Until then, single concrete Live2D model instances are the supported runtime target.
