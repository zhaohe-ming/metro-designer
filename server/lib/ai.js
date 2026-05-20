// DeepSeek 客户端。走 OpenAI 兼容接口，所以接口形态跟 OpenAI SDK 完全一样，
// 以后想换 Doubao / Kimi / GLM 等只换 base URL + key 即可。
//
// 设计要点：
// - 内部不抛网络异常，统一返回 { ok, data?, reason? } 让路由不写 try/catch。
// - 不在文件里打 key；console.error 只打 status 和 body 前 300 字。
// - 短上下文：translate / suggest 用 chat completion；edit 用 function calling（在路由里直接传 tools）。

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
// 默认 deepseek-chat（V3）；如果将来想换模型只改 env 不改代码
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();

const hasKey = () => Boolean(DEEPSEEK_API_KEY);

async function chatCompletion({ messages, tools, toolChoice, temperature, maxTokens, timeoutMs = 30_000 }) {
  if (!hasKey()) {
    return { ok: false, reason: 'no_key' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
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
      console.error(`[ai] DeepSeek ${response.status} ${body.slice(0, 300)}`);
      return { ok: false, reason: `deepseek_${response.status}` };
    }
    const data = await response.json();
    return { ok: true, data };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: 'timeout' };
    console.error('[ai] network error', err);
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  hasKey,
  chatCompletion,
  // 暴露给路由作 logging / health
  DEEPSEEK_MODEL
};
