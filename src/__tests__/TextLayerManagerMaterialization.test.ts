/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stageLayer = {
  children: [] as any[],
  addChild(child: any) {
    child.parent = this;
    this.children.push(child);
    return child;
  },
  removeChild(child: any) {
    this.children = this.children.filter((entry) => entry !== child);
    child.parent = null;
    return child;
  },
};

vi.mock('pixi.js', () => {
  class Container {
    children: any[] = [];
    parent: any = null;
    visible = true;
    destroyed = false;
    x = 0;
    y = 0;
    rotation = 0;
    alpha = 1;
    scale = { x: 1, y: 1, set: (value: number) => { this.scale.x = value; this.scale.y = value; } };
    transform = {};

    addChild(child: any) {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    removeChild(child: any) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parent = null;
      return child;
    }

    destroy() {
      this.destroyed = true;
      this.children = [];
    }
  }

  class Graphics {
    transform = {};
    beginFill() { return this; }
    drawRect() { return this; }
    endFill() { return this; }
    clear() { return this; }
  }

  class TextStyle {
    fontSize = 36;
    lineHeight = 50;
    constructor(options: any) { Object.assign(this, options); }
  }

  class Text {
    anchor = { set: vi.fn() };
    resolution = 1;
    mask: any = null;
    public text: string;
    public style: any;
    constructor(textOrOptions: string | { text: string; style: any }, legacyStyle?: any) {
      this.text = typeof textOrOptions === 'string' ? textOrOptions : textOrOptions.text;
      this.style = typeof textOrOptions === 'string' ? legacyStyle : textOrOptions.style;
    }
  }

  return {
    Container,
    Graphics,
    TextStyle,
    Text,
    CanvasTextMetrics: { measureText: vi.fn(() => ({ lines: ['Hello'], width: 100, height: 50 })) },
  };
});

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getLayer: vi.fn(() => stageLayer),
  },
}));

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: { get: vi.fn(() => 0.05) },
}));

import { textLayerManager } from '../engine/TextLayerManager';

describe('TextLayerManager materialized state', () => {
  beforeEach(() => {
    textLayerManager.clearAll();
    stageLayer.children.length = 0;
  });

  it('applies a middle-timestamp transform to an existing layer', () => {
    textLayerManager.addLayer({ id: 'title', text: 'Hello', style: 'instant' });
    const container = textLayerManager.getLayerContainer('title') as any;

    textLayerManager.applyLayerState('title', {
      position: [0.75, 0.25],
      scale: 1.5,
      rotation: 12,
      opacity: 0.4,
      visible: true,
    });

    expect(container.x).toBeCloseTo(1440);
    expect(container.y).toBeCloseTo(270);
    expect(container.scale.x).toBeCloseTo(1.5);
    expect(container.rotation).toBeCloseTo(12 * Math.PI / 180);
    expect(container.alpha).toBeCloseTo(0.4);
  });

  it('hides inactive layers and reuses the same proxy when reconciling', () => {
    textLayerManager.addLayer({ id: 'title', text: 'Hello', style: 'instant' });
    const proxy = textLayerManager.getProxy('title');
    textLayerManager.reconcileLayers(new Map());
    expect((textLayerManager.getLayerContainer('title') as any).visible).toBe(false);

    textLayerManager.reconcileLayers(new Map([
      ['title', {
        config: { id: 'title', text: 'Hello', style: 'instant' },
        position: [0.5, 0.5] as [number, number],
        scale: 1,
        rotation: 0,
        opacity: 1,
      }],
    ]));

    expect(textLayerManager.getProxy('title')).toBe(proxy);
    expect((textLayerManager.getLayerContainer('title') as any).visible).toBe(true);
    expect((textLayerManager.getLayerContainer('title') as any).alpha).toBe(1);
  });

  it('rebuilds a same-id layer when text content or style changes', () => {
    textLayerManager.addLayer({ id: 'title', text: 'Hello', style: 'instant', color: '#FFFFFF' });
    const previous = textLayerManager.getLayerContainer('title') as any;

    textLayerManager.reconcileLayers(new Map([
      ['title', {
        config: { id: 'title', text: 'Replacement', style: 'fadeIn', color: '#FF0000' },
        position: [0.5, 0.5] as [number, number],
        scale: 1,
        rotation: 0,
        opacity: 1,
      }],
    ]));

    const replacement = textLayerManager.getLayerContainer('title') as any;
    expect(replacement).not.toBe(previous);
    expect(previous.destroyed).toBe(true);
    expect(replacement.children[0].text).toBe('Replacement');
    expect(replacement.children[0].style.fill).toBe('#FF0000');
  });
});
