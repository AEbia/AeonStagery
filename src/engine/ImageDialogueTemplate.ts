import * as PIXI from 'pixi.js';
import type { DialogueImagePanelStyle, DialogueImagePresentation } from '../api/types/semantic-scene';
import type { DialogueConfig, DialogueTemplate } from './DialogueTemplates';

const DEFAULT_FONT_FAMILY = "'Outfit', 'Inter', 'Noto Sans SC', 'Microsoft YaHei', sans-serif";

export const ImageDialogueTemplate: DialogueTemplate = {
  id: 'image-dialogue-v1',
  name: 'Template Image Dialogue',

  resolveTextStyle(config) {
    const style = config.presentation?.text;
    if (!style) return {};
    return {
      fontFamily: style.fontFamily || DEFAULT_FONT_FAMILY,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fill: config.textColor || style.color,
      lineHeight: style.lineHeight,
      align: style.align,
      stroke: { color: style.strokeColor ?? 'transparent', width: style.strokeWidth ?? 0 },
      dropShadow: style.dropShadow
        ? {
            color: style.dropShadowColor ?? '#000000',
            alpha: style.dropShadowAlpha ?? 1,
            blur: style.dropShadowBlur ?? 0,
            distance: style.dropShadowDistance ?? 5,
          }
        : false,
      wordWrapWidth: style.maxWidth,
    };
  },

  render(container, config, metrics) {
    const presentation = requireImagePresentation(config);
    const textboxHeight = presentation.textbox.height
      ?? Math.max(
        presentation.textbox.minHeight ?? 1,
        presentation.text.y - presentation.textbox.y + metrics.height,
      );
    const textbox = createImagePanel(presentation.textbox, textboxHeight);
    container.addChild(textbox);

    if (config.speaker && presentation.namebox) {
      renderNamebox(container, config, presentation);
    }

    return {
      textX: presentation.text.x,
      textY: presentation.text.y,
      textWidth: presentation.text.maxWidth,
      textHeight: Math.max(1, textboxHeight - (presentation.text.y - presentation.textbox.y)),
      boxHeight: textboxHeight,
      boxY: presentation.textbox.y,
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
  panel.x = style.x;
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
  const speakerText = new PIXI.Text({ text: config.speaker, style: {
    fontFamily: speakerStyle?.fontFamily || presentation.text.fontFamily || DEFAULT_FONT_FAMILY,
    fontSize: speakerStyle?.fontSize ?? Math.round((presentation.text.fontSize ?? config.fontSize ?? 44) * 0.9),
    fontWeight: (speakerStyle?.fontWeight || '700') as any,
    fill: color,
    align: 'center',
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

  speakerText.anchor.set(0.5);
  speakerText.x = panelStyle.x
    + paddingLeft
    + Math.max(0, panelWidth - paddingLeft - paddingRight) / 2
    + (speakerStyle?.textOffset?.[0] ?? 0);
  speakerText.y = panelStyle.y
    + paddingTop
    + Math.max(0, panelHeight - paddingTop - paddingBottom) / 2
    + (speakerStyle?.textOffset?.[1] ?? 0);
  container.addChild(speakerText);
}
