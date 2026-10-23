import * as PIXI from 'pixi.js';
import type { DialogueImagePanelStyle, DialogueImagePresentation } from '../api/types/semantic-scene';
import type { DialogueConfig, DialogueTemplate } from './DialogueTemplates';
import { STAGE_WIDTH, STAGE_HEIGHT } from './StageDimensions';

const DEFAULT_FONT_FAMILY = "'Outfit', 'Inter', 'Noto Sans SC', 'Microsoft YaHei', sans-serif";

/** Image templates are authored on a 1920×1080 design surface. Reflow the
 * panel horizontally and preserve its top/bottom attachment, without scaling
 * glyphs or modifying the persisted presentation. */
export function adaptDialoguePresentation(presentation: DialogueImagePresentation): DialogueImagePresentation {
  if (STAGE_WIDTH === 1920 && STAGE_HEIGHT === 1080) return presentation;
  const xScale = STAGE_WIDTH / 1920;
  const yOffset = presentation.textbox.y >= 540 ? STAGE_HEIGHT - 1080 : 0;
  return {
    ...presentation,
    textbox: { ...presentation.textbox, x: presentation.textbox.x * xScale, y: presentation.textbox.y + yOffset, width: presentation.textbox.width * xScale },
    ...(presentation.namebox ? { namebox: { ...presentation.namebox, x: presentation.namebox.x * xScale, y: presentation.namebox.y + yOffset } } : {}),
    text: { ...presentation.text, x: presentation.text.x * xScale, y: presentation.text.y + yOffset, maxWidth: presentation.text.maxWidth * xScale },
  };
}

export const ImageDialogueTemplate: DialogueTemplate = {
  id: 'image-dialogue-v1',
  name: 'Template Image Dialogue',

  resolveTextStyle(config) {
    const style = config.presentation?.text;
    if (!style) return {};
    const hidden = style.hidden === true;
    return {
      fontFamily: style.fontFamily || DEFAULT_FONT_FAMILY,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fill: hidden ? 'transparent' : config.textColor || style.color,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      align: style.align,
      stroke: {
        color: hidden ? 'transparent' : style.strokeColor ?? 'transparent',
        width: hidden ? 0 : style.strokeWidth ?? 0,
      },
      dropShadow: !hidden && style.dropShadow
        ? {
            color: style.dropShadowColor ?? '#000000',
            alpha: style.dropShadowAlpha ?? 1,
            blur: style.dropShadowBlur ?? 0,
            distance: style.dropShadowDistance ?? 5,
            ...(style.dropShadowAngle != null ? { angle: style.dropShadowAngle } : {}),
          }
        : false,
      wordWrapWidth: style.maxWidth,
    };
  },

  render(container, config, metrics) {
    const presentation = requireImagePresentation(config);
    const topInset = Math.max(0, presentation.text.y - presentation.textbox.y);
    const baseHeight = presentation.textbox.height ?? presentation.textbox.minHeight ?? 1;
    const textboxHeight = Math.max(baseHeight, topInset + metrics.height + topInset);
    // Expand upward around the authored bottom edge so additional lines stay
    // on stage, and keep the nameplate attached to the textbox.
    const expansionOffset = presentation.textbox.height === undefined ? 0 : baseHeight - textboxHeight;
    const offsetY = Math.min(0, STAGE_HEIGHT - presentation.textbox.y - textboxHeight, expansionOffset);
    const textbox = createImagePanel({ ...presentation.textbox, y: presentation.textbox.y + offsetY }, textboxHeight);
    container.addChild(textbox);

    if (config.speaker && presentation.namebox) {
      renderNamebox(container, config, {
        ...presentation,
        namebox: { ...presentation.namebox, y: presentation.namebox.y + offsetY },
      });
    }

    return {
      textX: presentation.text.x,
      textY: presentation.text.y + offsetY,
      textWidth: presentation.text.maxWidth,
      textHeight: Math.max(1, textboxHeight - topInset * 2),
      boxHeight: textboxHeight,
      boxY: presentation.textbox.y + offsetY,
    };
  },
};

function requireImagePresentation(config: DialogueConfig): DialogueImagePresentation {
  if (config.presentation?.renderer !== 'image-dialogue-v1') {
    throw new Error('image-dialogue-v1 requires a materialized dialogue presentation');
  }
  return config.presentation;
}

function createImagePanel(style: DialogueImagePanelStyle, height: number, width = style.width): PIXI.Container {
  const texture = PIXI.Texture.from(style.image);
  const panel = style.nineSlice
    ? new PIXI.NineSlicePlane(
      texture,
      style.nineSlice[0],
      style.nineSlice[1],
      style.nineSlice[2],
      style.nineSlice[3],
    )
    : new PIXI.Sprite(texture);
  panel.x = style.x - width * (style.anchorX ?? 0);
  panel.y = style.y;
  panel.width = width;
  panel.height = height;
  panel.alpha = style.opacity ?? 1;
  return panel;
}

function renderNamebox(
  container: PIXI.Container,
  config: DialogueConfig,
  presentation: DialogueImagePresentation,
): void {
  const panelStyle = presentation.namebox!;
  const speakerStyle = presentation.speaker;
  const color = speakerStyle?.color === '$characterColor'
    ? config.speakerColor || '#FFFFFF'
    : speakerStyle?.color || config.speakerColor || '#FFFFFF';
  // Pixi's text measurement counts the stroke and the shadow *distance*, but not
  // the shadow *blur*, so a glow gets sliced off at the texture edge. `padding`
  // only grows the texture and leaves the text bounds alone, so reserving it here
  // cannot disturb the plate geometry below.
  const shadowPadding = speakerStyle?.dropShadow
    ? Math.ceil((speakerStyle.dropShadowBlur ?? 0) + Math.abs(speakerStyle.dropShadowDistance ?? 5))
    : 0;
  const speakerText = new PIXI.Text({ text: config.speaker, style: {
    fontFamily: speakerStyle?.fontFamily || presentation.text.fontFamily || DEFAULT_FONT_FAMILY,
    fontSize: speakerStyle?.fontSize ?? Math.round((presentation.text.fontSize ?? config.fontSize ?? 44) * 0.9),
    fontWeight: (speakerStyle?.fontWeight || '700') as any,
    fill: color,
    letterSpacing: speakerStyle?.letterSpacing ?? 0,
    align: speakerStyle?.align ?? 'center',
    // Nameplate typography mirrors the body text layer so imported templates can
    // carry their own plate outline and glow instead of a flat fill.
    stroke: {
      color: speakerStyle?.strokeColor ?? 'transparent',
      width: speakerStyle?.strokeWidth ?? 0,
    },
    dropShadow: speakerStyle?.dropShadow
      ? {
          color: speakerStyle.dropShadowColor ?? '#000000',
          alpha: speakerStyle.dropShadowAlpha ?? 1,
          blur: speakerStyle.dropShadowBlur ?? 0,
          distance: speakerStyle.dropShadowDistance ?? 5,
          ...(speakerStyle.dropShadowAngle != null ? { angle: speakerStyle.dropShadowAngle } : {}),
        }
      : false,
    padding: shadowPadding,
  } });
  speakerText.resolution = 2;
  const [paddingLeft, paddingTop, paddingRight, paddingBottom] = speakerStyle?.padding ?? [0, 0, 0, 0];
  const panelWidth = Math.max(panelStyle.width, speakerText.width + paddingLeft + paddingRight);
  const panelHeight = Math.max(
    panelStyle.height ?? panelStyle.minHeight ?? 1,
    speakerText.height + paddingTop + paddingBottom,
  );
  const panel = createImagePanel(panelStyle, panelHeight, panelWidth);
  container.addChild(panel);

  // Alignment defaults to `center` so existing templates keep their exact layout.
  const speakerAlign = speakerStyle?.align ?? 'center';
  const innerWidth = Math.max(0, panelWidth - paddingLeft - paddingRight);
  speakerText.anchor.set(speakerAlign === 'left' ? 0 : speakerAlign === 'right' ? 1 : 0.5, 0.5);
  speakerText.x = panel.x
    + paddingLeft
    + (speakerAlign === 'left' ? 0 : speakerAlign === 'right' ? innerWidth : innerWidth / 2)
    + (speakerStyle?.textOffset?.[0] ?? 0);
  speakerText.y = panelStyle.y
    + paddingTop
    + Math.max(0, panelHeight - paddingTop - paddingBottom) / 2
    + (speakerStyle?.textOffset?.[1] ?? 0);
  container.addChild(speakerText);
}
