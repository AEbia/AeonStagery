import { describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { DialogueCoordinator } from '../engine/coordinators/DialogueCoordinator';

/**
 * 回归：文本口型在正常播放时必须随剧本动画（此前整条播放管线零写入）。
 *
 * 根因：文本口型时间线只被 `timeline.seek()` 驱动，而 GSAP seek() 不触发
 * tween onUpdate，口型写入又都在 onUpdate 里 → 播放时嘴巴冻结；暂停后
 * 未暂停的孤儿时间线在全局 ticker 上自由播放才出现口型动画。
 *
 * 修复：DialogueCoordinator 改为每 tick 调用 LipSyncEngine.setTextMouthAt
 * （确定性纯函数计算 + 显式写入通道），不再依赖 GSAP 时间线。
 */
const live2DMocks = vi.hoisted(() => ({
  setLipSyncParameter: vi.fn(),
  clearLipSyncParameters: vi.fn(),
  setParameter: vi.fn(),
  getParameterValue: vi.fn(),
}));
vi.mock('../engine/Live2DManager', () => ({
  live2DManager: live2DMocks,
}));

const dialogue = {
  _id: 'd1',
  text: '你好，世界。这是一段测试台词！',
  startTime: 0.15,
  duration: 2.4,
  speakerId: 'tomori',
  lipSync: 'text' as const,
};

function createCoordinator(lipSync: any) {
  const subtitle = {
    setDialogueVisibility: vi.fn(),
    ensureDialogueOnStage: vi.fn(),
    getCurrentTimeline: () => null,
    forceUpdate: vi.fn(),
    hideDialogue: vi.fn(),
  };
  return new DialogueCoordinator(subtitle as any, lipSync as any);
}

describe('text-driven lip sync during playback (regression)', () => {
  it('normal playback animates the mouth: mouth channel written every tick with varying openness', async () => {
    const { default: LipSyncEngine } = await import('../engine/LipSyncEngine');
    const lipSync = new LipSyncEngine();
    const coordinator = createCoordinator(lipSync);
    live2DMocks.setLipSyncParameter.mockClear();

    // 复刻 ScriptEngine 播放循环：master 时间线播放，onUpdate 同步对话。
    const master = gsap.timeline({ paused: true, duration: 3 });
    master.eventCallback('onUpdate', () => {
      const t = master.time();
      coordinator.sync(
        t,
        t >= dialogue.startTime && t < dialogue.startTime + dialogue.duration ? dialogue : null,
        false,
        () => ({} as HTMLAudioElement),
        (p) => p,
        () => {},
      );
    });
    master.play();
    await new Promise((r) => setTimeout(r, 1200));
    master.pause();

    const mouthWrites = live2DMocks.setLipSyncParameter.mock.calls
      .filter(([id, p]) => id === 'tomori' && p === 'PARAM_MOUTH_OPEN_Y');
    const positive = mouthWrites.filter(([, , v]) => Number(v) > 0).length;
    // 播放期间嘴巴必须持续写入且数值有变化（真正在动，而不是定格一个姿态）。
    expect(positive).toBeGreaterThan(3);
    const distinct = new Set(mouthWrites.map(([, , v]) => Number(v).toFixed(3))).size;
    expect(distinct).toBeGreaterThan(2);
  }, 20000);

  it('scrub stepping writes the exact deterministic mouth values as computeTextMouthOpenness', async () => {
    const { default: LipSyncEngine } = await import('../engine/LipSyncEngine');
    const lipSync = new LipSyncEngine();
    const coordinator = createCoordinator(lipSync);
    live2DMocks.setLipSyncParameter.mockClear();

    for (const t of [0.3, 0.6, 1.0, 1.4, 1.8, 2.2]) {
      coordinator.sync(
        t,
        dialogue,
        true,
        () => ({} as HTMLAudioElement),
        (p) => p,
        () => {},
      );
    }
    const mouthWrites = live2DMocks.setLipSyncParameter.mock.calls
      .filter(([id, p]) => id === 'tomori' && p === 'PARAM_MOUTH_OPEN_Y');
    expect(mouthWrites.length).toBe(6);
    // 最后一次 scrub 写入 == 确定性求值结果（播放与 scrub 共用同一求值器）
    const last = Number(mouthWrites.at(-1)?.[2]);
    expect(last).toBe(lipSync.computeTextMouthOpenness(dialogue.text, dialogue.duration!, 2.2 - dialogue.startTime));
  });
});
