import type { ReactNode } from 'react';
import './homeShell.css';

// A quiet command rail gives the cinematic stage the visual focus.
export function HomeShell({ rail, sources, children }: { rail: ReactNode; sources: ReactNode; children: ReactNode }) {
  return <div className="ph-overlay">
    <div className="ph-shell">
      {rail}
      <main className="ph-main" aria-label="项目工作台">{children}</main>
      {sources}
    </div>
  </div>;
}
