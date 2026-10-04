import React from 'react';
import { IconWarning } from './icons';

interface Props { children: React.ReactNode; name?: string; }
interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.name || 'unknown'}]`, error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', padding: 24, gap: 16, color: 'var(--text-primary)',
          background: 'var(--bg-secondary)',
        }}>
          <IconWarning width={48} height={48} style={{ opacity: 0.3 }} />
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {this.props.name || '组件'} 发生错误
          </div>
          <div style={{ fontSize: 12, opacity: 0.5, maxWidth: 400, textAlign: 'center', wordBreak: 'break-all' }}>
            {this.state.error.message}
          </div>
          <button className="btn btn--primary" onClick={this.handleReset} style={{ padding: '8px 24px', borderRadius: 'var(--radius-md)' }}>
            尝试恢复
          </button>
          <button className="btn" onClick={() => window.location.reload()} style={{ padding: '6px 16px', fontSize: 11 }}>
            重新加载应用
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
