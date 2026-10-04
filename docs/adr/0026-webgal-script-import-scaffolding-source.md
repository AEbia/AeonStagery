---
status: accepted
---

# WebGAL Script Import as a Scaffolding Source

Project creation can import a single WebGAL scene script and convert it into the starting scene of a new AeonStagery project. The import is a scaffold, not a migration: it produces a scene the author continues from, never promises lossless fidelity to WebGAL gameplay, and lists everything not converted in a line-referenced import report.

## Decision

- **One script file per project.** AeonStagery edits a single scene at a time, so one WebGAL chapter maps to one project scene; a multi-file WebGAL game becomes one project per file. `changeScene`/`callScene` stay recognized-but-reported and are never converted.
- **`changeFigure` is "set the figure's current state", not "enter".** The converter tracks figure lifecycle: first appearance emits an enter; motion/expression changes on a present character emit performance statements; a model change re-models the character (position preserved); `changeFigure:none` or an empty figure emits an exit (resolved by `-id`, or the current focus when absent). This is what prevents one character's twenty expression changes from becoming twenty entrances.
- **Character identity binds both namespaces.** The speaker name and the figure instance id (`-id`/`-figureId`) name the same character. The converter registers the binding in both directions so a dialogue line that precedes its figure does not split one character into `char-a` and `char-a_2`.
- **Assets are referenced, not copied.** The scene points into the machine-registered external library (`@mount/<id>/...`, per ADR-0021). The imported scene is not self-contained; the mount must stay registered for assets to resolve.
- **Per-line voice drives timing and playback.** A `-path.wav` flag attaches to its dialogue and its real audio duration sets the dialogue hold time when the file is reachable through the mount; lines without voice fall back to a per-character estimate scaled by the import-time reading speed. BGM/effect/choice/variable/jump commands are recognized but reported as skipped.
- **Reading speed is an import-time parameter, not a runtime control.** AeonStagery timelines use absolute times, so changing pacing re-times the whole scene and requires regenerating it.
- **The project keeps an import receipt** (raw script, import options, mount id, report) so the author can regenerate the scene after changing speed or after converter fixes. Regeneration replaces the current scene after confirmation.

## Considered Options

- **Scaffold vs full migration.** Full migration (choices, variables, multi-scene navigation, music) would require AeonStagery to gain WebGAL-shaped gameplay features. Rejected for now: the product is a cinematic timeline tool, and the report makes the boundary explicit.
- **Reference vs copy.** Copying makes scenes self-contained but drags multi-gigabyte Live2D packs into every project and raises sharing/licensing questions. Reference-only keeps imports light and matches ADR-0021.
- **One-shot vs regenerate.** One-shot import bakes the speed and any converter bugs forever. Keeping the import receipt and allowing regeneration makes pacing an adjustable, non-destructive choice.

## Consequences

- Imported scenes are starting points. Anything WebGAL-specific without an AeonStagery equivalent (BGM, choices, variables, scene jumps, textbox toggles) is reported, not silently dropped — the report is the contract for what a scaffold does not carry.
- The converter stays single-file and reference-only, keeping it I/O-light except for reading voice duration through the registered mount.
- Because durations depend on reading speed and voice file availability, re-importing the same script at a different speed is a supported workflow, not an error.
