import { BLEND_MODES, type BlendMode } from '../../api/types/blend-mode';
import type { FormSelectOption } from '../FormSelect';

const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: '正常 (Normal)',
  multiply: '正片叠底 (Multiply)',
  screen: '滤色 (Screen)',
  darken: '变暗 (Darken)',
  lighten: '变亮 (Lighten)',
  overlay: '叠加 (Overlay)',
  'soft-light': '柔光 (Soft Light)',
  'hard-light': '强光 (Hard Light)',
};

export const BLEND_MODE_OPTIONS: readonly FormSelectOption[] = BLEND_MODES.map((value) => ({
  value,
  label: BLEND_MODE_LABELS[value],
}));
