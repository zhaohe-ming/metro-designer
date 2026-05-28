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

// 流式版本：stream:true 走 SSE。
// - onDelta(token) 实时回吐每个文本增量；
// - tool_calls 在流式里是分片到达的（同一个 index 的 name / arguments 分多个 chunk 拼），
//   这里按 index 累加，流结束后返回完整的 toolCalls 数组。
// 返回 { ok, content, toolCalls } 或 { ok:false, reason }。
async function chatCompletionStream({ messages, tools, toolChoice, temperature, maxTokens, onDelta, timeoutMs = 60_000 }) {
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
      console.error(`[ai] DeepSeek stream ${response.status} ${body.slice(0, 300)}`);
      return { ok: false, reason: `deepseek_${response.status}` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCallsAcc = []; // index → { name, arguments }

    // DeepSeek SSE：每个事件以 "data: {...}\n" 出现，事件间用换行分隔，末尾是 "data: [DONE]"
    /* eslint-disable no-constant-condition */
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 末行可能不完整，留到下次
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
    if (err.name === 'AbortError') return { ok: false, reason: 'timeout' };
    console.error('[ai] stream network error', err);
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  hasKey,
  chatCompletion,
  chatCompletionStream,
  // 暴露给路由作 logging / health
  DEEPSEEK_MODEL
};
