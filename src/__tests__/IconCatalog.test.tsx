/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  IconAgent,
  IconAiProse,
  IconCinematicMaster,
  IconError,
  IconPerformanceDirector,
  IconPlay,
  IconSearch,
  IconSelectLeft,
  IconSelectRight,
  IconSparkles,
  IconThink,
  IconToolCompaction,
  IconToolProjectFiles,
  IconToolProjectOverview,
  IconToolProjectSearch,
  IconToolProjectText,
  IconToolResourceInspect,
  IconToolResourceSearch,
  IconTools,
  IconToolSceneRead,
  IconToolSceneSearch,
  IconToolSceneValidate,
  IconToolTerminal,
  IconToolVision,
  IconToolWrite,
  IconWarning,
} from '../ui/icons';
import { ActionIcons } from '../ui/timeline/TimelineConstants';

const REQUIRED_ACTION_ICONS = [
  'dialogue',
  'playMotion',
  'setExpression',
  'moveCharacter',
  'transformCharacter',
  'characterLookAt',
  'characterBlink',
  'addCharacter',
  'removeCharacter',
  'setCharacterRimLight',
  'cameraMotion',
  'cameraMove',
  'cameraFollow',
  'cameraPath',
  'cameraShake',
  'cameraHitchcock',
  'cameraReset',
  'setBackground',
  'transformBackground',
  'removeBackground',
  'setEnvironmentLayer',
  'transformEnvironmentLayer',
  'removeEnvironmentLayer',
  'addLensFilter',
  'changeLensFilter',
  'resetLensFilters',
  'setCompositeRecipe',
  'modulateComposite',
  'setLighting',
  'resetLighting',
  'setBlur',
  'resetBlur',
  'setGodrays',
  'resetGodrays',
  'setPostProcessing',
  'resetPostProcessing',
  'addColorOverlay',
  'removeColorOverlay',
  'clearColorOverlays',
  'addPointLight',
  'removePointLight',
  'clearPointLights',
  'playAudio',
  'stopAudio',
  'setBGM',
  'addImage',
  'addTextLayer',
  'transformTextLayer',
  'removeTextLayer',
  'playCustomAnimation',
  'default',
] as const;

const getSvg = (container: HTMLElement) => container.querySelector('svg');

describe('icon catalog', () => {
  it('forwards width, height, className, title, and aria attributes', () => {
    const { container } = render(
      <IconSearch
        width={18}
        height={16}
        className="custom-icon"
        title="Search"
        role="img"
        aria-label="Search"
        data-testid="search-icon"
      />,
    );

    const svg = screen.getByTestId('search-icon');
    expect(svg).toHaveAttribute('width', '18');
    expect(svg).toHaveAttribute('height', '16');
    expect(svg).toHaveClass('mgf-icon');
    expect(svg).toHaveClass('custom-icon');
    expect(svg).toHaveAttribute('title', 'Search');
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', 'Search');
    expect(getSvg(container)).toBe(svg);
  });

  it('uses currentColor so CSS themes control icon color', () => {
    const { container: play } = render(<IconPlay width={14} height={14} />);
    const { container: search } = render(<IconSearch width={14} height={14} />);

    expect(getSvg(play)).toHaveAttribute('fill', 'currentColor');
    expect(getSvg(search)).toHaveAttribute('stroke', 'currentColor');
  });

  it('does not hide icons labelled by aria-labelledby', () => {
    render(
      <>
        <span id="warning-title">Warning</span>
        <IconWarning aria-labelledby="warning-title" data-testid="warning-icon" />
      </>,
    );

    expect(screen.getByTestId('warning-icon')).not.toHaveAttribute('aria-hidden');
  });

  it('exports new specific glyphs for repeated UI concepts', () => {
    const icons = [
      IconSelectLeft,
      IconSelectRight,
      IconWarning,
      IconError,
    ];

    icons.forEach((Icon) => {
      const { container } = render(<Icon width={15} height={15} />);
      const svg = getSvg(container);

      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg).toHaveClass('mgf-icon');
    });
  });
});

describe('timeline action icons', () => {
  it('keeps dynamic action icon keys renderable', () => {
    for (const key of REQUIRED_ACTION_ICONS) {
      const Icon = ActionIcons[key];
      const { container } = render(<Icon width={14} height={14} data-testid={`action-${key}`} />);
      const svg = getSvg(container);
      expect(svg).toHaveAttribute('width', '14');
      expect(svg).toHaveAttribute('height', '14');
      expect(svg).toHaveClass('mgf-icon');
    }
  });

  it('does not reuse identical glyphs for different dense timeline concepts', () => {
    const renderGlyph = (key: keyof typeof ActionIcons) => {
      const Icon = ActionIcons[key];
      const { container } = render(<Icon width={14} height={14} />);
      return getSvg(container)?.innerHTML;
    };

    const distinctPairs: Array<[keyof typeof ActionIcons, keyof typeof ActionIcons]> = [
      ['addLensFilter', 'changeLensFilter'],
      ['setCompositeRecipe', 'modulateComposite'],
      ['characterLookAt', 'characterBlink'],
      ['setBackground', 'setEnvironmentLayer'],
      ['setLighting', 'setCharacterRimLight'],
      ['playAudio', 'setBGM'],
      ['addTextLayer', 'dialogue'],
      ['removeTextLayer', 'removeCharacter'],
    ];

    distinctPairs.forEach(([left, right]) => {
      expect(renderGlyph(left)).not.toEqual(renderGlyph(right));
    });
  });

  it('defaults action icons without explicit dimensions to the legacy compact size', () => {
    const Icon = ActionIcons.dialogue;
    const { container } = render(<Icon data-testid="action-dialogue-default-size" />);
    const svg = getSvg(container);

    expect(svg).toHaveAttribute('width', '14');
    expect(svg).toHaveAttribute('height', '14');
  });
});

describe('AI and Agent feature icons', () => {
  const AI_FEATURE_ICONS = [
    { name: 'IconSparkles', Icon: IconSparkles },
    { name: 'IconAgent', Icon: IconAgent },
    { name: 'IconThink', Icon: IconThink },
    { name: 'IconTools', Icon: IconTools },
    { name: 'IconAiProse', Icon: IconAiProse },
    { name: 'IconPerformanceDirector', Icon: IconPerformanceDirector },
    { name: 'IconCinematicMaster', Icon: IconCinematicMaster },
  ];

  it('renders all AI feature icons with valid SVG structure and attributes', () => {
    AI_FEATURE_ICONS.forEach(({ name, Icon }) => {
      const { container } = render(<Icon width={16} height={16} data-testid={`ai-${name}`} />);
      const svg = getSvg(container);

      expect(svg).toHaveAttribute('width', '16');
      expect(svg).toHaveAttribute('height', '16');
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg).toHaveClass('mgf-icon');
    });
  });

  it('ensures AI feature icons have distinct visual glyphs', () => {
    const glyphs = new Map<string, string>();
    AI_FEATURE_ICONS.forEach(({ name, Icon }) => {
      const { container } = render(<Icon width={16} height={16} />);
      const inner = getSvg(container)?.innerHTML ?? '';
      expect(glyphs.has(inner)).toBe(false);
      glyphs.set(inner, name);
    });
  });
});

describe('Agent activity stream tool icons', () => {
  const TOOL_ICONS = [
    { name: 'IconToolSceneRead', Icon: IconToolSceneRead },
    { name: 'IconToolSceneSearch', Icon: IconToolSceneSearch },
    { name: 'IconToolSceneValidate', Icon: IconToolSceneValidate },
    { name: 'IconToolProjectOverview', Icon: IconToolProjectOverview },
    { name: 'IconToolProjectFiles', Icon: IconToolProjectFiles },
    { name: 'IconToolProjectText', Icon: IconToolProjectText },
    { name: 'IconToolProjectSearch', Icon: IconToolProjectSearch },
    { name: 'IconToolResourceSearch', Icon: IconToolResourceSearch },
    { name: 'IconToolResourceInspect', Icon: IconToolResourceInspect },
    { name: 'IconToolVision', Icon: IconToolVision },
    { name: 'IconToolTerminal', Icon: IconToolTerminal },
    { name: 'IconToolWrite', Icon: IconToolWrite },
    { name: 'IconToolCompaction', Icon: IconToolCompaction },
  ];

  it('renders each tool activity icon cleanly with viewBox 0 0 24 24', () => {
    TOOL_ICONS.forEach(({ name, Icon }) => {
      const { container } = render(<Icon width={12} height={12} data-testid={`tool-${name}`} />);
      const svg = getSvg(container);

      expect(svg).toHaveAttribute('width', '12');
      expect(svg).toHaveAttribute('height', '12');
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg).toHaveClass('mgf-icon');
    });
  });

  it('ensures each tool activity icon has a distinct glyph representation', () => {
    const glyphs = new Map<string, string>();
    TOOL_ICONS.forEach(({ name, Icon }) => {
      const { container } = render(<Icon width={12} height={12} />);
      const inner = getSvg(container)?.innerHTML ?? '';
      expect(glyphs.has(inner)).toBe(false);
      glyphs.set(inner, name);
    });
  });
});
