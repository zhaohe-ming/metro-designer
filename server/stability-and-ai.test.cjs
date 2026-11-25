const { test } = require('node:test');
const assert = require('node:assert/strict');
const ai = require('./lib/ai');
const { createTileProxyHandler } = require('./lib/tileProxy');

test('resolveAiEndpointConfig normalizes valid HTTPS providers and rejects SSRF / private / HTTP targets', () => {
  // Auto-adds /v1 for OpenAI / SiliconFlow / Moonshot root domains & strips /chat/completions
  const sf = ai.resolveAiEndpointConfig({
    apiKey: 'sk-test1234567890',
    baseUrl: 'https://api.siliconflow.cn',
    model: 'deepseek-ai/DeepSeek-V3'
  });
  assert.equal(sf.ok, true);
  assert.equal(sf.baseUrl, 'https://api.siliconflow.cn/v1');
  assert.equal(sf.model, 'deepseek-ai/DeepSeek-V3');

  const stripped = ai.resolveAiEndpointConfig({
    apiKey: 'sk-test1234567890',
    baseUrl: 'https://api.deepseek.com/chat/completions/',
    model: 'deepseek-chat'
  });
  assert.equal(stripped.ok, true);
  assert.equal(stripped.baseUrl, 'https://api.deepseek.com');

  // Rejects HTTP, localhost, loopback, private LAN, and cloud metadata IPs
  for (const badUrl of [
    'http://api.deepseek.com',
    'https://localhost:8080/v1',
    'https://127.0.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.10/v1',
    'https://10.0.0.5/v1',
    'https://[::1]:11434/v1'
  ]) {
    const res = ai.resolveAiEndpointConfig({ apiKey: 'sk-test1234567890', baseUrl: badUrl });
    assert.equal(res.ok, false, `Expected ${badUrl} to be rejected`);
  }
});

test('chatCompletion passes custom apiKey/baseUrl/model without leaking key on upstream error', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const okRes = await ai.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    customConfig: {
      apiKey: 'sk-secret-user-key-999',
      baseUrl: 'https://api.moonshot.cn',
      model: 'moonshot-v1-8k'
    },
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'OK' } }] })
      };
    }
  });
  assert.equal(okRes.ok, true);
  assert.equal(seenUrl, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(seenAuth, 'Bearer sk-secret-user-key-999');

  const errRes = await ai.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    customConfig: {
      apiKey: 'sk-secret-user-key-999',
      baseUrl: 'https://api.deepseek.com'
    },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => 'Invalid key sk-secret-user-key-999'
    })
  });
  assert.equal(errRes.ok, false);
  assert.ok(!JSON.stringify(errRes).includes('sk-secret-user-key-999'));
});

test('email strict delivery does not silently pretend ok in production when Resend fails', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  delete require.cache[require.resolve('./lib/email')];
  const prodEmail = require('./lib/email');
  try {
    assert.equal(prodEmail.isStrictEmailDelivery(), true);
    const res = await prodEmail.sendVerificationEmail(
      { to: 'user@example.com', username: 'Tester', token: 'tok123' },
      async () => ({ ok: false, status: 429, text: async () => 'daily quota exceeded' })
    );
    assert.equal(res.ok, false);
  } finally {
    process.env.NODE_ENV = prevEnv;
    delete require.cache[require.resolve('./lib/email')];
  }
});

test('tileProxy caches valid tiles and sets CORS headers for untainted Canvas export', async () => {
  let upstreamCalls = 0;
  const handler = createTileProxyHandler({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return {
        ok: true,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer
      };
    }
  });

  const makeRes = () => ({
    code: 200,
    headers: {},
    body: null,
    status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; }
  });

  const res1 = makeRes();
  await handler({ params: { style: 'dark', z: '11', x: '1685', y: '775.png' } }, res1);
  assert.equal(res1.code, 200);
  assert.equal(res1.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(res1.headers['X-Tile-Cache'], 'MISS');
  assert.equal(upstreamCalls, 1);

  const res2 = makeRes();
  await handler({ params: { style: 'dark', z: '11', x: '1685', y: '775.png' } }, res2);
  assert.equal(res2.code, 200);
  assert.equal(res2.headers['X-Tile-Cache'], 'HIT');
  assert.equal(upstreamCalls, 1);

  const badRes = makeRes();
  await handler({ params: { style: 'normal', z: '2', x: '99', y: '0' } }, badRes);
  assert.equal(badRes.code, 400);
});
