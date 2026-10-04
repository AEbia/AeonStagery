import type { CustomMotionSegment } from '../../api/types/semantic-scene';

/**
 * 关键帧曲线预设(ADR-0029 契约:控制点时间必须落在区段内且单调)。
 *
 * 预设以"比例规格"声明两个贝塞尔控制点:
 * - timeRatio 相对区段时间跨度 (next.time - prev.time)
 * - valueRatio 相对区段值跨度 (next.value - prev.value),允许越界以表达过冲
 *
 * 纯函数构建,便于单元测试;CustomMotionEditor 只负责取锚点与提交。
 */
export type CurvePresetId = 'smooth' | 'easeOut' | 'easeIn' | 'snappy' | 'backOut' | 'linear';

export const CURVE_PRESETS: readonly { id: CurvePresetId; label: string }[] = [
  { id: 'linear', label: '线性插值 (Linear)' },
  { id: 'smooth', label: '缓入缓出 (Ease In-Out)' },
  { id: 'easeIn', label: '缓入 (Ease In)' },
  { id: 'easeOut', label: '缓出 (Ease Out)' },
  { id: 'snappy', label: '快速缓出 (Fast Ease Out)' },
  { id: 'backOut', label: '回弹缓出 (Back Out)' },
];

export type CurrentCurvePresetId = CurvePresetId | 'custom' | 'stepped' | 'inverseStepped';

export interface CurvePresetAnchor {
  readonly time: number;
  readonly value: number;
}

interface ControlPointSpec {
  readonly timeRatio: number;
  readonly valueRatio: number;
}

interface BezierPresetSpec {
  readonly cp1: ControlPointSpec;
  readonly cp2: ControlPointSpec;
}

const BEZIER_PRESET_SPECS: Readonly<Record<Exclude<CurvePresetId, 'linear'>, BezierPresetSpec>> = {
  // 平滑缓动:标准 S 曲线
  smooth: { cp1: { timeRatio: 0.35, valueRatio: 0 }, cp2: { timeRatio: 0.65, valueRatio: 1 } },
  // 自然减速:起步快、收尾缓
  easeOut: { cp1: { timeRatio: 0.15, valueRatio: 0.55 }, cp2: { timeRatio: 0.65, valueRatio: 1 } },
  // 蓄力加速:起步缓、收尾急
  easeIn: { cp1: { timeRatio: 0.35, valueRatio: 0 }, cp2: { timeRatio: 0.85, valueRatio: 0.45 } },
  // 利落快停:极早到达目标后保持
  snappy: { cp1: { timeRatio: 0.08, valueRatio: 0.85 }, cp2: { timeRatio: 0.45, valueRatio: 1 } },
  // 过冲回弹(Back Out):冲过目标再回落,值允许越界 [0,1]
  backOut: { cp1: { timeRatio: 0.35, valueRatio: 1.22 }, cp2: { timeRatio: 0.75, valueRatio: 1.05 } },
};

const CONTROL_POINT_TIME_MARGIN = 0.01;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isCurvePresetId(value: string): value is CurvePresetId {
  return CURVE_PRESETS.some((preset) => preset.id === value);
}

/** Derive the displayed easing from persisted control points, including imported curves. */
export function resolveCurvePresetId(
  segment: CustomMotionSegment | undefined,
  prev: CurvePresetAnchor,
  next: CurvePresetAnchor,
): CurrentCurvePresetId {
  if (!segment || segment.type !== 'bezier') return segment?.type ?? 'linear';
  const span = next.time - prev.time;
  const delta = next.value - prev.value;
  for (const { id } of CURVE_PRESETS) {
    if (id === 'linear') continue;
    const expected = buildCurvePresetSegment(id, prev, next);
    const spec = BEZIER_PRESET_SPECS[id];
    const matches = segment.controlPoints.every((point, index) => {
      const built = expected?.type === 'bezier' ? expected.controlPoints[index] : null;
      const ideal = index === 0 ? spec.cp1 : spec.cp2;
      const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
      // Compare both the rounded editor output and exact normalized presets.
      return (built && close(point.time, built.time) && close(point.value, built.value))
        || (span > 0 && close(point.time, prev.time + span * ideal.timeRatio)
          && close(point.value, prev.value + delta * ideal.valueRatio));
    });
    if (matches) return id;
  }
  return 'custom';
}

/**
 * 由预设构建关键帧区段(prev → next)。区段时间跨度非法时返回 null。
 * 保证:控制点时间经 clamp + round2 后仍满足 from.time < cp1.time <= cp2.time < to.time。
 */
export function buildCurvePresetSegment(
  presetId: string,
  prev: CurvePresetAnchor,
  next: CurvePresetAnchor,
): CustomMotionSegment | null {
  if (!isCurvePresetId(presetId)) return null;

  const dx = next.time - prev.time;
  const dy = next.value - prev.value;
  if (dx <= CONTROL_POINT_TIME_MARGIN * 2) {
    // 区段窄于两个控制点的安全边距之和时无法合法放置(编辑器时间网格 0.05s,正常不会触发)
    return null;
  }

  if (presetId === 'linear') {
    return { type: 'linear' };
  }

  const spec = BEZIER_PRESET_SPECS[presetId];
  const minCp1Time = prev.time + CONTROL_POINT_TIME_MARGIN;
  const maxCp2Time = next.time - CONTROL_POINT_TIME_MARGIN;

  // 先 round 再 clamp 链式约束 cp2 >= cp1,确保落盘值仍单调
  const cp1Time = round2(clamp(round2(prev.time + dx * spec.cp1.timeRatio), minCp1Time, maxCp2Time));
  const cp2Time = round2(clamp(round2(prev.time + dx * spec.cp2.timeRatio), cp1Time, maxCp2Time));

  return {
    type: 'bezier',
    controlPoints: [
      { time: cp1Time, value: round2(prev.value + dy * spec.cp1.valueRatio) },
      { time: cp2Time, value: round2(prev.value + dy * spec.cp2.valueRatio) },
    ],
  };
}
