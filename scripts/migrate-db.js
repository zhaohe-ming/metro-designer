/**
 * 数据库整库搬家脚本（纯 Node，只依赖项目已有的 pg，无需 pg_dump / psql / docker）。
 *
 * 用途：把旧 Postgres（如即将被删的 Render 免费库）里的全部数据复制到新库。
 * 做法：在新库上建好（与线上一致的）schema → 按外键顺序逐表 SELECT + INSERT。
 * 幂等：所有表都按主键 ON CONFLICT (id) DO NOTHING，可安全重跑。
 *
 * 用法（Windows PowerShell）：
 *   $env:OLD_DATABASE_URL = "postgresql://user:pass@old-host/db?sslmode=require"
 *   $env:NEW_DATABASE_URL = "postgresql://user:pass@new-host/db?sslmode=require"
 *   node scripts/migrate-db.js
 *
 * 可选：若某一端是本地无 SSL 的库，设 OLD_DB_SSL=false 或 NEW_DB_SSL=false。
 */

const { Pool } = require('pg');

const OLD = (process.env.OLD_DATABASE_URL || '').trim();
const NEW = (process.env.NEW_DATABASE_URL || '').trim();

if (!OLD || !NEW) {
  console.error('✗ 需要同时设置 OLD_DATABASE_URL 和 NEW_DATABASE_URL 两个环境变量');
  process.exit(1);
}
if (OLD === NEW) {
  console.error('✗ 新旧连接串相同，拒绝执行');
  process.exit(1);
}

const sslFor = (flag) => (process.env[flag] === 'false' ? false : { rejectUnauthorized: false });
const oldPool = new Pool({ connectionString: OLD, ssl: sslFor('OLD_DB_SSL') });
const newPool = new Pool({ connectionString: NEW, ssl: sslFor('NEW_DB_SSL') });

// 外键顺序：users 必须先于引用它的 email_tokens / maps。
const TABLES = ['users', 'email_tokens', 'maps', 'rate_violations', 'bans'];

// 与 server/index.js 的 ensurePgSchema 保持一致（已去掉 phone 的全局 UNIQUE 隐患）。
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
  ALTER TABLE users ALTER COLUMN phone SET DEFAULT '';
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_key;
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users(LOWER(email)) WHERE email <> '';
  CREATE INDEX IF NOT EXISTS users_phone_idx ON users(phone) WHERE phone <> '';

  CREATE TABLE IF NOT EXISTS email_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS email_tokens_user_type_idx ON email_tokens(user_id, type, expires_at DESC);

  CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    stations JSONB NOT NULL DEFAULT '[]'::jsonb,
    sections JSONB NOT NULL DEFAULT '[]'::jsonb,
    map_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS maps_user_updated_idx ON maps(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS rate_violations (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS rate_violations_key_time_idx ON rate_violations(key, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS bans (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    reason TEXT NOT NULL,
    banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unban_at TIMESTAMPTZ NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'system'
  );
  CREATE INDEX IF NOT EXISTS bans_key_unban_idx ON bans(key, unban_at DESC);
`;

// node-pg 对参数的默认编码：数组会被当成 Postgres 数组字面量（会破坏 jsonb），
// Date 能正确转 timestamptz。所以：Date 原样传；其它对象/数组 JSON.stringify 成文本
// （插入 jsonb 列时 Postgres 会用 jsonb 输入函数解析该文本）。
function encode(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

async function copyTable(table) {
  const { rows } = await oldPool.query(`SELECT * FROM ${table}`);
  if (rows.length === 0) {
    console.log(`  ${table.padEnd(16)} 0 行（跳过）`);
    return { table, total: 0, copied: 0 };
  }
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;

  let copied = 0;
  for (const row of rows) {
    const res = await newPool.query(sql, cols.map((c) => encode(row[c])));
    copied += res.rowCount;
  }
  console.log(`  ${table.padEnd(16)} 读到 ${rows.length} 行，写入 ${copied} 行` + (copied < rows.length ? `（${rows.length - copied} 行已存在，跳过）` : ''));
  return { table, total: rows.length, copied };
}

(async () => {
  console.log('① 在新库创建 / 校验 schema …');
  await newPool.query(SCHEMA_SQL);

  console.log('② 逐表搬运数据 …');
  const summary = [];
  for (const t of TABLES) summary.push(await copyTable(t));

  // 校验：对比每张表的总行数
  console.log('③ 行数校验（旧 → 新）…');
  for (const t of TABLES) {
    const [{ rows: o }, { rows: n }] = await Promise.all([
      oldPool.query(`SELECT COUNT(*)::int AS c FROM ${t}`),
      newPool.query(`SELECT COUNT(*)::int AS c FROM ${t}`)
    ]);
    const mark = n[0].c >= o[0].c ? '✓' : '✗';
    console.log(`  ${mark} ${t.padEnd(16)} 旧=${o[0].c}  新=${n[0].c}`);
  }

  await oldPool.end();
  await newPool.end();
  console.log('\n✓ 迁移完成。把后端的 DATABASE_URL 切到新库并重新部署即可。');
})().catch(async (err) => {
  console.error('\n✗ 迁移失败：', err.message);
  try { await oldPool.end(); } catch {}
  try { await newPool.end(); } catch {}
  process.exit(1);
});
