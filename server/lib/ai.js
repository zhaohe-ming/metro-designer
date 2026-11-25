// OpenAI 兼容大模型客户端（默认官方 DeepSeek，同时支持用户本地自填 API Key / Base URL / Model 安全透传）。
//
// 安全与稳定性设计要点：
// - 内部统一捕获网络与超时异常，返回 { ok, data?, reason?, message? }；
// - 绝对不在任何日志、错误信息或持久化存储中输出用户的 API Key；
// - 严格拦截自定义 Base URL 的内网 / 环回 / 云元数据地址，彻底杜绝 SSRF；
// - 自动归一化常见第三方兼容地址（如漏写 /v1 或误粘完整 /chat/completions 后缀）。

const net = require('node:net');

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();

const hasKey = () => Boolean(DEEPSEEK_API_KEY);

const AUTO_V1_HOSTS = new Set([
  'api.openai.com',
  'api.siliconflow.cn',
  'api.moonshot.cn',
  'api.groq.com',
  'api.together.xyz',
  'openrouter.ai'
]);

function isPrivateOrLoopbackHost(hostname) {
  const lower = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower) return true;
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }

  const ipVersion = net.isIP(lower);
  if (ipVersion === 4) {
    const parts = lower.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (ipVersion === 6) {
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    if (lower.startsWith('::ffff:')) {
      return isPrivateOrLoopbackHost(lower.slice(7));
    }
  }
  return false;
}

/**
 * 解析并安全校验本次请求使用的 AI 接口配置。
 * 若传入 custom.apiKey，则使用用户自有 Key 配置；否则回退到服务端内置配置。
 */
function resolveAiEndpointConfig(custom) {
  const customKey = typeof custom?.apiKey === 'string' ? custom.apiKey.trim() : '';
  if (!customKey) {
    if (!DEEPSEEK_API_KEY) {
      return {
        ok: false,
        reason: 'no_key',
        message: '平台暂未配置内置 AI 密钥，请在右上角「API 设置」中填入你的 API Key 继续使用'
      };
    }
    return {
      ok: true,
      isCustom: false,
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: DEEPSEEK_BASE_URL,
      model: DEEPSEEK_MODEL
    };
  }

  if (!/^[\x21-\x7E]{8,256}$/.test(customKey)) {
    return {
      ok: false,
      reason: 'invalid_custom_key',
      message: '自定义 API Key 格式无效（应为 8–256 位英文字符/数字，不含空格或中文）'
    };
  }

  const rawBaseUrl = typeof custom?.baseUrl === 'string' && custom.baseUrl.trim()
    ? custom.baseUrl.trim()
    : 'https://api.deepseek.com';

  let parsedUrl;
  try {
    parsedUrl = new URL(rawBaseUrl);
  } catch {
    return {
      ok: false,
      reason: 'invalid_base_url',
      message: '自定义接口地址（Base URL）格式无效，请填写以 https:// 开头的完整地址'
    };
  }

  if (parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'insecure_base_url',
      message: '出于安全保护，自定义接口地址必须使用 https:// 协议'
    };
  }

  if (parsedUrl.username || parsedUrl.password) {
    return {
      ok: false,
      reason: 'invalid_base_url',
      message: '接口地址中不可包含账号密码字段'
    };
  }

  if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
    return {
      ok: false,
      reason: 'forbidden_base_url',
      message: '不允许使用内网或本地环回地址作为自定义接口地址'
    };
  }

  // 容错归一化：去掉用户可能误粘的 /chat/completions 后缀与末尾斜杠；常见平台若只填了根域名自动补 /v1
  let cleanPath = parsedUrl.pathname.replace(/\/+$/, '');
  cleanPath = cleanPath.replace(/\/chat\/completions$/i, '');
  if (!cleanPath && AUTO_V1_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    cleanPath = '/v1';
  }
  const normalizedBaseUrl = `${parsedUrl.origin}${cleanPath}`;

  const rawModel = typeof custom?.model === 'string' && custom.model.trim()
    ? custom.model.trim()
    : 'deepseek-chat';
  if (!/^[a-zA-Z0-9._:/-]{1,120}$/.test(rawModel)) {
    return {
      ok: false,
      reason: 'invalid_model',
      message: '模型名称格式无效（仅支持字母、数字及 ._:/- 符号）'
    };
  }

  return {
    ok: true,
    isCustom: true,
    apiKey: customKey,
    baseUrl: normalizedBaseUrl,
    model: rawModel
  };
}

function formatUpstreamError(status, isCustom) {
  if (status === 401 || status === 403) {
    return isCustom
      ? '自定义 API Key 无效或无权限（401），请检查密钥是否正确'
      : 'AI 服务鉴权失败，请联系管理员或切换自有 API Key';
  }
  if (status === 402) {
    return isCustom
      ? '你的自定义 API 账户余额不足（402），请前往对应平台充值'
      : '官方免费 AI 通道余额暂时耗尽，可点击「API 设置」填入自有 API Key 立即继续使用';
  }
  if (status === 404) {
    return isCustom
      ? '未找到对应接口路径或模型名称（404），请检查 Base URL 与模型名是否匹配'
      : 'AI 模型接口不存在（404）';
  }
  if (status === 429) {
    return isCustom
      ? '你的自定义 API Key 触发上游速率限制（429），请稍后重试'
      : '当前 AI 并发请求较多（429），请稍后重试或配置自有 API Key 独享通道';
  }
  return `AI 上游服务暂时异常（HTTP ${status}），请稍后重试`;
}

async function chatCompletion({
  messages,
  tools,
  toolChoice,
  temperature,
  maxTokens,
  timeoutMs = 30_000,
  customConfig,
  fetchImpl = fetch
}) {
  const endpoint = resolveAiEndpointConfig(customConfig);
  if (!endpoint.ok) {
    return { ok: false, reason: endpoint.reason, message: endpoint.message };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (!endpoint.isCustom) {
        console.error(`[ai] upstream ${response.status} ${body.slice(0, 240)}`);
      }
      return {
        ok: false,
        status: response.status,
        reason: `upstream_${response.status}`,
        message: formatUpstreamError(response.status, endpoint.isCustom)
      };
    }
    const data = await response.json();
    return { ok: true, data, model: endpoint.model };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, reason: 'timeout', message: 'AI 响应超时，请缩短指令或稍后重试' };
    }
    if (!endpoint.isCustom) {
      console.error('[ai] network error', err.message || err);
    }
    return {
      ok: false,
      reason: 'network',
      message: endpoint.isCustom
        ? '无法连接到自定义接口地址，请检查 Base URL 是否正确'
        : 'AI 网络连接异常，请稍后重试'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function chatCompletionStream({
  messages,
  tools,
  toolChoice,
  temperature,
  maxTokens,
  onDelta,
  timeoutMs = 60_000,
  customConfig,
  fetchImpl = fetch
}) {
  const endpoint = resolveAiEndpointConfig(customConfig);
  if (!endpoint.ok) {
    return { ok: false, reason: endpoint.reason, message: endpoint.message };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        stream: true,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      if (!endpoint.isCustom) {
        console.error(`[ai] stream upstream ${response.status} ${body.slice(0, 240)}`);
      }
      return {
        ok: false,
        status: response.status,
        reason: `upstream_${response.status}`,
        message: formatUpstreamError(response.status, endpoint.isCustom)
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCallsAcc = [];

    /* eslint-disable no-constant-condition */
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { name: '', arguments: '' };
            if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
          }
        }
      }
    }
    /* eslint-enable no-constant-condition */
    return { ok: true, content, toolCalls: toolCallsAcc.filter(Boolean) };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, reason: 'timeout', message: 'AI 流式响应超时，请稍后重试' };
    }
    if (!endpoint.isCustom) {
      console.error('[ai] stream network error', err.message || err);
    }
    return {
      ok: false,
      reason: 'network',
      message: endpoint.isCustom
        ? '无法连接到自定义接口地址，请检查 Base URL 是否正确'
        : 'AI 网络连接异常，请稍后重试'
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  hasKey,
  resolveAiEndpointConfig,
  chatCompletion,
  chatCompletionStream,
  DEEPSEEK_MODEL
};
