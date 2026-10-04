import { AiProseWorkbench } from './AiProseWorkbench';
import { FormalSceneEnhancementPanel } from './FormalSceneEnhancementPanel';
import {
  AiWorkbenchModeProvider,
  useAiWorkbenchMode,
  type AiWorkbenchMode,
} from './AiWorkbenchMode';
import './ai-prose-workbench.css';

export type { AiWorkbenchMode };
export { AiWorkbenchModeSwitch, useAiWorkbenchMode } from './AiWorkbenchMode';

function AiWorkbenchShellBody({ onClose }: { onClose?: () => void }) {
  const ctx = useAiWorkbenchMode();
  const mode = ctx?.mode ?? 'prose';
  const direction = ctx?.direction ?? null;
  const stageClass = direction
    ? `ai-prose-shell__stage is-enter-${direction}`
    : 'ai-prose-shell__stage';

  return (
    <div key={mode} className={stageClass}>
      {mode === 'prose'
        ? <AiProseWorkbench onClose={onClose} />
        : <FormalSceneEnhancementPanel onClose={onClose} />}
    </div>
  );
}

export function AiWorkbenchShell({ onClose }: { onClose?: () => void } = {}) {
  return (
    <AiWorkbenchModeProvider>
      <div className="ai-prose-shell" onMouseDown={(event) => event.stopPropagation()}>
        <AiWorkbenchShellBody onClose={onClose} />
      </div>
    </AiWorkbenchModeProvider>
  );
}

export { AiProseWorkbench };
export default AiWorkbenchShell;
