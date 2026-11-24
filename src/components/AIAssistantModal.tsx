import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Switch, Tooltip, message } from 'antd';
import {
  ArrowUpOutlined,
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  RollbackOutlined
} from '@ant-design/icons';
import DraggableModal from './DraggableModal';
import { AIOperation } from '../api';
import { Line, Station } from '../types';
import {
  AIChatMessage,
  AIConversationSession,
  buildApiHistory,
  createEmptyAISession,
  deriveSessionTitle,
  formatRelativeTime,
  loadAISessions,
  saveAISessions
} from '../lib/aiSessionStore';

const { TextArea } = Input;

interface AnalyzeResult {
  explanation: string;
  operations: AIOperation[];
  summaries: string[];
  skippedCount: number;
}

interface AIAssistantModalProps {
  open: boolean;
  busy: boolean;
  userId?: string | null;
  mapKey: string;
  mapName: string;
  lines: Line[];
  stations: Station[];
  canUndo?: boolean;
  onUndo?: () => void;
  onAnalyzeStream: (
    messages: { role: 'user' | 'assistant'; content: string }[],
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ) => Promise<AnalyzeResult>;
  onApply: (operations: AIOperation[]) => number;
  onCancel: () => void;
}

const AUTO_APPLY_KEY = 'metro_ai_auto_apply';

interface StarterPrompt {
  id: string;
  color: string;
  prompt: string;
}

function buildContextualPrompts(lines: Line[], stations: Station[]): StarterPrompt[] {
  if (lines.length === 0 || stations.length === 0) {
    return [
      {
        id: 'blank-1',
        color: '#dc2626',
        prompt: '创建红色 1 号线（东西向），包含西站、市民中心、人民广场、科技园、东站'
      },
      {
        id: 'blank-2',
        color: '#2563eb',
        prompt: '新建 1 号线（#e11d48）与 2 号线（#2563eb），在「人民广场」十字换乘'
      },
      {
        id: 'blank-3',
        color: '#0891b2',
        prompt: '新建机场快线（#0891b2），连接火车北站、中央商务区、会展中心与国际机场'
      },
      {
        id: 'blank-4',
        color: '#7c3aed',
        prompt: '新建紫色 3 号线，连接大学城、软件园与南站'
      }
    ];
  }

  const stationById = new Map(stations.map((s) => [s.id, s]));
  const firstLine = lines[0];
  const secondLine = lines[1] || firstLine;
  const lineStations = firstLine.stationIds.map((id) => stationById.get(id)).filter(Boolean) as Station[];
  const pivotStation = lineStations[Math.floor(lineStations.length / 2)] || stations[0];
  const stA = lineStations[0];
  const stB = lineStations[1];

  const prompts: StarterPrompt[] = [
    {
      id: 'ext',
      color: firstLine.color || '#2563eb',
      prompt: `将「${firstLine.name}」向终点方向延伸 3 个新站点`
    },
    {
      id: 'branch',
      color: '#2563eb',
      prompt: `新建蓝色线路与「${firstLine.name}」在「${pivotStation.name}」换乘，延伸 4 站`
    }
  ];

  if (stA && stB) {
    prompts.push({
      id: 'between',
      color: secondLine.color || firstLine.color || '#10b981',
      prompt: `在「${firstLine.name}」的「${stA.name}」和「${stB.name}」之间新增 2 个站点`
    });
  } else {
    prompts.push({
      id: 'new-ring',
      color: '#f97316',
      prompt: '新建橙色联络线（#f97316），包含 5 个站点'
    });
  }

  prompts.push({
    id: 'recolor',
    color: '#d23030',
    prompt: `把「${firstLine.name}」改为深红色 #d23030`
  });

  return prompts;
}

const HEX_IN_SUMMARY_RE = /(#[0-9a-fA-F]{6})/g;

function renderSummaryWithColorSwatches(summary: string): React.ReactNode {
  const parts = summary.split(HEX_IN_SUMMARY_RE);
  if (parts.length === 1) return summary;
  return parts.map((part, idx) => {
    if (/^#[0-9a-fA-F]{6}$/.test(part)) {
      return (
        <span key={idx} className="metro-ai-color-chip">
          <span className="metro-ai-color-chip__dot" style={{ backgroundColor: part }} />
          <code>{part}</code>
        </span>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function inferOperationAccentColor(op: AIOperation | undefined, lines: Line[]): string {
  if (!op) return '#94a3b8';
  if ('color' in op && typeof op.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(op.color)) {
    return op.color;
  }
  if ('lineId' in op && typeof op.lineId === 'string') {
    const matched = lines.find((l) => l.id === op.lineId);
    if (matched?.color) return matched.color;
  }
  return '#2563eb';
}

const AIAssistantModal: React.FC<AIAssistantModalProps> = ({
  open,
  busy,
  userId,
  mapKey,
  mapName,
  lines,
  stations,
  canUndo = false,
  onUndo,
  onAnalyzeStream,
  onApply,
  onCancel
}) => {
  const [sessions, setSessions] = useState<AIConversationSession[]>(() => loadAISessions(userId));
  const [activeSession, setActiveSession] = useState<AIConversationSession>(() => {
    const existing = loadAISessions(userId).find((s) => s.mapKey === mapKey);
    return existing || createEmptyAISession(mapKey, mapName);
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyScope, setHistoryScope] = useState<'current' | 'all'>('current');
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  const [autoApply, setAutoApply] = useState<boolean>(() => {
    try {
      return window.localStorage?.getItem(AUTO_APPLY_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [lastAppliedMsgId, setLastAppliedMsgId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<any>(null);
  const abortRef = useRef<AbortController | null>(null);
  const prevMapKeyRef = useRef(mapKey);
  const prevUserIdRef = useRef(userId);
  const autoApplyRef = useRef(autoApply);
  autoApplyRef.current = autoApply;

  useEffect(() => {
    if (prevUserIdRef.current !== userId || prevMapKeyRef.current !== mapKey) {
      prevUserIdRef.current = userId;
      prevMapKeyRef.current = mapKey;
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      const loaded = loadAISessions(userId);
      setSessions(loaded);
      const match = loaded.find((s) => s.mapKey === mapKey);
      setActiveSession(match || createEmptyAISession(mapKey, mapName));
      setLastAppliedMsgId(null);
      setError('');
    }
  }, [userId, mapKey, mapName]);

  useEffect(() => {
    if (!mapName) return;
    setActiveSession((prev) => (prev.mapKey === mapKey && prev.mapName !== mapName ? { ...prev, mapName } : prev));
  }, [mapKey, mapName]);

  useEffect(() => {
    const hasRealMessages = activeSession.messages.some(
      (m) => !(m.role === 'assistant' && m.streaming && !m.content)
    );
    if (!hasRealMessages) return;

    setSessions((prev) => {
      const others = prev.filter((s) => s.id !== activeSession.id);
      const next = [activeSession, ...others].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 32);
      saveAISessions(userId, next);
      return next;
    });
  }, [activeSession, userId]);

  const messages = activeSession.messages;
  const isCompactEmpty = messages.length === 0 && !busy && !historyOpen;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [open]);

  const starterPrompts = useMemo(() => buildContextualPrompts(lines, stations), [lines, stations]);

  const filteredSessions = useMemo(() => {
    if (historyScope === 'all') return sessions;
    return sessions.filter((s) => s.mapKey === mapKey);
  }, [sessions, historyScope, mapKey]);

  const currentMapSessionCount = useMemo(
    () => sessions.filter((s) => s.mapKey === mapKey).length,
    [sessions, mapKey]
  );

  const handleToggleAutoApply = (checked: boolean) => {
    setAutoApply(checked);
    try {
      window.localStorage?.setItem(AUTO_APPLY_KEY, checked ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const handleStopStream = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  };

  const sendPrompt = async (rawPrompt: string, baseMessages?: AIChatMessage[]) => {
    const text = rawPrompt.trim();
    if (!text || busy) return;
    setError('');

    const prior = baseMessages ?? activeSession.messages;
    const now = Date.now();
    const userMsg: AIChatMessage = {
      role: 'user',
      id: `u_${now}_${Math.random().toString(36).slice(2, 6)}`,
      content: text,
      createdAt: now
    };
    const assistantId = `a_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const assistantPlaceholder: AIChatMessage = {
      role: 'assistant',
      id: assistantId,
      content: '',
      createdAt: now + 1,
      operations: [],
      summaries: [],
      skippedCount: 0,
      streaming: true,
      applied: false,
      discarded: false
    };

    const historyForApi = buildApiHistory(prior, text);
    const cleanedPrior =
      prior.length > 0 && prior[prior.length - 1].role === 'user' && prior[prior.length - 1].content.trim() === text
        ? prior.slice(0, -1)
        : prior;

    setActiveSession((prev) => ({
      ...prev,
      mapKey,
      mapName: mapName || prev.mapName,
      title: !prev.titleEdited && cleanedPrior.length === 0 ? deriveSessionTitle(text) : prev.title,
      messages: [...cleanedPrior, userMsg, assistantPlaceholder],
      updatedAt: now
    }));
    setInput('');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await onAnalyzeStream(
        historyForApi,
        (cumulativeText) => {
          setActiveSession((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantId && m.role === 'assistant' ? { ...m, content: cumulativeText } : m
            )
          }));
        },
        controller.signal
      );

      let didAutoApply = false;
      if (autoApplyRef.current && result.operations.length > 0) {
        onApply(result.operations);
        didAutoApply = true;
        setLastAppliedMsgId(assistantId);
      }

      setActiveSession((prev) => ({
        ...prev,
        updatedAt: Date.now(),
        messages: prev.messages.map((m) => {
          if (m.id === assistantId && m.role === 'assistant') {
            return {
              ...m,
              streaming: false,
              content:
                result.explanation ||
                (result.operations.length > 0
                  ? didAutoApply
                    ? `已应用 ${result.operations.length} 项变更。`
                    : `生成 ${result.operations.length} 项变更，确认后可应用到画布。`
                  : '未解析出可执行的画布操作，请补充具体的线路或站点名称。'),
              operations: result.operations,
              summaries: result.summaries,
              skippedCount: result.skippedCount,
              applied: didAutoApply
            };
          }
          return m;
        })
      }));
    } catch (e: any) {
      const aborted = e?.name === 'AbortError';
      if (!aborted) {
        setError(e?.message || '响应失败，请重试');
      }
      setActiveSession((prev) => ({
        ...prev,
        updatedAt: Date.now(),
        messages: prev.messages
          .map((m) => {
            if (m.id !== assistantId || m.role !== 'assistant') return m;
            if (aborted && m.content.trim()) {
              return { ...m, streaming: false, content: `${m.content}\n\n（已停止）` };
            }
            return null;
          })
          .filter(Boolean) as AIChatMessage[]
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const handleSubmit = () => {
    void sendPrompt(input);
  };

  const handleApply = (msgId: string) => {
    const target = activeSession.messages.find((m) => m.id === msgId);
    if (!target || target.role !== 'assistant' || (target.applied && !target.undone) || target.discarded) {
      return;
    }
    const count = onApply(target.operations);
    if (count > 0) {
      setLastAppliedMsgId(msgId);
      message.success(`已应用 ${count} 项修改`);
    }
    setActiveSession((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      messages: prev.messages.map((m) =>
        m.id === msgId && m.role === 'assistant' ? { ...m, applied: true, undone: false } : m
      )
    }));
  };

  const handleUndoApplied = (msgId: string) => {
    if (!canUndo || !onUndo) return;
    onUndo();
    setLastAppliedMsgId(null);
    setActiveSession((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      messages: prev.messages.map((m) =>
        m.id === msgId && m.role === 'assistant' ? { ...m, undone: true } : m
      )
    }));
    message.info('已撤回此次修改');
  };

  const handleDiscard = (msgId: string) => {
    setActiveSession((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      messages: prev.messages.map((m) =>
        m.id === msgId && m.role === 'assistant' && !m.applied && !m.discarded ? { ...m, discarded: true } : m
      )
    }));
  };

  const handleRegenerateFrom = (assistantMsgId: string) => {
    if (busy) return;
    const idx = messages.findIndex((m) => m.id === assistantMsgId);
    if (idx <= 0) return;
    const prevUser = messages[idx - 1];
    if (prevUser?.role !== 'user') return;
    void sendPrompt(prevUser.content, messages.slice(0, idx - 1));
  };

  const handleRetryTrailingUser = (userMsgId: string) => {
    if (busy) return;
    const idx = messages.findIndex((m) => m.id === userMsgId);
    if (idx < 0) return;
    const target = messages[idx];
    if (target.role !== 'user') return;
    void sendPrompt(target.content, messages.slice(0, idx));
  };

  const handleNewConversation = () => {
    handleStopStream();
    const fresh = createEmptyAISession(mapKey, mapName);
    setActiveSession(fresh);
    setLastAppliedMsgId(null);
    setInput('');
    setError('');
    window.setTimeout(() => inputRef.current?.focus?.(), 40);
  };

  const handleSelectSession = (session: AIConversationSession) => {
    if (busy) handleStopStream();
    setActiveSession(session);
    setLastAppliedMsgId(null);
    setError('');
    if (window.innerWidth <= 640) setHistoryOpen(false);
  };

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = sessions.filter((s) => s.id !== sessionId);
    setSessions(next);
    saveAISessions(userId, next);
    if (activeSession.id === sessionId) {
      const fallback = next.find((s) => s.mapKey === mapKey) || createEmptyAISession(mapKey, mapName);
      setActiveSession(fallback);
      setLastAppliedMsgId(null);
    }
  };

  const handleClearVisibleSessions = () => {
    const next = historyScope === 'all' ? [] : sessions.filter((s) => s.mapKey !== mapKey);
    setSessions(next);
    saveAISessions(userId, next);
    setActiveSession(createEmptyAISession(mapKey, mapName));
    setLastAppliedMsgId(null);
    message.success('记录已清空');
  };

  const commitSessionRename = (sessionId: string) => {
    const trimmed = renamingValue.trim();
    setRenamingSessionId(null);
    if (!trimmed) return;
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === sessionId ? { ...s, title: trimmed, titleEdited: true } : s));
      saveAISessions(userId, next);
      return next;
    });
    if (activeSession.id === sessionId) {
      setActiveSession((prev) => ({ ...prev, title: trimmed, titleEdited: true }));
    }
  };

  const applyPresetPrompt = (promptText: string) => {
    setInput(promptText);
    window.setTimeout(() => inputRef.current?.focus?.(), 20);
  };

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => message.success('已复制'),
      () => {}
    );
  };

  const lastMessage = messages[messages.length - 1];
  const showNewChatAction = messages.length > 0 || Boolean(error);

  return (
    <DraggableModal
      className="metro-ai-modal"
      title={
        <div className="metro-ai-header">
          <div className="metro-ai-header__brand">
            <span className="metro-ai-header__title">AI 助手</span>
            <span className="metro-ai-header__map-name" title={mapName || '未命名方案'}>
              · {mapName || '未命名方案'}
            </span>
          </div>

          <div className="metro-ai-header__actions" onMouseDown={(e) => e.stopPropagation()}>
            <Tooltip title={sessions.length > 0 ? `对话记录 (${sessions.length})` : '对话记录'}>
              <button
                type="button"
                aria-label="对话记录"
                className={`metro-ai-icon-btn${historyOpen ? ' is-active' : ''}`}
                onClick={() => setHistoryOpen((prev) => !prev)}
              >
                <HistoryOutlined />
              </button>
            </Tooltip>
            {showNewChatAction ? (
              <Tooltip title="新对话">
                <button
                  type="button"
                  aria-label="新对话"
                  className="metro-ai-icon-btn"
                  onClick={handleNewConversation}
                >
                  <PlusOutlined />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>
      }
      open={open}
      onCancel={onCancel}
      footer={null}
      width={historyOpen ? 840 : 600}
    >
      <div className={`metro-ai-shell${historyOpen ? ' has-sidebar' : ''}${isCompactEmpty ? ' is-compact' : ''}`}>
        {historyOpen ? (
          <aside className="metro-ai-sidebar" aria-label="对话记录">
            <div className="metro-ai-sidebar__tabs">
              <button
                type="button"
                className={`metro-ai-sidebar__tab${historyScope === 'current' ? ' is-active' : ''}`}
                onClick={() => setHistoryScope('current')}
              >
                当前地图 ({currentMapSessionCount})
              </button>
              <button
                type="button"
                className={`metro-ai-sidebar__tab${historyScope === 'all' ? ' is-active' : ''}`}
                onClick={() => setHistoryScope('all')}
              >
                全部 ({sessions.length})
              </button>
            </div>

            <div className="metro-ai-sidebar__list">
              {filteredSessions.length === 0 ? (
                <div className="metro-ai-sidebar__empty">
                  {historyScope === 'current' && sessions.length > 0
                    ? '当前地图暂无记录，可切换到「全部」查看'
                    : '暂无历史记录'}
                </div>
              ) : (
                filteredSessions.map((session) => {
                  const isCurrent = session.id === activeSession.id;
                  const turnCount = session.messages.filter((m) => m.role === 'user').length;
                  const isRenaming = renamingSessionId === session.id;
                  return (
                    <div
                      key={session.id}
                      className={`metro-ai-session-item${isCurrent ? ' is-active' : ''}`}
                      onClick={() => !isRenaming && handleSelectSession(session)}
                    >
                      {isRenaming ? (
                        <Input
                          size="small"
                          autoFocus
                          value={renamingValue}
                          maxLength={28}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenamingValue(e.target.value)}
                          onBlur={() => commitSessionRename(session.id)}
                          onPressEnter={() => commitSessionRename(session.id)}
                        />
                      ) : (
                        <>
                          <div className="metro-ai-session-item__top">
                            <span className="metro-ai-session-item__title" title={session.title}>
                              {session.title}
                            </span>
                            <span className="metro-ai-session-item__ops">
                              <button
                                type="button"
                                aria-label="重命名对话"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRenamingSessionId(session.id);
                                  setRenamingValue(session.title);
                                }}
                              >
                                <EditOutlined />
                              </button>
                              <button
                                type="button"
                                className="is-danger"
                                aria-label="删除对话"
                                onClick={(e) => handleDeleteSession(session.id, e)}
                              >
                                <DeleteOutlined />
                              </button>
                            </span>
                          </div>
                          <div className="metro-ai-session-item__meta">
                            <span>{formatRelativeTime(session.updatedAt)}</span>
                            <span>· {turnCount} 轮</span>
                            {historyScope === 'all' && session.mapName ? (
                              <span className="metro-ai-session-item__map" title={session.mapName}>
                                {session.mapName}
                              </span>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {filteredSessions.length > 1 ? (
              <div className="metro-ai-sidebar__foot">
                <button type="button" className="metro-ai-sidebar__clear" onClick={handleClearVisibleSessions}>
                  <DeleteOutlined /> 清空记录
                </button>
              </div>
            ) : null}
          </aside>
        ) : null}

        <div className="metro-ai-stage">
          <div ref={scrollRef} className={`metro-ai-stream${isCompactEmpty ? ' is-empty' : ''}`}>
            {messages.length === 0 && !busy ? (
              <div className="metro-ai-quick-list">
                <div className="metro-ai-quick-list__heading">试试</div>
                <div className="metro-ai-quick-list__rows">
                  {starterPrompts.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="metro-ai-quick-row"
                      onClick={() => applyPresetPrompt(item.prompt)}
                    >
                      <span
                        className="metro-ai-quick-row__dot"
                        style={{ backgroundColor: item.color }}
                        aria-hidden="true"
                      />
                      <span className="metro-ai-quick-row__text">{item.prompt}</span>
                      <span className="metro-ai-quick-row__enter" aria-hidden="true">
                        ↵
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg, idx) => {
                const isLast = idx === messages.length - 1;
                if (msg.role === 'user') {
                  const isUnanswered = isLast && !busy;
                  return (
                    <div key={msg.id} className="metro-ai-row metro-ai-row--user">
                      <div className="metro-ai-user-wrap">
                        <div className="metro-ai-bubble metro-ai-bubble--user">{msg.content}</div>
                        <div className="metro-ai-msg-tools metro-ai-msg-tools--right">
                          <button type="button" onClick={() => copyText(msg.content)} title="复制">
                            <CopyOutlined />
                          </button>
                          <button type="button" onClick={() => applyPresetPrompt(msg.content)} title="重新编辑">
                            <EditOutlined />
                          </button>
                          {isUnanswered ? (
                            <button
                              type="button"
                              className="is-retry"
                              onClick={() => handleRetryTrailingUser(msg.id)}
                            >
                              <ReloadOutlined /> 重试
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                }

                return (
                  <AssistantTurn
                    key={msg.id}
                    msg={msg}
                    lines={lines}
                    isLatestAssistant={
                      msg.id ===
                      [...messages]
                        .reverse()
                        .find((m) => m.role === 'assistant')?.id
                    }
                    canUndoThis={Boolean(msg.applied && !msg.undone && lastAppliedMsgId === msg.id && canUndo && onUndo)}
                    busy={busy}
                    onApply={() => handleApply(msg.id)}
                    onUndoApplied={() => handleUndoApplied(msg.id)}
                    onDiscard={() => handleDiscard(msg.id)}
                    onRegenerate={() => handleRegenerateFrom(msg.id)}
                    onCopy={() => copyText(msg.content)}
                  />
                );
              })
            )}
          </div>

          {error ? (
            <Alert
              type="error"
              showIcon
              className="metro-ai-alert"
              message={error}
              action={
                lastMessage?.role === 'user' && !busy ? (
                  <Button size="small" danger onClick={() => handleRetryTrailingUser(lastMessage.id)}>
                    重试
                  </Button>
                ) : undefined
              }
              closable
              onClose={() => setError('')}
            />
          ) : null}

          <div className="metro-ai-composer">
            <TextArea
              ref={inputRef}
              variant="borderless"
              autoSize={{ minRows: 2, maxRows: 5 }}
              maxLength={500}
              className="metro-ai-composer__input"
              title="Enter 发送，Shift+Enter 换行"
              placeholder={
                messages.length === 0
                  ? '输入线网修改指令，如：把 1 号线向东延伸 3 站…'
                  : '继续补充指令…'
              }
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmit();
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />

            <div className="metro-ai-composer__bar">
              <div className="metro-ai-composer__meta">
                <span className="metro-ai-context-text">
                  {lines.length} 条线路 · {stations.length} 座车站
                </span>
                <label className="metro-ai-auto-switch" title="开启后生成的线网修改将直接应用到画布">
                  <Switch size="small" checked={autoApply} onChange={handleToggleAutoApply} />
                  <span>自动应用</span>
                </label>
              </div>

              <div className="metro-ai-composer__right">
                {input.length > 0 ? (
                  <span className={`metro-ai-char-count${input.length >= 460 ? ' is-warn' : ''}`}>
                    {input.length}/500
                  </span>
                ) : null}

                {busy ? (
                  <button
                    type="button"
                    className="metro-ai-send-btn is-stop"
                    onClick={handleStopStream}
                    aria-label="停止生成"
                    title="停止生成"
                  >
                    <span className="metro-ai-stop-square" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="metro-ai-send-btn"
                    disabled={!input.trim()}
                    onClick={handleSubmit}
                    aria-label="发送消息"
                    title="发送 (Enter)"
                  >
                    <ArrowUpOutlined />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </DraggableModal>
  );
};

interface AssistantTurnProps {
  msg: Extract<AIChatMessage, { role: 'assistant' }>;
  lines: Line[];
  isLatestAssistant: boolean;
  canUndoThis: boolean;
  busy: boolean;
  onApply: () => void;
  onUndoApplied: () => void;
  onDiscard: () => void;
  onRegenerate: () => void;
  onCopy: () => void;
}

const AssistantTurn: React.FC<AssistantTurnProps> = ({
  msg,
  lines,
  isLatestAssistant,
  canUndoThis,
  busy,
  onApply,
  onUndoApplied,
  onDiscard,
  onRegenerate,
  onCopy
}) => {
  const { content, operations, summaries, skippedCount, streaming, applied, discarded, undone } = msg;

  if (streaming && !content) {
    return (
      <div className="metro-ai-row metro-ai-row--assistant">
        <div className="metro-ai-thinking">
          <span className="metro-ai-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>思考中…</span>
        </div>
      </div>
    );
  }

  const hasOps = !streaming && operations.length > 0;
  const showApplyControls = hasOps && (!applied || undone) && !discarded;
  const stateClass = applied && !undone ? 'is-applied' : discarded || undone ? 'is-muted' : 'is-pending';

  return (
    <div className="metro-ai-row metro-ai-row--assistant">
      <div className="metro-ai-assistant-wrap">
        {content ? (
          <div className="metro-ai-prose">
            {content}
            {streaming ? <span className="metro-ai-typing-cursor">▋</span> : null}
          </div>
        ) : null}

        {hasOps ? (
          <div className={`metro-ai-ops-card ${stateClass}`}>
            <div className="metro-ai-ops-card__head">
              <span className="metro-ai-ops-card__title">
                {applied && !undone
                  ? `已应用 ${operations.length} 项变更`
                  : undone
                    ? `已撤回 ${operations.length} 项变更`
                    : discarded
                      ? `已放弃 ${operations.length} 项变更`
                      : `变更清单 (${operations.length})`}
              </span>
              {!applied && !discarded && skippedCount > 0 ? (
                <span className="metro-ai-ops-card__skipped">已跳过 {skippedCount} 项无效参数</span>
              ) : null}
            </div>

            <ul className="metro-ai-ops-list">
              {summaries.map((s, i) => (
                <li key={i} className="metro-ai-ops-list__item">
                  <span
                    className="metro-ai-ops-list__bar"
                    style={{ backgroundColor: inferOperationAccentColor(operations[i], lines) }}
                    aria-hidden="true"
                  />
                  <span className="metro-ai-ops-list__text">{renderSummaryWithColorSwatches(s)}</span>
                </li>
              ))}
            </ul>

            {showApplyControls ? (
              <div className="metro-ai-ops-card__actions">
                <Button type="primary" size="small" icon={<CheckOutlined />} onClick={onApply}>
                  {undone ? '重新应用' : '应用'}
                </Button>
                {!undone ? (
                  <Button size="small" type="text" onClick={onDiscard}>
                    放弃
                  </Button>
                ) : null}
              </div>
            ) : canUndoThis ? (
              <div className="metro-ai-ops-card__actions">
                <Button size="small" type="text" icon={<RollbackOutlined />} onClick={onUndoApplied}>
                  撤回
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {!streaming ? (
          <div className="metro-ai-msg-tools">
            {content ? (
              <button type="button" onClick={onCopy} title="复制">
                <CopyOutlined />
              </button>
            ) : null}
            {isLatestAssistant && !busy ? (
              <button type="button" onClick={onRegenerate} title="重新生成">
                <ReloadOutlined /> 重新生成
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AIAssistantModal;
