// 本地自有高德 Web 端（JS API 2.0）密钥持久化管理：
// 密钥仅保存在用户当前浏览器/客户端 localStorage 中，绝不写入服务端数据库，
// 支持随时与内置免配置瓦片底图一键无缝切换。

export interface CustomAmapConfig {
  enabled: boolean;
  apiKey: string;
  securityJsCode: string;
}

const STORAGE_KEY = 'metro_custom_amap_config_v1';
export const CUSTOM_AMAP_CHANGED_EVENT = 'metro:custom-amap-config-changed';

export const DEFAULT_CUSTOM_AMAP_CONFIG: CustomAmapConfig = {
  enabled: false,
  apiKey: '',
  securityJsCode: ''
};

export function loadCustomAmapConfig(): CustomAmapConfig {
  if (typeof window === 'undefined') return { ...DEFAULT_CUSTOM_AMAP_CONFIG };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CUSTOM_AMAP_CONFIG };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CUSTOM_AMAP_CONFIG };
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    const securityJsCode = typeof parsed.securityJsCode === 'string' ? parsed.securityJsCode.trim() : '';
    const enabled = Boolean(parsed.enabled && apiKey.length >= 16);
    return { enabled, apiKey, securityJsCode };
  } catch {
    return { ...DEFAULT_CUSTOM_AMAP_CONFIG };
  }
}

export function saveCustomAmapConfig(next: CustomAmapConfig): CustomAmapConfig {
  const clean: CustomAmapConfig = {
    enabled: Boolean(next.enabled && next.apiKey.trim().length >= 16),
    apiKey: next.apiKey.trim(),
    securityJsCode: next.securityJsCode.trim()
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch {
      /* ignore quota errors */
    }
    window.dispatchEvent(new CustomEvent(CUSTOM_AMAP_CHANGED_EVENT, { detail: clean }));
  }
  return clean;
}

export function hasConfiguredCustomAmapKey(cfg = loadCustomAmapConfig()): boolean {
  return cfg.apiKey.trim().length >= 16;
}

export function isCustomAmapActive(): boolean {
  const cfg = loadCustomAmapConfig();
  return Boolean(cfg.enabled && cfg.apiKey.trim().length >= 16);
}

export function setCustomAmapEngineEnabled(enabled: boolean): CustomAmapConfig {
  const cur = loadCustomAmapConfig();
  return saveCustomAmapConfig({
    ...cur,
    enabled: Boolean(enabled && cur.apiKey.trim().length >= 16)
  });
}
