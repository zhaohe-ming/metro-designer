export type AIProviderId =
  | 'deepseek'
  | 'siliconflow'
  | 'openai'
  | 'moonshot'
  | 'dashscope'
  | 'custom';

export interface CustomAIConfig {
  enabled: boolean;
  providerId: AIProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AIProviderPreset {
  id: AIProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  keyHint: string;
}

export const AI_PROVIDER_PRESETS: AIProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    keyHint: 'platform.deepseek.com 获取 sk-...'
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    keyHint: 'cloud.siliconflow.cn 获取 sk-...'
  },
  {
    id: 'dashscope',
    label: '通义百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    keyHint: '阿里云百炼控制台获取 sk-...'
  },
  {
    id: 'moonshot',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-32k',
    keyHint: 'platform.moonshot.cn 获取 sk-...'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyHint: 'platform.openai.com 获取 sk-...'
  },
  {
    id: 'custom',
    label: '自定义兼容',
    baseUrl: '',
    defaultModel: 'deepseek-chat',
    keyHint: '任意 OpenAI 兼容 HTTPS 接口'
  }
];

const STORAGE_KEY = 'metro_custom_ai_config_v1';
export const AI_CONFIG_CHANGED_EVENT = 'metro-ai-config-changed';

export const DEFAULT_CUSTOM_AI_CONFIG: CustomAIConfig = {
  enabled: false,
  providerId: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat'
};

export function loadCustomAIConfig(): CustomAIConfig {
  if (typeof window === 'undefined') return { ...DEFAULT_CUSTOM_AI_CONFIG };
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CUSTOM_AI_CONFIG };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CUSTOM_AI_CONFIG };
    const providerId = AI_PROVIDER_PRESETS.some((p) => p.id === parsed.providerId)
      ? (parsed.providerId as AIProviderId)
      : 'deepseek';
    return {
      enabled: Boolean(parsed.enabled),
      providerId,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
      baseUrl:
        typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
          ? parsed.baseUrl.trim()
          : DEFAULT_CUSTOM_AI_CONFIG.baseUrl,
      model:
        typeof parsed.model === 'string' && parsed.model.trim()
          ? parsed.model.trim()
          : DEFAULT_CUSTOM_AI_CONFIG.model
    };
  } catch {
    return { ...DEFAULT_CUSTOM_AI_CONFIG };
  }
}

export function saveCustomAIConfig(config: CustomAIConfig): void {
  if (typeof window === 'undefined') return;
  try {
    const normalized: CustomAIConfig = {
      enabled: Boolean(config.enabled),
      providerId: config.providerId,
      apiKey: (config.apiKey || '').trim(),
      baseUrl: (config.baseUrl || '').trim() || 'https://api.deepseek.com',
      model: (config.model || '').trim() || 'deepseek-chat'
    };
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent(AI_CONFIG_CHANGED_EVENT, { detail: normalized }));
  } catch {
    /* ignore storage quota errors */
  }
}

export function hasActiveCustomAiKey(): boolean {
  const cfg = loadCustomAIConfig();
  return Boolean(cfg.enabled && cfg.apiKey.trim().length >= 8);
}

export function getActiveCustomAiHeaders(): Record<string, string> {
  const cfg = loadCustomAIConfig();
  if (!cfg.enabled || cfg.apiKey.trim().length < 8) return {};
  const headers: Record<string, string> = {
    'X-Custom-AI-Key': cfg.apiKey.trim()
  };
  if (cfg.baseUrl.trim()) headers['X-Custom-AI-Base-Url'] = cfg.baseUrl.trim();
  if (cfg.model.trim()) headers['X-Custom-AI-Model'] = cfg.model.trim();
  return headers;
}

export function getActiveAiBadgeLabel(): string | null {
  const cfg = loadCustomAIConfig();
  if (!cfg.enabled || cfg.apiKey.trim().length < 8) return null;
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === cfg.providerId);
  return preset && preset.id !== 'custom' ? `自有 Key · ${preset.label}` : '自有 Key';
}
