# Template System Documentation

- English: [docs/en/template-system.md](en/template-system.md)
- 中文: [docs/cn/template-system.md](cn/template-system.md)

Architecture decisions live in [KSM-0001](ksm-adr/ksm-0001-unified-template-system.md), [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md), and [ADR-0031](adr/0031-evolution-compatibility-policy.md). Deferred work is tracked in [docs/ksm-adr/TODO.md](ksm-adr/TODO.md).

## Key Capabilities & Compatibility

- **Supported Scene Schema Versions**: Manifest schema v2 (`manifest.v2.json`) supports packages targeting scene schema versions 4 and 5. Payloads are validated and materialized into the active `SceneDocumentV5` epoch.
- **Settings Management**: The "项目模板" (`templates`) tab in `SettingsDialog` allows users to configure project template precedence, default dialogue styles, character imports, and AI performance profiles.
- **ZIP Package Import**: Installing and updating template packages via ZIP archives is supported directly from both `ProjectHome` and `SettingsDialog`.
- **Omission of Deferred Presets**: Camera and lighting preset selectors are omitted from the configuration UI to avoid exposing unassigned runtime capabilities.

## Voice Profiles

Template voice authoring is part of the unified package contract through typed `voiceProfiles[]` and `characterPresets[].voiceProfileId`. Profiles use logical model selectors and `assets.index` IDs only. During template application, reference audio and profile data are materialized into the project; scenes never retain template-relative audio references.

See [ADR-0020](adr/0020-gpt-sovits-voice-authoring.md) for ownership, portability, and authoring transaction rules.
