import { IconFolder, IconInfo, IconPlus } from '../../icons';

export function SourceDock({ paths, shouldPrompt, isBusy, onAdd, onReplace, onRemove, onSkip }: {
  paths: string[];
  shouldPrompt: boolean;
  isBusy: boolean;
  onAdd: () => void | Promise<void>;
  onReplace: (index: number) => void | Promise<void>;
  onRemove: (index: number) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
}) {
  return <section className="ph-sources" aria-label="素材来源">
    <div className="ph-sources__heading">
      <div><h2>素材来源</h2><span>{paths.length} 个外部库</span></div>
      <button type="button" className="btn btn--icon" aria-label="添加外部库" title="添加外部库"
        data-tutorial-target="external-library-add" disabled={isBusy} onClick={() => { void onAdd(); }}>
        <IconPlus width={16} height={16} />
      </button>
    </div>
    <div className="ph-sources__list" role="region" aria-label="外部库列表" tabIndex={0}>
      {paths.length ? paths.map((path, index) => <div className="ph-source" key={`${path}:${index}`}>
        <IconFolder width={16} height={16} />
        <div className="ph-source__copy"><strong>{path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path}</strong>
          <span title={path}>{path}</span></div>
        <div className="ph-source__actions">
          <button type="button" className="btn ph-btn-tiny" data-tutorial-target={`external-library-replace-${index}`}
            disabled={isBusy} onClick={() => { void onReplace(index); }}>修改</button>
          <button type="button" className="btn ph-btn-tiny" disabled={isBusy} onClick={() => { void onRemove(index); }}>移除</button>
        </div>
      </div>) : <div className="ph-sources__empty"><IconInfo width={16} height={16} />
        <span>{shouldPrompt ? '还没有连接外部素材库。' : '未配置外部素材库。'}</span>
        {shouldPrompt && <button type="button" className="btn ph-btn-tiny" disabled={isBusy}
          onClick={() => { void onSkip(); }}>暂不配置</button>}
      </div>}
    </div>
  </section>;
}
