import type { ReactNode } from 'react';
import { IconArrowLeft } from '../../icons';
import { InfoTip } from '../../Tooltip';

export function HomeSubviewFrame({ title, currentLabel = title, info, parent, onGoHome, onBack, children }: {
  title: string;
  currentLabel?: string;
  info?: string;
  parent?: { label: string; onClick: () => void };
  onGoHome: () => void;
  onBack: () => void;
  children: ReactNode;
}) {
  return <section className="ph-surface ph-subview">
    <div className="ph-section-header ph-stagger-1">
      <div className="ph-subview-titles">
        <nav className="ph-breadcrumbs" aria-label="页面导航">
          <button type="button" className="ph-breadcrumb-btn" onClick={onGoHome}>开始制作</button>
          <span className="ph-breadcrumb-sep" aria-hidden="true">›</span>
          {parent && <>
            <button type="button" className="ph-breadcrumb-btn" onClick={parent.onClick}>{parent.label}</button>
            <span className="ph-breadcrumb-sep" aria-hidden="true">›</span>
          </>}
          <span className="ph-breadcrumb-current" aria-current="page">{currentLabel}</span>
        </nav>
        <h1 className="ph-section-title">{title}{info && <InfoTip content={info} />}</h1>
      </div>
      <button type="button" className="btn ph-btn-compact ph-back-btn" onClick={onBack}>
        <IconArrowLeft width={13} height={13} className="ph-back-icon" /> 返回
      </button>
    </div>
    {children}
  </section>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="ph-field"><span className="ph-field-label">{label}</span>{children}</label>;
}
