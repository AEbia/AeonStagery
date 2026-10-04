import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { stageManager } from './StageManager';
import { settingsManager } from '../ui/SettingsStore';
import type { TextLayerConfig, TextLayerTransformConfig } from '../api/types/textLayer';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

class TextLayerManager {
  // Mapping of active layers and their visual containers
  private layers = new Map<string, PIXI.Container>();

  // Material content/config identity is separate from the animated transform
  // so a seek can reuse a layer safely, but same-id text/style replacements
  // still rebuild the actual Pixi text object.
  private layerMaterialSignatures = new Map<string, string>();
  
  // Proxies used by GSAP to animate values linearly across the timeline
  private proxies = new Map<string, { x: number; y: number; scale: number; rotation: number; alpha: number }>();
  
  // Callbacks to synchronize masks or internal properties during seek
  private syncCallbacks = new Map<string, () => void>();

  // Typewriter reveal callbacks are retained so a seek can materialize the
  // exact mask state without relying on nested GSAP callbacks firing.
  private typewriterCallbacks = new Map<string, (progress: number) => void>();

  // Synchronizes the proxies to the actual PIXI containers
  public applyProxyTransform(id: string) {
    const container = this.layers.get(id);
    const proxy = this.proxies.get(id);
    if (container && proxy && !container.destroyed) {
      if (!container.destroyed) container.visible = true;
      container.x = proxy.x;
      container.y = proxy.y;
      container.scale.set(proxy.scale);
      container.rotation = proxy.rotation * (Math.PI / 180);
      container.alpha = proxy.alpha;
    }
  }

  public applyAllProxyTransforms() {
    for (const id of this.layers.keys()) {
      this.applyProxyTransform(id);
      this.syncCallbacks.get(id)?.();
    }
  }

  public getProxy(id: string) {
    if (!this.proxies.has(id)) {
      this.proxies.set(id, { x: 0, y: 0, scale: 1, rotation: 0, alpha: 0 });
    }
    return this.proxies.get(id)!;
  }

  public getLayerContainer(id: string): PIXI.Container | null {
    return this.layers.get(id) ?? null;
  }
  
  public clearAll() {
    this.proxies.clear();
    this.syncCallbacks.clear();
    this.typewriterCallbacks.clear();
    this.layerMaterialSignatures.clear();
    const layer = stageManager.getLayer('subtitle');
    if (layer) {
      // Find all text layer containers (they have an identifier or just clear all children?)
      // We can't clear all children, subtitle renderer also uses this layer.
      for (const container of this.layers.values()) {
        if (container.parent) container.parent.removeChild(container);
        container.destroy({ children: true });
      }
    }
    this.layers.clear();
  }

  public hasLayer(id: string): boolean {
    const container = this.layers.get(id);
    return Boolean(container && !container.destroyed);
  }

  /** Create a layer when materialized seek state needs one. */
  public ensureLayer(config: TextLayerConfig): void {
    const signature = this.getLayerMaterialSignature(config);
    if (!this.hasLayer(config.id) || this.layerMaterialSignatures.get(config.id) !== signature) {
      this.addLayer(config);
    }
    const container = this.layers.get(config.id);
    if (container && !container.destroyed) container.visible = true;
  }

  /**
   * Apply a materialized state without creating/playing a second timeline.
   * `typewriterProgress` is optional and only affects typewriter masks.
   */
  public applyLayerState(
    id: string,
    state: {
      position?: [number, number];
      scale?: number;
      rotation?: number;
      opacity?: number;
      typewriterProgress?: number;
      visible?: boolean;
    },
  ): void {
    const proxy = this.getProxy(id);
    if (state.position) {
      proxy.x = state.position[0] * STAGE_WIDTH;
      proxy.y = state.position[1] * STAGE_HEIGHT;
    }
    if (state.scale !== undefined) proxy.scale = state.scale;
    if (state.rotation !== undefined) proxy.rotation = state.rotation;
    if (state.opacity !== undefined) proxy.alpha = state.opacity;
    this.applyProxyTransform(id);

    const container = this.layers.get(id);
    if (container && !container.destroyed && state.visible !== undefined) {
      container.visible = state.visible;
    }
    if (state.typewriterProgress !== undefined) {
      this.typewriterCallbacks.get(id)?.(Math.max(0, Math.min(1, state.typewriterProgress)));
    }
  }

  /** Hide a layer during seek while preserving its proxy for future playback. */
  public hideLayer(id: string): void {
    const container = this.layers.get(id);
    const proxy = this.proxies.get(id);
    if (proxy) {
      proxy.alpha = 0;
      this.applyProxyTransform(id);
    }
    if (container && !container.destroyed) container.visible = false;
  }

  public reconcileLayers(
    activeLayers: ReadonlyMap<string, {
      config: Record<string, any>;
      position: [number, number];
      scale: number;
      rotation: number;
      opacity: number;
      typewriterProgress?: number;
    }>,
  ): void {
    for (const id of this.layers.keys()) {
      if (!activeLayers.has(id)) this.hideLayer(id);
    }

    for (const [id, state] of activeLayers) {
      this.ensureLayer({ ...state.config, id } as TextLayerConfig);
      this.applyLayerState(id, {
        position: state.position,
        scale: state.scale,
        rotation: state.rotation,
        opacity: state.opacity,
        typewriterProgress: state.typewriterProgress,
        visible: true,
      });
    }
  }

  /**
   * Processes text for proper CJK/Mixed wrapping without breaking English words.
   */
  private processText(text: string): string {
    if (!text) return '';
    const cjkRange = '\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef';
    const cjkRegex = new RegExp(`([${cjkRange}])`, 'g');
    const boundaryRegex1 = new RegExp(`([a-zA-Z0-9])([${cjkRange}])`, 'g');
    const boundaryRegex2 = new RegExp(`([${cjkRange}])([a-zA-Z0-9])`, 'g');

    return text
      .replace(boundaryRegex1, '$1\u200B$2')
      .replace(boundaryRegex2, '$1\u200B$2')
      .replace(cjkRegex, '$1\u200B');
  }

  public addLayer(config: TextLayerConfig): gsap.core.Timeline {
    const {
      id,
      text: rawText,
      position = [0.5, 0.5],
      scale = 1,
      rotation = 0,
      opacity = 1,
      fontFamily = "'Outfit', 'Inter', 'Noto Sans SC', sans-serif",
      fontSize = 60,
      color = '#FFFFFF',
      stroke = '#000000',
      strokeThickness = 4,
      dropShadow = true,
      dropShadowColor = '#000000',
      dropShadowAlpha = 0.5,
      dropShadowBlur = 8,
      dropShadowDistance = 4,
      style = 'fadeIn',
      duration = 0.5,
      wordWrapWidth = STAGE_WIDTH - 200,
    } = config;

    this.layerMaterialSignatures.set(id, this.getLayerMaterialSignature(config));

    const previous = this.layers.get(id);
    if (previous && !previous.destroyed) {
      if (previous.parent) previous.parent.removeChild(previous);
      previous.destroy({ children: true });
    }
    this.syncCallbacks.delete(id);
    this.typewriterCallbacks.delete(id);

    const container = new PIXI.Container();
    const textStyle = new PIXI.TextStyle({
      fontFamily,
      fontSize,
      fill: color,
      stroke: { color: stroke, width: strokeThickness },
      dropShadow: dropShadow
        ? { color: dropShadowColor, alpha: dropShadowAlpha, blur: dropShadowBlur, distance: dropShadowDistance }
        : false,
      wordWrap: true,
      wordWrapWidth: wordWrapWidth,
      breakWords: false,
      align: 'center',
      padding: 20,
    });

    const text = this.processText(rawText);
    const pixiText = new PIXI.Text({ text, style: textStyle });
    pixiText.resolution = 2;
    
    // Center the text anchor
    pixiText.anchor.set(0.5);
    
    container.addChild(pixiText);

    // Initial Transform Proxy
    const proxy = this.getProxy(id);
    proxy.x = position[0] * STAGE_WIDTH;
    proxy.y = position[1] * STAGE_HEIGHT;
    proxy.scale = scale;
    proxy.rotation = rotation;
    proxy.alpha = 0; // Handled by entrance animation

    // Text Mask for typewriter
    const textMask = new PIXI.Graphics();
    textMask.beginFill(0xFFFFFF).drawRect(-STAGE_WIDTH, -STAGE_HEIGHT, 0, 0).endFill();
    container.addChild(textMask);
    
    if (style === 'typewriter') {
      pixiText.mask = textMask;
    }

    const layer = stageManager.getLayer('subtitle');
    if (layer && !layer.destroyed) {
      layer.addChild(container);
    }
    this.layers.set(id, container);
    this.applyProxyTransform(id);
    container.visible = true;

    const tl = gsap.timeline();

    // ── Animations ──
    const syncCallbacks: (() => void)[] = [];
    tl.eventCallback('onUpdate', () => {
      this.applyProxyTransform(id);
      for (const cb of syncCallbacks) cb();
    });

    if (style === 'typewriter') {
      // Basic typewriter mask logic (simplified from SubtitleRenderer)
      proxy.alpha = opacity;
      
      const metrics = PIXI.CanvasTextMetrics.measureText(text, textStyle);
      const charCount = text.length;
      const revealProxy = { charIndex: 0 };
      const LINE_HEIGHT = textStyle.lineHeight || fontSize * 1.4;
      const typeSpeed = settingsManager.get('typewriterSpeed') || 0.05;
      const totalTypeTime = Math.min(duration, charCount * typeSpeed);
      
      const lineCharWidths: number[][] = [];
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) {
        context.font = `${textStyle.fontStyle} ${textStyle.fontVariant} ${textStyle.fontWeight} ${textStyle.fontSize}px ${textStyle.fontFamily}`;
        metrics.lines.forEach((line) => {
          const widths: number[] = [0];
          for (let i = 1; i <= line.length; i++) widths.push(context.measureText(line.substring(0, i)).width);
          lineCharWidths.push(widths);
        });
      }

      const animSteps: { lineIdx: number; localIdx: number }[] = [];
      metrics.lines.forEach((line, lineIdx) => {
        let isInsideTag = false;
        for (let i = 1; i <= line.length; i++) {
          const char = line[i - 1];
          if (char === '<') isInsideTag = true;
          if (char === '\u200B' || isInsideTag) {
            if (char === '>') isInsideTag = false;
            continue;
          }
          animSteps.push({ lineIdx, localIdx: i });
        }
      });

      // Text is centered. But PIXI.Text metrics represent the unpadded width.
      // PIXI's internal texture includes padding, but local origin (0,0) with anchor(0.5) 
      // means the text box bounds are -width/2 to width/2.
      const startX = -metrics.width / 2;
      const startY = -metrics.height / 2;

      const updateMask = () => {
        if (textMask.destroyed) return;
        const stepIdx = Math.floor(revealProxy.charIndex);
        textMask.clear().beginFill(0xFFFFFF);

        if (stepIdx >= animSteps.length) {
          textMask.drawRect(-STAGE_WIDTH, -STAGE_HEIGHT, STAGE_WIDTH * 2, STAGE_HEIGHT * 2);
          textMask.endFill();
          return;
        }

        const currentStep = stepIdx > 0 ? animSteps[Math.min(stepIdx - 1, animSteps.length - 1)] : undefined;
        for (let i = 0; i < metrics.lines.length; i++) {
          const lineY = startY + i * LINE_HEIGHT;
          const widths = lineCharWidths[i];
          if (currentStep && i < currentStep.lineIdx) {
            textMask.drawRect(startX - 20, lineY - 20, widths[widths.length - 1] + 40, LINE_HEIGHT + 40);
          } else if (currentStep && i === currentStep.lineIdx) {
            // Draw perfectly up to the current character width, plus a tiny offset for smooth right-edge strokes
            textMask.drawRect(startX - 20, lineY - 20, widths[currentStep.localIdx] + 20 + 8, LINE_HEIGHT + 40);
            break;
          } else break;
        }
        textMask.endFill();
      };
      
      this.syncCallbacks.set(id, updateMask);
      this.typewriterCallbacks.set(id, (progress) => {
        revealProxy.charIndex = Math.max(0, Math.min(1, progress)) * animSteps.length;
        updateMask();
      });
      syncCallbacks.push(updateMask);
      
      tl.to(revealProxy, {
        charIndex: animSteps.length,
        duration: totalTypeTime,
        ease: 'none',
        onUpdate: () => {
          this.applyProxyTransform(id);
        }
      }, 0);
      
      // Pad out the rest of the duration so the timeline matches action duration
      tl.to({}, { duration: 0.001 }, duration);

    } else if (style === 'cinematic') {
      this.typewriterCallbacks.delete(id);
      proxy.y = proxy.y + 30;
      tl.to(proxy, { alpha: opacity, y: proxy.y - 30, duration: duration, ease: 'power2.out', onUpdate: () => this.applyProxyTransform(id) }, 0);
    } else if (style === 'fadeIn') {
      this.typewriterCallbacks.delete(id);
      tl.to(proxy, { alpha: opacity, duration: duration, ease: 'power2.out', onUpdate: () => this.applyProxyTransform(id) }, 0);
    } else {
      this.typewriterCallbacks.delete(id);
      tl.to(proxy, { alpha: opacity, duration: 0.001, onUpdate: () => this.applyProxyTransform(id) }, 0);
    }

    return tl;
  }

  private getLayerMaterialSignature(config: Partial<TextLayerConfig>): string {
    return JSON.stringify({
      text: config.text ?? '',
      fontFamily: config.fontFamily ?? "'Outfit', 'Inter', 'Noto Sans SC', sans-serif",
      fontSize: config.fontSize ?? 60,
      color: config.color ?? '#FFFFFF',
      stroke: config.stroke ?? '#000000',
      strokeThickness: config.strokeThickness ?? 4,
      dropShadow: config.dropShadow ?? true,
      dropShadowColor: config.dropShadowColor ?? '#000000',
      dropShadowAlpha: config.dropShadowAlpha ?? 0.5,
      dropShadowBlur: config.dropShadowBlur ?? 8,
      dropShadowDistance: config.dropShadowDistance ?? 4,
      style: config.style ?? 'fadeIn',
      duration: config.duration ?? 0.5,
      wordWrapWidth: config.wordWrapWidth ?? STAGE_WIDTH - 200,
    });
  }

  public removeLayer(id: string, duration: number = 0.5): gsap.core.Timeline {
    const tl = gsap.timeline();
    const proxy = this.getProxy(id);
    
    tl.to(proxy, {
      alpha: 0,
      duration: duration,
      ease: 'power2.in',
      onUpdate: () => this.applyProxyTransform(id),
      onComplete: () => {
        const container = this.layers.get(id);
        if (container && !container.destroyed) container.visible = false;
      }
    });
    return tl;
  }

  public transformLayer(config: TextLayerTransformConfig): gsap.core.Timeline {
    const tl = gsap.timeline();
    const { id, position, scale, rotation, opacity, duration, ease = 'power2.inOut' } = config;
    
    const proxy = this.getProxy(id);
    const target: any = {};
    if (position) {
      target.x = position[0] * STAGE_WIDTH;
      target.y = position[1] * STAGE_HEIGHT;
    }
    if (scale !== undefined) target.scale = scale;
    if (rotation !== undefined) target.rotation = rotation;
    if (opacity !== undefined) target.alpha = opacity;

    tl.to(proxy, {
      ...target,
      duration,
      ease,
      onUpdate: () => this.applyProxyTransform(id),
    });

    return tl;
  }
}

export const textLayerManager = new TextLayerManager();
