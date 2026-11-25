import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, message } from 'antd';
import {
  CheckCircleOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import DraggableModal from './DraggableModal';
import ElasticCapsuleTabs from './ElasticCapsuleTabs';
import {
  AI_PROVIDER_PRESETS,
  AIProviderId,
  CustomAIConfig,
  loadCustomAIConfig,
  saveCustomAIConfig
} from '../lib/aiCustomConfig';
import { api, AIStatusInfo } from '../api';

interface AIApiSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const AIApiSettingsModal: React.FC<AIApiSettingsModalProps> = ({ open, onClose }) => {
  const [draft, setDraft] = useState<CustomAIConfig>(() => loadCustomAIConfig());
  const [statusInfo, setStatusInfo] = useState<AIStatusInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(loadCustomAIConfig());
    setShowKey(false);
    setTestResult(null);
    api
      .aiStatus()
      .then((info) => setStatusInfo(info))
      .catch(() => setStatusInfo(null));
  }, [open]);

  const currentPreset =
    AI_PROVIDER_PRESETS.find((p) => p.id === draft.providerId) || AI_PROVIDER_PRESETS[0];

  const handleSelectProvider = (providerId: AIProviderId) => {
    const preset = AI_PROVIDER_PRESETS.find((p) => p.id === providerId);
    if (!preset) return;
    setTestResult(null);
    setDraft((prev) => ({
      ...prev,
      providerId,
      baseUrl: preset.id === 'custom' ? prev.baseUrl : preset.baseUrl,
      model: preset.defaultModel
    }));
  };

  const handleTestConnection = async () => {
    const trimmedKey = draft.apiKey.trim();
    if (trimmedKey.length < 8) {
      setTestResult({ ok: false, text: '请先输入有效的 API Key（至少 8 位字符）' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testAiKey({
        apiKey: trimmedKey,
        baseUrl: draft.baseUrl.trim() || 'https://api.deepseek.com',
        model: draft.model.trim() || 'deepseek-chat'
      });
      setTestResult({
        ok: true,
        text: `连接成功（模型 ${res.model} · 延迟 ${res.latencyMs}ms）`
      });
    } catch (err: any) {
      setTestResult({
        ok: false,
        text: err?.message || '连接测试失败，请检查密钥与接口地址'
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    if (draft.enabled && draft.apiKey.trim().length < 8) {
      message.warning('启用自有密钥模式前，请填写完整的 API Key');
      return;
    }
    saveCustomAIConfig(draft);
    message.success(draft.enabled ? '已启用本地自有 API Key' : '已切换为平台免费 AI 通道');
    onClose();
  };

  return (
    <DraggableModal
      open={open}
      onCancel={onClose}
      width={520}
      title="AI 接口与自有密钥设置"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div>
            {draft.enabled ? (
              <Button loading={testing} onClick={handleTestConnection}>
                测试连接
              </Button>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" onClick={handleSave}>
              保存设置
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ElasticCapsuleTabs<'official' | 'custom'>
          block
          ariaLabel="AI 通道模式"
          value={draft.enabled ? 'custom' : 'official'}
          onChange={(mode) => {
            setTestResult(null);
            setDraft((prev) => ({ ...prev, enabled: mode === 'custom' }));
          }}
          options={[
            { value: 'official', label: '平台免费通道' },
            { value: 'custom', label: '使用自有 API Key（推荐重度创作）' }
          ]}
        />

        {!draft.enabled ? (
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 14,
              background: 'var(--color-surface-subtle, #f8fafc)',
              border: '1px solid var(--color-border, #e2e8f0)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              当前状态：{statusInfo?.officialAvailable === false ? '平台内置密钥暂未开启' : '平台免费通道可用'}
            </div>
            {statusInfo ? (
              <div style={{ fontSize: 13, color: 'var(--color-text-muted, #64748b)', lineHeight: 1.6 }}>
                今日剩余免费规划次数：<strong>{statusInfo.editRemaining}</strong> / {statusInfo.editDailyLimit} 次
                &nbsp;·&nbsp; 站名自动翻译：<strong>{statusInfo.translateRemaining}</strong> /{' '}
                {statusInfo.translateDailyLimit} 次
              </div>
            ) : null}
            <div style={{ fontSize: 12.5, color: 'var(--color-text-muted, #64748b)', lineHeight: 1.6 }}>
              日常轻量体验可直接使用免费额度；若遇到高峰期限流、额度用尽或离线免登录桌面创作，切换到上方「使用自有 API Key」即可无限制使用。
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>快捷服务商预设</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {AI_PROVIDER_PRESETS.map((preset) => {
                  const active = draft.providerId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleSelectProvider(preset.id)}
                      style={{
                        padding: '5px 12px',
                        borderRadius: 999,
                        fontSize: 12.5,
                        fontWeight: active ? 600 : 500,
                        cursor: 'pointer',
                        border: active ? '1px solid #2563eb' : '1px solid var(--color-border, #cbd5e1)',
                        background: active ? 'rgba(37, 99, 235, 0.10)' : 'transparent',
                        color: active ? '#2563eb' : 'inherit'
                      }}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  <KeyOutlined style={{ marginRight: 5 }} />
                  API Key
                </span>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted, #64748b)' }}>
                  {currentPreset.keyHint}
                </span>
              </div>
              <Input
                type="text"
                name="metro_ai_custom_api_token"
                placeholder="sk-..."
                value={draft.apiKey}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                data-form-type="other"
                className={!showKey && draft.apiKey ? 'metro-secret-token-masked' : undefined}
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                    style={{
                      border: 0,
                      background: 'transparent',
                      padding: 0,
                      cursor: 'pointer',
                      color: 'var(--color-text-muted, #64748b)',
                      display: 'inline-flex',
                      alignItems: 'center'
                    }}
                  >
                    {showKey ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                  </button>
                }
                onChange={(e) => {
                  setTestResult(null);
                  setDraft((prev) => ({ ...prev, apiKey: e.target.value }));
                }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>接口地址 (Base URL)</div>
                <Input
                  name="metro_ai_custom_base_url"
                  placeholder="https://api.deepseek.com"
                  value={draft.baseUrl}
                  autoComplete="off"
                  spellCheck={false}
                  data-form-type="other"
                  onChange={(e) => {
                    setTestResult(null);
                    setDraft((prev) => ({ ...prev, baseUrl: e.target.value }));
                  }}
                />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>模型名称 (Model)</div>
                <Input
                  name="metro_ai_custom_model"
                  placeholder="deepseek-chat"
                  value={draft.model}
                  autoComplete="off"
                  spellCheck={false}
                  data-form-type="other"
                  onChange={(e) => {
                    setTestResult(null);
                    setDraft((prev) => ({ ...prev, model: e.target.value }));
                  }}
                />
              </div>
            </div>

            {testResult ? (
              <Alert
                type={testResult.ok ? 'success' : 'error'}
                showIcon
                icon={testResult.ok ? <CheckCircleOutlined /> : undefined}
                message={testResult.text}
              />
            ) : null}

            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                fontSize: 12,
                color: 'var(--color-text-muted, #64748b)',
                lineHeight: 1.55
              }}
            >
              <SafetyCertificateOutlined style={{ marginTop: 3, color: '#10b981' }} />
              <span>
                隐私安全承诺：你的 API Key <strong>仅保存在本机浏览器/客户端本地存储</strong>，绝不写入服务端数据库，不受平台每日免费次数限制，未登录访客模式也可直接使用。
              </span>
            </div>
          </div>
        )}
      </div>
    </DraggableModal>
  );
};

export default AIApiSettingsModal;
