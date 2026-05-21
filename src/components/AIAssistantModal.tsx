import React, { useState } from 'react';
import { Alert, Button, Input, Space, Tag, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, SendOutlined, ThunderboltOutlined } from '@ant-design/icons';
import DraggableModal from './DraggableModal';
import { AIOperation } from '../api';

const { Paragraph, Text } = Typography;
const { TextArea } = Input;

interface AIAssistantModalProps {
  open: boolean;
  busy: boolean;
  // 拆开"分析"和"执行"：onAnalyze 调 LLM 拿到 operations + summaries，
  // 不立刻改地图；用户在 modal 里点"应用"才走 onApply。
  onAnalyze: (message: string) => Promise<{
    explanation: string;
    operations: AIOperation[];
    summaries: string[];
    skippedCount: number;
  }>;
  onApply: (operations: AIOperation[]) => number;
  onCancel: () => void;
}

const PRESET_PROMPTS = [
  '把 1 号线改成红色 #d23030',
  '在 A 站和 B 站之间加 3 个新站点',
  '新建 2 号线，蓝色，从 X 站延伸出 5 个新站',
  '删除 3 号线'
];

type PendingPlan = {
  explanation: string;
  operations: AIOperation[];
  summaries: string[];
  skippedCount: number;
};

const AIAssistantModal: React.FC<AIAssistantModalProps> = ({ open, busy, onAnalyze, onApply, onCancel }) => {
  const [message, setMessage] = useState('');
  // 待用户确认的操作计划。null = 当前无 plan 可看。
  const [pending, setPending] = useState<PendingPlan | null>(null);
  // 上一次成功应用的结果（应用完之后保留一会儿给用户回顾）
  const [appliedResult, setAppliedResult] = useState<{ count: number; summaries: string[] } | null>(null);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!message.trim() || busy) return;
    setError('');
    setAppliedResult(null);
    try {
      const plan = await onAnalyze(message.trim());
      setPending(plan);
      // 不清 message，方便用户在 plan 不满意时直接改文案再 submit
    } catch (e: any) {
      setError(e?.message || 'AI 调用失败');
      setPending(null);
    }
  };

  const handleApply = () => {
    if (!pending) return;
    const count = onApply(pending.operations);
    setAppliedResult({ count, summaries: pending.summaries });
    setPending(null);
    setMessage('');
  };

  const handleDiscard = () => {
    setPending(null);
  };

  return (
    <DraggableModal
      title={
        <span>
          <ThunderboltOutlined style={{ marginRight: 8, color: '#2563eb' }} />
          AI 助手
        </span>
      }
      open={open}
      onCancel={onCancel}
      footer={null}
      width={600}
    >
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        用自然语言描述你想做的修改，AI 会先给出一个操作清单 —— 你确认后才真正写到画布。
        操作完成后可以 Ctrl+Z 撤销。
      </Paragraph>

      <div style={{ marginBottom: 12 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>常用示例（点击填入）：</Text>
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PRESET_PROMPTS.map((p) => (
            <Tag
              key={p}
              style={{ cursor: 'pointer', padding: '4px 8px' }}
              onClick={() => setMessage(p)}
            >
              {p}
            </Tag>
          ))}
        </div>
      </div>

      <TextArea
        rows={3}
        placeholder="例：在五道口和清华东路之间加 3 个站，名字依次叫北航、知春路、海淀黄庄"
        value={message}
        maxLength={500}
        showCount
        onChange={(e) => setMessage(e.target.value)}
        onPressEnter={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        style={{ marginBottom: 12 }}
      />

      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Ctrl/Cmd + Enter 提交</Text>
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={busy}
          disabled={!message.trim()}
          onClick={handleSubmit}
        >
          提交给 AI
        </Button>
      </Space>

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

      {/* 待确认的操作计划：AI 分析完会先停在这一步，等用户点"应用"。 */}
      {pending ? (
        <div
          style={{
            marginTop: 16,
            padding: 14,
            background: 'var(--color-primary-50, #eef4ff)',
            borderRadius: 10,
            border: '1px solid var(--color-primary-100, #d8e5ff)'
          }}
        >
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            {pending.operations.length > 0
              ? `AI 建议执行 ${pending.operations.length} 个操作`
              : 'AI 没有给出可执行的操作'}
            {pending.skippedCount > 0 ? `（另有 ${pending.skippedCount} 个无效操作已被跳过）` : ''}
          </Text>

          {pending.operations.length > 0 ? (
            <ol style={{ margin: '0 0 12px', paddingLeft: 22, fontSize: 13, lineHeight: 1.7 }}>
              {pending.summaries.map((s, i) => (
                <li key={i} style={{ color: 'var(--color-text)' }}>{s}</li>
              ))}
            </ol>
          ) : null}

          {pending.explanation ? (
            <Paragraph
              type="secondary"
              style={{
                fontSize: 12,
                marginBottom: 12,
                whiteSpace: 'pre-wrap',
                padding: 10,
                background: 'rgba(255, 255, 255, 0.5)',
                borderRadius: 6
              }}
            >
              AI 的说明：{pending.explanation}
            </Paragraph>
          ) : null}

          <Space>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              disabled={pending.operations.length === 0}
              onClick={handleApply}
            >
              应用到画布
            </Button>
            <Button icon={<CloseOutlined />} onClick={handleDiscard}>
              丢弃并重新输入
            </Button>
          </Space>
        </div>
      ) : null}

      {/* 上一次成功应用的结果摘要 */}
      {appliedResult ? (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: 'rgba(34, 197, 94, 0.08)',
            borderRadius: 8,
            border: '1px solid rgba(34, 197, 94, 0.25)'
          }}
        >
          <Text strong style={{ display: 'block', marginBottom: 6, color: '#16a34a' }}>
            ✓ 已应用 {appliedResult.count} 个操作
          </Text>
          {appliedResult.summaries.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-soft)' }}>
              {appliedResult.summaries.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ) : null}
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            可以 Ctrl + Z 撤销所有操作。
          </Paragraph>
        </div>
      ) : null}
    </DraggableModal>
  );
};

export default AIAssistantModal;
