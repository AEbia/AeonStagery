import { describe, expect, it } from 'vitest';
import { getLive2DParameterDisplayName } from '../ui/timeline/live2dParameterPresentation';

describe('Live2D 关键帧参数显示名称', () => {
  it.each([
    ['ParamAngleX', '头部左右'],
    ['PARAM_ANGLE', '头部角度'],
    ['PARAM_ANGLE_Z', '头部倾斜'],
    ['PARAM_EYE_L_OPEN', '左眼开合'],
    ['PARAM_EYE_L_SMILE', '左眼微笑'],
    ['Parameter.ParamEyeBallY', '眼球上下'],
    ['PARAM_EYE_HIGHLIGHT', '眼睛高光'],
    ['PARAM_EYELID_R', '右眼皮'],
    ['ParamBrowRForm', '右眉形态'],
    ['PARAM_MOUTH_OPEN_Y', '嘴部开合'],
    ['PARAM_MOUTH_FORM_01', '嘴部形态 1'],
    ['PARAM_BODY_ANGLE_Z', '身体倾斜'],
    ['PARAM_UPPER_BODY', '上身'],
    ['ParamArmLA', '左臂 A'],
    ['PARAM_ARM_R_01_001-1', '右臂 1-1-1'],
    ['PARAM_HAND_R', '右手'],
    ['PARAM_CHEEK2', '脸颊 2'],
    ['PARAM_CLOTHES_A', '服装 A'],
    ['PARAM_POSITION_X', '整体左右'],
    ['PARAM_ROTATION_Z', '整体旋转'],
    ['PARAM_mask_3', '遮罩 3'],
    ['PARAM_motions2', '动作 2'],
    ['Parameter.ParamHairFront', '前发'],
  ])('将 %s 显示为 %s', (parameterId, expected) => {
    expect(getLive2DParameterDisplayName(parameterId)).toBe(expected);
  });

  it('未知参数仍会去掉技术前缀并保留可辨认部分', () => {
    expect(getLive2DParameterDisplayName('Parameter.ParamCustomCapeSwing')).toBe('自定义 Cape Swing');
  });
});
