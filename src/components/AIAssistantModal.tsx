import React, { useState } from 'react';
import { Alert, Button, Input, Space, Tag, Typography } from 'antd';
import { SendOutlined, ThunderboltOutlined } from '@ant-design/icons';
import DraggableModal from './DraggableModal';
import { AIOperation } from '../api';

const { Paragraph, Text } = Typography;
const { TextArea } = Input;

interface AIAssistantModalProps {
  open: boolean;
  busy: boolean;
  // 由父组件传入 → 父组件负责把当前 lines / stations 序列化成 mapState、调 api.aiEdit，
  // 拿到 operations 后调用 applyAIOperations 写状态。Modal 只关心 UI 和文案。
  onSubmit: (message: string) => Promise<{ explanation: string; appliedCount: number; skippedCount: number }>;
  onCancel: () => void;
}

const PRESET_PROMPTS = [
  '把 1 号线改成红色 #d23030',
  '在 A 站和 B 站之间加一个新站点叫 C',
  '新建 2 号线，蓝色，从 X 站到 Z 站途经 Y',
  '删除 3 号线'
];

const AIAssistantModal: React.FC<AIAssistantModalProps> = ({ open, busy, onSubmit, onCancel }) => {
  const [message, setMessage] = useState('');
  const [lastResult, setLastResult] = useState<{ explanation: string; appliedCount: number; skippedCount: number } | null>(null);
  const [error, setError] = useState('');

  const handleSend = async () => {
    if (!message.trim() || busy) return;
    setError('');
    try {
      const result = await onSubmit(message.trim());
      setLastResult(result);
      setMessage('');
    } catch (e: any) {
      setError(e?.message || 'AI 调用失败');
    }
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
      width={560}
    >
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        用自然语言描述你想做的修改，AI 会自动应用到画布上。比如改颜色、加站点、新建线路。
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
        placeholder="例：在五道口和清华东路之间加一个站叫北航"
        value={message}
        maxLength={500}
        showCount
        onChange={(e) => setMessage(e.target.value)}
        onPressEnter={(e) => {
          // Ctrl/Cmd+Enter 发送；普通 Enter 换行
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        style={{ marginBottom: 12 }}
      />

      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Ctrl/Cmd + Enter 发送</Text>
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={busy}
          disabled={!message.trim()}
          onClick={handleSend}
        >
          执行
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

      {lastResult ? (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: 'var(--color-primary-50, #eef4ff)',
            borderRadius: 8,
            border: '1px solid var(--color-primary-100, #d8e5ff)'
          }}
        >
          <Text strong style={{ display: 'block', marginBottom: 6 }}>
            ✓ 已应用 {lastResult.appliedCount} 个操作
            {lastResult.skippedCount > 0 ? `（跳过 ${lastResult.skippedCount} 个无效操作）` : ''}
          </Text>
          {lastResult.explanation ? (
            <Paragraph
              type="secondary"
              style={{ fontSize: 13, marginBottom: 0, whiteSpace: 'pre-wrap' }}
            >
              {lastResult.explanation}
            </Paragraph>
          ) : null}
        </div>
      ) : null}
    </DraggableModal>
  );
};

export default AIAssistantModal;
