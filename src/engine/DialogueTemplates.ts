import * as PIXI from 'pixi.js';
import { settingsManager } from '../ui/SettingsStore';
import type { DialogueImagePresentation } from '../api/types/semantic-scene';

export interface DialogueConfig {
  _id?: string;
  speaker: string;
  speakerId?: string;
  text: string;
  style?: 'typewriter' | 'fadeIn' | 'cinematic' | 'instant';
  template?: string;
  duration?: number;
  speakerColor?: string;
  textColor?: string;
  fontSize?: number;
  position?: 'bottom' | 'top' | 'center';
  presentation?: DialogueImagePresentation;
}

export interface DialogueTemplate {
  id: string;
  name: string;
  resolveTextStyle?(config: DialogueConfig): Record<string, unknown>;
  render(container: PIXI.Container, config: DialogueConfig, metrics: PIXI.CanvasTextMetrics): {
    textX: number;
    textY: number;
    textWidth: number;
    textHeight: number;
    boxHeight: number;
    boxY: number;
  };
}

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

/**
 * Helper to draw rounded rectangle with specific corner radii
 */
function drawChamferRect(
  g: PIXI.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  bl: number,
  br: number
) {
  g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y);
  if (tr > 0) g.arcTo(x + w, y, x + w, y + tr, tr);
  else g.lineTo(x + w, y);
  g.lineTo(x + w, y + h - br);
  if (br > 0) g.arcTo(x + w, y + h, x + w - br, y + h, br);
  else g.lineTo(x + w, y + h);
  g.lineTo(x + bl, y + h);
  if (bl > 0) g.arcTo(x, y + h, x, y + h - bl, bl);
  else g.lineTo(x, y + h);
  g.lineTo(x, y + tl);
  if (tl > 0) g.arcTo(x, y, x + tl, y, tl);
  else g.lineTo(x, y);
}

/**
 * PREMIUM GLASS TEMPLATE (The Original Look)
 */
export const GlassTemplate: DialogueTemplate = {
  id: 'glass',
  name: 'Premium Glass',
  render(container, config, metrics) {
    const { speaker, speakerColor, fontSize = 44, position = 'bottom' } = config;
    
    const boxWidth = STAGE_WIDTH - 240;
    const boxX = 120;
    const minBoxHeight = 280;
    const textPaddingY = 80;
    const boxHeight = Math.max(minBoxHeight, metrics.height + textPaddingY);
    const boxY = position === 'bottom' ? STAGE_HEIGHT - boxHeight - 50 : position === 'top' ? 50 : (STAGE_HEIGHT - boxHeight) / 2;
    const borderRadius = 20;

    const finalSpeakerColor = speakerColor || '#FFD700';
    const colorNum = parseInt(finalSpeakerColor.replace('#', '0x'), 16);

    const bgContainer = new PIXI.Container();

    // 1. Soft beautiful shadow
    const shadow = new PIXI.Graphics();
    shadow.beginFill(0x000000, 0.15);
    shadow.drawRoundedRect(boxX + 8, boxY + 12, boxWidth, boxHeight, borderRadius);
    shadow.endFill();
    
    // Conditionally apply blur to prevent errors on some setups
    if (PIXI.BlurFilter) {
      const blur = new PIXI.BlurFilter();
      blur.blur = 16;
      shadow.filters = [blur];
    }
    container.addChild(shadow);

    const mask = new PIXI.Graphics();
    mask.beginFill(0xFFFFFF);
    mask.drawRoundedRect(boxX, boxY, boxWidth, boxHeight, borderRadius);
    mask.endFill();
    container.addChild(mask);
    bgContainer.mask = mask;

    const bg = new PIXI.Graphics();
    // Glass base
    bg.beginFill(0xFFFFFF, 0.18);
    bg.drawRoundedRect(boxX, boxY, boxWidth, boxHeight, borderRadius);
    bg.endFill();



    // Left accent color
    bg.beginFill(colorNum, 0.95);
    drawChamferRect(bg, boxX, boxY, 8, boxHeight, borderRadius, 0, borderRadius, 0);
    bg.endFill();

    // Top highlight rim
    bg.beginFill(0xFFFFFF, 0.6);
    drawChamferRect(bg, boxX, boxY, boxWidth, 2, borderRadius, borderRadius, 0, 0);
    bg.endFill();

    // Outer bright border
    bg.roundRect(boxX, boxY, boxWidth, boxHeight, borderRadius)
      .stroke({ width: 1.5, color: 0xFFFFFF, alpha: 0.5 });

    // Signature (bottom right)
    const sigText1 = settingsManager.get('dialogueSignatureText1') || '';
    const sigColor1 = settingsManager.get('dialogueSignatureColor1') || '#FFDADE';
    const sigText2 = settingsManager.get('dialogueSignatureText2') || '';
    const sigColor2 = settingsManager.get('dialogueSignatureColor2') || '#CEA493';
    
    if (sigText1 || sigText2) {
      const sigContainer = new PIXI.Container();
      
      let currentX = 0;
      if (sigText1) {
        const t1 = new PIXI.Text({ text: sigText1, style: {
          fontFamily: "'Outfit', 'Inter', sans-serif",
          fontSize: 16, fill: sigColor1, fontWeight: '800', fontStyle: 'italic',
          dropShadow: { color: '#000000', alpha: 0.2, blur: 2, distance: 1 },
        } });
        sigContainer.addChild(t1);
        currentX += t1.width;
      }
      if (sigText2) {
        const t2 = new PIXI.Text({ text: sigText2, style: {
          fontFamily: "'Outfit', 'Inter', sans-serif",
          fontSize: 16, fill: sigColor2, fontWeight: '800', fontStyle: 'italic',
          dropShadow: { color: '#000000', alpha: 0.2, blur: 2, distance: 1 },
        } });
        t2.x = currentX;
        sigContainer.addChild(t2);
      }
      
      sigContainer.x = boxX + boxWidth - sigContainer.width - 24;
      sigContainer.y = boxY + boxHeight - sigContainer.height - 16;
      sigContainer.alpha = 0.8;
      bg.addChild(sigContainer);
    }

    bgContainer.addChild(bg);
    container.addChild(bgContainer);

    // Speaker Plate
    if (speaker) {
      const speakerContainer = new PIXI.Container();
      const speakerFontSize = Math.round(fontSize * 1.3);
      const speakerText = new PIXI.Text({ text: speaker, style: {
        fontFamily: "'Outfit', 'Inter', 'Noto Sans SC', sans-serif",
        fontSize: speakerFontSize, fill: '#FFFFFF', fontWeight: '800', letterSpacing: 2, 
        dropShadow: { color: '#000000', alpha: 0.3, blur: 4, distance: 2 },
      } });
      const plateWidth = Math.max(220, speakerText.width + 100);
      const plateHeight = 72;

      // Speaker Plate Shadow
      const pShadow = new PIXI.Graphics();
      pShadow.beginFill(0x000000, 0.15);
      pShadow.drawRoundedRect(3, 8, plateWidth, plateHeight, 12);
      pShadow.endFill();
      if (PIXI.BlurFilter) {
        const pBlur = new PIXI.BlurFilter();
        pBlur.blur = 8;
        pShadow.filters = [pBlur];
      }
      speakerContainer.addChild(pShadow);

      const plateContent = new PIXI.Container();
      const plateMask = new PIXI.Graphics();
      plateMask.beginFill(0xFFFFFF);
      plateMask.drawRoundedRect(0, 0, plateWidth, plateHeight, 12);
      plateMask.endFill();
      plateContent.mask = plateMask;
      speakerContainer.addChild(plateMask, plateContent);

      const plate = new PIXI.Graphics();
      plate.beginFill(colorNum, 0.95);
      plate.drawRoundedRect(0, 0, plateWidth, plateHeight, 12);
      plate.endFill();

      // Left highlight instead of top highlight
      plate.beginFill(0xFFFFFF, 0.5);
      drawChamferRect(plate, 0, 0, 4, plateHeight, 12, 0, 12, 0);
      plate.endFill();

      plate.roundRect(0, 0, plateWidth, plateHeight, 12)
        .stroke({ width: 1.5, color: 0xFFFFFF, alpha: 0.5 });
      
      plateContent.addChild(plate);

      speakerText.resolution = 2;
      speakerText.anchor.set(0.5, 0.5);
      speakerText.x = plateWidth / 2;
      speakerText.y = plateHeight / 2;
      plateContent.addChild(speakerText);

      speakerContainer.x = boxX + 40;
      speakerContainer.y = boxY - plateHeight + 12;
      container.addChild(speakerContainer);
    }

    return { textX: boxX + 60, textY: boxY + 36, textWidth: boxWidth - 120, textHeight: boxHeight - 72, boxHeight, boxY };
  }
};

/**
 * MINIMALIST TEMPLATE (Clean, floating text)
 */
export const MinimalTemplate: DialogueTemplate = {
  id: 'minimal',
  name: 'Minimalist',
  render(container, config, metrics) {
    const { speaker, speakerColor, fontSize = 44, position = 'bottom' } = config;
    const boxWidth = STAGE_WIDTH - 400;
    const boxX = 200;
    const boxHeight = metrics.height + 100;
    const boxY = position === 'bottom' ? STAGE_HEIGHT - boxHeight - 80 : position === 'top' ? 80 : (STAGE_HEIGHT - boxHeight) / 2;

    const finalSpeakerColor = speakerColor || '#FFD700';

    if (speaker) {
      const speakerText = new PIXI.Text({ text: speaker, style: {
        fontFamily: "'Outfit', 'Inter', 'Noto Sans SC', sans-serif",
        fontSize: fontSize * 0.9,
        fill: finalSpeakerColor,
        fontWeight: '900',
        letterSpacing: 4,
        stroke: { color: '#000000', width: 4 },
        dropShadow: { color: '#000000', alpha: 0.7, blur: 6, distance: 0 },
      } });
      speakerText.anchor.set(0.5, 0.5);
      speakerText.x = STAGE_WIDTH / 2;
      speakerText.y = boxY - 60;
      container.addChild(speakerText);
    }

    return { textX: boxX, textY: boxY + 20, textWidth: boxWidth, textHeight: boxHeight, boxHeight, boxY };
  }
};

/**
 * CLASSIC VN TEMPLATE (Solid box)
 */
export const ClassicTemplate: DialogueTemplate = {
  id: 'classic',
  name: 'Classic VN',
  render(container, config, _metrics) {
    const { speaker, speakerColor, fontSize = 44, position = 'bottom' } = config;
    const boxHeight = 320;
    const boxY = position === 'bottom' ? STAGE_HEIGHT - boxHeight : position === 'top' ? 0 : (STAGE_HEIGHT - boxHeight) / 2;

    const finalSpeakerColor = speakerColor || '#FFD700';

    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.7);
    bg.drawRect(0, boxY, STAGE_WIDTH, boxHeight);
    bg.endFill();
    bg.moveTo(0, boxY); bg.lineTo(STAGE_WIDTH, boxY);
    bg.moveTo(0, boxY + boxHeight); bg.lineTo(STAGE_WIDTH, boxY + boxHeight);
    bg.stroke({ width: 2, color: 0xFFFFFF, alpha: 0.2 });
    container.addChild(bg);

    if (speaker) {
      const speakerText = new PIXI.Text({ text: `【 ${speaker} 】`, style: {
        fontFamily: "'Outfit', 'Inter', 'Noto Sans SC', sans-serif",
        fontSize: fontSize, fill: finalSpeakerColor, fontWeight: 'bold',
      } });
      speakerText.x = 100;
      speakerText.y = boxY + 40;
      container.addChild(speakerText);
    }

    return { textX: 100, textY: boxY + 110, textWidth: STAGE_WIDTH - 200, textHeight: boxHeight - 150, boxHeight, boxY };
  }
};

export const templates: Record<string, DialogueTemplate> = {
  glass: GlassTemplate,
  minimal: MinimalTemplate,
  classic: ClassicTemplate,
};
