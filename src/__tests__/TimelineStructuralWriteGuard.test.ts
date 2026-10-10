import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const UI_ROOT = path.join(ROOT, 'ui');

const forbiddenWrites: Array<{ label: string; pattern: RegExp }> = [
  { label: 'direct addAction', pattern: /documentAdapter\.addAction\(/ },
  { label: 'direct deleteActions', pattern: /documentAdapter\.deleteActions\(/ },
  { label: 'direct deleteAction', pattern: /documentAdapter\.deleteAction\(/ },
  { label: 'direct duplicateAction', pattern: /documentAdapter\.duplicateAction\(/ },
  { label: 'direct pasteActions', pattern: /documentAdapter\.pasteActions\(/ },
  { label: 'direct loadScene', pattern: /documentAdapter\.loadScene\(/ },
  { label: 'direct setTimeline', pattern: /documentAdapter\.setTimeline\(/ },
  { label: 'direct marker meta write', pattern: /documentAdapter\.setMetaField\(\s*['"]markers['"]/ },
  { label: 'manual structural pushUndo', pattern: /documentAdapter\.pushUndo\(/ },
  { label: 'direct previewActionUpdate', pattern: /documentAdapter\.previewActionUpdate\(/ },
  { label: 'direct previewActionUpdates', pattern: /documentAdapter\.previewActionUpdates\(/ },
  { label: 'direct commitActionUpdate', pattern: /documentAdapter\.commitActionUpdate\(/ },
  { label: 'direct commitActionUpdates', pattern: /documentAdapter\.commitActionUpdates\(/ },
];

const restoredTimelineUiFiles = [
  'ActionInspector.tsx',
  'ActionInspectorTabs.tsx',
  'InspectorArea.tsx',
  'TimelineListView.tsx',
  'TimelineSelectionBar.tsx',
  'TrackArea.tsx',
  'TrackComponents.tsx',
  'RawScriptTab.tsx',
];

function collectUiFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectUiFiles(fullPath));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

describe('timeline structural write guard', () => {
  for (const fullPath of collectUiFiles(UI_ROOT)) {
    const relativeFile = path.relative(ROOT, fullPath).replace(/\\/g, '/');
    it(`blocks legacy structural writes in ${relativeFile}`, () => {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const { label, pattern } of forbiddenWrites) {
        expect(content, `${relativeFile} should not contain ${label}`).not.toMatch(pattern);
      }
    });
  }

  it('keeps v2 raw source wiring out of legacy reverse compilation', () => {
    const files = [
      path.join(ROOT, 'App.tsx'),
      path.join(UI_ROOT, 'AiScriptSegmentPanel.tsx'),
      path.join(UI_ROOT, 'timeline', 'RawScriptTab.tsx'),
      path.join(ROOT, 'services', 'io', 'SceneFileService.ts'),
    ];
    for (const fullPath of files) {
      const content = fs.readFileSync(fullPath, 'utf8');
      expect(content, fullPath).not.toContain('SceneCompiler.decompile');
      expect(content, fullPath).not.toContain('migrateLegacySceneToDocumentV2FromRawJson');
    }
  });

  it('keeps raw editing and AI script generation wired to CurrentSceneDocument source', () => {
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
    const rawScriptTab = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'RawScriptTab.tsx'), 'utf8');
    const aiPanel = fs.readFileSync(path.join(UI_ROOT, 'AiScriptSegmentPanel.tsx'), 'utf8');
    const sceneFileService = fs.readFileSync(path.join(ROOT, 'services', 'io', 'SceneFileService.ts'), 'utf8');

    expect(app).toContain('useSemanticDocument');
    expect(app).toContain('JSON.stringify(semanticDocument');
    expect(rawScriptTab).toContain('useSemanticTimelineSnapshot');
    expect(aiPanel).toContain('useSemanticAuthoringService');
    expect(aiPanel).toContain('compileAiScriptSegmentPlanToSceneStatements');
    expect(sceneFileService).toContain('Only current Scene Document JSON is supported');
  });

  it('keeps StageOverlay edits on semantic statement authoring', () => {
    const stageOverlay = fs.readFileSync(path.join(UI_ROOT, 'StageOverlay.tsx'), 'utf8');

    expect(stageOverlay).toContain('useSemanticAuthoringService');
    expect(stageOverlay).toContain('AUTHORING_SCHEMA_VERSION');
    expect(stageOverlay).not.toContain('useTimelineAuthoringService');
    expect(stageOverlay).not.toContain('commitActionEdit');
  });

  it('keeps TimelineListView direct item edits on semantic statement authoring', () => {
    const listView = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'TimelineListView.tsx'), 'utf8');
    const editing = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'useTimelineListEditing.ts'), 'utf8');

    expect(listView).toContain('useTimelineListEditing');
    expect(editing).toContain('useSemanticAuthoringService');
    expect(editing).toContain('AUTHORING_SCHEMA_VERSION');
    for (const content of [listView, editing]) {
      expect(content).not.toContain('useTimelineAuthoringService');
      expect(content).not.toContain('commitActionEdit');
      expect(content).not.toContain("kind: 'delete-actions'");
    }
  });

  it('keeps TimelineEditor structural edits on semantic statement authoring', () => {
    const editor = fs.readFileSync(path.join(UI_ROOT, 'TimelineEditor.tsx'), 'utf8');

    expect(editor).toContain('useSemanticAuthoringService');
    expect(editor).toContain('AUTHORING_SCHEMA_VERSION');
    expect(editor).toContain('buildSemanticMoveTimelineIntent');
    const commands = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'semanticTimelineCommands.ts'), 'utf8');
    expect(editor).toContain('useSemanticTimelineCommands');
    expect(commands).toContain('buildSemanticDeleteTimelineIntents');
    expect(commands).toContain('buildSemanticDuplicateTimelineIntent');
    expect(editor).toContain('buildSemanticRetargetTimelineIntents');
    expect(commands).toContain('defaultDialogueStatementDraft');
    expect(editor).not.toContain("kind: 'insert-action'");
    expect(editor).not.toContain("kind: 'delete-actions'");
    expect(editor).not.toContain("kind: 'duplicate-actions'");
    expect(editor).not.toContain('commitActionEdits');
  });

  it('keeps character directory product writes on semantic authoring', () => {
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
    const characterDirectory = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'CharacterDirectoryPanel.tsx'), 'utf8');

    expect(app).toContain('semanticAuthoring.applyCharacterCommand');
    expect(characterDirectory).toContain('useSemanticAuthoringService');
    expect(characterDirectory).toContain('semanticAuthoring.applyCharacterCommand');
    expect(characterDirectory).not.toContain('useCharacterDirectoryService');
  });

  it('keeps both inspector layouts on semantic statement authoring for batch delete', () => {
    for (const [file, deleteCall] of [
      ['PropertyInspectorShell.tsx', 'commands.delete(selectedIdsList)'],
      ['useTimelineListEditing.ts', 'deleteActions: commands.delete'],
    ]) {
      const inspector = fs.readFileSync(path.join(UI_ROOT, 'timeline', file), 'utf8');
      expect(inspector).toContain('useSemanticTimelineCommands');
      expect(inspector).toContain(deleteCall);
      expect(inspector).not.toContain('useTimelineAuthoringService');
      expect(inspector).not.toContain("kind: 'delete-actions'");
    }
    const listView = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'TimelineListView.tsx'), 'utf8');
    expect(listView).toContain('editing.deleteActions(selectedIdsList)');
  });

  it('keeps marker prompt edits on semantic statement authoring', () => {
    const markerManager = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'useMarkerManager.ts'), 'utf8');

    expect(markerManager).toContain('useSemanticAuthoringService');
    expect(markerManager).toContain('AUTHORING_SCHEMA_VERSION');
    expect(markerManager).toContain("kind: 'add-marker'");
    expect(markerManager).toContain("kind: 'remove-marker'");
    expect(markerManager).not.toContain('useTimelineAuthoringService');
    expect(markerManager).not.toContain('createStructuralIntentBase');
  });

  it('keeps block-context duplicate and delete on semantic statement authoring', () => {
    const blockMenu = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'useBlockContextMenu.ts'), 'utf8');

    expect(blockMenu).toContain('useSemanticAuthoringService');
    expect(blockMenu).toContain('useSemanticTimelineCommands');
    expect(blockMenu).toContain('commands.copy([id])');
    expect(blockMenu).toContain('commands.paste(buffer, insertTime');
    expect(blockMenu).toContain('commands.duplicate([id])');
    expect(blockMenu).toContain('buildSemanticSplitTimelineIntents');
    expect(blockMenu).toContain('commands.delete([id])');
    expect(blockMenu).not.toContain('useTimelineAuthoringService');
    expect(blockMenu).not.toContain('createStructuralIntentBase');
    expect(blockMenu).not.toContain("kind: 'paste-actions'");
    expect(blockMenu).not.toContain("kind: 'split-action'");
    expect(blockMenu).not.toContain("kind: 'duplicate-actions'");
    expect(blockMenu).not.toContain("kind: 'delete-actions'");
  });

  it('keeps timeline interactions on the semantic read model without sceneData action fallback', () => {
    const files = [
      'useBatchDrag.ts',
      'useBlockDrag.ts',
      'useBlockResize.ts',
      'useBlockContextMenu.ts',
    ];
    for (const file of files) {
      const content = fs.readFileSync(path.join(UI_ROOT, 'timeline', file), 'utf8');
      expect(content, file).not.toContain('sceneData?.timeline');
      expect(content, file).not.toContain('timeline.find');
    }
  });

  it('keeps display and selection lists on the semantic read model', () => {
    const expectations: Array<[string, string[]]> = [
      ['TimelineListView.tsx', [': sceneData.timeline', 'semanticTimelineActions.length > 0']],
      ['InspectorArea.tsx', [': sceneData.timeline', 'semanticTimelineItems.length > 0']],
      ['ActionInspector.tsx', [': sceneData.timeline', 'semanticTimelineItems.length > 0']],
      ['ActionInspectorTabs.tsx', ['sceneData.timeline?.find']],
      ['StageOverlay.tsx', ['documentStore.sceneData', 'sceneData?.timeline ?? []', 'semanticTimelineItems.length > 0']],
      ['TimelineEditor.tsx', ['sceneData?.timeline ?? []', 'semanticTimelineItems.length > 0']],
    ];
    for (const [relativeFile, forbidden] of expectations) {
      const fullPath = relativeFile === 'StageOverlay.tsx' || relativeFile === 'TimelineEditor.tsx'
        ? path.join(UI_ROOT, relativeFile)
        : relativeFile.startsWith('..')
          ? path.join(UI_ROOT, relativeFile)
          : path.join(UI_ROOT, 'timeline', relativeFile);
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const text of forbidden) expect(content, `${relativeFile} should not contain ${text}`).not.toContain(text);
    }
  });

  it('keeps timeline presentation labels on semantic registry metadata', () => {
    const registry = fs.readFileSync(path.join(ROOT, 'services', 'semantic-scene', 'SceneStatementDefinitionRegistry.ts'), 'utf8');
    const readModel = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'semanticTimelineReadModel.ts'), 'utf8');
    const timelineTypes = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'semanticTimelineTypes.ts'), 'utf8');
    const trackComponents = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'TrackComponents.tsx'), 'utf8');
    const density = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'timelineDensity.ts'), 'utf8');
    const statementRow = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'TimelineStatementRow.tsx'), 'utf8');
    const selectionBar = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'TimelineSelectionBar.tsx'), 'utf8');
    const actionInspector = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'ActionInspector.tsx'), 'utf8');
    const inspectorSubmodules = collectUiFiles(path.join(UI_ROOT, 'timeline', 'inspector'))
      .map((file) => fs.readFileSync(file, 'utf8'));
    const inspectorCode = [actionInspector, ...inspectorSubmodules];
    const inspectorCodeText = inspectorCode.join('\n');
    const timelineEditor = fs.readFileSync(path.join(UI_ROOT, 'TimelineEditor.tsx'), 'utf8');

    expect(timelineTypes).toContain('semanticType?: StatementFamily');
    expect(timelineTypes).toContain('semanticCategory?: StatementCategory');
    expect(timelineTypes).toContain('semanticLabel?: string');
    expect(timelineTypes).toContain('semanticIconKey?: string');
    expect(timelineTypes).toContain('sourceParams?: Record<string, any>');
    expect(registry).toContain('timelinePresentation(params');
    expect(readModel).toContain('sceneStatementDefinitionRegistry.timelinePresentation(source)');
    expect(readModel).toContain('getSemanticTimelineDisplay(source)');
    expect(readModel).toContain('sourceParams');
    expect(trackComponents).toContain('action.semanticLabel');
    expect(trackComponents).toContain('action.semanticIconKey ?? action.action');
    expect(trackComponents).toContain('segment.dominantActionLabel');
    expect(trackComponents).not.toContain("case 'wait'");
    expect(trackComponents).not.toContain("case 'custom'");
    expect(density).toContain('item.action.semanticType ?? item.action.action');
    expect(density).toContain('item.action.semanticLabel');
    expect(density).toContain("dominantActionType: dominantType?.type ?? 'unknown'");
    expect(statementRow).toContain('action.semanticIconKey ?? action.action');
    expect(statementRow).toContain('action.semanticLabel ?? action.action');
    expect(statementRow).not.toContain("action.action === 'wait'");
    expect(selectionBar).toContain('action.semanticLabel ?? getActionDisplayLabel');
    expect(actionInspector).toContain('action.semanticLabel || getActionDisplayLabel');
    expect(actionInspector).toContain('const usesSourceParamForm =');
    expect(inspectorCodeText).toContain('SOURCE_PARAM_FORM_SEMANTIC_TYPES');
    expect(inspectorCodeText).toContain('SOURCE_PARAM_FORM_CHARACTER_PERFORMANCE_ACTIONS');
    expect(inspectorCodeText).toContain("'characterLookAt'");
    expect(inspectorCodeText).toContain("'characterBlink'");
    expect(actionInspector).toContain('CharacterLookAtPanel');
    expect(actionInspector).toContain('CharacterBlinkPanel');
    expect(inspectorSubmodules.join('\n')).toContain('export function CharacterLookAtPanel');
    expect(inspectorSubmodules.join('\n')).toContain('export function CharacterBlinkPanel');
    expect(inspectorCodeText).toContain("'characterPresence'");
    expect(inspectorCodeText).toContain("'characterTransform'");
    expect(inspectorCodeText).toContain("'characterPerformance'");
    expect(inspectorCodeText).toContain("'environmentLayer'");
    expect(inspectorCodeText).toContain("'audio'");
    expect(inspectorCodeText).toContain("'graphicLayer'");
    expect(inspectorCodeText).toContain("'customAnimation'");
    expect(inspectorCodeText).toContain("hiddenParamKeys.add('role')");
    expect(inspectorCodeText).toContain("hiddenParamKeys.add('kind')");
    expect(actionInspector).toContain('usesSourceParamForm && action.sourceParams');
    expect(inspectorCodeText).toContain("'camera'");
    expect(inspectorCodeText).toContain("'visualStyle'");
    expect(inspectorCodeText).toContain("'lighting'");
    for (const internalInspectorNode of [
      'semantic-camera-source-form',
      'semantic-camera-path-editor',
      'semantic-lens-filter-source-form',
      'semantic-lens-filter-parameters',
      'semantic-visual-style-source-form',
      'semantic-visual-style-override-editor',
      'semantic-lighting-source-form',
    ]) {
      for (const inspectorModule of inspectorCode) {
        expect(inspectorModule, `${internalInspectorNode} should stay out of the user-facing inspector`).not.toContain(internalInspectorNode);
      }
    }
    for (const inspectorModule of inspectorCode) {
      expect(inspectorModule).not.toContain('action-${actionId}-camera-mode');
      expect(inspectorModule).not.toContain('updateCameraMode');
    }
    expect(inspectorCodeText).toContain("'from'");
    expect(inspectorCodeText).toContain("'to'");
    expect(inspectorSubmodules.join('\n')).toContain('clampCameraCoordinate');
    expect(inspectorCodeText).toContain("hiddenParamKeys.add('z')");
    expect(timelineEditor).toContain('commands.replaceSourceParams(item.locator, params, item.source.params');
    expect(timelineEditor).toContain('commands.updateSourceParams(id, paramPatch)');
    expect(timelineEditor).toContain('shouldUseSourceParamPatch');
  });

  it('keeps workspace tools off the legacy SceneScript compatibility seam', () => {
    const expectations: Array<[string, string[]]> = [
      ['ContextPanel.tsx', ['legacy-scene', 'sceneData.timeline']],
      ['CharacterDirectoryPanel.tsx', ['legacy-scene', 'sceneData.timeline']],
      ['ActionInspectorTabs.tsx', ['legacy-scene', 'sceneData.timeline']],
      ['TimelineListView.tsx', ['legacy-scene', 'sceneData.timeline']],
      ['TimelineStatementRow.tsx', ['legacy-scene', 'sceneData.timeline']],
      ['TimelineListGapMenu.tsx', ['legacy-scene', 'sceneData.timeline']],
      ['useTimelineListEditing.ts', ['legacy-scene', 'sceneData.timeline']],
      ['useTimelineListExpansion.ts', ['legacy-scene', 'sceneData.timeline']],
      ['ActionInspector.tsx', ['legacy-scene', 'sceneData.timeline']],
      ['InspectorArea.tsx', ['legacy-scene', 'sceneData.timeline']],
    ];
    for (const [file, forbidden] of expectations) {
      const content = fs.readFileSync(path.join(UI_ROOT, 'timeline', file), 'utf8');
      for (const text of forbidden) {
        expect(content, `${file} should not contain ${text}`).not.toContain(text);
      }
    }
  });

  it('keeps timeline presentation sampling off the legacy compiler seam', () => {
    const editor = fs.readFileSync(path.join(UI_ROOT, 'TimelineEditor.tsx'), 'utf8');
    const visualIntent = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'visualIntentAuthoring.ts'), 'utf8');

    expect(editor).toContain('timelinePresentationScene.timeline.filter');
    expect(editor).not.toContain('withAuthorFacingEnvironmentLabel(sceneData');
    expect(visualIntent).toContain('TimelineScene');
    expect(visualIntent).toContain('reconstructEnvironmentAtTime');
    expect(visualIntent).not.toContain('../../engine/SceneCompiler');
    expect(visualIntent).not.toContain('computeSceneStateAtTime');
  });

  it('keeps semantic statement insertion defaults off projected scene data', () => {
    const statementBlocks = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'semanticStatementBlocks.ts'), 'utf8');
    const dropHook = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'useTimelineDrop.ts'), 'utf8');
    const trackArea = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'TrackArea.tsx'), 'utf8');

    expect(statementBlocks).toContain('SceneMeta');
    expect(statementBlocks).toContain('sceneMeta');
    expect(statementBlocks).not.toContain('legacy-scene');
    expect(statementBlocks).not.toContain('SceneScript');
    expect(statementBlocks).not.toContain('sceneData');
    expect(dropHook).toContain('sceneData: TimelineScene | null');
    expect(dropHook).toContain('sceneMeta: sceneData.meta');
    expect(trackArea).toContain('sceneData: TimelineScene');
    expect(trackArea).toContain('sceneMeta: sceneData.meta');
  });

  it('keeps detached workspace snapshot off projected scene data', () => {
    const workspaceTypes = fs.readFileSync(path.join(UI_ROOT, 'workspace-tools', 'types.ts'), 'utf8');
    const workspaceWindow = fs.readFileSync(path.join(ROOT, 'WorkspaceToolsWindow.tsx'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
    const storeHooks = fs.readFileSync(path.join(UI_ROOT, 'store', 'storeHooks.ts'), 'utf8');

    expect(workspaceTypes).toContain('sceneMeta: SceneMeta | null');
    expect(workspaceTypes).toContain('timelineActionTimesById');
    expect(workspaceTypes).not.toContain('legacy-scene');
    expect(workspaceTypes).not.toContain('SceneScript');
    expect(workspaceWindow).toContain('snapshot.sceneMeta?.characters');
    expect(workspaceWindow).toContain('snapshot.timelineActionTimesById[actionId]');
    expect(workspaceWindow).not.toContain('snapshot.sceneData');
    expect(app).toContain('sceneMeta: semanticDocument?.meta ?? null');
    expect(app).toContain('getCompiledSceneSnapshot()?.actions');
    expect(app).not.toContain('useDocumentData');
    expect(storeHooks).not.toContain('useDocumentData');
    expect(storeHooks).not.toContain('store.sceneData');
  });

  it('keeps autosave gated on semantic source documents', () => {
    const autoSaveDaemon = fs.readFileSync(path.join(ROOT, 'engine', 'daemons', 'AutoSaveDaemon.ts'), 'utf8');

    expect(autoSaveDaemon).toContain('getCurrentSceneDocumentSnapshot()');
    expect(autoSaveDaemon).not.toContain('sceneData');
  });

  it('keeps validation daemon gated on semantic source documents', () => {
    const validationDaemon = fs.readFileSync(path.join(ROOT, 'engine', 'daemons', 'ValidationDaemon.ts'), 'utf8');

    expect(validationDaemon).toContain('getCurrentSceneDocumentSnapshot()');
    expect(validationDaemon).toContain('validateSemanticSceneStructure');
    expect(validationDaemon).not.toContain('sceneData');
    expect(validationDaemon).not.toContain('validateSceneStructure');
    expect(validationDaemon).not.toContain('runAsyncValidationChecks');
    expect(fs.existsSync(path.join(ROOT, 'engine', 'daemons', 'ValidationChecks.ts'))).toBe(false);
  });

  it('keeps export adapter on prepared semantic snapshots', () => {
    const exportAdapter = fs.readFileSync(path.join(ROOT, 'api', 'adapters', 'ExportAdapter.ts'), 'utf8');
    const frameCaptureEngine = fs.readFileSync(path.join(ROOT, 'engine', 'export', 'FrameCaptureEngine.ts'), 'utf8');
    const frameCaptureVisualRuntime = fs.readFileSync(path.join(ROOT, 'engine', 'export', 'PreparedFrameCaptureVisualRuntime.ts'), 'utf8');
    const audioMixer = fs.readFileSync(path.join(ROOT, 'engine', 'export', 'AudioMixer.ts'), 'utf8');
    const bootstrapper = fs.readFileSync(path.join(ROOT, 'engine', 'Bootstrapper.ts'), 'utf8');
    const ffmpegArgs = fs.readFileSync(path.join(ROOT, '..', 'electron', 'ffmpeg-args.ts'), 'utf8');

    expect(exportAdapter).toContain('getPreparedSceneSnapshot()');
    expect(exportAdapter).toContain('createPreparedFrameCaptureVisualRuntime(preparedScene)');
    expect(exportAdapter).not.toContain('preparedSceneToRuntimeScript');
    expect(exportAdapter).toContain('collectPreparedSources(preparedScene');
    expect(exportAdapter).not.toContain('documentStore.sceneData');
    expect(exportAdapter).not.toContain('collectSources(sceneData');
    expect(frameCaptureEngine).toContain('visualRuntime?: FrameCaptureVisualRuntime');
    expect(frameCaptureEngine).not.toContain('SceneScript');
    expect(frameCaptureEngine).not.toContain('scene?:');
    expect(frameCaptureVisualRuntime).toContain('timeline: scene.actions');
    expect(frameCaptureVisualRuntime).not.toContain('preparedSceneToRuntimeScript');
    expect(audioMixer).toContain('collectPreparedSources(');
    expect(audioMixer).not.toContain('preparedSceneToRuntimeScript');
    expect(audioMixer).toContain('resolveExportTiming');
    expect(bootstrapper).toContain('hydratePreparedRuntimeConfigs(bundle.prepared)');
    expect(bootstrapper).not.toContain('preparedSceneToRuntimeScript');
    expect(ffmpegArgs).toContain('buildFFmpegConvertArgs');
    expect(ffmpegArgs).toContain('-shortest');
    expect(ffmpegArgs).toContain("'-t'");
    expect(ffmpegArgs).toContain('atrim=start=');
    expect(ffmpegArgs).toContain('afade=t=in');
    expect(ffmpegArgs).toContain('afade=t=out');
  });

  it('keeps shared marker and character metadata imports off legacy scene types', () => {
    const files = [
      path.join(UI_ROOT, 'timeline', 'Ruler.tsx'),
      path.join(ROOT, 'services', 'timeline-authoring', 'SemanticTimelineAuthoringService.ts'),
      path.join(ROOT, 'services', 'timeline-authoring', 'SemanticAuthoringReceipt.ts'),
      path.join(ROOT, 'api', 'types', 'character-directory.ts'),
      path.join(ROOT, 'api', 'interfaces', 'IProjectWorkspaceService.ts'),
    ];

    for (const fullPath of files) {
      const content = fs.readFileSync(fullPath, 'utf8');
      expect(content, fullPath).not.toContain('legacy-scene');
      expect(content, fullPath).not.toContain('SceneScript');
    }
  });

  it('keeps collaboration connect panel on semantic document facts', () => {
    const panel = fs.readFileSync(path.join(UI_ROOT, 'CollaborationConnectPanel.tsx'), 'utf8');
    expect(panel).toContain('CurrentSceneDocument');
    expect(panel).toContain('statements.length');
    expect(panel).not.toContain('legacy-scene');
    expect(panel).not.toContain('sceneData.timeline');
  });

  it('keeps timeline drop insertion on semantic statement authoring', () => {
    const dropHook = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'useTimelineDrop.ts'), 'utf8');
    const resourceBrowser = fs.readFileSync(path.join(UI_ROOT, 'ResourceFileBrowser.tsx'), 'utf8');

    expect(dropHook).toContain('useSemanticAuthoringService');
    expect(dropHook).toContain('createSemanticStatementDraftForResource');
    expect(dropHook).toContain('templateAuthoringComboToSemanticIntent');
    expect(dropHook).toContain("kind: 'insert-statement'");
    expect(dropHook).not.toContain('useTimelineAuthoringService');
    expect(dropHook).not.toContain('createStructuralIntentBase');
    expect(dropHook).not.toContain("kind: 'insert-action'");
    expect(dropHook).not.toContain("kind: 'insert-template'");

    expect(resourceBrowser).toContain("type: 'resource'");
    expect(resourceBrowser).not.toContain('actionType');
  });

  it('keeps dialogue companion editing and template authoring on semantic intents', () => {
    const inspector = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'ActionInspector.tsx'), 'utf8');
    const companionPanel = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'inspector', 'panels', 'DialogueCompanionPanel.tsx'), 'utf8');
    const companionModel = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'inspector', 'dialogueCompanionModel.ts'), 'utf8');
    const trackArea = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'TrackArea.tsx'), 'utf8');

    expect(inspector).toContain('DialogueCompanionPanel');
    expect(companionPanel).toContain('dialogue-companion-editor');
    expect(companionPanel).toContain("kind: 'reorder-dialogue-companions'");
    expect(companionModel).toContain('sceneStatementDefinitionRegistry.list()');
    expect(trackArea).toContain('buildTemplateAuthoringPreview');
    expect(trackArea).toContain('commands.insert(preview.intent)');
  });

  it('keeps character directory product writes on semantic authoring', () => {
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
    const characterDirectory = fs.readFileSync(path.join(UI_ROOT, 'timeline', 'CharacterDirectoryPanel.tsx'), 'utf8');

    expect(app).toContain('semanticAuthoring.applyCharacterCommand');
    expect(app).not.toContain('services.characterDirectory.apply');
    expect(characterDirectory).toContain('useSemanticAuthoringService');
    expect(characterDirectory).toContain('semanticAuthoring.applyCharacterCommand');
    expect(characterDirectory).not.toContain('useCharacterDirectoryService');
  });

  it('keeps rolled-back timeline UI modules present', () => {
    for (const file of restoredTimelineUiFiles) {
      expect(fs.existsSync(path.join(UI_ROOT, 'timeline', file)), file).toBe(true);
    }
  });

  it('keeps experimental semantic timeline UI files out of product tree', () => {
    expect(collectUiFiles(path.join(UI_ROOT, 'semantic-timeline'))).toEqual([]);
  });
});
