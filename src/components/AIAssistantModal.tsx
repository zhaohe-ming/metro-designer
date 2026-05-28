import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Space, Spin, Tag, Typography } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  PlusOutlined,
  SendOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import DraggableModal from './DraggableModal';
import { AIOperation } from '../api';

const { Paragraph, Text } = Typography;
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
  // 多轮 + 流式：每次提交把"完整对话历史（只含 role+content）"送给 onAnalyzeStream。
  // onDelta 实时回吐 AI 正在生成的累计文本；signal 用于取消。
  // 父组件不需要管对话状态，由本组件维护。
  onAnalyzeStream: (
    messages: { role: 'user' | 'assistant'; content: string }[],
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ) => Promise<AnalyzeResult>;
  onApply: (operations: AIOperation[]) => number;
  onCancel: () => void;
}

// 前端用的内部消息格式：比"传给后端的纯 role+content"多一些 UI 维护字段
type ChatMessage =
  | { role: 'user'; id: string; content: string }
  | {
      role: 'assistant';
      id: string;
      content: string;
      operations: AIOperation[];
      summaries: string[];
      skippedCount: number;
      // streaming = 流式生成中（文字还在往里灌，操作卡片还没出现）
      streaming: boolean;
      // applied = 已经被用户点过"应用"（按钮消失），或"丢弃"（操作清空）。
      applied: boolean;
      discarded: boolean;
    };

const PRESET_PROMPTS = [
  '把 1 号线改成红色 #d23030',
  '在 A 站和 B 站之间加 3 个新站点',
  '新建 2 号线，蓝色，从 X 站延伸出 5 个新站',
  '删除 3 号线'
];

const AIAssistantModal: React.FC<AIAssistantModalProps> = ({ open, busy, onAnalyzeStream, onApply, onCancel }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  // 当前进行中的流的 AbortController：弹窗关闭 / 新提交 / 新建对话时取消
  const abortRef = useRef<AbortController | null>(null);

  // 新消息进来 / busy 状态变化时自动滚到底部，让"正在思考"指示器和 AI 回复始终可见
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  // 弹窗关闭时取消进行中的流，避免后台继续写一个已经看不到的消息
  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [open]);

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setError('');

    // 先把 user message + 一个 streaming 占位的 assistant message 推进 history
    const userMsg: ChatMessage = {
      role: 'user',
      id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      content: text
    };
    const assistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const assistantPlaceholder: ChatMessage = {
      role: 'assistant',
      id: assistantId,
      content: '',
      operations: [],
      summaries: [],
      skippedCount: 0,
      streaming: true,
      applied: false,
      discarded: false
    };
    const historyForApi = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, userMsg, assistantPlaceholder]);
    setInput('');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await onAnalyzeStream(
        historyForApi,
        // onDelta：把累计文本实时写进占位 assistant 消息
        (cumulativeText) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId && m.role === 'assistant' ? { ...m, content: cumulativeText } : m
            )
          );
        },
        controller.signal
      );
      // 流结束：补上最终文案 + 操作卡片
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === assistantId && m.role === 'assistant') {
            return {
              ...m,
              streaming: false,
              content:
                result.explanation ||
                (result.operations.length > 0
                  ? `好的，准备执行 ${result.operations.length} 个操作。`
                  : 'AI 没有给出可执行的操作。'),
              operations: result.operations,
              summaries: result.summaries,
              skippedCount: result.skippedCount
            };
          }
          return m;
        })
      );
    } catch (e: any) {
      // 用户主动取消（关弹窗）不算错误
      if (e?.name !== 'AbortError') {
        setError(e?.message || 'AI 调用失败');
      }
      // 移除流式占位（失败 / 取消都移除，保留用户那条提问方便重试）
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const handleApply = (msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === msgId && m.role === 'assistant' && !m.applied && !m.discarded) {
          onApply(m.operations);
          return { ...m, applied: true };
        }
        return m;
      })
    );
  };

  const handleDiscard = (msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === msgId && m.role === 'assistant' && !m.applied && !m.discarded) {
          return { ...m, discarded: true };
        }
        return m;
      })
    );
  };

  const handleNewConversation = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages([]);
    setInput('');
    setError('');
  };

  const usePresetPrompt = (p: string) => {
    setInput((cur) => (cur ? cur : p));
  };

  return (
    <DraggableModal
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>
            <ThunderboltOutlined style={{ marginRight: 8, color: '#2563eb' }} />
            AI 助手
          </span>
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={handleNewConversation}
            disabled={messages.length === 0 || busy}
            style={{ marginRight: 28 /* 给 modal 关闭 X 留位 */ }}
          >
            新建对话
          </Button>
        </div>
      }
      open={open}
      onCancel={onCancel}
      footer={null}
      width={640}
    >
      {/* 对话历史 */}
      <div
        ref={scrollRef}
        style={{
          minHeight: 260,
          maxHeight: 460,
          overflowY: 'auto',
          padding: '12px 8px',
          borderRadius: 10,
          background: 'var(--color-surface-muted, #f6f8fc)',
          border: '1px solid var(--color-border-subtle, #e2e8f0)'
        }}
      >
        {messages.length === 0 && !busy ? (
          <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--color-text-soft, #94a3b8)' }}>
            <ThunderboltOutlined style={{ fontSize: 32, marginBottom: 12, color: '#2563eb' }} />
            <Paragraph type="secondary" style={{ marginBottom: 16 }}>
              用自然语言描述你想做的修改。可以连续追问，AI 会记住上文。
            </Paragraph>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
              {PRESET_PROMPTS.map((p) => (
                <Tag
                  key={p}
                  style={{ cursor: 'pointer', padding: '4px 10px', fontSize: 12 }}
                  onClick={() => usePresetPrompt(p)}
                >
                  {p}
                </Tag>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) =>
            msg.role === 'user' ? (
              <UserBubble key={msg.id} content={msg.content} />
            ) : (
              <AssistantBubble
                key={msg.id}
                content={msg.content}
                operations={msg.operations}
                summaries={msg.summaries}
                skippedCount={msg.skippedCount}
                streaming={msg.streaming}
                applied={msg.applied}
                discarded={msg.discarded}
                onApply={() => handleApply(msg.id)}
                onDiscard={() => handleDiscard(msg.id)}
              />
            )
          )
        )}
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginTop: 12 }}
          closable
          onClose={() => setError('')}
        />
      ) : null}

      {/* 输入区 */}
      <div style={{ marginTop: 12 }}>
        <TextArea
          rows={2}
          placeholder={messages.length === 0 ? '例：把 1 号线改成红色' : '继续追问，比如：再加 3 个站'}
          value={input}
          maxLength={500}
          showCount
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={busy}
          style={{ marginBottom: 10 }}
        />
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Ctrl/Cmd + Enter 发送
          </Text>
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={busy}
            disabled={!input.trim() || busy}
            onClick={handleSubmit}
          >
            发送
          </Button>
        </Space>
      </div>
    </DraggableModal>
  );
};

// ── Bubble 组件们 ────────────────────────────────────────────────────────

const UserBubble: React.FC<{ content: string }> = ({ content }) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
    <div
      style={{
        maxWidth: '80%',
        padding: '8px 12px',
        background: '#2563eb',
        color: '#ffffff',
        borderRadius: '12px 12px 4px 12px',
        whiteSpace: 'pre-wrap',
        fontSize: 14,
        lineHeight: 1.55
      }}
    >
      {content}
    </div>
  </div>
);

interface AssistantBubbleProps {
  content?: string;
  operations?: AIOperation[];
  summaries?: string[];
  skippedCount?: number;
  streaming?: boolean;
  applied?: boolean;
  discarded?: boolean;
  onApply?: () => void;
  onDiscard?: () => void;
}

const AssistantBubble: React.FC<AssistantBubbleProps> = ({
  content,
  operations,
  summaries,
  skippedCount,
  streaming,
  applied,
  discarded,
  onApply,
  onDiscard
}) => {
  // 流式中且还没有任何文字 → 显示"正在思考"
  if (streaming && !content) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
        <div
          style={{
            padding: '10px 14px',
            background: '#ffffff',
            border: '1px solid var(--color-border-subtle, #e2e8f0)',
            borderRadius: '12px 12px 12px 4px',
            color: 'var(--color-text-soft, #94a3b8)',
            fontSize: 14
          }}
        >
          <Spin size="small" style={{ marginRight: 8 }} />
          AI 正在思考…
        </div>
      </div>
    );
  }

  // 流式中：只显示正在打字的文本（末尾加一个闪烁光标），操作卡片等流结束才出
  const hasOps = !streaming && (operations?.length || 0) > 0;
  const showApplyControls = hasOps && !applied && !discarded;

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
      <div style={{ maxWidth: '88%' }}>
        {content ? (
          <div
            style={{
              padding: '8px 12px',
              background: '#ffffff',
              border: '1px solid var(--color-border-subtle, #e2e8f0)',
              borderRadius: '12px 12px 12px 4px',
              whiteSpace: 'pre-wrap',
              fontSize: 14,
              lineHeight: 1.55,
              marginBottom: hasOps ? 6 : 0
            }}
          >
            {content}
            {streaming ? <span className="metro-ai-typing-cursor">▋</span> : null}
          </div>
        ) : null}

        {hasOps ? (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              fontSize: 13,
              background: applied
                ? 'rgba(34, 197, 94, 0.08)'
                : discarded
                  ? 'rgba(148, 163, 184, 0.12)'
                  : 'var(--color-primary-50, #eef4ff)',
              border: `1px solid ${
                applied
                  ? 'rgba(34, 197, 94, 0.25)'
                  : discarded
                    ? 'rgba(148, 163, 184, 0.3)'
                    : 'var(--color-primary-100, #d8e5ff)'
              }`
            }}
          >
            <Text
              strong
              style={{
                display: 'block',
                marginBottom: 6,
                color: applied ? '#16a34a' : discarded ? '#64748b' : undefined
              }}
            >
              {applied
                ? `✓ 已应用 ${operations!.length} 个操作`
                : discarded
                  ? `已丢弃 ${operations!.length} 个操作`
                  : `建议执行 ${operations!.length} 个操作`}
              {!applied && !discarded && (skippedCount || 0) > 0
                ? `（${skippedCount} 个无效已跳过）`
                : ''}
            </Text>
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
              {summaries!.map((s, i) => (
                <li key={i} style={{ color: discarded ? '#94a3b8' : undefined }}>
                  {s}
                </li>
              ))}
            </ol>
            {showApplyControls ? (
              <Space style={{ marginTop: 10 }}>
                <Button type="primary" size="small" icon={<CheckOutlined />} onClick={onApply}>
                  应用到画布
                </Button>
                <Button size="small" icon={<CloseOutlined />} onClick={onDiscard}>
                  丢弃
                </Button>
              </Space>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AIAssistantModal;
