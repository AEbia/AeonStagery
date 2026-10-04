/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SEMANTIC_STATEMENT_BLOCKS, createSemanticStatementDraftForBlock } from '../ui/timeline/semanticStatementBlocks';
import { VISUAL_TIER_LABELS } from '../ui/timeline/visualPresentation';
import StatementBlockLibrary from '../ui/StatementBlockLibrary';
import { sceneStatementCompiler } from '../services/semantic-scene/SceneStatementCompiler';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';

describe('Visual Effects Authoring (Three Tiers & Usability)', () => {
  it('classifies visual statement blocks into three distinct tiers', () => {
    const visualBlocks = SEMANTIC_STATEMENT_BLOCKS.filter((b) => b.category === 'visual');

    const wheelchairBlocks = visualBlocks.filter((b) => b.visualTier === 'wheelchair');
    const advancedBlocks = visualBlocks.filter((b) => b.visualTier === 'advanced');
    const customBlocks = visualBlocks.filter((b) => b.visualTier === 'custom');

    const wheelchairIds = wheelchairBlocks.map((b) => b.id);
    const advancedIds = advancedBlocks.map((b) => b.id);
    const customIds = customBlocks.map((b) => b.id);

    // 🌟 轮椅阶
    expect(wheelchairIds).toContain('visual.character-integration');
    expect(wheelchairIds).toContain('visual.character-rim-light');
    expect(wheelchairIds).toContain('visual.character-grounding');

    // ⚡ 进阶级
    expect(advancedIds).toContain('lighting.overlay');
    expect(advancedIds).toContain('lighting.blur');
    expect(advancedIds).not.toContain('filter.add');
    expect(advancedIds).not.toContain('filter.change');
    expect(advancedIds).not.toContain('filter.reset');

    // 🛠️ 自定义级
    expect(customIds).toContain('lighting.point-light');
    expect(customIds).toContain('lighting.post');
    expect(customIds).toContain('visual.modulate-character-accent');
    expect(customIds).toContain('visual.modulate-character-distortion');

    // 移除了 lighting.preset 与 lighting.godrays UI 入口
    expect(visualBlocks.find((b) => b.id === 'lighting.preset')).toBeUndefined();
    expect(visualBlocks.find((b) => b.id === 'lighting.modulate-preset')).toBeUndefined();
    expect(visualBlocks.find((b) => b.id === 'lighting.reset-preset')).toBeUndefined();
    expect(visualBlocks.find((b) => b.id === 'lighting.godrays')).toBeUndefined();
    expect(visualBlocks.find((b) => b.id === 'lighting.modulate-godrays')).toBeUndefined();
    expect(visualBlocks.find((b) => b.id === 'lighting.reset-godrays')).toBeUndefined();
  });

  it('renders visual category in StatementBlockLibrary without tiered sub-headers', () => {
    render(
      <StatementBlockLibrary
        activeCategory="visual"
        search=""
        onSearchChange={vi.fn()}
      />
    );

    expect(screen.queryByText(VISUAL_TIER_LABELS.wheelchair)).toBeNull();
    expect(screen.queryByText(VISUAL_TIER_LABELS.advanced)).toBeNull();
    expect(screen.queryByText(VISUAL_TIER_LABELS.custom)).toBeNull();

    expect(screen.getByText('角色色彩融入')).toBeDefined();
    expect(screen.getByText('角色边光')).toBeDefined();
    expect(screen.queryByText('添加滤镜')).toBeNull();
    expect(screen.getByText('添加色彩叠加')).toBeDefined();
    expect(screen.getByText('添加点光源')).toBeDefined();
    expect(screen.getByText('设置后期处理')).toBeDefined();
  });

  it('filters visual blocks using action label in search', () => {
    render(
      <StatementBlockLibrary
        activeCategory="visual"
        search="边光"
        onSearchChange={vi.fn()}
      />
    );

    expect(screen.getByText('角色边光')).toBeDefined();
    expect(screen.queryByText('添加点光源')).toBeNull();
  });

  it('preserves compiler backward compatibility for historical lighting preset statements', () => {
    const historicalDoc: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'test-preset-scene',
      meta: { title: 'Test', durationSeconds: 2 },
      statements: [
        {
          id: 'stmt-hist-preset',
          type: 'lighting',
          time: 0,
          params: {
            effect: 'preset',
            mode: 'set',
            preset: 'warm',
            durationSeconds: 0.5,
          },
        },
      ],
    };

    const compiled = sceneStatementCompiler.compile(historicalDoc);

    expect(compiled.actions.length).toBeGreaterThan(0);
    expect(compiled.actions[0].action).toBe('setLighting');
  });

  it('creates drafts with friendly defaults for wheelchair and advanced statements', () => {
    const sceneMeta = { title: 'Test', characters: [{ id: 'char1', name: 'Alice' }] };

    // 角色色彩融入
    const integrationDraft = createSemanticStatementDraftForBlock('visual.character-integration', { sceneMeta, charId: 'char1' });
    expect(integrationDraft).toMatchObject({
      type: 'visualStyle',
      params: {
        target: 'char1',
        slot: 'integration',
        recipeId: 'builtin:integration-soft',
        intensity: 0.8,
        blend: 0.36,
        contamination: 0.18,
      },
    });

    // 角色边光
    const rimDraft = createSemanticStatementDraftForBlock('visual.character-rim-light', { sceneMeta, charId: 'char1' });
    expect(rimDraft).toMatchObject({
      type: 'visualStyle',
      params: {
        target: 'char1',
        slot: 'rim-light',
        color: '#ffffff',
        thickness: 10,
        angle: 45,
        softness: 2,
      },
    });

    // 进阶级色彩叠加（替代 preset）
    const overlayDraft = createSemanticStatementDraftForBlock('lighting.overlay', {});
    expect(overlayDraft).toMatchObject({
      type: 'lighting',
      params: {
        effect: 'overlay',
        blendMode: 'multiply',
        intensity: 0.5,
      },
    });
  });
});
