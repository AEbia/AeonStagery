export function describeCustomMotionAuthoringError(error: unknown): string {
  const candidate = error as { code?: string; message?: string };
  switch (candidate?.code) {
    case 'lease-denied': return '编辑租约被协作者占用，无法修改。请等待对方释放后再试。';
    case 'character-not-loaded': return '角色尚未加载为 Cubism 2.1 模型，请先在舞台上加载角色。';
    case 'no-convertible-parameters': return '源动作没有可转换的参数曲线。';
    case 'motion-source-unavailable': return '当前动作没有可重新采样的源动作。';
    case 'sampling-failed': return '源动作采样失败。';
    case 'entity-changed': return '场景或源动作已变化，转换已中止。';
    default: return candidate?.message ?? '操作失败，请稍后再试';
  }
}
