import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, message } from 'antd';
import {
  CheckCircleOutlined,
  CompassOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import DraggableModal from './DraggableModal';
import ElasticCapsuleTabs from './ElasticCapsuleTabs';
import {
  CustomAmapConfig,
  hasConfiguredCustomAmapKey,
  loadCustomAmapConfig,
  saveCustomAmapConfig
} from '../lib/amapCustomConfig';
import { testCustomAmapConnection } from '../amapLoader';

interface AmapApiSettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** 当用户保存并启用高德矢量引擎时，若当前尚未开启地理底图模式可一键切入 */
  isCurrentlyGeoMode?: boolean;
  onActivateGeoMode?: () => void;
}

const AmapApiSettingsModal: React.FC<AmapApiSettingsModalProps> = ({
  open,
  onClose,
  isCurrentlyGeoMode,
  onActivateGeoMode
}) => {
  const [draft, setDraft] = useState<CustomAmapConfig>(() => loadCustomAmapConfig());
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showSec, setShowSec] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const saved = loadCustomAmapConfig();
    // 若用户尚未保存过 Key 就点进本配置框，默认展开「高德矢量底图」填表与新手引导，省去多点一次
    setDraft(hasConfiguredCustomAmapKey(saved) ? saved : { ...saved, enabled: true });
    setShowKey(false);
    setShowSec(false);
    setTestResult(null);
  }, [open]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testCustomAmapConnection(draft.apiKey, draft.securityJsCode);
    setTesting(false);
    setTestResult({ ok: res.ok, text: res.message });
  };

  const handleSave = () => {
    if (draft.enabled && draft.apiKey.trim().length < 16) {
      message.warning('请先按上方 4 步引导粘贴 32 位高德 Web 端（JS API）Key');
      return;
    }
    const saved = saveCustomAmapConfig(draft);
    if (saved.enabled) {
      if (!isCurrentlyGeoMode && onActivateGeoMode) {
        onActivateGeoMode();
      }
      message.success('已切换至高德矢量底图引擎（自动纠偏对齐 WGS-84 车站坐标）');
    } else {
      message.success('已切换回内置免配置瓦片底图');
    }
    onClose();
  };

  const keyReady = draft.apiKey.trim().length >= 16;

  return (
    <DraggableModal
      open={open}
      onCancel={onClose}
      width={540}
      title="地理底图引擎与自有高德 Key 设置"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div>
            {draft.enabled ? (
              <Button loading={testing} onClick={() => void handleTest()}>
                测试高德连接
              </Button>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" onClick={handleSave}>
              {draft.enabled
                ? isCurrentlyGeoMode
                  ? '保存并立即切换高德底图'
                  : '保存并开启高德地理底图'
                : '保存并切回内置瓦片'}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ElasticCapsuleTabs<'tile' | 'amap'>
          block
          ariaLabel="地理底图渲染引擎"
          value={draft.enabled ? 'amap' : 'tile'}
          onChange={(mode) => {
            setTestResult(null);
            const nextEnabled = mode === 'amap';
            setDraft((prev) => {
              const updated = { ...prev, enabled: nextEnabled };
              if (!nextEnabled || prev.apiKey.trim().length >= 16) {
                saveCustomAmapConfig(updated);
                message.success(
                  nextEnabled ? '已一键切换为高德矢量底图引擎' : '已一键切回内置免配置瓦片底图'
                );
              }
              return updated;
            });
          }}
          options={[
            { value: 'tile', label: '内置免配瓦片底图' },
            { value: 'amap', label: keyReady ? '高德矢量底图（已就绪）' : '高德矢量底图（自有 Key）' }
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
              gap: 8,
              fontSize: 13,
              lineHeight: 1.65
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              <CompassOutlined style={{ marginRight: 6 }} />
              当前正在使用：内置免配置公开瓦片底图（OpenStreetMap / CARTO）
            </div>
            <div style={{ color: 'var(--color-text-muted, #64748b)' }}>
              优点是无需注册任何账号开箱即用、支持全球城市与直接合成导出视频；如果你希望在国内城市获得更干净锐利的<strong>高德原版 WebGL 矢量道路、水系与雅士灰/幻影黑配色</strong>，只需切换到上方「高德矢量底图」按引导免费领一个个人 Key 填入即可。
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <div
              style={{
                padding: '11px 13px',
                borderRadius: 12,
                background: 'var(--color-surface-subtle, #f8fafc)',
                border: '1px solid var(--color-border, #e2e8f0)',
                fontSize: 12,
                lineHeight: 1.68,
                color: 'var(--color-text-soft, #475569)'
              }}
            >
              <div style={{ fontWeight: 700, color: 'var(--color-text, #0f172a)', marginBottom: 4 }}>
                新手 4 步免费申请高德个人 Key 指南（0 元免费额度 · 约 2 分钟）：
              </div>
              <div>
                <strong>第 1 步：</strong>打开{' '}
                <a
                  href="https://console.amap.com/dev/key/app"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontWeight: 600 }}
                >
                  高德开放平台控制台 (console.amap.com) ↗
                </a>{' '}
                登录并完成个人开发者实名认证（免费）。
              </div>
              <div>
                <strong>第 2 步：</strong>进入左侧「应用管理 → 我的应用」，点击右上角<strong>「创建新应用」</strong>（名称任填，如“个人地铁制图”）。
              </div>
              <div>
                <strong>第 3 步：</strong>在刚创建的应用右侧点击<strong>「添加 Key」</strong>——
                <span style={{ color: '#d97706', fontWeight: 700 }}>
                  服务平台务必勾选「Web端 (JS API)」
                </span>
                （切勿选成 Web服务或小程序），提交即可生成。
              </div>
              <div>
                <strong>第 4 步：</strong>把表格里生成的 <strong>Key</strong> 和旁边的 <strong>安全密钥 (jscode)</strong> 分别粘贴到下方，点击保存即可一键无感切换（车站坐标自动精准对齐，绝不偏移！）。
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  <KeyOutlined style={{ marginRight: 5 }} />
                  高德 Web端 (JS API) Key
                </span>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted, #64748b)' }}>
                  32 位字母数字串
                </span>
              </div>
              <Input
                name="metro_custom_amap_key"
                placeholder="例如：a1b2c3d4e5f6..."
                value={draft.apiKey}
                autoComplete="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                className={!showKey && draft.apiKey ? 'metro-secret-token-masked' : undefined}
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? '隐藏 Key' : '显示 Key'}
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

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  安全密钥 (securityJsCode)
                </span>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted, #64748b)' }}>
                  高德控制台 Key 右侧紧邻的 32 位安全密钥（必填）
                </span>
              </div>
              <Input
                name="metro_custom_amap_jscode"
                placeholder="例如：f6e5d4c3b2a1..."
                value={draft.securityJsCode}
                autoComplete="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                className={!showSec && draft.securityJsCode ? 'metro-secret-token-masked' : undefined}
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowSec((s) => !s)}
                    aria-label={showSec ? '隐藏安全密钥' : '显示安全密钥'}
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
                    {showSec ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                  </button>
                }
                onChange={(e) => {
                  setTestResult(null);
                  setDraft((prev) => ({ ...prev, securityJsCode: e.target.value }));
                }}
              />
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
                gap: 8,
                fontSize: 12,
                color: 'var(--color-text-muted, #64748b)',
                lineHeight: 1.55
              }}
            >
              <SafetyCertificateOutlined style={{ color: '#10b981', marginTop: 3, flexShrink: 0 }} />
              <span>
                本地隐私说明：你的高德 Key 与安全密钥<strong>仅保存在本机浏览器本地存储</strong>，由浏览器直连高德服务器渲染矢量底图，绝不上传本站后台；仅限个人学习研究预览使用。
              </span>
            </div>
          </div>
        )}
      </div>
    </DraggableModal>
  );
};

export default AmapApiSettingsModal;
