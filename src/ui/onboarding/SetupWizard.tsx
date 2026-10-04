import { useState } from 'react';
import { IconFolder, IconInfo } from '../icons';
import { useSettings } from '../SettingsStore';

export const SetupWizard = ({ onComplete }: { onComplete: () => void }) => {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const { setSetting } = useSettings();

  const handleSelectExternal = async () => {
    try {
      const api = (window as any).aeonStageryAPI;
      const result = await (api.dialog?.showOpen || api.app?.showOpenDialog)?.({
        title: '选择外部资源库目录',
        properties: ['openDirectory']
      });
      if (result && !result.canceled && result.filePaths?.length > 0) {
        setSetting('assetsPath', result.filePaths[0]);
        onComplete();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateNew = async () => {
    try {
      const api = (window as any).aeonStageryAPI;
      const result = await (api.dialog?.showOpen || api.app?.showOpenDialog)?.({
        title: '选择一个空文件夹作为新库',
        properties: ['openDirectory']
      });
      
      if (result && !result.canceled && result.filePaths?.length > 0) {
        setLoading(true);
        const basePath = result.filePaths[0];
        
        // 自动生成标准目录结构
        const folders = ['models', 'backgrounds', 'audio', 'images'];
        for (const folder of folders) {
          const keepPath = await api.path.join(basePath, folder, '.keep');
          await api.fs.writeTextFile(keepPath, '');
        }
        
        setSetting('assetsPath', basePath);
        setLoading(false);
        onComplete();
      }
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg-primary)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, color: 'var(--text-primary)'
    }}>
      <div style={{
        width: 600, padding: 40, background: 'var(--bg-secondary)', 
        borderRadius: 'var(--radius-2xl)', boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
        border: '1px solid var(--border-default)',
        animation: 'slideUp 0.5s ease-out'
      }}>
        {step === 1 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 80, height: 80, margin: '0 auto 24px auto',
              background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(168, 85, 247, 0.15))',
              border: '1px solid rgba(168, 85, 247, 0.3)',
              borderRadius: 'var(--radius-full)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 24px var(--accent-glow)'
            }}>
              <img src="./icon.png" alt="AeonStagery" style={{ width: 56, height: 56, objectFit: 'contain' }} />
            </div>
            <h1 style={{ fontSize: 28, marginBottom: 16 }}>欢迎使用 AeonStagery</h1>
            <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 32 }}>
              在开始创作前，我们需要配置您的**核心资产库**。<br/>
              这是您存放 Live2D 模型、背景图和音频的“仓库”。
            </p>
            <button 
              className="btn btn--primary" 
              style={{ width: '100%', padding: 16, fontSize: 16, borderRadius: 'var(--radius-lg)' }}
              onClick={() => setStep(2)}
            >
              开始配置
            </button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 style={{ fontSize: 22, marginBottom: 8, textAlign: 'center' }}>选择资产库方案</h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', marginBottom: 32 }}>
              您有现成的游戏包资源吗？还是想从零开始？
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div 
                style={{
                  padding: 24, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)',
                  background: 'var(--bg-tertiary)', cursor: 'pointer', transition: 'all 0.2s'
                }}
                onClick={handleSelectExternal}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-primary)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <IconFolder width={24} color="var(--accent-primary)" />
                  <h3 style={{ fontSize: 16, margin: 0 }}>我有现成的外部资源库</h3>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, paddingLeft: 36 }}>
                  例如：直接选中某个游戏的 <code>public</code> 文件夹，无需复制文件即可直接引用。
                </p>
              </div>

              <div 
                style={{
                  padding: 24, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)',
                  background: 'var(--bg-tertiary)', cursor: 'pointer', transition: 'all 0.2s'
                }}
                onClick={handleCreateNew}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-primary)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <div style={{ color: 'var(--text-primary)' }}><IconInfo width={24} /></div>
                  <h3 style={{ fontSize: 16, margin: 0 }}>创建新的专属资产库</h3>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, paddingLeft: 36 }}>
                  选择一个空文件夹，我们会自动为您建立规范的 <code>models/</code>、<code>audio/</code> 等子目录。
                </p>
              </div>
            </div>

            {loading && (
              <div style={{ textAlign: 'center', marginTop: 24, color: 'var(--accent-primary)', fontSize: 14 }}>
                正在初始化库结构...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
