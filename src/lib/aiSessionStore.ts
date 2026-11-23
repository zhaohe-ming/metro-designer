import { AIOperation } from '../api';

export type AIChatMessage =
  | {
      role: 'user';
      id: string;
      content: string;
      createdAt: number;
    }
  | {
      role: 'assistant';
      id: string;
      content: string;
      createdAt: number;
      operations: AIOperation[];
      summaries: string[];
      skippedCount: number;
      streaming?: boolean;
      applied: boolean;
      discarded: boolean;
      undone?: boolean;
    };

export interface AIConversationSession {
  id: string;
  mapKey: string;
  mapName: string;
  title: string;
  titleEdited?: boolean;
  messages: AIChatMessage[];
  createdAt: number;
  updatedAt: number;
}

const STORAGE_PREFIX = 'metro_ai_sessions_v1:';
const MAX_SESSIONS = 32;
const MAX_PERSISTED_MESSAGES = 80;
export const MAX_API_HISTORY_MESSAGES = 36;

function storageKey(userId?: string | null): string {
  return `${STORAGE_PREFIX}${userId || 'guest'}`;
}

export function deriveSessionTitle(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新对话';
  const chars = Array.from(cleaned);
  return chars.length > 22 ? `${chars.slice(0, 22).join('')}…` : cleaned;
}

export function createEmptyAISession(mapKey: string, mapName: string): AIConversationSession {
  const now = Date.now();
  return {
    id: `ais_${now}_${Math.random().toString(36).slice(2, 7)}`,
    mapKey: mapKey || 'draft',
    mapName: mapName || '未命名方案',
    title: '新对话',
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function sanitizeLoadedMessage(raw: any): AIChatMessage | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.content !== 'string') {
    return null;
  }
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  if (raw.role === 'user') {
    return { role: 'user', id: raw.id, content: raw.content, createdAt };
  }
  if (raw.role === 'assistant') {
    // 异常中断遗留的空流式占位直接丢弃，避免重开后永远转圈
    if (raw.streaming && !raw.content && (!Array.isArray(raw.operations) || raw.operations.length === 0)) {
      return null;
    }
    return {
      role: 'assistant',
      id: raw.id,
      content: raw.content,
      createdAt,
      operations: Array.isArray(raw.operations) ? raw.operations : [],
      summaries: Array.isArray(raw.summaries) ? raw.summaries.filter((s: unknown) => typeof s === 'string') : [],
      skippedCount: typeof raw.skippedCount === 'number' ? raw.skippedCount : 0,
      streaming: false,
      applied: Boolean(raw.applied),
      discarded: Boolean(raw.discarded),
      undone: Boolean(raw.undone)
    };
  }
  return null;
}

export function loadAISessions(userId?: string | null): AIConversationSession[] {
  try {
    const raw = window.localStorage?.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const sessions: AIConversationSession[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
      const messages = Array.isArray(item.messages)
        ? (item.messages.map(sanitizeLoadedMessage).filter(Boolean) as AIChatMessage[])
        : [];
      if (messages.length === 0) continue;
      sessions.push({
        id: item.id,
        mapKey: typeof item.mapKey === 'string' && item.mapKey ? item.mapKey : 'draft',
        mapName: typeof item.mapName === 'string' && item.mapName ? item.mapName : '未命名方案',
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : deriveSessionTitle(messages[0].content),
        titleEdited: Boolean(item.titleEdited),
        messages: messages.slice(-MAX_PERSISTED_MESSAGES),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now()
      });
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

export function saveAISessions(userId: string | null | undefined, sessions: AIConversationSession[]): void {
  try {
    const persistable = sessions
      .filter((s) => s.messages.some((m) => !(m.role === 'assistant' && m.streaming && !m.content)))
      .map((s) => ({
        ...s,
        messages: s.messages
          .filter((m) => !(m.role === 'assistant' && m.streaming && !m.content))
          .slice(-MAX_PERSISTED_MESSAGES)
          .map((m) => (m.role === 'assistant' ? { ...m, streaming: false } : m))
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    window.localStorage?.setItem(storageKey(userId), JSON.stringify(persistable));
  } catch {
    /* localStorage 配额满或隐私模式时静默降级为内存态 */
  }
}

export function migrateDraftAISessions(
  userId: string | null | undefined,
  fromMapKey: string,
  toMapKey: string,
  toMapName: string
): void {
  if (!fromMapKey || !toMapKey || fromMapKey === toMapKey) return;
  const list = loadAISessions(userId);
  let changed = false;
  const next = list.map((s) => {
    if (s.mapKey !== fromMapKey) return s;
    changed = true;
    return { ...s, mapKey: toMapKey, mapName: toMapName || s.mapName };
  });
  if (changed) saveAISessions(userId, next);
}

/**
 * 组装发往后端 LLM 的多轮上下文：
 * 1. 把 assistant 消息里的操作摘要与【已应用 / 已撤销 / 已放弃 / 待确认】状态注入文本，解决第二轮追问时模型失忆问题；
 * 2. 自动清理连续未回复的失败提问，并限制在 MAX_API_HISTORY_MESSAGES 窗口内。
 */
export function buildApiHistory(
  priorMessages: AIChatMessage[],
  nextUserContent: string
): { role: 'user' | 'assistant'; content: string }[] {
  const normalized: { role: 'user' | 'assistant'; content: string }[] = [];

  for (const msg of priorMessages) {
    if (msg.role === 'assistant' && msg.streaming) continue;
    if (msg.role === 'user') {
      const text = msg.content.trim();
      if (!text) continue;
      // 若上一条也是未得到回复的失败 user 提问，合并或覆盖成最新一条，保持角色交替清晰
      if (normalized.length > 0 && normalized[normalized.length - 1].role === 'user') {
        normalized[normalized.length - 1] = { role: 'user', content: text };
      } else {
        normalized.push({ role: 'user', content: text });
      }
    } else {
      const statusLabel = msg.undone
        ? '用户应用后已撤销'
        : msg.applied
          ? '用户已应用到画布'
          : msg.discarded
            ? '用户已放弃未执行'
            : '待用户确认（尚未应用到画布）';
      const opsSummary =
        msg.summaries.length > 0
          ? `\n【本轮建议操作（${statusLabel}）：${msg.summaries.join('；')}】`
          : '';
      const combined = `${msg.content || ''}${opsSummary}`.trim().slice(0, 2600);
      if (combined) {
        normalized.push({ role: 'assistant', content: combined });
      }
    }
  }

  // 若历史末尾因上次网络报错残留了一条孤立的相同 user 消息，去重后再推入本次提问
  if (normalized.length > 0 && normalized[normalized.length - 1].role === 'user') {
    normalized.pop();
  }

  const full = [...normalized, { role: 'user' as const, content: nextUserContent.trim() }];
  let sliced = full.slice(-MAX_API_HISTORY_MESSAGES);
  if (sliced.length > 1 && sliced[0].role === 'assistant') {
    sliced = sliced.slice(1);
  }
  return sliced;
}

export function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
