import { describe, expect, it, vi } from 'vitest';
import {
  CompatibleSceneSession,
} from '../services/semantic-scene';
import {
  CollaborativeSceneAdmissionError,
  CollaborativeSceneAdmissionGate,
  validateCanonicalV5CollaborationAdmission,
} from '../services/collaboration/CollaborativeSceneAdmissionGate';
import { CollaborativeSessionOrchestratorV2 } from '../services/collaboration/CollaborativeSessionOrchestratorV2';

function makeCanonicalV5Scene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    sceneId: 'scene-canonical-v5',
    meta: {
      title: 'Canonical V5 Scene',
      author: 'Author',
      resolution: [1920, 1080],
      fps: 30,
      paceTier: 'normal',
      markers: [
        {
          markerId: 'marker-1',
          time: 0,
          label: 'Start',
          role: 'beat',
        },
      ],
    },
    statements: [
      {
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: {
          text: 'Hello, World!',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'camera-comp-1',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: 'hero',
            },
          },
        ],
      },
      {
        id: 'lighting-1',
        time: 0,
        type: 'lighting',
        params: {
          effect: 'preset',
          mode: 'set',
          preset: 'natural-warm',
        },
      },
    ],
    visual: {
      visualTargets: {
        hero: {
          targetType: 'character',
          rimLightBaseline: {
            color: '#FFFFFF',
            intensity: 0.8,
            thickness: 0.2,
            angle: 45,
            softness: 0.5,
          },
        },
      },
      segments: {
        opening: {
          boundaryRef: { startMarkerId: 'marker-1' },
          lensStyleBaseline: {
            grade: {
              recipeId: 'warm-grade',
              semanticOverride: { warmth: 0.2 },
            },
          },
        },
      },
      recipeOverlay: {
        'warm-grade': {
          stack: 'lens',
          slot: 'grade',
          payload: {
            brightness: 1,
            contrast: 1,
            saturation: 1.1,
            red: 1,
            green: 1,
            blue: 1,
          },
        },
      },
    },
    ...overrides,
  };
}

describe('Canonical v5 Collaboration Admission', () => {
  describe('Canonical v5 admission pass paths', () => {
    it('admits a minimal canonical v5 scene document', () => {
      const minimalScene = {
        schemaVersion: 5,
        sceneId: 'minimal-v5',
        meta: { title: 'Minimal V5' },
        statements: [],
      };

      const outcome = validateCanonicalV5CollaborationAdmission(minimalScene);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('Expected admission to pass');

      expect(outcome.status).toBe('admitted');
      expect(outcome.document.schemaVersion).toBe(5);
      expect(outcome.document.sceneId).toBe('minimal-v5');
      expect(outcome.session).toBeInstanceOf(CompatibleSceneSession);
      expect(outcome.session.hasUnknownFields).toBe(false);
    });

    it('admits a rich canonical v5 scene with all statement families, companions, markers, and visual blocks', () => {
      const richScene = makeCanonicalV5Scene();

      const outcome = validateCanonicalV5CollaborationAdmission(richScene);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('Expected admission to pass');

      expect(outcome.status).toBe('admitted');
      expect(outcome.document.statements).toHaveLength(2);
      expect(outcome.document.statements[0].companions).toHaveLength(1);
      expect(outcome.document.visual).toBeDefined();
      expect(outcome.session.hasUnknownFields).toBe(false);
    });

    it('admits a CompatibleSceneSession instance directly when it contains no unknown fields', () => {
      const canonicalScene = makeCanonicalV5Scene();
      const openOutcome = CompatibleSceneSession.open(canonicalScene);
      expect(openOutcome.status).toBe('ready');
      if (openOutcome.status !== 'ready') throw new Error('Expected open to succeed');

      const outcome = validateCanonicalV5CollaborationAdmission(openOutcome.session);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('Expected admission to pass');

      expect(outcome.status).toBe('admitted');
      expect(outcome.session).toBe(openOutcome.session);
      expect(outcome.document).toBe(openOutcome.session.projection);
    });

    it('CollaborativeSceneAdmissionGate methods work cleanly for canonical scenes', () => {
      const gate = new CollaborativeSceneAdmissionGate();
      const canonicalScene = makeCanonicalV5Scene();

      expect(gate.isCanonicalV5(canonicalScene)).toBe(true);
      expect(gate.getIncompatibilityReason(canonicalScene)).toBeNull();

      const session = gate.assertAdmission(canonicalScene);
      expect(session).toBeInstanceOf(CompatibleSceneSession);
      expect(session.hasUnknownFields).toBe(false);
    });
  });

  describe('Unknown field rejection with actionable diagnostics', () => {
    it('rejects a scene with an unknown field at root level', () => {
      const sceneWithRootUnknown = makeCanonicalV5Scene({
        futureRootField: { extra: 'data' },
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithRootUnknown);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected admission to be rejected');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.futureRootField');
      expect(outcome.reason).toContain('unknown fields');
      expect(outcome.reason).toContain('wire compatibility');
    });

    it('rejects a scene with an unknown field in meta', () => {
      const sceneWithMetaUnknown = makeCanonicalV5Scene({
        meta: {
          title: 'Canonical V5 Scene',
          futureMetaProperty: 'unrecognized',
        },
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithMetaUnknown);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected admission to be rejected');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.meta.futureMetaProperty');
    });

    it('rejects a scene with an unknown field in markers', () => {
      const sceneWithMarkerUnknown = makeCanonicalV5Scene({
        meta: {
          title: 'Canonical V5 Scene',
          markers: [
            {
              markerId: 'marker-1',
              time: 0,
              label: 'Start',
              futureMarkerProp: true,
            },
          ],
        },
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithMarkerUnknown);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected admission to be rejected');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.meta.markers[0].futureMarkerProp');
    });

    it('rejects a scene with an unknown field on a statement root', () => {
      const sceneWithStatementUnknown = makeCanonicalV5Scene({
        statements: [
          {
            id: 'dialogue-1',
            time: 0,
            type: 'dialogue',
            futureStatementProp: 12345,
            params: {
              text: 'Hello',
              durationSeconds: 1,
            },
          },
        ],
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithStatementUnknown);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected admission to be rejected');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.statements[0].futureStatementProp');
    });

    it('rejects a scene with an unknown field inside statement params', () => {
      const sceneWithParamUnknown = makeCanonicalV5Scene({
        statements: [
          {
            id: 'dialogue-1',
            time: 0,
            type: 'dialogue',
            params: {
              text: 'Hello',
              durationSeconds: 1,
              futureDialogueParam: { nested: true },
            },
          },
        ],
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithParamUnknown);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected admission to be rejected');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.statements[0].params.futureDialogueParam');
    });

    it('rejects a scene with an unknown field on a companion root', () => {
      const sceneWithCompanionUnknown = makeCanonicalV5Scene({
        statements: [
          {
            id: 'dialogue-1',
            time: 0,
            type: 'dialogue',
            params: {
              text: 'Hello',
              durationSeconds: 1,
            },
            companions: [
              {
                id: 'camera-comp-1',
                anchor: 'start',
                offset: 0,
                type: 'camera',
                futureCompanionProp: 'foo',
                params: {
                  mode: 'focus',
                  target: 'hero',
                },
              },
            ],
          },
        ],
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithCompanionUnknown);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected admission to be rejected');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.statements[0].companions[0].futureCompanionProp');
    });

    it('rejects a scene with an unknown field inside companion params', () => {
      const sceneWithCompanionParamUnknown = makeCanonicalV5Scene({
        statements: [
          {
            id: 'dialogue-1',
            time: 0,
            type: 'dialogue',
            params: {
              text: 'Hello',
              durationSeconds: 1,
            },
            companions: [
              {
                id: 'camera-comp-1',
                anchor: 'start',
                offset: 0,
                type: 'camera',
                params: {
                  mode: 'focus',
                  target: 'hero',
                  futureCameraParam: 'cinematic',
                },
              },
            ],
          },
        ],
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithCompanionParamUnknown);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected admission to be rejected');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.statements[0].companions[0].params.futureCameraParam');
    });

    it('rejects a scene with an unknown field inside the visual block', () => {
      const sceneWithVisualUnknown = makeCanonicalV5Scene({
        visual: {
          futureVisualField: 'unrecognized',
          visualTargets: {
            hero: {
              targetType: 'character',
              futureTargetField: true,
            },
          },
        },
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithVisualUnknown);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected admission to be rejected');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.visual');
    });

    it('rejects a CompatibleSceneSession instance containing unknown fields', () => {
      const source = makeCanonicalV5Scene({
        futureRootField: 'preserved',
        meta: {
          title: 'V5',
          futureMeta: 'preserved',
        },
      });

      const openOutcome = CompatibleSceneSession.open(source);
      expect(openOutcome.status).toBe('ready');
      if (openOutcome.status !== 'ready') throw new Error('Expected open to succeed');

      const outcome = validateCanonicalV5CollaborationAdmission(openOutcome.session);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected rejection');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_fields_present');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.futureRootField');
      expect(outcome.issue.unknownFieldPaths).toContain('scene.meta.futureMeta');
    });

    it('assertAdmission throws CollaborativeSceneAdmissionError with actionable outcome details', () => {
      const gate = new CollaborativeSceneAdmissionGate();
      const sourceWithUnknown = makeCanonicalV5Scene({
        futureRootField: 'blocked',
      });

      expect(() => gate.assertAdmission(sourceWithUnknown)).toThrow(CollaborativeSceneAdmissionError);

      try {
        gate.assertAdmission(sourceWithUnknown);
      } catch (error) {
        expect(error).toBeInstanceOf(CollaborativeSceneAdmissionError);
        const admissionError = error as CollaborativeSceneAdmissionError;
        expect(admissionError.outcome.status).toBe('incompatible');
        expect(admissionError.outcome.issue.code).toBe('unknown_fields_present');
        expect(admissionError.outcome.reason).toContain('scenes with unknown fields cannot enter exact-version collaboration');
      }
    });
  });

  describe('Non-v5, future epoch, and malformed scene rejections', () => {
    it('rejects scene v4 with unsupported_schema_version outcome explaining migration required', () => {
      const sceneV4 = {
        schemaVersion: 4,
        sceneId: 'scene-v4',
        meta: { title: 'V4 Scene' },
        statements: [],
      };

      const outcome = validateCanonicalV5CollaborationAdmission(sceneV4);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected rejection');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unsupported_schema_version');
      expect(outcome.reason).toContain('migration to canonical v5');
    });

    it('rejects scene v3 with unsupported_schema_version outcome explaining migration required', () => {
      const sceneV3 = {
        schemaVersion: 3,
        sceneId: 'scene-v3',
        meta: { title: 'V3 Scene' },
        statements: [],
      };

      const outcome = validateCanonicalV5CollaborationAdmission(sceneV3);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected rejection');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unsupported_schema_version');
      expect(outcome.reason).toContain('migration to canonical v5');
    });

    it('rejects legacy v1 and v2 scenes explaining offline migration required', () => {
      const sceneV2 = {
        schemaVersion: 2,
        sceneId: 'scene-v2',
      };

      const outcome = validateCanonicalV5CollaborationAdmission(sceneV2);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected rejection');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unsupported_schema_version');
      expect(outcome.reason).toContain('offline migration');
    });

    it('rejects future schema epoch scene documents', () => {
      const sceneV6 = {
        schemaVersion: 6,
        sceneId: 'scene-v6',
        meta: { title: 'V6 Scene' },
        statements: [],
      };

      const outcome = validateCanonicalV5CollaborationAdmission(sceneV6);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected rejection');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unsupported_schema_version');
      expect(outcome.reason).toContain('Unsupported scene schema epoch 6; expected 5');
    });

    it('rejects unversioned and malformed scenes', () => {
      const unversioned = {
        sceneId: 'unversioned',
        meta: { title: 'No version' },
        statements: [],
      };

      const outcome = validateCanonicalV5CollaborationAdmission(unversioned);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected rejection');

      expect(outcome.status).toBe('invalid');
      expect(outcome.issue.code).toBe('malformed_scene');
    });

    it('rejects scenes with unknown discriminators (e.g. unknown statement family)', () => {
      const sceneWithUnknownFamily = makeCanonicalV5Scene({
        statements: [
          {
            id: 'stmt-1',
            time: 0,
            type: 'future_unknown_statement_family',
            params: {},
          },
        ],
      });

      const outcome = validateCanonicalV5CollaborationAdmission(sceneWithUnknownFamily);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected rejection');

      expect(outcome.status).toBe('incompatible');
      expect(outcome.issue.code).toBe('unknown_discriminator');
    });
  });

  describe('Strict preflight isolation: no mutation or side effects on failure', () => {
    it('leaves local source JSON strictly untouched when admission is rejected', () => {
      const originalSource = makeCanonicalV5Scene({
        futureRootField: { deep: [1, 2, 3] },
        meta: {
          title: 'Canonical V5 Scene',
          futureMeta: 'keep_me',
        },
        statements: [
          {
            id: 'dialogue-1',
            time: 0,
            type: 'dialogue',
            futureStatement: { flag: true },
            params: {
              text: 'Hello',
              durationSeconds: 1,
              futureParam: 'exact_value',
            },
          },
        ],
      });

      const serializedBefore = JSON.stringify(originalSource);
      const outcome = validateCanonicalV5CollaborationAdmission(originalSource);
      const serializedAfter = JSON.stringify(originalSource);

      expect(outcome.ok).toBe(false);
      expect(serializedAfter).toBe(serializedBefore);
      expect(originalSource).toHaveProperty('futureRootField');
      expect((originalSource as any).meta).toHaveProperty('futureMeta');
      expect((originalSource as any).statements[0]).toHaveProperty('futureStatement');
      expect((originalSource as any).statements[0].params).toHaveProperty('futureParam');
    });

    it('leaves CompatibleSceneSession and its Compatibility Source strictly untouched on rejection', () => {
      const source = makeCanonicalV5Scene({
        futureRootField: 'untouched',
      });

      const openOutcome = CompatibleSceneSession.open(source);
      if (openOutcome.status !== 'ready') throw new Error('Expected open to succeed');
      const session = openOutcome.session;

      const serializedSessionBefore = JSON.stringify(session.serialize());
      const outcome = validateCanonicalV5CollaborationAdmission(session);
      const serializedSessionAfter = JSON.stringify(session.serialize());

      expect(outcome.ok).toBe(false);
      expect(serializedSessionAfter).toBe(serializedSessionBefore);
      expect(session.hasUnknownFields).toBe(true);
    });

    it('fails before collaborative seeding, Yjs doc mutation, WebSocket connect, or asset transfer', async () => {
      const sourceWithUnknown = makeCanonicalV5Scene({
        futureRootField: 'blocking_field',
      });

      const mockClient = {
        join: vi.fn(async () => null),
        seed: vi.fn(async () => undefined),
        connectRealtime: vi.fn(async () => undefined),
        getState: vi.fn(() => null),
        subscribeRealtimeConnection: vi.fn(() => () => undefined),
        subscribeErrors: vi.fn(() => () => undefined),
        subscribePresence: vi.fn(() => () => undefined),
        dispose: vi.fn(),
      };

      const mockDocumentStore = {
        getCurrentSceneDocumentSnapshot: () => sourceWithUnknown as any,
        getHistoricalSceneDocumentV4Snapshot: () => null,
      };

      const mockCoordinator = {};
      const prepareSeedState = vi.fn(async () => ({ document: sourceWithUnknown as any, assets: {} }));
      const prepareLocalState = vi.fn(async () => ({ document: sourceWithUnknown as any, assets: {} }));

      const orchestrator = new CollaborativeSessionOrchestratorV2();

      await expect(orchestrator.start({
        endpoint: '127.0.0.1:12345',
        identity: { clientId: 'client-1', displayName: 'User' },
        collaborationProjectId: 'proj-1',
        roomId: 'room-1',
        documentStore: mockDocumentStore as any,
        coordinator: mockCoordinator as any,
        client: mockClient as any,
        prepareSeedState,
        prepareLocalState,
        enforceCanonicalV5Admission: true,
      })).rejects.toThrow(CollaborativeSceneAdmissionError);

      // Verify no network or state actions occurred
      expect(mockClient.join).not.toHaveBeenCalled();
      expect(mockClient.seed).not.toHaveBeenCalled();
      expect(mockClient.connectRealtime).not.toHaveBeenCalled();
      expect(prepareSeedState).not.toHaveBeenCalled();
      expect(prepareLocalState).not.toHaveBeenCalled();
      expect(orchestrator.activeLayer).toBeNull();
    });
  });
});
