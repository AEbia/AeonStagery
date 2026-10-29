import { IconCheck, IconChevronRight, IconCopy, IconEye, IconEyeOff, IconFolder, IconPlus, IconUsers } from '../../icons';
import { CollaborationAssetHandshakePanel } from '../../CollaborationAssetHandshakePanel';
import { VideoFormatFields } from '../../VideoFormatFields';
import { InfoTip, Tooltip } from '../../Tooltip';
import type { ProjectHomeProps, NavigationTarget, CollaborationMode } from '../ProjectHome';
import type { CollaborationDraft } from './useCollaborationDraft';
import { Field, HomeFormSection, HomeSubviewFrame } from './HomeSubviewFrame';

type Props = Pick<ProjectHomeProps, 'collaborationStatus' | 'collaborationEndpoint' | 'collaborationServerStatus' | 'assetHandshake' | 'onCancelResourceTransfer' | 'onStopCollaborationServer'> & {
  draft: CollaborationDraft;
  collaborationMode: CollaborationMode;
  navigateTo: (target: NavigationTarget) => void;
};

export function CollaborationView({ draft, collaborationMode, navigateTo, collaborationStatus, collaborationEndpoint,
  collaborationServerStatus, assetHandshake, onCancelResourceTransfer, onStopCollaborationServer }: Props) {
  const {
    hostProjectName,
    hostProjectRootPath,
    setHostProjectRootPath,
    setIsHostRootPathDirty,
    joinEndpoint,
    setJoinEndpoint,
    collaborationName,
    setCollaborationName,
    collaborationPort,
    setCollaborationPort,
    allowNetwork,
    setAllowNetwork,
    hostPassword,
    setHostPassword,
    joinPassword,
    setJoinPassword,
    joinRootPath,
    setJoinRootPath,
    setIsJoinRootPathDirty,
    copiedServerField,
    showServerDetails,
    setShowServerDetails,
    showHostPassword,
    setShowHostPassword,
    showJoinPassword,
    setShowJoinPassword,
    showServerPassword,
    setShowServerPassword,
    handleCopyServerInfo,
    videoFormatError,
    handleHostNameChange,
    handleBrowseHostLocation,
    handleBrowseJoinLocation,
    handleHostNew,
    handleHostExisting,
    handleJoinCollaboration,
    isSubmitting,
    videoFormat,
    setVideoFormat,
  } = draft;
  const collaborationProgressLabel = collaborationStatus === 'connecting'
    ? '连接中'
    : collaborationStatus === 'seeding'
      ? '准备协作'
      : null;
  const collaborationServerAddress = collaborationEndpoint.trim()
    || collaborationServerStatus?.localUrl
    || '未设置';

  const title = collaborationMode === 'host-new' ? '主持新剧本' : collaborationMode === 'host-existing' ? '主持已有剧本' : collaborationMode === 'join' ? '加入房间' : '协作';
  const description = collaborationMode === 'host-new' ? '新建项目并开启协作'
    : collaborationMode === 'host-existing' ? '选择已有项目开启协作'
    : collaborationMode === 'join' ? '输入链接或地址加入房间' : '主持或加入实时协作房间';
  return <HomeSubviewFrame title={title} info={description} onGoHome={() => navigateTo('start')}
    onBack={() => navigateTo(collaborationMode === 'menu' ? 'start' : 'collab-menu')}
    parent={collaborationMode === 'menu' ? undefined : { label: '协作', onClick: () => navigateTo('collab-menu') }}>
    {collaborationServerStatus && (
      <div className="ph-server-credentials-card ph-server-capsule ph-stagger-2">
        <div className="ph-server-capsule-bar">
          <div className="ph-server-capsule-main">
            <span className="ph-live-dot ph-live-dot--success" />
            <span className="ph-server-capsule-label">
              本机服务器 {collaborationServerStatus.running ? '运行中' : '已停止'}
            </span>
            <strong className="ph-server-capsule-url">{collaborationServerStatus.localUrl}</strong>
            <button
              type="button"
              className="btn ph-btn-micro"
              onClick={() => { void handleCopyServerInfo(collaborationServerStatus.localUrl, 'url'); }}
              title="复制服务地址"
            >
              {copiedServerField === 'url' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
              <span>{copiedServerField === 'url' ? '已复制' : '复制'}</span>
            </button>
          </div>

          <div className="ph-server-capsule-actions">
            <button
              type="button"
              className="btn ph-btn-micro"
              onClick={() => setShowServerDetails((v) => !v)}
              title="展开或折叠详细网络与资源信息"
            >
              {showServerDetails ? '收起详情' : '连接详情'}
            </button>
            <button
              type="button"
              className="btn ph-btn-micro ph-btn-danger-outline"
              onClick={() => { void onStopCollaborationServer(); }}
            >
              停止服务器
            </button>
          </div>
        </div>

        <div className="ph-credentials-grid">
          {collaborationServerStatus.inviteUrls && collaborationServerStatus.inviteUrls.length > 0 && (
            <div className="ph-credential-item ph-credential-item--featured">
              <div className="ph-credential-header">
                <span className="ph-credential-label">协作邀请链接</span>
                <button
                  type="button"
                  className="btn ph-btn-micro ph-btn-copy"
                  onClick={() => { void handleCopyServerInfo(collaborationServerStatus.inviteUrls![0], 'server-invite'); }}
                  title="复制完整邀请链接"
                >
                  {copiedServerField === 'server-invite' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                  <span>{copiedServerField === 'server-invite' ? '已复制' : '复制链接'}</span>
                </button>
              </div>
              <div className="ph-credential-input-wrapper">
                <input
                  className="ph-input ph-font-mono ph-credential-input"
                  readOnly
                  value={collaborationServerStatus.inviteUrls[0]}
                  aria-label="协作邀请链接"
                />
              </div>
            </div>
          )}

          {collaborationServerStatus.connectionPassword && (
            <div className="ph-credential-item">
              <div className="ph-credential-header">
                <span className="ph-credential-label">房间密码</span>
                <button
                  type="button"
                  className="btn ph-btn-micro ph-btn-copy"
                  onClick={() => { void handleCopyServerInfo(collaborationServerStatus.connectionPassword!, 'server-pwd'); }}
                  title="复制连接密码"
                >
                  {copiedServerField === 'server-pwd' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                  <span>{copiedServerField === 'server-pwd' ? '已复制' : '复制密码'}</span>
                </button>
              </div>
              <div className="ph-credential-input-wrapper ph-password-input-row">
                <input
                  className="ph-input ph-font-mono ph-credential-input"
                  type={showServerPassword ? 'text' : 'password'}
                  readOnly
                  value={collaborationServerStatus.connectionPassword}
                  aria-label="协作连接密码"
                />
                <button
                  type="button"
                  className="ph-input-eye-btn"
                  onClick={() => setShowServerPassword((v) => !v)}
                  title={showServerPassword ? '隐藏密码' : '显示密码'}
                  aria-label={showServerPassword ? '隐藏密码' : '显示密码'}
                >
                  {showServerPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
                </button>
              </div>
            </div>
          )}

          <div className="ph-credential-item">
            <div className="ph-credential-header">
              <span className="ph-credential-label">服务地址（局域网 / 本机）</span>
              <button
                type="button"
                className="btn ph-btn-micro ph-btn-copy"
                onClick={() => {
                  const endpoint = collaborationServerStatus.lanUrls[0] || collaborationServerStatus.localUrl;
                  void handleCopyServerInfo(endpoint, 'server-endpoint');
                }}
                title="复制服务地址"
              >
                {copiedServerField === 'server-endpoint' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                <span>{copiedServerField === 'server-endpoint' ? '已复制' : '复制地址'}</span>
              </button>
            </div>
            <div className="ph-credential-input-wrapper">
              <input
                className="ph-input ph-font-mono ph-credential-input"
                readOnly
                value={collaborationServerStatus.lanUrls[0] || collaborationServerStatus.localUrl}
                aria-label="协作服务地址"
              />
            </div>
          </div>
        </div>

        {showServerDetails && (
          <div className="ph-server-details-panel">
            <div className="ph-server-resource-status">
              <span>资源目录</span>
              <strong title={collaborationServerStatus.assetRoot}>{collaborationServerStatus.assetRoot}</strong>
              <span>{collaborationServerStatus.hasState ? '已有房间状态' : '等待首次发布'}</span>
            </div>
            {collaborationServerStatus.lanUrls.length > 0 && (
              <div className="ph-server-urls">
                <span style={{ alignSelf: 'center', opacity: 0.7 }}>局域网：</span>
                {collaborationServerStatus.lanUrls.map((url) => (
                  <span
                    key={url}
                    onClick={() => { void handleCopyServerInfo(url, url); }}
                    title="点击复制该地址"
                    style={{ cursor: 'pointer' }}
                  >
                    {url}
                  </span>
                ))}
              </div>
            )}
            {collaborationServerStatus.connectionPassword && (
              <Field label="连接密码（仅分享给协作者）">
                <input className="ph-input" readOnly value={collaborationServerStatus.connectionPassword} />
              </Field>
            )}
          </div>
        )}
      </div>
    )}

    {collaborationProgressLabel ? (
      <div role="status" className="ph-collab-progress ph-stagger-2">
        <div className="ph-collab-progress-main">
          <strong>{collaborationProgressLabel}</strong>
          <span>{collaborationStatus === 'connecting' ? '正在连接协作服务器...' : '正在准备协作资源...'}</span>
        </div>
        <div className="ph-collab-progress-endpoint">
          <span>服务器地址</span>
          <strong>{collaborationServerAddress}</strong>
        </div>
      </div>
    ) : null}

    <CollaborationAssetHandshakePanel
      state={assetHandshake}
      onCancelTransfer={onCancelResourceTransfer}
    />

    {collaborationMode === 'menu' && (
      <div className="ph-collab-choices">
        <Tooltip content="新建项目并开启协作。" placement="right">
          <button className="ph-collab-choice" onClick={() => navigateTo('collab-host-new')}>
            <span className="ph-collab-choice__icon"><IconPlus width={22} height={22} /></span>
            <span className="ph-command__title">主持新剧本</span>
            <IconChevronRight className="ph-collab-choice__arrow" width={18} height={18} />
          </button>
        </Tooltip>
        <Tooltip content="选择已有项目并开启协作。" placement="right">
          <button className="ph-collab-choice" onClick={() => navigateTo('collab-host-existing')}>
            <span className="ph-collab-choice__icon"><IconFolder width={22} height={22} /></span>
            <span className="ph-command__title">主持已有剧本</span>
            <IconChevronRight className="ph-collab-choice__arrow" width={18} height={18} />
          </button>
        </Tooltip>
        <Tooltip content="输入邀请链接或服务器地址加入房间。" placement="right">
          <button className="ph-collab-choice" onClick={() => navigateTo('collab-join')}>
            <span className="ph-collab-choice__icon"><IconUsers width={22} height={22} /></span>
            <span className="ph-command__title">加入房间</span>
            <IconChevronRight className="ph-collab-choice__arrow" width={18} height={18} />
          </button>
        </Tooltip>
      </div>
    )}

    {collaborationMode === 'host-new' && (
      <div className="ph-collab-form-stack">
        <CollabModeTabs currentMode="host-new" onSelectMode={navigateTo} />

        <HomeFormSection title="项目信息">
          <Field label="项目名称">
            <input
              className="ph-input"
              value={hostProjectName}
              onChange={(event) => handleHostNameChange(event.target.value)}
              placeholder="例如：第 1 话协作"
            />
          </Field>
          <div className="ph-field-full">
            <Field label="项目位置">
              <div className="ph-browse-row">
                <input
                  className="ph-input"
                  value={hostProjectRootPath}
                  onChange={(event) => {
                    setIsHostRootPathDirty(true);
                    setHostProjectRootPath(event.target.value);
                  }}
                  placeholder="选择新项目目录"
                />
                <button className="btn ph-btn-compact" onClick={() => { void handleBrowseHostLocation(); }}>
                  浏览
                </button>
              </div>
            </Field>
          </div>
        </HomeFormSection>
        <HomeFormSection title="房间设置">
          <div className="ph-form-grid">
            <Field label="昵称">
              <input className="ph-input" value={collaborationName}
                onChange={(event) => setCollaborationName(event.target.value)} placeholder="导演" />
            </Field>
            <Field label="端口">
              <input
                className="ph-input"
                value={collaborationPort}
                onChange={(event) => setCollaborationPort(event.target.value.replace(/[^\d]/g, ''))}
                placeholder="12345"
              />
            </Field>
            <Field label="协作密码（选填）" className="ph-field-full">
              <div className="ph-password-input-row">
                <input
                  className="ph-input"
                  type={showHostPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={hostPassword}
                  onChange={(event) => setHostPassword(event.target.value)}
                  placeholder="留空自动生成随机密码"
                />
                <button
                  type="button"
                  className="ph-input-eye-btn"
                  onClick={() => setShowHostPassword((v) => !v)}
                  title={showHostPassword ? '隐藏密码' : '显示密码'}
                  aria-label={showHostPassword ? '隐藏密码' : '显示密码'}
                >
                  {showHostPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
                </button>
              </div>
            </Field>
            <div className="ph-field-full ph-network-option">
              <label className="ph-hint-text ph-checkbox-row">
                <input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} />
                <span>允许其他设备连接</span>
              </label>
              <InfoTip ariaLabel="连接范围说明" content="监听所有网卡，配置公网网卡或端口转发时可能向公网开放，实际连接范围受防火墙和路由规则影响。" />
            </div>
          </div>
        </HomeFormSection>
        <HomeFormSection title="画布与帧率" info="画布与帧率保存在项目中，协作成员需保持一致。">
          <div className="ph-video-section">
            <VideoFormatFields value={videoFormat} onChange={setVideoFormat} idPrefix="host-video" disabled={isSubmitting} />
            {videoFormatError && <p role="alert" className="video-format__error">{videoFormatError}</p>}
          </div>
        </HomeFormSection>
        <div className="ph-footer-row">
          <div />
          <button
            className="btn btn--primary ph-btn-primary-compact"
            onClick={() => { void handleHostNew(); }}
            disabled={!hostProjectName.trim() || !hostProjectRootPath.trim() || isSubmitting || !!videoFormatError}
          >
            {isSubmitting ? '正在主持...' : '创建并主持'}
          </button>
        </div>
      </div>
    )}

    {collaborationMode === 'host-existing' && (
      <div className="ph-collab-form-stack">
        <CollabModeTabs currentMode="host-existing" onSelectMode={navigateTo} />

        <HomeFormSection title="房间设置">
          <div className="ph-form-grid">
            <Field label="昵称">
              <input
                className="ph-input"
                value={collaborationName}
                onChange={(event) => setCollaborationName(event.target.value)}
                placeholder="导演"
              />
            </Field>
            <Field label="端口">
              <input
                className="ph-input"
                value={collaborationPort}
                onChange={(event) => setCollaborationPort(event.target.value.replace(/[^\d]/g, ''))}
                placeholder="12345"
              />
            </Field>
            <Field label="协作密码（选填）" className="ph-field-full">
              <div className="ph-password-input-row">
                <input
                  className="ph-input"
                  type={showHostPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={hostPassword}
                  onChange={(event) => setHostPassword(event.target.value)}
                  placeholder="留空自动生成随机密码"
                />
                <button
                  type="button"
                  className="ph-input-eye-btn"
                  onClick={() => setShowHostPassword((v) => !v)}
                  title={showHostPassword ? '隐藏密码' : '显示密码'}
                  aria-label={showHostPassword ? '隐藏密码' : '显示密码'}
                >
                  {showHostPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
                </button>
              </div>
            </Field>
            <div className="ph-field-full ph-network-option">
              <label className="ph-hint-text ph-checkbox-row">
                <input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} />
                <span>允许其他设备连接</span>
              </label>
              <InfoTip ariaLabel="连接范围说明" content="监听所有网卡，配置公网网卡或端口转发时可能向公网开放，实际连接范围受防火墙和路由规则影响。" />
            </div>
          </div>
        </HomeFormSection>
        <div className="ph-footer-row">
          <div />
          <button
            className="btn btn--primary ph-btn-primary-compact"
            onClick={() => { void handleHostExisting(); }}
            disabled={isSubmitting}
          >
            {isSubmitting ? '正在主持...' : '选择项目并主持'}
          </button>
        </div>
      </div>
    )}

    {collaborationMode === 'join' && (
      <div className="ph-collab-form-stack">
        <CollabModeTabs currentMode="join" onSelectMode={navigateTo} />

        <HomeFormSection title="连接信息">
          <Field label="服务器">
            <input
              className="ph-input"
              value={joinEndpoint}
              onChange={(event) => setJoinEndpoint(event.target.value)}
              placeholder="127.0.0.1:12345"
            />
          </Field>
          <Field label="房间密码（选填）">
            <div className="ph-password-input-row">
              <input
                className="ph-input"
                type={showJoinPassword ? 'text' : 'password'}
                autoComplete="off"
                value={joinPassword}
                onChange={(event) => setJoinPassword(event.target.value)}
                placeholder="输入主持人提供的密码"
              />
              <button
                type="button"
                className="ph-input-eye-btn"
                onClick={() => setShowJoinPassword((v) => !v)}
                title={showJoinPassword ? '隐藏密码' : '显示密码'}
                aria-label={showJoinPassword ? '隐藏密码' : '显示密码'}
              >
                {showJoinPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
              </button>
            </div>
          </Field>
        </HomeFormSection>
        <HomeFormSection title="本地工作区">
          <Field label="昵称">
            <input
              className="ph-input"
              value={collaborationName}
              onChange={(event) => setCollaborationName(event.target.value)}
              placeholder="导演"
            />
          </Field>
          <div className="ph-field-full">
            <Field label="本地协作工作区">
              <div className="ph-browse-row">
                <input
                  className="ph-input"
                  value={joinRootPath}
                  onChange={(event) => {
                    setIsJoinRootPathDirty(true);
                    setJoinRootPath(event.target.value);
                  }}
                  placeholder="选择空目录或已有项目目录"
                />
                <button className="btn ph-btn-compact" onClick={() => { void handleBrowseJoinLocation(); }}>
                  浏览
                </button>
              </div>
            </Field>
          </div>
        </HomeFormSection>
        <div className="ph-footer-row">
          <div />
          <button
            className="btn btn--primary ph-btn-primary-compact"
            onClick={() => { void handleJoinCollaboration(); }}
            disabled={!joinEndpoint.trim() || !joinRootPath.trim() || isSubmitting || collaborationStatus === 'connecting' || collaborationStatus === 'seeding'}
          >
            {isSubmitting ? '正在加入...' : '加入房间'}
          </button>
        </div>
      </div>
    )}
  </HomeSubviewFrame>;
}

const CollabModeTabs: React.FC<{
  currentMode: CollaborationMode;
  onSelectMode: (target: NavigationTarget) => void;
}> = ({ currentMode, onSelectMode }) => (
  <div className="ph-collab-mode-tabs" role="tablist" aria-label="协作模式选择">
    <button
      type="button"
      role="tab"
      aria-selected={currentMode === 'join'}
      aria-label="切换到加入房间"
      className={`ph-collab-mode-tab ${currentMode === 'join' ? 'ph-collab-mode-tab--active' : ''}`}
      onClick={() => onSelectMode('collab-join')}
    >
      <IconUsers width={14} height={14} />
      <span>加入房间</span>
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={currentMode === 'host-existing'}
      aria-label="切换到主持已有剧本"
      className={`ph-collab-mode-tab ${currentMode === 'host-existing' ? 'ph-collab-mode-tab--active' : ''}`}
      onClick={() => onSelectMode('collab-host-existing')}
    >
      <IconFolder width={14} height={14} />
      <span>主持已有剧本</span>
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={currentMode === 'host-new'}
      aria-label="切换到主持新剧本"
      className={`ph-collab-mode-tab ${currentMode === 'host-new' ? 'ph-collab-mode-tab--active' : ''}`}
      onClick={() => onSelectMode('collab-host-new')}
    >
      <IconPlus width={14} height={14} />
      <span>主持新剧本</span>
    </button>
  </div>
);
