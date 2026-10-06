/** Shared by settings navigation and UI deep links; contains no service state. */
export const SETTINGS_CATEGORIES = [
  { id: 'general', group: '编辑器', label: '常规', icon: 'settings', description: '主题、自动保存和工作区布局', scope: '本机偏好 · 修改后即时保存', keywords: '外观 浅色 深色 性能 布局' },
  { id: 'engine', group: '编辑器', label: '播放与性能', icon: 'activity', description: '预览与播放行为', scope: '本机播放设置 · 修改后即时保存', keywords: '引擎 渲染 预烘焙 缓存' },
  { id: 'audio', group: '编辑器', label: '音频', icon: 'volume', description: '主音量和背景音乐', scope: '本机监听设置 · 修改后即时保存', keywords: '混音 bgm 背景音乐' },
  { id: 'dialogue', group: '编辑器', label: '对白', icon: 'dialogue', description: '默认样式、字号、文字速度、时长和入场动画', scope: '默认样式保存在项目；文字与动画偏好保存在本机 · 修改后即时保存', keywords: '对话 字幕 文本框 粉色 名牌 打字机 节奏 字体 大小 换行' },
  { id: 'shortcuts', group: '编辑器', label: '快捷键', icon: 'settings', description: '键盘操作与快捷键绑定', scope: '本机快捷键 · 修改后即时保存', keywords: '键盘 按键 热键' },
  { id: 'ai', group: '功能服务', label: 'AI 服务', icon: 'sparkles', description: '模型、连接、并发与访问密钥', scope: '本机 AI 服务 · 密钥需单独保存', keywords: 'api 模型 大模型 铺戏 agent 项目助手 endpoint base url' },
  { id: 'voice', group: '功能服务', label: '配音服务', icon: 'volume', description: 'GPT-SoVITS、模型与参考音频目录', scope: '本机语音服务 · 配置即时保存，连接和启停手动执行', keywords: '语音 音色 声音 gpt sovits 克隆 参考音频' },
  { id: 'resources', group: '项目与素材', label: '素材与路径', icon: 'folder', description: '项目位置与本机外部素材库', scope: '项目位置只读 · 外部素材库路径保存在本机', keywords: '资源 文件 目录 短资源名 mount 模型 背景 motion expression' },
  { id: 'templates', group: '项目与素材', label: '项目模板', icon: 'folder', description: '模板包与角色导入', scope: '项目配置 · 点击保存后生效', keywords: '预设 包 服装 角色' },
  { id: 'collaboration', group: '项目与素材', label: '协作数据', icon: 'activity', description: '本机协作服务的历史房间与存储', scope: '本机协作数据 · 清理前需要确认', keywords: '服务器 多人 房间 历史 缓存 清理' },
  { id: 'about', group: '应用', label: '关于', icon: 'info', description: '版本、更新与重置', scope: '当前应用', keywords: '版本 更新 重置' },
] as const;

export type SettingsDialogTab = typeof SETTINGS_CATEGORIES[number]['id'];

export function isSettingsDialogTab(value: unknown): value is SettingsDialogTab {
  return SETTINGS_CATEGORIES.some(category => category.id === value);
}

export function findSettingsCategories(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return SETTINGS_CATEGORIES.filter(category => {
    const text = `${category.label} ${category.description} ${category.keywords}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}
