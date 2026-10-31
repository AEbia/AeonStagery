import { diagnoseAiError } from '../../services/ai-authoring/aiErrorPresentation';
import { IconWarning } from '../icons';

interface AgentWindowWelcomeProps {
  greeting: string;
  startError: string | null;
  needsCredentialSetup: boolean;
  openSettings: () => void;
}
export function AgentWindowWelcome({
  greeting,
  startError,
  needsCredentialSetup,
  openSettings,
}: AgentWindowWelcomeProps) {
  return (
    <main className="agent-welcome">
      {startError && (() => {
        const diagnosis = diagnoseAiError(startError);
        return (
          <div className="agent-welcome__error" role="alert">
            <div className="agent-welcome__error-main">
              <IconWarning width={13} height={13} />
              <span>{startError}</span>
            </div>
            {diagnosis.category !== 'unknown' && diagnosis.userMessage !== startError && (
              <p className="agent-welcome__error-detail">
                {diagnosis.userMessage}
                {' '}
                {diagnosis.suggestion}
              </p>
            )}
            {diagnosis.suggestOpenSettings && (
              <button
                type="button"
                className="btn btn--sm agent-welcome__error-action"
                onClick={openSettings}
              >
                前往 AI 设置
              </button>
            )}
          </div>
              );
      })()}
      <h1 className="agent-welcome__title">{greeting}</h1>
      {needsCredentialSetup && (
        <div className="agent-welcome__setup-guide" role="region" aria-label="AI 配置引导">
          <div className="agent-welcome__setup-header">
            <span className="agent-welcome__setup-badge">首次使用引导</span>
            <strong>尚未配置 AI 服务（API Key）</strong>
          </div>
          <p className="agent-welcome__setup-desc">
            项目 Agent 需要调用支持工具调用（Tool Calling）的大语言模型来理解并编辑剧本工程。开始对话前请完成以下 3 步配置：
          </p>
          <ol className="agent-welcome__setup-steps">
            <li>前往 AI 服务商后台（如 DeepSeek、OpenAI 等）获取 <strong>API Key</strong>，或启动本地模型服务（如 Ollama）。</li>
            <li>点击下方按钮打开主窗口<strong>「AI 设置」</strong>，填写接口地址（Base URL）并保存 API 密钥。</li>
            <li>选择支持工具调用的模型（如 <code>deepseek-chat</code>、<code>gpt-4o</code>），点击<strong>「测试连接」</strong>验证后即可开始对话。</li>
          </ol>
          <div className="agent-welcome__setup-actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={openSettings}
            >
              前往 AI 设置
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
