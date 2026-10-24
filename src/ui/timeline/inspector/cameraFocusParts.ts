import type { Live2DAnchorName } from '../../../engine/Live2DAnchorGeometry';

/** Labels describe the geometry actually available, including cropped models. */
export const CAMERA_FOCUS_PART_OPTIONS = [
  { value: 'head', label: '头部', title: '优先使用模型头部标记；无标记时按模型高度估算。' },
  { value: 'chest', label: '胸口', title: '按模型高度估算胸口位置，适合在默认人物大小下居中构图。' },
  { value: 'feet', label: '模型底部', title: '靠近模型下边缘；半身模型的底部不代表脚部。' },
  { value: 'center', label: '模型中心', title: '模型外观边界的几何中心，不代表胸口。' },
] as const satisfies readonly { value: Live2DAnchorName; label: string; title: string }[];

export const CAMERA_FOCUS_PART_HELP = '胸口按模型比例估算，适合居中构图；模型底部不一定是脚部。人物占比由角色大小和镜头缩放决定。';
