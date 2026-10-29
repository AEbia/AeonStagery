import { useId, type ReactNode } from 'react';
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
  return <section className="ph-subview">
    <header className="ph-section-header">
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
        <div className="ph-section-heading">
          <h1 className="ph-section-title">{title}</h1>
          {info && <InfoTip content={info} ariaLabel={`${title}说明`} />}
        </div>
      </div>
      <button type="button" className="btn ph-btn-compact ph-back-btn" onClick={onBack}>
        <IconArrowLeft width={13} height={13} className="ph-back-icon" /> 返回
      </button>
    </header>
    <div className="ph-subview__body">{children}</div>
  </section>;
}

export function HomeFormSection({ title, info, children }: {
  title: string;
  info?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return <section className="ph-form-section" aria-labelledby={headingId}>
    <div className="ph-form-section__intro">
      <h2 id={headingId} className="ph-form-section__title">{title}{info && <InfoTip content={info} ariaLabel={`${title}说明`} />}</h2>
    </div>
    <div className="ph-form-section__fields">{children}</div>
  </section>;
}

export function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <label className={`ph-field${className ? ` ${className}` : ''}`}><span className="ph-field-label">{label}</span>{children}</label>;
}
