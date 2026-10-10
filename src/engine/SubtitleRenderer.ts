/**
 * AeonStagery — Subtitle / Dialogue Renderer (Premium Light Edition)
 *
 * Optimized for high performance:
 * 1. TextMetrics caching to reduce CPU load.
 * 2. Mask-based reveal for built-in boxes; fixed-line text reveal for image boxes.
 * 3. Pluggable Template system.
 */

import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { stageManager } from './StageManager';
import { hookSystem } from '../api/hooks';
import { templates, DialogueConfig } from './DialogueTemplates';
import { ImageDialogueTemplate } from './ImageDialogueTemplate';
import { settingsManager } from '../ui/SettingsStore';
import type { PreparedAssetRef, PreparedCompiledScene, PreparedRuntimeValue } from '../api/types/semantic-scene';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

// Performance: TextMetrics Cache
const metricsCache = new Map<string, PIXI.CanvasTextMetrics>();

class SubtitleRenderer {
  private dialogueContainer: PIXI.Container | null = null;
  private dialogueOpacity = 1;
  private currentTimeline: gsap.core.Timeline | null = null;
  private currentTemplateId: string = 'glass';
  // 彻底解决 Seek 重复创建时间轴/容器导致的打字机消失、画面卡死 Bug
  private dialogueCache = new Map<string, {
    container: PIXI.Container;
    timeline: gsap.core.Timeline;
    config: DialogueConfig;
    fontSize: number;
    textSpeed: number;
  }>();
  private activeConfig: DialogueConfig | null = null;
  private activeFontSize = 48;
  private activeTextSpeed = 0.025;
  /** fontFamily → runtimeUri of dialogue fonts already registered with document.fonts. */
  private readonly loadedDialogueFonts = new Map<string, string>();

  public setTemplate(id: string) {
    this.currentTemplateId = id;
  }

  private buildDialogueCacheKey(
    config: DialogueConfig,
    templateId: string,
    dialogueTextSpeed: number,
  ): string {
    const {
      text: rawText,
      speaker = '',
      speakerId = '',
      speakerColor = '',
      style = 'typewriter',
      duration = 3,
      textColor = '#FFFFFF',
      fontSize = 44,
      position = 'bottom',
      presentation,
    } = config;
    const speedKey = style === 'typewriter' ? dialogueTextSpeed : 'static';
    const textHash = [
      rawText,
      speaker,
      speakerId,
      speakerColor,
      style,
      textColor,
      fontSize,
      position,
      duration,
      templateId,
      presentation ? JSON.stringify(presentation) : '',
      speedKey,
      settingsManager.get('dialogueEntranceAnimation') !== false,
      this.getDialogueFontSize(),
    ].join('_');
    return config._id ? `${config._id}_${textHash}` : textHash;
  }

  private getDialogueFontSize(): number {
    const size = settingsManager.get('dialogueFontSize');
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 48;
  }

  private getCachedMetrics(text: string, style: PIXI.TextStyle): PIXI.CanvasTextMetrics {
    const key = `${text}|${style.styleKey}`;
    if (metricsCache.has(key)) return metricsCache.get(key)!;
    const metrics = PIXI.CanvasTextMetrics.measureText(text, style);
    metricsCache.set(key, metrics);
    // Limit cache size
    if (metricsCache.size > 200) {
      const firstKey = metricsCache.keys().next().value;
      if (firstKey !== undefined) metricsCache.delete(firstKey);
    }
    return metrics;
  }

  showDialogue(config: DialogueConfig): gsap.core.Timeline {
    const {
      text: rawText,
      style = 'typewriter',
      duration = 3,
      textColor = '#FFFFFF',
      fontSize = this.getDialogueFontSize() - 4,
      template: configTemplate,
    } = config;

    const templateId = configTemplate || this.currentTemplateId;
    const dialogueTextSpeed = settingsManager.get('dialogueTextSpeed');
    const cacheKey = this.buildDialogueCacheKey(config, templateId, dialogueTextSpeed);

    // Clean up obsolete cache entries for the same config._id
    if (config._id) {
      for (const oldKey of this.dialogueCache.keys()) {
        if (oldKey.startsWith(`${config._id}_`) && oldKey !== cacheKey) {
          const oldEntry = this.dialogueCache.get(oldKey);
          if (oldEntry) {
            oldEntry.timeline.kill();
            if (oldEntry.container.parent) {
              oldEntry.container.parent.removeChild(oldEntry.container);
            }
            oldEntry.container.destroy({ children: true });
          }
          this.dialogueCache.delete(oldKey);
        }
      }
    }

    if (this.dialogueCache.has(cacheKey)) {
      return this.dialogueCache.get(cacheKey)!.timeline;
    }

    const text = rawText;
    const globalFontSize = this.getDialogueFontSize();
    const container = new PIXI.Container();

    const template = config.presentation?.renderer === 'image-dialogue-v1'
      ? ImageDialogueTemplate
      : templates[templateId] || templates.glass;

    // ── 1. Layout & Metrics ──
    const PADDING = 10;
    const textStyle = new PIXI.TextStyle({
      fontFamily: "'Outfit', 'Inter', 'Noto Sans SC', 'Microsoft YaHei', sans-serif",
      fontSize: fontSize + 4,
      fill: textColor,
      fontWeight: '600',
      stroke: { color: '#000000', width: 3 },
      dropShadow: { color: '#000000', alpha: 0.3, blur: 4, distance: 3 },
      wordWrap: true,
      wordWrapWidth: STAGE_WIDTH - 360,
      // Pixi's tokenizer does not call the legacy isBreakingSpace override.
      // Break oversized tokens directly, including Chinese without spaces.
      breakWords: true,
      lineHeight: Math.round((fontSize + 4) * 1.4),
      letterSpacing: 0.5,
      padding: PADDING,
    });

    const resolvedTextStyle = template.resolveTextStyle?.(config) ?? {};
    for (const [key, value] of Object.entries(resolvedTextStyle)) {
      if (value !== undefined) (textStyle as unknown as Record<string, unknown>)[key] = value;
    }

    if (config.presentation?.renderer === 'image-dialogue-v1') {
      const presentation = config.presentation;
      const originalFontSize = Number(textStyle.fontSize);
      textStyle.fontSize = fontSize + 4;
      textStyle.lineHeight = Math.round(textStyle.lineHeight * Number(textStyle.fontSize) / originalFontSize);
      const inset = Math.max(0, presentation.text.x - presentation.textbox.x);
      textStyle.wordWrapWidth = Math.max(1, Math.min(
        presentation.text.maxWidth,
        presentation.textbox.x + presentation.textbox.width - presentation.text.x - inset,
        STAGE_WIDTH - presentation.text.x - PADDING,
      ));
    } else if (templateId === 'glass') textStyle.wordWrapWidth = STAGE_WIDTH - 360;
    else if (templateId === 'minimal') textStyle.wordWrapWidth = STAGE_WIDTH - 400;

    const metrics = this.getCachedMetrics(text, textStyle);
    // Local body-text preferences must not change the template's speaker font.
    const layout = template.render(container, config, metrics);

    // ── 2. Main Text ──
    const dialogueText = new PIXI.Text({ text, style: textStyle });
    dialogueText.resolution = 2;
    dialogueText.x = layout.textX;
    dialogueText.y = layout.textY;
    container.addChild(dialogueText);

    const textMask = new PIXI.Graphics();
    textMask.beginFill(0xFFFFFF).drawRect(0, 0, 0, 0).endFill();
    dialogueText.mask = textMask;
    container.addChild(textMask);

    // ── Animations ──
    const tl = gsap.timeline({
      onStart: () => {
        if (container.destroyed) return;

        if (this.dialogueContainer && this.dialogueContainer !== container) {
          this.clearStage();
        }

        this.dialogueContainer = container;
        container.visible = this.dialogueOpacity > 0;
        this.currentTimeline = tl;
        this.activeConfig = config;
        this.activeFontSize = globalFontSize;
        const layer = stageManager.getLayer('subtitle');
        if (layer && !layer.destroyed) {
          if (container.parent !== layer) {
            layer.addChild(container);
          }
        }
        hookSystem.execute('dialogue:show', config);
      },
      onReverseComplete: () => {
        if (container.destroyed) return;
        if (container.parent) container.parent.removeChild(container);
        if (this.dialogueContainer === container) {
          this.dialogueContainer = null;
          this.currentTimeline = null;
        }
        hookSystem.execute('dialogue:hide', {});
      }
    });

    const syncCallbacks: (() => void)[] = [];
    tl.eventCallback('onUpdate', () => {
      for (const cb of syncCallbacks) cb();
    });

    const animateEntrance = settingsManager.get('dialogueEntranceAnimation') !== false;
    const textStart = animateEntrance ? 0.2 : 0;
    const entranceProxy = { alpha: 0, y: 40 };
    const syncEntrance = () => {
      if (!container.destroyed) {
        const enabled = settingsManager.get('dialogueEntranceAnimation') !== false;
        container.alpha = (enabled ? entranceProxy.alpha : 1) * this.dialogueOpacity;
        container.y = enabled ? entranceProxy.y : 0;
      }
    };
    syncCallbacks.push(syncEntrance);

    syncEntrance();
    // Alpha fade in quickly
    tl.to(entranceProxy, {
      alpha: 1, duration: 0.2, ease: 'power2.out',
      onUpdate: syncEntrance,
    }, 0);

    // Y position pops up with a slight overshoot (spring effect)
    tl.to(entranceProxy, {
      y: 0, duration: 0.45, ease: 'back.out(1.4)',
      onUpdate: syncEntrance,
    }, 0);
    // Image dialogue reveals text itself so sprite/stencil batching cannot
    // expose the unrevealed suffix. Wrap and alignment use the full metrics.
    if (style === 'typewriter' && config.presentation?.renderer === 'image-dialogue-v1') {
      dialogueText.mask = null;
      container.removeChild(textMask);
      textMask.destroy();
      const lineStyle = textStyle.clone();
      const align = lineStyle.align;
      lineStyle.wordWrap = false;
      lineStyle.align = 'left';
      const lineHeight = (lineStyle.lineHeight || metrics.lineHeight) + lineStyle.leading;
      const lineTexts = metrics.lines.map((_, index) => {
        const lineText = index === 0 ? dialogueText : new PIXI.Text({ text: '', style: lineStyle });
        lineText.style = lineStyle;
        lineText.text = '';
        lineText.resolution = 2;
        const alignmentOffset = metrics.maxLineWidth - metrics.lineWidths[index];
        lineText.x = layout.textX + (align === 'center' ? alignmentOffset / 2 : align === 'right' ? alignmentOffset : 0);
        lineText.y = layout.textY + index * lineHeight;
        if (index > 0) container.addChild(lineText);
        return lineText;
      });
      const steps: { lineIndex: number; end: number }[] = [];
      metrics.lines.forEach((line, lineIndex) => {
        let end = 0;
        for (const character of line) {
          end += character.length;
          if (character !== '\u200B') steps.push({ lineIndex, end });
        }
      });
      const reveal = { count: 0 };
      let lastCount = -1;
      const syncText = () => {
        const count = Math.max(0, Math.min(steps.length, Math.floor(reveal.count + 1e-7)));
        if (count === lastCount || container.destroyed) return;
        lastCount = count;
        const current = count > 0 ? steps[count - 1] : undefined;
        lineTexts.forEach((lineText, index) => {
          const visible = count === steps.length || (current && index < current.lineIndex)
            ? metrics.lines[index]
            : current && index === current.lineIndex ? metrics.lines[index].slice(0, current.end) : '';
          if (lineText.text !== visible) lineText.text = visible;
        });
      };
      syncCallbacks.push(syncText);
      syncText();
      const revealDuration = Math.max(0, Math.min(duration - textStart, steps.length * dialogueTextSpeed));
      tl.to(reveal, {
        // A short authored window truncates the reveal without speeding it up.
        count: revealDuration === steps.length * dialogueTextSpeed ? steps.length : revealDuration / dialogueTextSpeed,
        duration: revealDuration,
        ease: 'none',
        onUpdate: syncText,
      }, textStart);
    } else if (style === 'typewriter') {
      const revealProxy = { charIndex: 0 };

      const lineCharWidths: number[][] = [];
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) {
        context.font = `${textStyle.fontStyle} ${textStyle.fontVariant} ${textStyle.fontWeight} ${textStyle.fontSize}px ${textStyle.fontFamily}`;
        if ('letterSpacing' in context) (context as any).letterSpacing = `${textStyle.letterSpacing}px`;

        metrics.lines.forEach((line) => {
          const widths: number[] = [0];
          for (let i = 1; i <= line.length; i++) {
            widths.push(context.measureText(line.substring(0, i)).width);
          }
          lineCharWidths.push(widths);
        });
      }

      const animSteps: { lineIdx: number; localIdx: number }[] = [];
      metrics.lines.forEach((line, lineIdx) => {
        let isInsideTag = false;
        let localIdx = 0;
        for (const char of line) {
          localIdx += char.length;
          if (char === '<') isInsideTag = true;
          if (char === '\u200B' || isInsideTag) {
            if (char === '>') isInsideTag = false;
            continue;
          }
          animSteps.push({ lineIdx, localIdx });
        }
      });

      const totalTypeTime = Math.max(0, Math.min(duration - textStart, animSteps.length * dialogueTextSpeed));
      const LINE_HEIGHT = textStyle.lineHeight || Number(textStyle.fontSize) * 1.4;
      const updateMask = () => {
        if (textMask.destroyed) return; // Container destroyed during seek
        const stepIdx = Math.floor(revealProxy.charIndex + 1e-7);
        textMask.clear().beginFill(0xFFFFFF);

        // 如果打字机动画已全部完成（或 seek 到动作之后），直接绘制全画幅遮罩，确保文本 100% 完整显示且无任何字符裁切
        if (stepIdx >= animSteps.length) {
          textMask.drawRect(layout.textX - PADDING, layout.textY - PADDING, STAGE_WIDTH, STAGE_HEIGHT);
          textMask.endFill();
          return;
        }

        const currentStep = stepIdx > 0 ? animSteps[Math.min(stepIdx - 1, animSteps.length - 1)] : undefined;
        for (let i = 0; i < metrics.lines.length; i++) {
          const lineY = layout.textY + i * LINE_HEIGHT;
          const widths = lineCharWidths[i];
          if (currentStep && i < currentStep.lineIdx) {
            textMask.drawRect(layout.textX, lineY, widths[widths.length - 1] + PADDING * 2, LINE_HEIGHT + PADDING);
          } else if (currentStep && i === currentStep.lineIdx) {
            // 核心微调：寻找完美平衡点。
            // +3px 会导致当前正在打出的字（特别是 CJK 宽字符及其描边、右侧阴影）后半部分被切掉；
            // +8.5px (PADDING - 1.5) 又会过多暴露下一个未显现的字。
            // 经过精确测算，+6px 是最完美的黄金分割点：既能让当前字的外描边和投影自然过渡不显突兀，又绝不会把下一个字露出。
            textMask.drawRect(layout.textX, lineY, widths[currentStep.localIdx] + 6.9, LINE_HEIGHT + PADDING);
            break;
          } else break;
        }
        textMask.endFill();
      };

      syncCallbacks.push(updateMask);

      tl.to(revealProxy, {
        charIndex: totalTypeTime === animSteps.length * dialogueTextSpeed ? animSteps.length : totalTypeTime / dialogueTextSpeed,
        duration: totalTypeTime,
        ease: 'none',
        onUpdate: updateMask
      }, textStart);
    } else {
      textMask.beginFill(0xFFFFFF).drawRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT).endFill();
      if (style === 'fadeIn') {
        dialogueText.alpha = 0;
        const fadeProxy = { alpha: 0 };
        const syncFade = () => {
          if (!dialogueText.destroyed) dialogueText.alpha = fadeProxy.alpha;
        };
        syncCallbacks.push(syncFade);

        tl.to(fadeProxy, { alpha: 1, duration: 0.6, ease: 'power2.out', onUpdate: syncFade }, textStart);
      } else if (style === 'cinematic') {
        dialogueText.alpha = 0;
        const originalY = dialogueText.y;
        dialogueText.y += 20;
        const cinProxy = { alpha: 0, y: dialogueText.y };
        const syncCinematic = () => {
          if (!dialogueText.destroyed) { dialogueText.alpha = cinProxy.alpha; dialogueText.y = cinProxy.y; }
        };
        syncCallbacks.push(syncCinematic);

        tl.to(cinProxy, { alpha: 1, y: originalY, duration: 0.8, ease: 'power2.out', onUpdate: syncCinematic }, textStart);
      }
    }

    tl.to({}, { duration: 0.001 }, duration);
    this.dialogueCache.set(cacheKey, {
      container,
      timeline: tl,
      config,
      fontSize: globalFontSize,
      textSpeed: dialogueTextSpeed,
    });
    return tl;
  }

  ensureDialogueOnStage(config: DialogueConfig, offset?: number): void {
    const templateId = config.template || this.currentTemplateId;
    const dialogueTextSpeed = settingsManager.get('dialogueTextSpeed');
    const cacheKey = this.buildDialogueCacheKey(config, templateId, dialogueTextSpeed);
    let cached = this.dialogueCache.get(cacheKey);
    // Seek restoration must be tolerant of cache-key drift caused by resolved
    // display fields (speaker/color) or runtime settings (type speed). The
    // timeline cache is keyed by statement id and cleaned on rebuild, so a
    // same-id fallback is safe and matches the pre-cache-refactor behavior.
    if (!cached && config._id) {
      for (const [key, entry] of this.dialogueCache) {
        if (key.startsWith(`${config._id}_`)) {
          cached = entry;
          break;
        }
      }
    }
    if (!cached) return;

    if (cached.fontSize !== this.getDialogueFontSize()
      || ((cached.config.style ?? 'typewriter') === 'typewriter'
        && cached.textSpeed !== settingsManager.get('dialogueTextSpeed'))) {
      // Keep the scheduled position and parent when changing a local dialogue
      // preference; the full resolved config preserves speaker/template data.
      const parent = cached.timeline.parent;
      const start = cached.timeline.startTime();
      const paused = cached.timeline.paused();
      const resolvedConfig = cached.config;
      const replacement = this.showDialogue(resolvedConfig);
      if (parent) parent.add(replacement, start);
      replacement.paused(parent ? paused : true);
      this.ensureDialogueOnStage(resolvedConfig, offset);
      return;
    }

    const { container, timeline } = cached;
    if (container.destroyed) return;

    if (this.dialogueContainer && this.dialogueContainer !== container) {
      if (this.dialogueContainer.parent) {
        this.dialogueContainer.parent.removeChild(this.dialogueContainer);
      }
    }

    this.dialogueContainer = container;
    container.visible = this.dialogueOpacity > 0;
    this.currentTimeline = timeline;
    this.activeConfig = cached.config;
    this.activeFontSize = cached.fontSize;
    this.activeTextSpeed = cached.textSpeed;

    const layer = stageManager.getLayer('subtitle');
    if (layer && !layer.destroyed) {
      if (container.parent !== layer) {
        layer.addChild(container);
      }
    }

    if (offset !== undefined) {
      timeline.seek(offset);
    }

    // 强制执行所有注册的同步回调，保证 PIXI 容器视觉状态和 GSAP 内部 Proxy 对象绝对一致
    const onUpdate = timeline.eventCallback('onUpdate');
    if (typeof onUpdate === 'function') {
      onUpdate();
    }
  }

  /** Apply scene-time opacity without detaching or stopping the dialogue timeline. */
  setDialogueVisibility(visible: boolean, opacity: number = visible ? 1 : 0): void {
    const nextOpacity = Math.max(0, Math.min(1, opacity));
    if (this.dialogueOpacity === nextOpacity) return;
    this.dialogueOpacity = nextOpacity;
    if (this.dialogueContainer && !this.dialogueContainer.destroyed) {
      this.dialogueContainer.visible = this.dialogueOpacity > 0;
      this.forceUpdate();
    }
  }

  hideDialogue(animated: boolean = true): gsap.core.Tween | null {
    if (!this.dialogueContainer) return null;

    hookSystem.execute('dialogue:hide', {});

    // MUST NOT kill this.currentTimeline here!
    // The timeline belongs to the ScriptEngine's masterTimeline.
    // Killing it here permanently breaks scrubbing and typewriter interpolation.
    this.currentTimeline = null;
    this.activeConfig = null;

    if (animated) {
      const container = this.dialogueContainer;
      // Kill any residual tweens on this container before adding a new one
      gsap.killTweensOf(container);
      const hideProxy = { alpha: container.alpha, y: container.y };
      const tween = gsap.to(hideProxy, {
        alpha: 0,
        y: hideProxy.y + 15,
        duration: 0.3,
        ease: 'power3.in',
        onUpdate: () => {
          if (!container.destroyed) {
            container.alpha = hideProxy.alpha;
            container.y = hideProxy.y;
          }
        },
        onComplete: () => {
          if (container.parent) container.parent.removeChild(container);
          // 彻底修复 CTI 拖拽黑屏卡死 Bug：在 Seek 期间不能 destroy 容器本身
          // 因为 GSAP 时间轴是预先构建的，销毁了容器会导致再次 Seek 时找不到渲染 Target。
          // 仅使用 removeChild 脱离渲染树，生命周期最终交由 clear() 统一销毁。
        },
      });
      this.dialogueContainer = null;
      return tween;
    } else {
      this.clearStage();
      return null;
    }
  }

  /**
   * Clears the current dialogue visuals from the stage.
   * Does NOT kill GSAP timelines — dialogue timelines are children of the
   * master timeline and must not be killed during seek (causes GSAP render
   * queue corruption). Timeline lifecycle is managed by hideDialogue/clear.
   */
  private clearStage(): void {
    // Just clear the reference — don't kill the timeline here.
    // Killing sibling timelines mid-seek corrupts GSAP's render queue.
    this.currentTimeline = null;
    this.activeConfig = null;
    if (this.dialogueContainer) {
      if (this.dialogueContainer.parent) {
        this.dialogueContainer.parent.removeChild(this.dialogueContainer);
      }
      // 彻底修复 CTI 拖拽黑屏卡死 Bug：在 Seek 期间不能 destroy 容器本身，仅 removeChild 脱离渲染
      this.dialogueContainer = null;
    }
  }

  showSubtitle(text: string, duration: number = 2, style: 'fadeIn' | 'cinematic' | 'typewriter' = 'fadeIn'): gsap.core.Timeline {
    const layer = stageManager.getLayer('subtitle');
    const subtitleText = new PIXI.Text({ text, style: {
      fontFamily: "'Outfit', 'Inter', 'Noto Sans SC', sans-serif",
      fontSize: this.getDialogueFontSize(), fill: '#FFFFFF', align: 'center', stroke: { color: '#000000', width: 6 },
      dropShadow: { color: '#000000', alpha: 0.5, blur: 8, distance: 4 },
      wordWrap: true, wordWrapWidth: STAGE_WIDTH - 200, breakWords: true,
    } });

    subtitleText.anchor.set(0.5);
    subtitleText.x = STAGE_WIDTH / 2;
    subtitleText.y = STAGE_HEIGHT - 150;
    subtitleText.alpha = 0;
    layer.addChild(subtitleText);

    const tl = gsap.timeline();
    if (style === 'cinematic') {
      subtitleText.y += 30;
      const subProxy = { alpha: 0, y: subtitleText.y };
      tl.to(subProxy, {
        alpha: 1, y: subProxy.y - 30, duration: 0.8, ease: 'power2.out', onUpdate: () => {
          if (!subtitleText.destroyed) { subtitleText.alpha = subProxy.alpha; subtitleText.y = subProxy.y; }
        }
      });
    } else {
      const subProxy = { alpha: 0 };
      tl.to(subProxy, {
        alpha: 1, duration: 0.5, ease: 'power2.out', onUpdate: () => {
          if (!subtitleText.destroyed) subtitleText.alpha = subProxy.alpha;
        }
      });
    }

    const fadeOutProxy = { alpha: 1 };
    tl.to(fadeOutProxy, {
      alpha: 0, duration: 0.5, ease: 'power2.in', delay: duration - 1,
      onUpdate: () => {
        if (!subtitleText.destroyed) subtitleText.alpha = fadeOutProxy.alpha;
      },
      onComplete: () => {
        if (subtitleText.parent) subtitleText.parent.removeChild(subtitleText);
        // 彻底修复 CTI 拖拽黑屏卡死 Bug：在 Seek 期间不能 destroy 字幕，仅 removeChild 脱离渲染
      },
    });
    return tl;
  }

  clear(): void {
    this.dialogueOpacity = 1;
    this.hideDialogue(false);
    this.dialogueCache.clear(); // 清理场景时彻底清除缓存以防止内存泄露
    const layer = stageManager.getLayer('subtitle');
    if (layer) {
      // 统一场景释放：在切换剧本、卸载场景时释放所有字幕及文本容器，彻底杜绝内存泄露
      layer.children.forEach((child) => {
        child.destroy({ children: true });
      });
      layer.removeChildren();
    }
  }

  public getCurrentTimeline() { return this.currentTimeline; }

  public async preloadPreparedScene(scene: PreparedCompiledScene): Promise<void> {
    const imageUris = new Set<string>();
    const fonts = new Map<string, string>();
    for (const action of scene.actions) {
      if (action.action !== 'dialogue') continue;
      const presentation = action.params.presentation;
      if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) continue;
      const record = presentation as Record<string, PreparedRuntimeValue>;
      collectPreparedUri(record.textbox, 'image', imageUris);
      collectPreparedUri(record.namebox, 'image', imageUris);
      collectPreparedFont(record.text, fonts);
      collectPreparedFont(record.speaker, fonts);
    }
    // PIXI.Assets caches by URI; skip already-materialized textures so an
    // unchanged scene preload is a pure Map lookup instead of a load resolve.
    const loadAssets = (PIXI.Assets as any)?.load as ((uri: string) => Promise<unknown>) | undefined;
    if (typeof loadAssets === 'function') {
      const missingUris = [...imageUris].filter((uri) => !(PIXI.Assets as any)?.cache?.has?.(uri));
      if (missingUris.length > 0) {
        await Promise.all(missingUris.map((uri) => loadAssets(uri)));
      }
    }
    if (typeof FontFace !== 'undefined' && typeof document !== 'undefined' && document.fonts) {
      // Rebuilding a FontFace per commit for every dialogue family would parse
      // font data on each edit; keep the family→uri mapping so only genuinely
      // new fonts are constructed and registered.
      const pendingFonts = [...fonts].filter(([family, uri]) => this.loadedDialogueFonts.get(family) !== uri);
      await Promise.all(pendingFonts.map(async ([family, uri]) => {
        const font = new FontFace(family, `url("${uri.replace(/"/g, '\\"')}")`);
        await font.load();
        document.fonts.add(font);
        this.loadedDialogueFonts.set(family, uri);
      }));
    }
  }

  public forceUpdate(): void {
    if (this.activeConfig && this.currentTimeline && (
      this.activeFontSize !== this.getDialogueFontSize()
      || ((this.activeConfig.style ?? 'typewriter') === 'typewriter'
        && this.activeTextSpeed !== settingsManager.get('dialogueTextSpeed'))
    )) {
      this.ensureDialogueOnStage(this.activeConfig, this.currentTimeline.time());
    }
    if (this.currentTimeline) {
      const onUpdate = this.currentTimeline.eventCallback('onUpdate');
      if (typeof onUpdate === 'function') {
        onUpdate();
      }
    }
  }
}

export const subtitleRenderer = new SubtitleRenderer();
export default SubtitleRenderer;

function collectPreparedUri(value: PreparedRuntimeValue | undefined, key: string, output: Set<string>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const candidate = (value as Record<string, PreparedRuntimeValue>)[key];
  if (isPreparedAssetRef(candidate) && !candidate.unavailable && candidate.runtimeUri.trim()) {
    output.add(candidate.runtimeUri);
  }
}

function collectPreparedFont(value: PreparedRuntimeValue | undefined, output: Map<string, string>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, PreparedRuntimeValue>;
  const file = record.fontFile;
  const family = record.fontFamily;
  if (isPreparedAssetRef(file) && !file.unavailable && file.runtimeUri.trim()
    && typeof family === 'string' && family.trim()) {
    output.set(family, file.runtimeUri);
  }
}

function isPreparedAssetRef(value: PreparedRuntimeValue | undefined): value is PreparedAssetRef {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as PreparedAssetRef).source === 'string'
    && typeof (value as PreparedAssetRef).runtimeUri === 'string';
}
