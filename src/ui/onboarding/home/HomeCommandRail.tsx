import { IconFolder, IconPlus, IconTarget, IconUsers } from '../../icons';

export function HomeCommandRail({ activeTarget, onGoHome, onCreate, onOpen, onCollaborate, onStartTutorial }: {
  activeTarget?: 'create' | 'collaboration';
  onGoHome: () => void;
  onCreate: () => void;
  onOpen: () => void | Promise<void>;
  onCollaborate: () => void;
  onStartTutorial: () => void;
}) {
  const commands = [
    { title: '新建项目', description: '创建可迁移的项目目录', icon: IconPlus, action: onCreate, target: 'create', style: 'primary' },
    { title: '打开项目', description: '选择项目目录或 project.json', icon: IconFolder, action: onOpen },
    { title: '协作', description: '主持或加入实时协作房间', icon: IconUsers, action: onCollaborate, target: 'collaboration' },
    { title: '开始教程', description: '跟着第一课完成一个镜头', icon: IconTarget, action: onStartTutorial, style: 'tutorial' },
  ];
  return <aside className="ph-command-rail" aria-label="制作命令">
    <button type="button" className="ph-brand" onClick={onGoHome} aria-label="AeonStagery 首页">
      <img src={`${import.meta.env.BASE_URL}icon-64.png`} width={36} height={36} alt="" />
      <span><strong>AeonStagery</strong><span>电影化场景工作台</span></span>
    </button>
    <nav className="ph-commands" aria-label="主命令">
      {commands.map(({ title, description, icon: Icon, action, target, style }) =>
        <button key={title} type="button" aria-label={title} aria-current={target && activeTarget === target ? 'page' : undefined}
          className={`ph-command${style ? ` ph-command--${style}` : ''}`} onClick={() => { void action(); }}>
          <span className="ph-command__icon"><Icon width={20} height={20} /></span>
          <span className="ph-command__copy"><span className="ph-command__title">{title}</span>
            <span className="ph-command__description">{description}</span></span>
        </button>)}
    </nav>
  </aside>;
}
