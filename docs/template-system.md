# Template System Documentation

- English: [docs/en/template-system.md](en/template-system.md)
- 中文: [docs/cn/template-system.md](cn/template-system.md)

Architecture decisions live in [KSM-0001](ksm-adr/ksm-0001-unified-template-system.md), [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md), and [ADR-0031](adr/0031-evolution-compatibility-policy.md). Deferred work is tracked in [docs/ksm-adr/TODO.md](ksm-adr/TODO.md).

## Key Capabilities & Compatibility

- **Supported Scene Schema Versions**: Manifest schema v2 (`manifest.v2.json`) supports packages targeting scene schema versions 4 and 5. Payloads are validated and materialized into the active `SceneDocumentV5` epoch.
- **Settings Management**: The "项目模板" (`templates`) tab in `SettingsDialog` allows users to configure project template precedence, default dialogue styles, character imports, and AI performance profiles.
- **ZIP Package Import**: Installing and updating template packages via ZIP archives is supported directly from both `ProjectHome` and `SettingsDialog`.
- **Package Removal**: External packages, including WebGAL subtitle styles and their assets, can be deleted from the home library manager or project template settings. Desktop deletion asks the user to select the listed package directory and confirm before moving it to the system trash; builtin packages remain available. Shared template roots containing legacy managed data are protected. The active project drops the removed package and its unavailable defaults; existing dialogue text and project-owned asset copies are retained.
- **Template Disablement**: Every package can be unchecked, including the last one. Saving an empty selection keeps templates disabled across catalog refreshes and project reopening; unavailable subtitle defaults and AI performance capabilities no longer remain active.
- **Dialogue Font Size**: Settings → Dialogue offers a machine-local choice between a uniform body font size (the existing default) and each template's authored font size. Templates without an authored size fall back to the uniform size; speaker sizes follow their styles. The builtin package includes the blue-line subtitle style (`blue-line-subtitle`).
  - Existing settings without a font-size source are normalized and saved as uniform sizing, preserving the user's font size. Template sizing requires an explicit choice. At the 1920×1080 stage size, authored body size / line height defaults are 42 / 52 px for pink-nameplate, 42 / 58 px for immersive-subtitle, and 32 / 48 px for blue-line-subtitle.
- **Omission of Deferred Presets**: Camera and lighting preset selectors are omitted from the configuration UI to avoid exposing unassigned runtime capabilities.

## Voice Profiles

Template voice authoring is part of the unified package contract through typed `voiceProfiles[]` and `characterPresets[].voiceProfileId`. Profiles use logical model selectors and `assets.index` IDs only. During template application, reference audio and profile data are materialized into the project; scenes never retain template-relative audio references.

See [ADR-0020](adr/0020-gpt-sovits-voice-authoring.md) for ownership, portability, and authoring transaction rules.
