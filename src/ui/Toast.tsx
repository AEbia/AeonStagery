import React, { useState, useEffect, useCallback, useRef } from 'react';
import { eventBus } from '../api/events';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCheckCircle,
  IconCopy,
  IconInfo,
  IconX,
} from './icons';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

export interface ToastItem {
  id: string | number;
  message: string;
  type: ToastType;
  duration: number;
  remaining: number;
  startTime: number;
  isPaused: boolean;
  count: number;
  action?: ToastAction;
}

let nextId = 0;

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  error: 6000,
  warning: 4500,
  info: 4000,
  success: 3500,
};

const MIN_RESUME_REMAINING_MS = 1500;
const MAX_TOASTS = 5;
const DEDUPE_WINDOW_MS = 3000;

const TOAST_ERROR_TRANSLATIONS: Array<[RegExp, string | ((match: string, operation: string) => string)]> = [
  [/^Assertion failed(?::\s*)?/i, '断言失败：'],
  [/^Failed to fetch\b/i, '网络请求失败'],
  [/^Network error\b/i, '网络错误'],
  [/^schema validation failed\b/i, '结构校验失败'],
  [/^Invalid JSON\b/i, 'JSON 无效'],
  [/^Invalid\b/i, '无效的'],
  [/^Unsupported\b/i, '不支持的'],
  [/^Failed to (?:load|read)\b/i, '加载失败'],
  [/^Failed to write\b/i, '写入失败'],
  [/^Failed to save\b/i, '保存失败'],
  [/^Failed to resolve\b/i, '解析失败'],
  [/^Failed to set\b/i, '设置失败'],
  [/^Failed to play\b/i, '播放失败'],
  [/^Failed to (\w+)\b/i, (_, operation: string) => `${operation}失败`],
  [/^Could not\b/i, '无法'],
  [/^Cannot read properties of (null|undefined) \(reading '([^']+)'\)/i, '无法读取 $1 的属性 "$2"'],
  [/^Cannot\b/i, '无法'],
  [/^No (.+?) resource matches\b/i, '没有找到匹配的$1资源'],
  [/\bnot found\b/i, '未找到'],
  [/\bnot initialized\b/i, '尚未初始化'],
  [/\bmissing\b/i, '缺少'],
  [/\bempty file path\b/i, '文件路径为空'],
  [/\bchoose an available (.+?) and retry\.?$/i, '请选择可用的$1后重试。'],
  [/\bPlease try again\.?$/i, '请重试。'],
];

export function localizeToastMessage(message: string): string {
  let localized = message;
  for (const [pattern, replacement] of TOAST_ERROR_TRANSLATIONS) {
    localized = typeof replacement === 'function'
      ? localized.replace(pattern, replacement)
      : localized.replace(pattern, replacement);
  }

  localized = localized
    .replace(/\bHTTP (\d{3})\b/gi, 'HTTP 状态码 $1')
    .replace(/\breading '([^']+)'/gi, '读取 "$1"')
    .replace(/Expected non-empty string at ([^\n]+)$/i, '$1：必须填写非空字符串')
    .replace(/Expected (.+?) at ([^\n]+)$/i, '$2：预期为 $1')
    .replace(/:\s*(?=[^:\n]+：)/g, '：');

  localized = localized
    .replace(/\bscene\.meta\.characters\b/g, '场景元数据.角色列表')
    .replace(/\bscene\.meta\.title\b/g, '场景元数据.标题')
    .replace(/\bscene\.meta\b/g, '场景元数据')
    .replace(/\bscene\.statements\b/g, '场景语句列表')
    .replace(/\.name\b/g, '.名称')
    .replace(/\.id\b/g, '.标识')
    .replace(/\.model\b/g, '.模型文件')
    .replace(/\.params\b/g, '.参数')
    .replace(/\.type\b/g, '.类型');

  return localized;
}

export function showToast(
  message: string,
  type: ToastType = 'info',
  options?: ToastOptions,
) {
  eventBus.emit('toast:show', {
    id: ++nextId,
    message: localizeToastMessage(message),
    type,
    duration: options?.duration,
    action: options?.action,
  });
}

export const ToastContainer: React.FC = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [leavingToastIds, setLeavingToastIds] = useState<Set<string | number>>(() => new Set());
  const [copiedToastId, setCopiedToastId] = useState<string | number | null>(null);

  const toastsRef = useRef<ToastItem[]>([]);
  toastsRef.current = toasts;

  const leavingToastIdsRef = useRef<Set<string | number>>(new Set());
  leavingToastIdsRef.current = leavingToastIds;

  const timerMapRef = useRef<Map<string | number, number>>(new Map());
  const exitTimersRef = useRef<number[]>([]);
  const copyResetTimerRef = useRef<number | null>(null);

  const removeToast = useCallback((id: string | number) => {
    const timer = timerMapRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timerMapRef.current.delete(id);
    }

    setLeavingToastIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      leavingToastIdsRef.current = next;
      return next;
    });

    const exitTimer = window.setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      setLeavingToastIds(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        leavingToastIdsRef.current = next;
        return next;
      });
    }, 200);
    exitTimersRef.current.push(exitTimer);
  }, []);

  const scheduleDismiss = useCallback((id: string | number, delayMs: number) => {
    const existing = timerMapRef.current.get(id);
    if (existing) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      removeToast(id);
    }, delayMs);
    timerMapRef.current.set(id, timer);
  }, [removeToast]);

  const handleMouseEnter = useCallback((id: string | number) => {
    const timer = timerMapRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timerMapRef.current.delete(id);
    }
    setToasts(prev =>
      prev.map(t => {
        if (t.id !== id || t.isPaused) return t;
        const elapsed = Date.now() - t.startTime;
        const remaining = Math.max(t.remaining - elapsed, MIN_RESUME_REMAINING_MS);
        return { ...t, remaining, isPaused: true };
      }),
    );
  }, []);

  const handleMouseLeave = useCallback((id: string | number) => {
    setToasts(prev => {
      const target = prev.find(t => t.id === id);
      if (!target || !target.isPaused) return prev;
      const now = Date.now();
      scheduleDismiss(id, target.remaining);
      return prev.map(t => (t.id === id ? { ...t, isPaused: false, startTime: now } : t));
    });
  }, [scheduleDismiss]);

  const handleCopy = useCallback(async (e: React.MouseEvent, toast: ToastItem) => {
    e.stopPropagation();
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(toast.message);
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = toast.message;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedToastId(toast.id);
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedToastId(null);
      }, 1800);
    } catch (err) {
      console.error('Failed to copy toast message', err);
    }
  }, []);

  useEffect(() => {
    const timerMap = timerMapRef.current;
    const exitTimers = exitTimersRef.current;
    const handler = (payload: any) => {
      if (!payload || typeof payload !== 'object') return;
      const rawMessage = String(payload.message ?? '');
      const localizedMessage = localizeToastMessage(rawMessage);
      const type: ToastType = (['success', 'error', 'info', 'warning'] as const).includes(payload.type)
        ? payload.type
        : 'info';
      const duration = typeof payload.duration === 'number' && payload.duration > 0
        ? payload.duration
        : DEFAULT_DURATIONS[type];
      const action = payload.action && typeof payload.action.label === 'string' && typeof payload.action.onClick === 'function'
        ? payload.action
        : undefined;
      const id = payload.id ?? ++nextId;
      const now = Date.now();

      setToasts(prev => {
        const lastIndex = prev.length - 1;
        const last = lastIndex >= 0 ? prev[lastIndex] : null;

        // Deduplicate identical consecutive toasts within window
        if (
          last &&
          last.message === localizedMessage &&
          last.type === type &&
          now - last.startTime < DEDUPE_WINDOW_MS &&
          !leavingToastIdsRef.current.has(last.id)
        ) {
          scheduleDismiss(last.id, duration);
          return prev.map((item, idx) =>
            idx === lastIndex
              ? {
                  ...item,
                  count: (item.count || 1) + 1,
                  duration,
                  remaining: duration,
                  startTime: now,
                  isPaused: false,
                }
              : item,
          );
        }

        let baseList = prev;
        if (baseList.length >= MAX_TOASTS) {
          const oldest = baseList[0];
          removeToast(oldest.id);
          baseList = baseList.slice(1);
        }

        scheduleDismiss(id, duration);

        const newItem: ToastItem = {
          id,
          message: localizedMessage,
          type,
          duration,
          remaining: duration,
          startTime: now,
          isPaused: false,
          count: 1,
          action,
        };

        return [...baseList, newItem];
      });
    };

    const unsub = eventBus.on('toast:show', handler);
    return () => {
      unsub();
      timerMap.forEach(timer => window.clearTimeout(timer));
      timerMap.clear();
      exitTimers.forEach(timer => window.clearTimeout(timer));
      exitTimersRef.current = [];
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, [removeToast, scheduleDismiss]);

  const renderIcon = (type: ToastType) => {
    switch (type) {
      case 'success':
        return <IconCheckCircle className="app-toast__icon" size={16} aria-hidden="true" />;
      case 'error':
        return <IconAlertCircle className="app-toast__icon" size={16} aria-hidden="true" />;
      case 'warning':
        return <IconAlertTriangle className="app-toast__icon" size={16} aria-hidden="true" />;
      case 'info':
      default:
        return <IconInfo className="app-toast__icon" size={16} aria-hidden="true" />;
    }
  };

  return (
    <div className="app-toast-region" role="region" aria-label="通知" aria-live="polite">
      {toasts.map(t => {
        const isLeaving = leavingToastIds.has(t.id);
        return (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            aria-atomic="true"
            className={`app-toast app-toast--${t.type}${isLeaving ? ' app-toast--leaving' : ''}${t.isPaused ? ' app-toast--paused' : ''}`}
            onMouseEnter={() => handleMouseEnter(t.id)}
            onMouseLeave={() => handleMouseLeave(t.id)}
          >
            <div className="app-toast__icon-wrapper" aria-hidden="true">
              {renderIcon(t.type)}
            </div>

            <div className="app-toast__body">
              <span className="app-toast__message">{t.message}</span>
              {t.count > 1 && (
                <span className="app-toast__badge" title={`已触发 ${t.count} 次`}>
                  ×{t.count}
                </span>
              )}
            </div>

            <div className="app-toast__actions">
              {t.action && (
                <button
                  type="button"
                  className="app-toast__btn app-toast__btn--action"
                  onClick={e => {
                    e.stopPropagation();
                    t.action?.onClick();
                  }}
                >
                  {t.action.label}
                </button>
              )}

              {t.type === 'error' && (
                <button
                  type="button"
                  className="app-toast__btn app-toast__btn--copy"
                  title={copiedToastId === t.id ? '已复制' : '复制报错信息'}
                  aria-label={copiedToastId === t.id ? '已复制' : '复制报错信息'}
                  onClick={e => handleCopy(e, t)}
                >
                  {copiedToastId === t.id ? (
                    <>
                      <IconCheck size={13} aria-hidden="true" />
                      <span className="app-toast__btn-text">已复制</span>
                    </>
                  ) : (
                    <>
                      <IconCopy size={13} aria-hidden="true" />
                      <span className="app-toast__btn-text">复制</span>
                    </>
                  )}
                </button>
              )}

              <button
                type="button"
                className="app-toast__btn app-toast__btn--close"
                title="关闭通知"
                aria-label="关闭通知"
                onClick={e => {
                  e.stopPropagation();
                  removeToast(t.id);
                }}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
            </div>

            <div
              className="app-toast__progress"
              style={{
                animationDuration: `${t.duration}ms`,
                animationPlayState: t.isPaused ? 'paused' : 'running',
              }}
            />
          </div>
        );
      })}
    </div>
  );
};
