---
status: accepted
last_verified: 2026-08-13
---

# Unified Template System and Lightweight Authoring Reuse

AeonStagery uses versioned template packages as the shared distribution and authoring boundary for builtin, user, project, and future community templates. Template packages unify manifest loading, source precedence, asset resolution, character presets, dialogue styles, and semantic timeline presets without merging their runtime consumers into one service.

## Decision

The canonical package entry is `manifest.v2.json`. Normal discovery and loading reject unversioned or v1 manifests. Historical `manifest.json` input is accepted only by the explicit offline migration CLI.

A v2 manifest declares:

- `manifestSchemaVersion: 2`;
- template identity and version;
- `compatibility.sceneSchemaVersion: 4`;
- optional asset, character preset, dialogue style, and semantic authoring records.

Template sources are merged in this order, from highest to lowest precedence:

1. `project`
2. `user`
3. `builtin`

Multiple packages can be enabled. Within one scope, later entries in the explicit enabled-template list take precedence. UI consumers use the catalog's enabled merged view and display source metadata; they do not scan template directories themselves.

## Semantic Authoring Payloads

`authoringCombos` use one of three semantic payloads:

- `statementPreset`: one `SceneStatementDraft`;
- `dialoguePreset`: one dialogue draft plus attachable companions;
- `timelineFragment`: an ordered list of root statement drafts with relative times.

Example:

```json
{
  "manifestSchemaVersion": 2,
  "template": {
    "id": "default.semantic",
    "name": "Default Semantic",
    "version": "2.0.0",
    "compatibility": { "sceneSchemaVersion": 4 }
  },
  "authoringCombos": [
    {
      "id": "dialogue_focus",
      "name": "Dialogue Focus",
      "category": "dialogue",
      "payload": {
        "kind": "dialoguePreset",
        "dialogue": {
          "type": "dialogue",
          "params": { "text": "", "durationSeconds": 3 }
        },
        "companions": [
          {
            "type": "camera",
            "anchor": "start",
            "offset": 0,
            "params": { "mode": "focus", "target": "$speaker" }
          }
        ]
      }
    },
    {
      "id": "entrance_fragment",
      "name": "Entrance Fragment",
      "category": "character",
      "payload": {
        "kind": "timelineFragment",
        "statements": [
          {
            "time": 0,
            "type": "characterPresence",
            "params": { "mode": "enter", "id": "$character", "model": "figure/actor.model3.json" }
          },
          {
            "time": 0.2,
            "type": "characterPerformance",
            "params": { "target": "$character", "expression": "smile" }
          }
        ]
      }
    }
  ]
}
```

Template parsing resolves placeholders, relative time, companions, and portable resource references into materialized drafts. `buildTemplateAuthoringPreview()` returns those drafts and the exact semantic authoring intent that confirmation submits. Preview and commit must not independently parse the payload. Cancelling preview creates no authoring transaction.

Templates never emit `ActionType[]`, `DraftAction[]`, or compiled runtime actions. Applied templates materialize as ordinary `SceneDocumentV4` source facts; scenes do not retain a template id or depend on later template availability.

## Assets

Template-local paths may be used inside a package definition. When applied, resource references pass through the existing project resource and portability pipeline. Assets required for save, collaboration, or migration are projectized or validated by the existing readiness gates. Scene source continues to store project-relative or explicitly mounted references, not registry ids or content hashes.

The package loader may index assets, but renderer code, arbitrary scripts, resolver implementations, and plugins are not executable manifest content.

The file browser projects entrypoints from enabled packages into standard resource categories with template source labels. It combines explicit asset entries, declarative resource conventions, and character preset model variants, while hiding model dependencies. Selecting or dropping an entrypoint projectizes it through the existing template asset importer, including the complete Live2D bundle; failed imports do not submit template-local references.

## Consequences

- The builtin package is `src/templates/default/manifest.v2.json`; there is no product v1 fallback.
- `StatementBlockLibrary` consumes semantic combos from the enabled catalog view.
- `statementPreset`, `dialoguePreset`, and `timelineFragment` share strict semantic parsing and preview/commit materialization.
- Dialogue presets visibly disclose companions before insertion.
- Lightweight clipboard/snippet reuse remains separate from versioned template packages.
- Scene/project blueprints, automatic dialogue camera generation, community registry installation, and a package editor remain deferred.

## Verification

Acceptance is backed by manifest v2 loader/discovery tests, legacy payload rejection, scope precedence tests, placeholder and resource parsing tests, preview/commit identity tests for all three payload kinds, and the tracked-data guard that permits only the builtin v2 manifest.
