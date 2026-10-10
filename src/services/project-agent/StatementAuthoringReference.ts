import type { StatementFamily } from '../../api/types/semantic-scene';

/**
 * Statement authoring reference injected into the project Agent system prompt
 * (prompt-engineering fix, journal-derived: the Agent previously guessed
 * statement.params field names one attempt at a time, burning 13
 * schema_validation_failed round trips for 4 committed writes).
 *
 * The reference is authoritative guidance for authoring params, NOT a second
 * validator: the statement parsers in SceneStatementDefinitionRegistry remain
 * the final arbiter, and their error messages report the allowed/required
 * field set so any residual mismatch converges in one retry.
 *
 * Keep this compact: the whole reference is injected verbatim into every
 * system message. STATEMENT_AUTHORING_REFERENCE_FAMILIES is the drift guard —
 * a test asserts it equals the registry family set, so a newly registered
 * family forces an update here.
 *
 * The guard tracks REGISTRY REGISTRATION, while the prose below documents the
 * families the Agent is meant to author. A family that the registry still
 * parses for compatibility without being an authoring capability appears in
 * the guard only, so the injected prompt stays a statement of current
 * capability instead of a changelog.
 */

/**
 * Families covered by the reference; must equal the registry family set.
 * filterAdd / filterChange / filterReset are registry-parsed compatibility
 * families with no authoring capability, so they are guarded here but have no
 * prose entry.
 */
export const STATEMENT_AUTHORING_REFERENCE_FAMILIES: readonly StatementFamily[] = [
  'dialogue',
  'dialogueVisibility',
  'characterPresence',
  'characterTransform',
  'characterPerformance',
  'camera',
  'environmentLayer',
  'visualStyle',
  'filterAdd',
  'filterChange',
  'filterReset',
  'lighting',
  'audio',
  'graphicLayer',
  'customAnimation',
];

/** Bounded reference size guard; keep the injected prompt lean. */
export const PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE_MAX_CHARS = 5000 as const;

export const PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE: string = [
  'Required fields: !. Resources: project-relative or @mount/<id>/... paths from resource tools. position, screenTarget, camera follow offset: [x, y]. Dialogue companion: { anchor (start|end), offset (seconds), type, params }; anchor counts from the parent start/end.',
  '',
  '- dialogue: text!, durationSeconds! (> 0); optional speakerId, speaker, voice (@mount vocal), voiceDurationSeconds, style, speakerColor, textColor, lipSync, template (glass|minimal|classic).',
  '- dialogueVisibility (v5): visible! boolean, durationSeconds? >=0 (default 0); fade box; voice/lip sync continue.',
  '- characterPresence: mode! (enter|exit), id! (character id from the scene character list); optional model (@mount figure), variant, position, scale, rotation, opacity, z, transition, durationSeconds, ease.',
  '- characterTransform: id!; optional position, scale, rotation, opacity, z, durationSeconds, ease.',
  '- characterPerformance (dialogue companion): target! (character id) and at least one of motion | expression | lookAt | blink; motion is "" (unfilled placeholder) or {"kind":"resource","key":"<catalog key>"}; lookAt { target?, point?, enabled?, intensity? }, blink { enabled?, interval?, intervalRange? }; schema v4 has no params.durationSeconds / loop / priority (motions run once with deterministic takeover); custom motions (kind "custom") are editor-authored, read views show their tracks as { parameterId, keyframeCount } metadata, never write tracks or keyframes yourself.',
  '- camera: mode! (focus|move|follow|path|shake|reset). focus: target or position required; optional targetPart (head|chest|feet|center), zoom { kind: absolute|delta, value }, rotation, durationSeconds, ease. move: optional position, to, zoom, rotation, durationSeconds, ease. follow: operation! (start|stop); optional target, offset, smoothing. path: keyframes! (>= 2 of { time!, position?, zoom?, rotation?, ease?, label? }); optional durationSeconds, ease, loop, repeat, yoyo. shake: optional intensity, frequency, durationSeconds, decay, direction (both|horizontal|vertical). reset: optional durationSeconds, ease.',
  '- environmentLayer: mode! (set|transform|remove), layerId! (e.g. "bg"); optional image or file (@mount background), position, scale, rotation, opacity, z, zIndex, durationSeconds, ease, transition.',
  '- visualStyle: scope! (object), target! (character id), slot! (integration|accent|distortion|rim-light), mode! (set|modulate|reset); recipeId is required for non-rim-light set and forbidden for modulate/rim-light. Fields: intensity, warmth, bloom, rgbSplit, blend, contamination, color/colorStops, colorBlendMode (normal|multiply|screen|darken|lighten|overlay|soft-light|hard-light), thickness/angle/softness, shadowDistance/shadowSoftness, semanticOverride/advancedOverride, durationSeconds; integration set defaults to intensity 0.8 and colorBlendMode multiply, and accepts brightness (-1..1, default 0).',
  '- lighting: effect! (preset|blur|godrays|post|overlay|pointLight), mode! (set|modulate|reset|remove|clear); optional durationSeconds. preset: preset!; optional intensity. blur: optional target (global|background|characters), intensity. godrays: intensity, angle, lacunarity. post: target (panorama|character/environment-layer ID; default panorama), bloomThreshold, bloomBloomScale, bloomBrightness, rgbSplitX/Y, godrayGain/lacunarity/angle, adjGamma/contrast/saturation/brightness/red/green/blue, overlayColor, overlayBlendMode (same modes as visualStyle), overlayIntensity. post reset: target?, durationSeconds?. overlay set/modulate: id!; optional color, blendMode (same modes as visualStyle), intensity; remove: id!; clear: none. pointLight set/modulate: id!; optional x, y, color, radius, intensity; remove: id!; clear: none. reset only applies to preset|blur|godrays|post.',
  '- audio: role! (bgm|sfx), mode! (play|stop). bgm play: file! (@mount audio), volume, loop, fadeIn, fadeOut. bgm stop: optional fadeOut. sfx play: instanceId!, file!; optional volume, loop, durationSeconds, fadeIn, fadeOut. sfx stop: instanceId!; optional fadeOut.',
  '- graphicLayer: kind! (image|text), mode! (set|transform|remove), id!; image: optional file; text: optional text, fontFamily, fontSize, color, style; both: optional position, scale, rotation, opacity, z, zIndex, durationSeconds, ease.',
  '- customAnimation: target!, file or animation (at least one), durationSeconds! (> 0); optional loop.',
  '',
  'Examples (the statement argument of insertStatement; time is a sibling argument):',
  '  {"type":"environmentLayer","params":{"mode":"set","layerId":"bg","image":"@mount/library/background/<dir>/<file>.png"}}',
  '  {"type":"characterPresence","params":{"mode":"enter","id":"1","model":"@mount/library/figure/anon/<outfit>/model.json"}}',
  '  {"type":"dialogue","params":{"speakerId":"1","text":"...","durationSeconds":2},"companions":[{"anchor":"start","offset":0,"type":"characterPerformance","params":{"target":"1","motion":""}}]}',
  '  {"type":"audio","params":{"role":"bgm","mode":"play","file":"@mount/library/bgm/<file>.mp3","loop":true}}',
].join('\n');
