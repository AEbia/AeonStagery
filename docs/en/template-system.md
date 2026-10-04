# Template System

AeonStagery templates are JSON manifest packages. A template package can provide reusable authoring combos, character presets, dialogue styles, visual presets, assets, and project defaults.

This document describes the implemented contract. Architecture decisions live in `docs/ksm-adr/ksm-0001-unified-template-system.md` and `docs/ksm-adr/ksm-0003-semantic-scene-statements.md`; deferred product work is tracked in `docs/ksm-adr/TODO.md`.

## First Version Scope

The first template-system version covers these flows:

- Discover built-in, project, and external-library template packages.
- Enable and order template packages during project creation and from an open project.
- Import template ZIP packages directly from both `ProjectHome` and the `SettingsDialog` "项目模板" tab.
- Merge only enabled template packages, using `project > user > builtin` and enabled-order precedence.
- Resolve template-suggested defaults with user overrides.
- Materialize resolved dialogue styles into newly authored semantic statements; deferred camera and lighting preset selectors are omitted from the configuration UI to avoid exposing unassigned runtime capabilities.
- Select initial character presets and variant import mode during project creation.
- Import selected template characters into an open scene (materializing into `SceneDocumentV5`).
- Copy selected Live2D model assets into the project when applying character presets.
- Expose template authoring combos in the timeline insert menu with source metadata.
- Create and edit AI performance templates in the `SettingsDialog` "项目模板" tab, including character IDs, aliases, and Motion/Expression semantics. Template IDs, performance profile IDs, and profile names are managed internally and omitted from the editor.

Performance templates first match scene characters by exact character ID. When IDs differ, template aliases match scene character names after Unicode normalization, trimming, and case folding; matching is exact, never fuzzy. Legacy `canonicalName` values become aliases during loading. Newly saved characters use only IDs and aliases.

With a project open, the editor displays matched character names, unmatched roles, or matching conflicts using the current scene characters and enabled templates. Results update immediately when IDs or aliases change. Multiple equal-rank candidates for a scene character, or multiple scene characters for one template role, appear as conflicts.

Deferred capabilities are tracked in `docs/ksm-adr/TODO.md`.

## Package Layout

Product template manifests use schema v2. Built-in templates are shipped from `src/templates/default/manifest.v2.json`.

Naming is intentionally asymmetric:

- `src/templates/` is plural because it is an application-bundled collection of template packages.
- `template/` is singular inside project and external library roots because it reuses the existing project asset root `assetRoots.template = "template"`.

Project and user templates are discovered from library roots:

```text
<project root>/template/<package>/manifest.v2.json
<external library root>/template/<package>/manifest.v2.json
```

`<root>/template/manifest.v2.json` is also accepted as a single package rooted directly at `template/`. Normal discovery does not load legacy `manifest.json` files; migrate them explicitly:

```bash
npm run migrate:template-v2 -- /path/to/template/package
```

The command creates `manifest.v2.json` in the package root and leaves the legacy manifest as migration input. A same-named PWA `manifest.json` at the root of a web application or WebGAL package is not an AeonStagery template manifest.

Discovery assigns scope by root:

- `project`: packages under the active project's `template/` directory.
- `user`: packages under external library roots.
- `builtin`: packages shipped with the app.

## Precedence

Merged template views include only packages listed in `templates.enabledTemplateIds` when project configuration is present. Enabled packages then use this precedence:

```text
project > user > builtin
```

Within the same scope, project metadata controls enabled order:

```json
{
  "templates": {
    "enabledTemplateIds": ["mygo", "mujica"]
  }
}
```

Later entries win conflicts, so `mujica` overrides `mygo` when both define the same record id.

The desktop app saves edits to app-bundled and ordinary external templates in one local template library; project-local templates are written back to their project package. A local package with the same template ID overrides app-bundled and ordinary external-library packages, while a project-local package with that ID remains highest priority. The UI presents one merged template and does not separate built-in and user templates.

## Manifest Format

The manifest format is JSON. Required fields:

```json
{
  "manifestSchemaVersion": 2,
  "template": {
    "id": "mujica",
    "name": "Ave Mujica",
    "version": "1.0.0",
    "compatibility": {
      "sceneSchemaVersion": 5
    }
  }
}
```

The manifest schema remains v2 (`manifest.v2.json`), but accepts payloads targeting either scene schema 4 or 5. Admitted payloads are validated and materialized into canonical facts under the active `SceneDocumentV5` epoch.

Supported top-level capability fields:

- `defaults`
- `assets.index`
- `characterPresets`
- `authoringCombos`
- `dialogueStyles`
- `performanceProfiles`
- `visualRecipes`
- `sceneBlueprints`
- `lightingPresets`
- `environmentPresets`
- `cameraPresets`
- `textLayerStyles`
- `audioPresets`
- `exportPresets`

Every mergeable record must have a stable string `id`. Unknown fields are preserved for generic presets, so UI and runtime adapters can evolve without changing the loader first.

## Image dialogue styles

`glass`, `minimal`, and `classic` remain built-in renderers. A package that only replaces the textbox and namebox should use the controlled `image-dialogue-v1` renderer, not CSS, TSX, or executable scripts.

Use the plural `assets/` package directory. Put dialogue UI images in `assets/ui/dialogue/` and fonts in `assets/fonts/`. Manifest references are relative to `assets.root`, for example `ui/dialogue/textbox.png` and `fonts/dialogue.ttf`. The Chinese guide contains a complete manifest example.

`nineSlice` uses left, top, right, bottom order; without it the image is scaled as a normal Sprite. Saving the template configuration copies its UI and font files into project-owned assets. The resolved presentation is applied to newly authored dialogue by default. Existing scenes do not change automatically when a package is updated or disabled, but authors can switch an existing dialogue manually with the **Dialogue box style** control in its Inspector. A `fontFile` must have a stable `fontFamily`.

## Characters

Character presets support multiple model variants under one role. This is the preferred shape for a character with multiple costumes, outfits, or model versions:

```json
{
  "characterPresets": [
    {
      "id": "tomori",
      "name": "Tomori",
      "speakerColor": "#8db7ff",
      "variants": [
        {
          "id": "school",
          "name": "School Uniform",
          "model": "assets/characters/tomori/school.model3.json"
        },
        {
          "id": "stage",
          "name": "Stage Outfit",
          "model": "assets/characters/tomori/stage.model3.json"
        }
      ]
    }
  ]
}
```

When a preset is selected during project creation, it is written into the initial scene's `meta.characters`. The first variant becomes the character's default `model` when the preset does not provide an explicit `model`, and all variants are preserved as the character's `variants`.

Selected character model files are imported into the new project during project creation. For Live2D models, the importer copies the model JSON and referenced bundle dependencies so the initial scene does not depend on the original template package path at runtime.

## Authoring Combos

Authoring combos become insertable timeline templates. Schema v2 uses a semantic scene `payload`, or a package-local JSON file containing a `payload`:

```json
{
  "authoringCombos": [
    {
      "id": "dialogue_push",
      "name": "Dialogue Push",
      "category": "dialogue",
      "payload": {
        "kind": "timelineFragment",
        "statements": [
          {
            "type": "camera",
            "params": {
              "mode": "move",
              "zoom": { "kind": "delta", "value": 0.25 },
              "durationSeconds": 1.2
            }
          },
          {
            "type": "dialogue",
            "params": { "text": "Dialogue", "durationSeconds": 3 }
          }
        ]
      }
    }
  ]
}
```

Only combos with a valid semantic `payload` are exposed as timeline templates. Legacy `actions` must be converted with the migration command and are not accepted by product discovery.

## Assets

The asset browser's **Files** view and the timeline's **File resources** list include resources from templates enabled in the current project, with a template source label. Models appear under `figure/`; backgrounds, music, voices, sound effects, images and animations appear in their corresponding categories, preserving directory nesting. Entrypoints come from `assets.index`, `resourceConventions`, and character presets including every model variant. Indexed paths are relative to `assets.root` (default `assets`); preset model paths retain their package-root-relative convention.

Model dependencies such as textures, motions and expressions are not listed independently. Selecting or dropping a template file copies it into the project, including the full dependency bundle for models, and stores a project-relative scene reference. Project and enabled-template changes refresh the list automatically; **Refresh file resources** rescans it manually. Disabling a template does not delete files already imported into the project.

Template assets are indexed with package-relative paths:

```json
{
  "assets": {
    "root": "assets",
    "index": [
      {
        "id": "mujica_logo",
        "kind": "image",
        "label": "Mujica Logo",
        "path": "assets/logo.png"
      }
    ]
  }
}
```

Asset resolution rejects paths that escape the package root.

## Project Metadata

Template packages can suggest project defaults:

```json
{
  "defaults": {
    "dialogueStyleId": "glass"
  }
}
```

Defaults are resolved in this order:

```text
built-in defaults -> enabled template defaults by precedence -> user overrides
```

`project.json` stores enabled templates, selected capabilities, and only user overrides:

```json
{
  "templates": {
    "enabledTemplateIds": ["aeonstagery.default"],
    "defaults": {},
    "selectedCharacterPresetIds": []
  }
}
```

If a user manually changes a default selector, that selector is saved under `templates.defaults` and will not be silently overwritten by later template changes.

Supported default selectors:

- `dialogueStyleId`
- `lightingPresetId`
- `environmentPresetId`
- `cameraPresetId`
- `textLayerStyleId`
- `audioPresetId`
- `exportPresetId`

Older projects without `templates` are normalized to the built-in default configuration when opened.

## Current UI Integration

The timeline blank-context menu reads authoring combos through `TimelineAuthoringService.getAvailableTemplates()`. That service refreshes package discovery when project or external library roots change.

Project creation is shown as a fullscreen onboarding surface (`ProjectHome`). Its primary creation page handles project name, location, template package enablement and order, and provides a direct entry point for importing template ZIP packages. Users can open a separate Template Capability Config view from that page for capability-level choices.

The current Template Capability Config implementation supports initial character selection and costume import mode (fast import for default costume only vs full import for all costumes). During project creation, it writes selected preset ids into `selectedCharacterPresetIds`, seeds the initial scene character directory, and imports selected character assets into the new project.

The Template Capability Config exposes a default dialogue style selector. The displayed value is resolved from built-in defaults, the highest-priority enabled template default, and finally any user override. The UI shows whether the value is built-in, template-provided, or user-overridden, and a user override can be reset back to the template default. Deferred camera and lighting preset selectors are omitted from the configuration UI to avoid exposing unassigned runtime capabilities.

In an open project, the TopBar interface is kept streamlined, and template management is hosted in `SettingsDialog` under the "项目模板" (`templates`) tab. In this tab, users can:
1. Import new template ZIP packages (installed directly into the local application template library with an immediate discovery refresh);
2. Manage template package enablement and precedence order for the open project;
3. Configure default dialogue styles and import selected template characters into the open scene (copying model assets, preserving variants, and persisting into the current `SceneDocumentV5`);
4. Create and edit AI performance profiles (`TemplatePerformanceProfileEditor`).

Scene blueprint, template asset calls, environment, text, audio, and export preset application are represented in the manifest and project metadata contracts, but their user-facing application flows are intentionally deferred.

## Implementation Entry Points

- Manifest parsing: `src/services/template-package/TemplatePackageManifest.ts`
- Package loading and merge precedence: `src/services/template-package/TemplatePackageLoader.ts`
- Package discovery: `src/services/template-package/TemplatePackageDiscovery.ts`
- Project metadata: `src/api/types/project.ts`
- Project creation persistence: `src/services/io/ProjectResourceService.ts`
- Authoring registry integration: `src/services/timeline-authoring/TimelineAuthoringService.ts`
- Timeline template UI entry: `src/ui/StatementBlockLibrary.tsx`

## Voice Profiles

The unified template package may declare typed `voiceProfiles[]`. A `characterPresets[]` entry selects a default with `voiceProfileId`. Models use logical selectors (`fileName` and optional `relativePathSuffix`), while reference audio must point to stable IDs in `assets.index`.

Complex profiles may use a package-local JSON `file`. The loader still validates selectors, references, and asset IDs; absolute paths and executable scripts are rejected. Applying a template character copies reference audio into `vocal/reference/`, materializes a project voice profile, and stores only the project profile ID in the scene.
