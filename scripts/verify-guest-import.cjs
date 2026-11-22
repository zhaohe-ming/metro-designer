// Isolated API regression: uses disposable JSON storage, never the project's real data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

async function main() {
  const dataDir = process.argv.includes('--serve') ? path.join(__dirname, '../outputs/guest-preview/fixture-data') : fs.mkdtempSync(path.join(os.tmpdir(), 'metro-guest-test-'));
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = 'isolated-guest-test-secret';
  const port = process.env.GUEST_TEST_PORT || '4013';
  const users = ['guest-test-a', 'guest-test-b'].map(id => ({ id, email: `${id}@example.test`,
    emailVerified: true, username: id, phone: '', passwordHash: bcrypt.hashSync('fixture-only-password', 4) }));
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, maps: [], seq: { user: 3, map: 1 }, email_tokens: [{
    id: 'fixture-verify', userId: users[0].id, type: 'verify',
    tokenHash: crypto.createHash('sha256').update('fixture-browser-verify-token').digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), usedAt: null
  }] }));
  const server = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], {
    env: { ...process.env, PORT: port, METRO_DATA_DIR: dataDir, JWT_SECRET: secret, DATABASE_URL: '', NODE_ENV: 'test', RESEND_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = ''; server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const token = id => jwt.sign({ userId: id, purpose: 'login' }, secret);
  const request = (method, route, userId, body) => fetch(`${base}${route}`, { method,
    headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${token(userId)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Waiting for this child only. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const payload = { name: 'Guest migration', clientDraftId: 'fixture-draft-1234', lines: [], stations: [], sections: [] };
    assert.equal((await request('POST', '/api/maps', null, payload)).status, 401);
    assert.equal((await request('POST', '/api/maps', users[0].id, { ...payload, clientDraftId: {} })).status, 400);
    const results = await Promise.all(Array.from({ length: 3 }, () => request('POST', '/api/maps', users[0].id, payload).then(r => r.json())));
    assert.ok(results[0].map?.id);
    assert.ok(results.every(result => result.map.id === results[0].map.id), 'parallel retries create one map');
    const edited = { ...payload, name: 'Updated after uncertain response', stations: [{ id: 'one', name: 'One', x: 10, y: 20 }] };
    const retry = await (await request('POST', '/api/maps', users[0].id, edited)).json();
    assert.equal(retry.map.id, results[0].map.id);
    const list = await (await request('GET', '/api/maps', users[0].id)).json();
    assert.equal(list.maps.length, 1);
    const loaded = await (await request('GET', `/api/maps/${retry.map.id}`, users[0].id)).json();
    assert.equal(loaded.map.stations.length, 1);
    assert.equal((await request('GET', `/api/maps/${retry.map.id}`, users[1].id)).status, 404);
    const other = await (await request('POST', '/api/maps', users[1].id, payload)).json();
    assert.notEqual(other.map.id, retry.map.id, 'same draft ID is scoped to its account');
    const ordinary = await (await request('POST', '/api/maps', users[0].id, { name: 'Ordinary map', lines: [], stations: [], sections: [] })).json();
    assert.ok(ordinary.map.id);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: users[0].email, password: 'fixture-only-password' }) });
    assert.equal(login.status, 200);
    console.log('PASS: guest import retries, latest payload, account isolation, ordinary saves and existing login.');
    if (process.argv.includes('--serve')) {
      console.log(`Isolated browser QA fixture ready at ${base}`);
      await new Promise(() => {});
    }
  } catch (error) { console.error(logs); throw error; }
  finally { server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
