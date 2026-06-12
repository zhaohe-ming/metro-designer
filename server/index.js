const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { sendVerificationEmail, sendPasswordResetEmail, hasResendKey, APP_BASE_URL } = require('./lib/email');
const ai = require('./lib/ai');

const app = express();
const PORT = process.env.PORT || 4000;

// ── 速率限制 + 自动封禁策略 ────────────────────────────────────────────────
// 触发任何一个速率限制器 = 一次 'rate_429' violation
// 登录失败 = 一次 'login_fail' violation
// 24 小时内 violation 累计达 BAN_THRESHOLD 自动拉黑 IP 24 小时
const VIOLATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const BAN_DURATION_MS = 24 * 60 * 60 * 1000;
const BAN_THRESHOLD = 50;          // 登录失败 / 限流触发数量阈值（24h 内）
const VIOLATION_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // 老 violation 7 天清理
const RAW_JWT_SECRET = (process.env.JWT_SECRET || '').trim();
if (!RAW_JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // 生产环境强制要求；否则签出的 token 一旦默认值泄露就等于敞开后门
    console.error('[FATAL] JWT_SECRET must be set in production');
    process.exit(1);
  }
  console.warn(
    '[WARN] JWT_SECRET is not set. Falling back to a random per-process secret. ' +
    'All issued tokens will be invalidated on restart. Set JWT_SECRET in .env to persist sessions.'
  );
}
const JWT_SECRET = RAW_JWT_SECRET || crypto.randomBytes(48).toString('hex');
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const AMAP_WEB_SERVICE_KEY = process.env.AMAP_WEB_SERVICE_KEY || '';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
// 头像图片以 dataURL 形式落库，限一个合理上限避免拖慢用户列表/me 接口
const MAX_AVATAR_LENGTH = 200_000; // ≈ 150KB 二进制

// ── 邮箱验证 / 找回密码 token ────────────────────────────────────────────
const EMAIL_TOKEN_TTL_MS = 15 * 60 * 1000;
// 升级 JWT 用：legacy 手机号用户登录后拿到的 short-lived token，只能调 /api/auth/upgrade-email
const UPGRADE_TOKEN_TTL = '15m';

console.log(`[email] provider=${hasResendKey() ? 'resend' : 'console-fallback'} app_base=${APP_BASE_URL}`);
console.log(`[ai] provider=${ai.hasKey() ? `deepseek (${ai.DEEPSEEK_MODEL})` : 'disabled'}`);

const DEFAULT_MAP_SETTINGS = {
  // 与前端 src/types/index.ts 保持一致：新项目默认 dot-label（专业线网）；
  // normalizeMapSettings 的 fallback 仍是 classic-badge，老数据不受影响。
  mapStyle: 'dot-label',
  canvasTheme: 'light',
  cityStyle: 'standard',
  showLineNameLabels: true,
  dotLabelStyle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#0f172a'
  },
  baseMap: {
    mode: 'plain',
    amap: {
      center: [116.397428, 39.90923],
      zoom: 11,
      style: 'normal'
    }
  },
  cornerRadius: 0
};

const allowedOrigins = FRONTEND_ORIGIN
  ? FRONTEND_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : [];

const pgPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
    })
  : null;
let pgReadyPromise = null;

// Render / Vercel 都把流量走代理，req.ip 必须信任 X-Forwarded-For 第一跳，
// 否则所有限流器看到的都是 127.0.0.1 / 0.0.0.0 等同形同虚设。
// 注意：只信任 1 跳，多层代理需手动调整。
app.set('trust proxy', 1);

// 安全 HTTP headers：X-Content-Type-Options / X-Frame-Options / HSTS / Referrer-Policy 等。
// 后端只返回 JSON，CSP 默认配置不会阻挡前端（前端 HTML 由 Vercel 单独 serve），
// 所以放心用默认；contentSecurityPolicy 留默认（仅影响 JSON 响应）。
app.use(helmet({
  // crossOriginResourcePolicy: 'same-site' 会阻止跨域 fetch 拿 amap proxy 图片，
  // 而 amap proxy 必须能被前端跨域取，所以放松到 cross-origin。
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  }
}));
// body limit 收紧到 1MB：avatar 上限 200KB，地图 payload 历史上不超过几百 KB。
// 真有大数据需求再单独走分块或专用 endpoint。
app.use(express.json({ limit: '1mb' }));

// 每个请求生成 requestId，500 时透出去方便定位日志
app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function ensureJsonDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify(
        { users: [], maps: [], bans: [], rate_violations: [], email_tokens: [], seq: { user: 1, map: 1 } },
        null,
        2
      ),
      'utf8'
    );
  }
}

function readJsonDb() {
  ensureJsonDb();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.users = Array.isArray(db.users) ? db.users : [];
  db.maps = Array.isArray(db.maps) ? db.maps : [];
  // bans / rate_violations / email_tokens 在 dev JSON 模式下也保存，跨重启不丢
  db.bans = Array.isArray(db.bans) ? db.bans : [];
  db.rate_violations = Array.isArray(db.rate_violations) ? db.rate_violations : [];
  db.email_tokens = Array.isArray(db.email_tokens) ? db.email_tokens : [];
  // 给老用户补 email / emailVerified 字段，迁移到强制升级路径
  db.users.forEach(u => {
    if (typeof u.email !== 'string') u.email = '';
    if (typeof u.emailVerified !== 'boolean') u.emailVerified = false;
  });
  db.seq = db.seq || { user: 1, map: 1 };
  return db;
}

function writeJsonDb(db) {
  ensureJsonDb();
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function generateId() {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function toIsoDate(value) {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

function normalizePhone(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function normalizeNumber(value, fallback, min, max) {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numberValue));
}

function normalizeMapSettings(settings) {
  const dotLabelStyle = settings && settings.dotLabelStyle ? settings.dotLabelStyle : {};
  const baseMap = settings && settings.baseMap ? settings.baseMap : {};
  const amap = baseMap && baseMap.amap ? baseMap.amap : {};
  return {
    mapStyle: settings && settings.mapStyle === 'dot-label' ? 'dot-label' : 'classic-badge',
    canvasTheme: settings && settings.canvasTheme === 'dark' ? 'dark' : 'light',
    cityStyle:
      settings && ['standard', 'beijing', 'shanghai', 'mtr'].includes(settings.cityStyle)
        ? settings.cityStyle
        : 'standard',
    showLineNameLabels: !settings || settings.showLineNameLabels !== false,
    dotLabelStyle: {
      fontSize: normalizeNumber(dotLabelStyle.fontSize, DEFAULT_MAP_SETTINGS.dotLabelStyle.fontSize, 10, 24),
      fontWeight: normalizeNumber(dotLabelStyle.fontWeight, DEFAULT_MAP_SETTINGS.dotLabelStyle.fontWeight, 300, 900),
      color:
        typeof dotLabelStyle.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(dotLabelStyle.color)
          ? dotLabelStyle.color
          : DEFAULT_MAP_SETTINGS.dotLabelStyle.color
    },
    baseMap: {
      mode: baseMap.mode === 'amap' ? 'amap' : 'plain',
      amap: {
        center:
          Array.isArray(amap.center) &&
          amap.center.length === 2 &&
          amap.center.every(value => typeof value === 'number' && Number.isFinite(value))
            ? [amap.center[0], amap.center[1]]
            : DEFAULT_MAP_SETTINGS.baseMap.amap.center,
        zoom: normalizeNumber(amap.zoom, DEFAULT_MAP_SETTINGS.baseMap.amap.zoom, 3, 20),
        style: ['dark', 'grey', 'fresh'].includes(amap.style) ? amap.style : 'normal'
      }
    },
    cornerRadius: normalizeNumber(settings && settings.cornerRadius, DEFAULT_MAP_SETTINGS.cornerRadius, 0, 40)
  };
}

function sanitizeUser(user) {
  return {
    id: user.id,
    phone: user.phone || '',
    email: user.email || '',
    emailVerified: !!user.emailVerified,
    username: user.username,
    avatar: user.avatar || ''
  };
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    phone: row.phone || '',
    email: row.email || '',
    emailVerified: !!row.email_verified,
    username: row.username,
    passwordHash: row.password_hash,
    avatar: row.avatar || '',
    createdAt: toIsoDate(row.created_at)
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// 邮件 token 原值 → DB 存的 hash。token 本身从 emails 发出后我们手里不留明文。
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}
function generateEmailTokenRaw() {
  return crypto.randomBytes(32).toString('hex');
}

function rowToMap(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: row.name,
    lines: row.lines || [],
    stations: row.stations || [],
    sections: row.sections || [],
    mapSettings: normalizeMapSettings(row.map_settings),
    createdAt: toIsoDate(row.created_at),
    updatedAt: toIsoDate(row.updated_at)
  };
}

async function ensurePgSchema() {
  if (!pgPool) return;
  if (!pgReadyPromise) {
    pgReadyPromise = pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 邮箱迁移：老 schema 没有 email 字段，IF NOT EXISTS 保证可重入。
      -- email 在已设置时唯一；'' 视为未设置（用唯一 partial index 兼容）。
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
      -- phone 从必填变可选：新用户走纯邮箱注册，phone 留空字符串。
      ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
      ALTER TABLE users ALTER COLUMN phone SET DEFAULT '';
      -- 历史遗留：phone 早期是唯一主标识，老 CREATE TABLE 留下的 users_phone_key
      -- 唯一约束会让第二个 phone='' 的纯邮箱用户注册时撞唯一键。幂等清掉它，
      -- phone 的唯一性现在不再要求（邮箱才是主标识，见 users_email_unique_idx）。
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_key;
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
        ON users(LOWER(email)) WHERE email <> '';
      CREATE INDEX IF NOT EXISTS users_phone_idx ON users(phone) WHERE phone <> '';

      -- 邮件 token 表：用于 verify 和 reset 两种用途。
      -- token_hash 存 SHA256(raw_token)，原 token 只在邮件中出现；
      -- 即使数据库泄露也无法直接拿来重置别人密码。
      CREATE TABLE IF NOT EXISTS email_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS email_tokens_user_type_idx
        ON email_tokens(user_id, type, expires_at DESC);

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

      -- 速率限制相关：违规事件流水 + 当前生效封禁
      CREATE TABLE IF NOT EXISTS rate_violations (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS rate_violations_key_time_idx
        ON rate_violations(key, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS bans (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        reason TEXT NOT NULL,
        banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        unban_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'system'
      );
      CREATE INDEX IF NOT EXISTS bans_key_unban_idx ON bans(key, unban_at DESC);
    `);
  }
  await pgReadyPromise;
}

const storage = {
  async findUserByPhone(phone) {
    if (!phone) return null;
    if (pgPool) {
      await ensurePgSchema();
      const { rows } = await pgPool.query("SELECT * FROM users WHERE phone = $1 AND phone <> '' LIMIT 1", [phone]);
      return rowToUser(rows[0]);
    }
    const db = readJsonDb();
    return db.users.find(user => normalizePhone(user.phone) === phone && user.phone) || null;
  },

  async findUserByEmail(email) {
    const e = normalizeEmail(email);
    if (!e) return null;
    if (pgPool) {
      await ensurePgSchema();
      const { rows } = await pgPool.query("SELECT * FROM users WHERE LOWER(email) = $1 AND email <> '' LIMIT 1", [e]);
      return rowToUser(rows[0]);
    }
    const db = readJsonDb();
    return db.users.find(user => normalizeEmail(user.email) === e && user.email) || null;
  },

  async findUserById(userId) {
    if (pgPool) {
      await ensurePgSchema();
      const { rows } = await pgPool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
      return rowToUser(rows[0]);
    }
    const db = readJsonDb();
    return db.users.find(user => user.id === userId) || null;
  },

  async createUser({ phone = '', email = '', username, passwordHash, emailVerified = false }) {
    const now = new Date().toISOString();
    const normalizedEmail = normalizeEmail(email);
    if (pgPool) {
      await ensurePgSchema();
      const id = generateId();
      const { rows } = await pgPool.query(
        `INSERT INTO users (id, phone, email, email_verified, username, password_hash, avatar, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, '', $7)
         RETURNING *`,
        [id, phone, normalizedEmail, emailVerified, username, passwordHash, now]
      );
      return rowToUser(rows[0]);
    }

    const db = readJsonDb();
    const user = {
      id: String(db.seq.user++),
      phone,
      email: normalizedEmail,
      emailVerified,
      username,
      passwordHash,
      avatar: '',
      createdAt: now
    };
    db.users.push(user);
    writeJsonDb(db);
    return user;
  },

  async updateUser(userId, updates) {
    if (pgPool) {
      await ensurePgSchema();
      const current = await this.findUserById(userId);
      if (!current) return null;
      const next = {
        username: updates.username ?? current.username,
        avatar: updates.avatar ?? current.avatar,
        passwordHash: updates.passwordHash ?? current.passwordHash,
        email: updates.email !== undefined ? normalizeEmail(updates.email) : (current.email || ''),
        emailVerified: updates.emailVerified !== undefined ? !!updates.emailVerified : !!current.emailVerified
      };
      const { rows } = await pgPool.query(
        `UPDATE users
         SET username = $2, avatar = $3, password_hash = $4, email = $5, email_verified = $6
         WHERE id = $1
         RETURNING *`,
        [userId, next.username, next.avatar, next.passwordHash, next.email, next.emailVerified]
      );
      return rowToUser(rows[0]);
    }

    const db = readJsonDb();
    const user = db.users.find(item => item.id === userId);
    if (!user) return null;
    if (updates.email !== undefined) updates.email = normalizeEmail(updates.email);
    Object.assign(user, updates);
    writeJsonDb(db);
    return user;
  },

  // ── 邮件 token CRUD ────────────────────────────────────────────────────
  // 一个用户一类型最多保留 1 个有效 token：新建时先把同用户同类型的旧 token 失效
  // （used_at=now）—— 避免攻击者在重发后还能用上一次的旧链接。
  async createEmailToken(userId, type, ttlMs) {
    const raw = generateEmailTokenRaw();
    const tokenHash = hashToken(raw);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const id = generateId();
    try {
      if (pgPool) {
        await ensurePgSchema();
        await pgPool.query(
          'UPDATE email_tokens SET used_at = NOW() WHERE user_id = $1 AND type = $2 AND used_at IS NULL',
          [userId, type]
        );
        await pgPool.query(
          'INSERT INTO email_tokens (id, user_id, type, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
          [id, userId, type, tokenHash, expiresAt]
        );
        return raw;
      }
      const db = readJsonDb();
      db.email_tokens.forEach(t => {
        if (t.userId === userId && t.type === type && !t.usedAt) t.usedAt = now.toISOString();
      });
      db.email_tokens.push({ id, userId, type, tokenHash, expiresAt, usedAt: null, createdAt: now.toISOString() });
      writeJsonDb(db);
      return raw;
    } catch (e) {
      console.error('[email_token] create failed', e);
      throw e;
    }
  },

  async consumeEmailToken(rawToken, type) {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    const now = new Date().toISOString();
    if (pgPool) {
      await ensurePgSchema();
      const { rows } = await pgPool.query(
        'SELECT * FROM email_tokens WHERE token_hash = $1 AND type = $2 LIMIT 1',
        [tokenHash, type]
      );
      const row = rows[0];
      if (!row) return null;
      if (row.used_at) return null;
      if (toIsoDate(row.expires_at) < now) return null;
      await pgPool.query('UPDATE email_tokens SET used_at = NOW() WHERE id = $1', [row.id]);
      return { userId: String(row.user_id), type: row.type };
    }
    const db = readJsonDb();
    const token = db.email_tokens.find(t => t.tokenHash === tokenHash && t.type === type);
    if (!token) return null;
    if (token.usedAt) return null;
    if (token.expiresAt < now) return null;
    token.usedAt = now;
    writeJsonDb(db);
    return { userId: token.userId, type: token.type };
  },

  async cleanupExpiredEmailTokens() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    try {
      if (pgPool) {
        await ensurePgSchema();
        await pgPool.query('DELETE FROM email_tokens WHERE expires_at < $1', [cutoff]);
        return;
      }
      const db = readJsonDb();
      const before = db.email_tokens.length;
      db.email_tokens = db.email_tokens.filter(t => t.expiresAt >= cutoff);
      if (db.email_tokens.length !== before) writeJsonDb(db);
    } catch (e) {
      console.error('[email_token] cleanup failed', e);
    }
  },

  async listMaps(userId) {
    if (pgPool) {
      await ensurePgSchema();
      // 用 jsonb_array_length 在数据库侧直接拿到三个 array 字段的长度，
      // 比把整张 map 拉回应用层再 .length 便宜得多。
      const { rows } = await pgPool.query(
        `SELECT id, name, created_at, updated_at,
                jsonb_array_length(COALESCE(lines, '[]'::jsonb))    AS line_count,
                jsonb_array_length(COALESCE(stations, '[]'::jsonb)) AS station_count,
                jsonb_array_length(COALESCE(sections, '[]'::jsonb)) AS section_count
         FROM maps
         WHERE user_id = $1
         ORDER BY updated_at DESC`,
        [userId]
      );
      return rows.map(row => ({
        id: String(row.id),
        name: row.name,
        createdAt: toIsoDate(row.created_at),
        updatedAt: toIsoDate(row.updated_at),
        lineCount: Number(row.line_count) || 0,
        stationCount: Number(row.station_count) || 0,
        sectionCount: Number(row.section_count) || 0
      }));
    }

    const db = readJsonDb();
    return db.maps
      .filter(map => map.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(map => ({
        id: map.id,
        name: map.name,
        updatedAt: map.updatedAt,
        createdAt: map.createdAt,
        lineCount: Array.isArray(map.lines) ? map.lines.length : 0,
        stationCount: Array.isArray(map.stations) ? map.stations.length : 0,
        sectionCount: Array.isArray(map.sections) ? map.sections.length : 0
      }));
  },

  async getMap(userId, mapId) {
    if (pgPool) {
      await ensurePgSchema();
      const { rows } = await pgPool.query('SELECT * FROM maps WHERE id = $1 AND user_id = $2 LIMIT 1', [mapId, userId]);
      return rowToMap(rows[0]);
    }

    const db = readJsonDb();
    const map = db.maps.find(item => item.id === mapId && item.userId === userId);
    return map ? { ...map, mapSettings: normalizeMapSettings(map.mapSettings) } : null;
  },

  async createMap(userId, { name, lines, stations, sections, mapSettings }) {
    const now = new Date().toISOString();
    const normalizedMapSettings = normalizeMapSettings(mapSettings || DEFAULT_MAP_SETTINGS);
    const mapName = String(name).trim() || '未命名地图';

    if (pgPool) {
      await ensurePgSchema();
      const id = generateId();
      const { rows } = await pgPool.query(
        `INSERT INTO maps (id, user_id, name, lines, stations, sections, map_settings, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
         RETURNING id, name, created_at, updated_at`,
        [
          id,
          userId,
          mapName,
          JSON.stringify(lines),
          JSON.stringify(stations),
          JSON.stringify(sections),
          JSON.stringify(normalizedMapSettings),
          now,
          now
        ]
      );
      const row = rows[0];
      return { id: String(row.id), name: row.name, createdAt: toIsoDate(row.created_at), updatedAt: toIsoDate(row.updated_at) };
    }

    const db = readJsonDb();
    const map = {
      id: String(db.seq.map++),
      userId,
      name: mapName,
      lines,
      stations,
      sections,
      mapSettings: normalizedMapSettings,
      createdAt: now,
      updatedAt: now
    };
    db.maps.push(map);
    writeJsonDb(db);
    return { id: map.id, name: map.name, createdAt: now, updatedAt: now };
  },

  async updateMap(userId, mapId, updates) {
    if (pgPool) {
      await ensurePgSchema();
      const current = await this.getMap(userId, mapId);
      if (!current) return null;
      const next = {
        name: typeof updates.name === 'string' && updates.name.trim() ? updates.name.trim() : current.name,
        lines: Array.isArray(updates.lines) ? updates.lines : current.lines,
        stations: Array.isArray(updates.stations) ? updates.stations : current.stations,
        sections: Array.isArray(updates.sections) ? updates.sections : current.sections,
        mapSettings: updates.mapSettings ? normalizeMapSettings(updates.mapSettings) : current.mapSettings
      };
      const now = new Date().toISOString();
      const { rows } = await pgPool.query(
        `UPDATE maps
         SET name = $3,
             lines = $4::jsonb,
             stations = $5::jsonb,
             sections = $6::jsonb,
             map_settings = $7::jsonb,
             updated_at = $8
         WHERE id = $1 AND user_id = $2
         RETURNING id, name, created_at, updated_at`,
        [
          mapId,
          userId,
          next.name,
          JSON.stringify(next.lines),
          JSON.stringify(next.stations),
          JSON.stringify(next.sections),
          JSON.stringify(next.mapSettings),
          now
        ]
      );
      const row = rows[0];
      return row ? { id: String(row.id), name: row.name, createdAt: toIsoDate(row.created_at), updatedAt: toIsoDate(row.updated_at) } : null;
    }

    const db = readJsonDb();
    const map = db.maps.find(item => item.id === mapId && item.userId === userId);
    if (!map) return null;
    if (typeof updates.name === 'string' && updates.name.trim()) map.name = updates.name.trim();
    if (Array.isArray(updates.lines)) map.lines = updates.lines;
    if (Array.isArray(updates.stations)) map.stations = updates.stations;
    if (Array.isArray(updates.sections)) map.sections = updates.sections;
    if (updates.mapSettings) map.mapSettings = normalizeMapSettings(updates.mapSettings);
    map.updatedAt = new Date().toISOString();
    writeJsonDb(db);
    return { id: map.id, name: map.name, updatedAt: map.updatedAt, createdAt: map.createdAt };
  },

  async deleteMap(userId, mapId) {
    if (pgPool) {
      await ensurePgSchema();
      const result = await pgPool.query('DELETE FROM maps WHERE id = $1 AND user_id = $2', [mapId, userId]);
      return result.rowCount > 0;
    }

    const db = readJsonDb();
    const index = db.maps.findIndex(map => map.id === mapId && map.userId === userId);
    if (index < 0) return false;
    db.maps.splice(index, 1);
    writeJsonDb(db);
    return true;
  },

  // ── 限流违规事件 & 自动封禁 ────────────────────────────────────────────
  // 这些方法都 try/catch 包了一层，永远不让限流/记录失败影响业务请求。
  async recordViolation(scope, key) {
    if (!key) return;
    const id = generateId();
    const now = new Date().toISOString();
    try {
      if (pgPool) {
        await ensurePgSchema();
        await pgPool.query(
          'INSERT INTO rate_violations (id, scope, key, occurred_at) VALUES ($1, $2, $3, $4)',
          [id, scope, key, now]
        );
        return;
      }
      const db = readJsonDb();
      db.rate_violations.push({ id, scope, key, occurredAt: now });
      writeJsonDb(db);
    } catch (e) {
      console.error('[rate] recordViolation failed', e);
    }
  },

  async countRecentViolations(key, windowMs) {
    if (!key) return 0;
    const since = new Date(Date.now() - windowMs).toISOString();
    try {
      if (pgPool) {
        await ensurePgSchema();
        const { rows } = await pgPool.query(
          'SELECT COUNT(*)::int AS n FROM rate_violations WHERE key = $1 AND occurred_at >= $2',
          [key, since]
        );
        return rows[0]?.n || 0;
      }
      const db = readJsonDb();
      return db.rate_violations.filter(v => v.key === key && v.occurredAt >= since).length;
    } catch (e) {
      console.error('[rate] countRecentViolations failed', e);
      return 0;
    }
  },

  async findActiveBan(key) {
    if (!key) return null;
    const now = new Date().toISOString();
    try {
      if (pgPool) {
        await ensurePgSchema();
        const { rows } = await pgPool.query(
          'SELECT * FROM bans WHERE key = $1 AND unban_at > $2 ORDER BY unban_at DESC LIMIT 1',
          [key, now]
        );
        const row = rows[0];
        return row
          ? { id: String(row.id), key: row.key, reason: row.reason, bannedAt: toIsoDate(row.banned_at), unbanAt: toIsoDate(row.unban_at) }
          : null;
      }
      const db = readJsonDb();
      const ban = db.bans
        .filter(b => b.key === key && b.unbanAt > now)
        .sort((a, b) => (a.unbanAt < b.unbanAt ? 1 : -1))[0];
      return ban || null;
    } catch (e) {
      console.error('[rate] findActiveBan failed', e);
      return null;
    }
  },

  async createBan(key, reason, durationMs) {
    if (!key) return null;
    const id = generateId();
    const now = Date.now();
    const bannedAt = new Date(now).toISOString();
    const unbanAt = new Date(now + durationMs).toISOString();
    try {
      if (pgPool) {
        await ensurePgSchema();
        await pgPool.query(
          'INSERT INTO bans (id, key, reason, banned_at, unban_at, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, key, reason, bannedAt, unbanAt, 'system']
        );
      } else {
        const db = readJsonDb();
        db.bans.push({ id, key, reason, bannedAt, unbanAt, createdBy: 'system' });
        writeJsonDb(db);
      }
      console.warn(`[rate] BAN created key=${key} reason=${reason} unban=${unbanAt}`);
      return { id, key, reason, bannedAt, unbanAt };
    } catch (e) {
      console.error('[rate] createBan failed', e);
      return null;
    }
  },

  async cleanupExpired() {
    const violationCutoff = new Date(Date.now() - VIOLATION_KEEP_MS).toISOString();
    const now = new Date().toISOString();
    try {
      if (pgPool) {
        await ensurePgSchema();
        await pgPool.query('DELETE FROM rate_violations WHERE occurred_at < $1', [violationCutoff]);
        await pgPool.query('DELETE FROM bans WHERE unban_at < $1', [now]);
        return;
      }
      const db = readJsonDb();
      const beforeV = db.rate_violations.length;
      const beforeB = db.bans.length;
      db.rate_violations = db.rate_violations.filter(v => v.occurredAt >= violationCutoff);
      db.bans = db.bans.filter(b => b.unbanAt >= now);
      if (db.rate_violations.length !== beforeV || db.bans.length !== beforeB) {
        writeJsonDb(db);
      }
    } catch (e) {
      console.error('[rate] cleanupExpired failed', e);
    }
  }
};

function auth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // 兼容 purpose 缺省的旧 token；新签出的都有 purpose='login'。
    // 升级专用 token（purpose='upgrade'）禁止访问业务接口。
    if (payload.purpose && payload.purpose !== 'login') {
      return res.status(401).json({ message: '当前会话不允许访问该资源' });
    }
    req.userId = payload.userId;
    next();
  } catch (_e) {
    return res.status(401).json({ message: '登录已过期' });
  }
}

// 升级专用：只用在 /api/auth/upgrade-email 上，必须是 purpose='upgrade' 的短期 token
function authUpgrade(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: '缺少升级令牌' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose !== 'upgrade') {
      return res.status(401).json({ message: '令牌用途不匹配' });
    }
    req.userId = payload.userId;
    next();
  } catch (_e) {
    return res.status(401).json({ message: '升级令牌已过期，请重新登录' });
  }
}

// ── 输入校验工具 ──────────────────────────────────────────────────────────
// 长度上限保护两件事：1) bcrypt 72 字节静默截断 → 我们直接拒绝 >128；
// 2) JSON body 内逻辑字段不应单独超过 1KB，避免下游 storage 被滥用。
const validatePhone = (raw) => {
  const v = normalizePhone(raw);
  if (!/^\d{6,15}$/.test(v)) return { ok: false, message: '手机号格式无效' };
  return { ok: true, value: v };
};
const validatePassword = (raw) => {
  const v = String(raw || '');
  if (v.length < 6) return { ok: false, message: '密码至少 6 位' };
  if (v.length > 128) return { ok: false, message: '密码过长（≤128）' };
  return { ok: true, value: v };
};
const validateUsername = (raw) => {
  const v = String(raw || '').trim();
  if (!v) return { ok: false, message: '昵称必填' };
  if ([...v].length > 32) return { ok: false, message: '昵称过长（≤32）' };
  return { ok: true, value: v };
};
// 邮箱：简单 RFC 兼容正则，过滤明显畸形；最终以发邮件能不能到为准。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validateEmail = (raw) => {
  const v = normalizeEmail(raw);
  if (!v) return { ok: false, message: '邮箱必填' };
  if (v.length > 254) return { ok: false, message: '邮箱过长' };
  if (!EMAIL_RE.test(v)) return { ok: false, message: '邮箱格式无效' };
  return { ok: true, value: v };
};

// 发主登录 token（30d）和"升级专用"短期 token（15m）分开签：
// 升级 token 只能调 /api/auth/upgrade-email，不能拿来访问 /api/maps 等业务接口。
function signLoginToken(userId) {
  return jwt.sign({ userId, purpose: 'login' }, JWT_SECRET, { expiresIn: '30d' });
}
function signUpgradeToken(userId) {
  return jwt.sign({ userId, purpose: 'upgrade' }, JWT_SECRET, { expiresIn: UPGRADE_TOKEN_TTL });
}

// ── 拉黑检查 + 违规计数升级到 BAN ─────────────────────────────────────────
const clientKey = (req) => req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

async function banCheck(req, res, next) {
  const key = clientKey(req);
  const ban = await storage.findActiveBan(key);
  if (ban) {
    const retryAfterSec = Math.max(1, Math.ceil((new Date(ban.unbanAt).getTime() - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(403).json({
      message: '请求过于频繁，已被临时限制访问，请稍后再试',
      unbanAt: ban.unbanAt
    });
  }
  next();
}

// 记录一次违规事件；若 24h 内累计达 BAN_THRESHOLD，自动开 24h 封禁。
async function escalateViolation(scope, key, req) {
  await storage.recordViolation(scope, key);
  const count = await storage.countRecentViolations(key, VIOLATION_WINDOW_MS);
  if (count >= BAN_THRESHOLD) {
    const existing = await storage.findActiveBan(key);
    if (!existing) {
      await storage.createBan(key, `${scope}_threshold_${count}_in_24h`, BAN_DURATION_MS);
      console.warn(`[rate] auto-ban key=${key} after ${count} violations (reqId=${req?.requestId || '-'})`);
    }
  }
}

// ── 速率限制器 ────────────────────────────────────────────────────────────
// 命中 429 后通过 handler 回调记录一次 'rate_429' violation 并尝试升级到封禁。
const buildLimiter = (options) => rateLimit({
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // express-rate-limit v7 在 trust proxy 设置不当时会报错。我们已 app.set('trust proxy', 1)
  validate: { trustProxy: false }, // 已自行处理，关掉它自己的 X-Forwarded-For 警告
  handler: async (req, res /* next, options */) => {
    const key = clientKey(req);
    // 不要 await，让响应尽快回出去；记录失败也只是丢一条日志
    escalateViolation('rate_429', key, req).catch(() => {});
    res.status(429).json({
      message: '请求过于频繁，请稍后重试',
      requestId: req.requestId
    });
  },
  ...options
});

// /api/auth/login + /register + /forgot-password：10 次 / 15 分钟 / IP
const authLimiter = buildLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
// PUT /api/me：30 次 / 15 分钟 / 用户（按 userId 限，未登录场景退化到 IP）
const meLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.userId || clientKey(req)
});
// AMap 静态地图代理：60 次 / 15 分钟 / 用户。保 amap 配额。
const amapLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.userId || clientKey(req)
});
// 全局兜底：每个 IP 每 5 分钟最多 300 次。
const globalLimiter = buildLimiter({ windowMs: 5 * 60 * 1000, max: 300 });
// 跨设备验证轮询：前端每 5 秒查一次"我这个会话验证好了没"，所以 1 分钟里有上限 12 次正常请求。
// 设 60/min/IP 给点裕量；触发限流照样记 violation。
const pollLimiter = buildLimiter({ windowMs: 60 * 1000, max: 60 });
// AI 接口：每用户 30 次 / 15 分钟。超出走 429 触发自动封禁累计。
// 单次 prompt 后端会强制截到合理长度，所以这里只控频次不控字符。
const aiLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.userId || clientKey(req)
});

// 顺序：requestId → 拉黑检查 → 全局兜底限流 → 业务路由
app.use(banCheck);
app.use(globalLimiter);

// 每 30 分钟跑一次清理（删过期 ban + 7 天前的 violation）
setInterval(() => {
  storage.cleanupExpired().catch(() => {});
  storage.cleanupExpiredEmailTokens().catch(() => {});
}, 30 * 60 * 1000).unref();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, storage: pgPool ? 'postgres' : 'json' });
});

app.get('/api/amap/static-map', auth, amapLimiter, asyncHandler(async (req, res) => {
  if (!AMAP_WEB_SERVICE_KEY) {
    return res.status(400).json({ message: '高德静态地图服务未配置 AMAP_WEB_SERVICE_KEY' });
  }

  const lng = Number(req.query.lng);
  const lat = Number(req.query.lat);
  const zoom = Math.max(3, Math.min(20, Number(req.query.zoom) || DEFAULT_MAP_SETTINGS.baseMap.amap.zoom));
  const width = Math.max(320, Math.min(1280, Math.round(Number(req.query.width) || 1280)));
  const height = Math.max(240, Math.min(1280, Math.round(Number(req.query.height) || 720)));
  const style = ['dark', 'grey', 'fresh'].includes(req.query.style) ? String(req.query.style) : 'normal';

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return res.status(400).json({ message: '高德静态地图中心点无效' });
  }

  const styleMap = {
    normal: 'normal',
    dark: 'dark',
    grey: 'grey',
    fresh: 'fresh'
  };
  const query = new URLSearchParams({
    location: `${lng},${lat}`,
    zoom: String(Math.round(zoom)),
    size: `${width}*${height}`,
    scale: '1',
    key: AMAP_WEB_SERVICE_KEY
  });
  if (styleMap[style]) query.set('style', styleMap[style]);

  const upstream = await fetch(`https://restapi.amap.com/v3/staticmap?${query.toString()}`);
  const contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok || !contentType.startsWith('image/')) {
    const text = await upstream.text().catch(() => '');
    console.error('AMap static map failed:', upstream.status, text.slice(0, 300));
    return res.status(502).json({ message: '高德静态地图获取失败，请检查 Web Service Key 和配额' });
  }

  const arrayBuffer = await upstream.arrayBuffer();
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(arrayBuffer));
}));

// 注册：新用户走纯邮箱路径。注册成功后并不直接 issue JWT —— 必须先点验证邮件链接。
// 返回 { status: 'verify_sent', email } 让前端展示"请前往邮箱完成验证"。
app.post('/api/auth/register', authLimiter, asyncHandler(async (req, res) => {
  const emailCheck = validateEmail(req.body?.email);
  if (!emailCheck.ok) return res.status(400).json({ message: emailCheck.message });
  const passwordCheck = validatePassword(req.body?.password);
  if (!passwordCheck.ok) return res.status(400).json({ message: passwordCheck.message });
  const usernameCheck = validateUsername(req.body?.username);
  if (!usernameCheck.ok) return res.status(400).json({ message: usernameCheck.message });

  const existing = await storage.findUserByEmail(emailCheck.value);
  if (existing) {
    return res.status(409).json({ message: '该邮箱已注册，如已忘记密码可使用"忘记密码"功能' });
  }
  const passwordHash = await bcrypt.hash(passwordCheck.value, 10);
  const user = await storage.createUser({
    email: emailCheck.value,
    username: usernameCheck.value,
    passwordHash,
    emailVerified: false
  });
  const raw = await storage.createEmailToken(user.id, 'verify', EMAIL_TOKEN_TTL_MS);
  await sendVerificationEmail({ to: emailCheck.value, username: usernameCheck.value, token: raw });
  // 跨设备轮询令牌：注册端本来停在"等待验证"状态，
  // 用这个 pollKey 静默 polling /api/auth/check-pending，
  // 一旦用户在另一设备上点验证链接，下次 poll 就回主 JWT。
  const pollKey = await storage.createEmailToken(user.id, 'poll', EMAIL_TOKEN_TTL_MS);
  res.json({ status: 'verify_sent', email: emailCheck.value, pollKey });
}));

// 登录：支持 account = 邮箱 或 (legacy) 手机号 两种格式。
// 三种结果状态：
//   - { status: 'ok', token, user }                    正常登录
//   - { status: 'verify_required', email }             已注册但未验证 → 前端提示去邮箱
//   - { status: 'upgrade_required', upgradeToken }     legacy 手机号账号 → 必须先补邮箱
app.post('/api/auth/login', authLimiter, asyncHandler(async (req, res) => {
  const rawAccount = String(req.body?.account || req.body?.email || req.body?.phone || '').trim();
  const password = String(req.body?.password || '');
  if (!rawAccount || !password) {
    await escalateViolation('login_fail', clientKey(req), req);
    return res.status(400).json({ message: '请输入账号和密码' });
  }
  if (password.length > 256) {
    await escalateViolation('login_fail', clientKey(req), req);
    return res.status(400).json({ message: '密码过长' });
  }
  // 先按邮箱查；查不到再按手机号兜底，兼容老账号。
  let user = null;
  if (rawAccount.includes('@')) {
    user = await storage.findUserByEmail(rawAccount);
  } else if (/^\d{6,15}$/.test(normalizePhone(rawAccount))) {
    user = await storage.findUserByPhone(normalizePhone(rawAccount));
  }
  if (!user || !user.passwordHash) {
    await escalateViolation('login_fail', clientKey(req), req);
    return res.status(401).json({ message: '账号或密码错误' });
  }
  const trimmedPassword = password.trim();
  const ok =
    (await bcrypt.compare(password, user.passwordHash)) ||
    (trimmedPassword !== password && (await bcrypt.compare(trimmedPassword, user.passwordHash)));
  if (!ok) {
    await escalateViolation('login_fail', clientKey(req), req);
    return res.status(401).json({ message: '账号或密码错误' });
  }

  // 强制升级路径：legacy 用户没绑邮箱 → 发短期升级 token，不直接放行
  if (!user.email) {
    const upgradeToken = signUpgradeToken(user.id);
    return res.json({
      status: 'upgrade_required',
      upgradeToken,
      hint: '为提升账户安全，请补充邮箱并完成验证'
    });
  }
  // 已有邮箱但未验证 → 提示用户去邮箱（前端可以加重发按钮）
  if (!user.emailVerified) {
    // 同样发一个 pollKey，让等待中的设备能跨设备自动登录
    const pollKey = await storage.createEmailToken(user.id, 'poll', EMAIL_TOKEN_TTL_MS);
    return res.json({
      status: 'verify_required',
      email: user.email,
      pollKey
    });
  }
  // 正常登录
  res.json({ status: 'ok', token: signLoginToken(user.id), user: sanitizeUser(user) });
}));

// 升级邮箱：用 login 返回的 upgradeToken 来调，绑定 + 发验证邮件
app.post('/api/auth/upgrade-email', authLimiter, authUpgrade, asyncHandler(async (req, res) => {
  const emailCheck = validateEmail(req.body?.email);
  if (!emailCheck.ok) return res.status(400).json({ message: emailCheck.message });
  const user = await storage.findUserById(req.userId);
  if (!user) return res.status(404).json({ message: '用户不存在' });

  // 邮箱被别的账号占用就直接拒绝（不能两个用户绑同一邮箱）
  const occupying = await storage.findUserByEmail(emailCheck.value);
  if (occupying && occupying.id !== user.id) {
    return res.status(409).json({ message: '该邮箱已被其他账号绑定' });
  }
  await storage.updateUser(user.id, { email: emailCheck.value, emailVerified: false });
  const raw = await storage.createEmailToken(user.id, 'verify', EMAIL_TOKEN_TTL_MS);
  await sendVerificationEmail({ to: emailCheck.value, username: user.username, token: raw });
  // 升级路径同样发 pollKey：legacy 用户在电脑上补完邮箱后，可以在手机点链接，电脑端自动进系统
  const pollKey = await storage.createEmailToken(user.id, 'poll', EMAIL_TOKEN_TTL_MS);
  res.json({ status: 'verify_sent', email: emailCheck.value, pollKey });
}));

// 验证邮箱：消费一次性 token，标记 verified，发主登录 JWT
app.post('/api/auth/verify-email', authLimiter, asyncHandler(async (req, res) => {
  const rawToken = String(req.body?.token || '').trim();
  if (!rawToken) return res.status(400).json({ message: '缺少验证令牌' });
  const consumed = await storage.consumeEmailToken(rawToken, 'verify');
  if (!consumed) {
    await escalateViolation('login_fail', clientKey(req), req);
    return res.status(400).json({ message: '验证链接无效或已过期，请重新获取' });
  }
  const user = await storage.findUserById(consumed.userId);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  await storage.updateUser(user.id, { emailVerified: true });
  const updated = await storage.findUserById(user.id);
  res.json({ status: 'ok', token: signLoginToken(user.id), user: sanitizeUser(updated) });
}));

// 重发验证邮件：用 email 查用户。无论是否存在都返回 200，避免枚举攻击。
app.post('/api/auth/resend-verification', authLimiter, asyncHandler(async (req, res) => {
  const emailCheck = validateEmail(req.body?.email);
  if (!emailCheck.ok) return res.status(400).json({ message: emailCheck.message });
  const user = await storage.findUserByEmail(emailCheck.value);
  if (user && !user.emailVerified) {
    const raw = await storage.createEmailToken(user.id, 'verify', EMAIL_TOKEN_TTL_MS);
    await sendVerificationEmail({ to: emailCheck.value, username: user.username, token: raw });
  }
  // 不暴露用户是否存在 / 是否已验证
  res.json({ status: 'verify_sent', email: emailCheck.value });
}));

// 跨设备轮询：等待验证的设备每 5 秒静默查一次"我那台用户的邮箱验证好了没"。
// 三种状态：
//   pending  → 还没验证，继续轮
//   ok       → 已验证，连同主 JWT 一起回；前端拿到就当登录成功
//   expired  → pollKey 已过期 / 已消费 / 找不到，前端应停止轮询并提示重新登录
app.post('/api/auth/check-pending', pollLimiter, asyncHandler(async (req, res) => {
  const rawPollKey = String(req.body?.pollKey || '').trim();
  if (!rawPollKey) return res.status(400).json({ message: '缺少 pollKey' });
  // 先 peek 这个 poll token 是否还有效，不要消费它（用户可能要继续 poll）
  const tokenHash = hashToken(rawPollKey);
  const now = new Date().toISOString();

  let tokenRow = null;
  if (pgPool) {
    await ensurePgSchema();
    const { rows } = await pgPool.query(
      "SELECT * FROM email_tokens WHERE token_hash = $1 AND type = 'poll' LIMIT 1",
      [tokenHash]
    );
    tokenRow = rows[0];
  } else {
    const db = readJsonDb();
    tokenRow = db.email_tokens.find(t => t.tokenHash === tokenHash && t.type === 'poll');
  }
  if (!tokenRow) return res.json({ status: 'expired' });
  const usedAt = tokenRow.used_at || tokenRow.usedAt;
  const expiresAt = tokenRow.expires_at ? toIsoDate(tokenRow.expires_at) : tokenRow.expiresAt;
  if (usedAt) return res.json({ status: 'expired' });
  if (expiresAt < now) return res.json({ status: 'expired' });

  const userId = tokenRow.user_id ? String(tokenRow.user_id) : tokenRow.userId;
  const user = await storage.findUserById(userId);
  if (!user) return res.json({ status: 'expired' });
  if (!user.emailVerified) return res.json({ status: 'pending' });

  // 已验证：消费 poll token（一次性签出主 JWT 后就失效），回给前端
  await storage.consumeEmailToken(rawPollKey, 'poll');
  res.json({ status: 'ok', token: signLoginToken(user.id), user: sanitizeUser(user) });
}));

// 忘记密码：发 reset 邮件。无论邮箱是否存在，统一回 200。
app.post('/api/auth/forgot-password', authLimiter, asyncHandler(async (req, res) => {
  const emailCheck = validateEmail(req.body?.email);
  if (!emailCheck.ok) return res.status(400).json({ message: emailCheck.message });
  const user = await storage.findUserByEmail(emailCheck.value);
  if (user && user.emailVerified) {
    const raw = await storage.createEmailToken(user.id, 'reset', EMAIL_TOKEN_TTL_MS);
    await sendPasswordResetEmail({ to: emailCheck.value, username: user.username, token: raw });
  }
  // 即使不存在或未验证也回成功，避免枚举；前端文案说"若邮箱已注册则邮件已发送"
  res.json({ status: 'reset_sent', email: emailCheck.value });
}));

// 重置密码：消费 reset token，更新密码，回登录 JWT
app.post('/api/auth/reset-password', authLimiter, asyncHandler(async (req, res) => {
  const rawToken = String(req.body?.token || '').trim();
  if (!rawToken) return res.status(400).json({ message: '缺少重置令牌' });
  const passwordCheck = validatePassword(req.body?.password);
  if (!passwordCheck.ok) return res.status(400).json({ message: passwordCheck.message });
  const consumed = await storage.consumeEmailToken(rawToken, 'reset');
  if (!consumed) {
    await escalateViolation('login_fail', clientKey(req), req);
    return res.status(400).json({ message: '重置链接无效或已过期，请重新申请' });
  }
  const passwordHash = await bcrypt.hash(passwordCheck.value, 10);
  await storage.updateUser(consumed.userId, { passwordHash });
  const updated = await storage.findUserById(consumed.userId);
  res.json({ status: 'ok', token: signLoginToken(consumed.userId), user: sanitizeUser(updated) });
}));

app.get('/api/me', auth, asyncHandler(async (req, res) => {
  const user = await storage.findUserById(req.userId);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  res.json({ user: sanitizeUser(user) });
}));

app.put('/api/me', auth, meLimiter, asyncHandler(async (req, res) => {
  const { username, avatar, password } = req.body || {};
  const user = await storage.findUserById(req.userId);
  if (!user) return res.status(404).json({ message: '用户不存在' });

  const updates = {};
  if (typeof username === 'string' && username.trim()) {
    const u = validateUsername(username);
    if (!u.ok) return res.status(400).json({ message: u.message });
    updates.username = u.value;
  }
  if (typeof avatar === 'string') {
    if (avatar.length > MAX_AVATAR_LENGTH) {
      return res.status(413).json({ message: '头像过大，请使用 150KB 以内的图片' });
    }
    updates.avatar = avatar;
  }
  if (typeof password === 'string' && password.trim()) {
    const p = validatePassword(password.trim());
    if (!p.ok) return res.status(400).json({ message: p.message });
    updates.passwordHash = await bcrypt.hash(p.value, 10);
  }

  const updatedUser = await storage.updateUser(req.userId, updates);
  res.json({ user: sanitizeUser(updatedUser) });
}));

// ── AI 接入（Phase A）─────────────────────────────────────────────────────
// 站名中 → 英 翻译：单次 chat 调用，限制字数防滥用。
// 没配 DEEPSEEK_API_KEY 时直接 503，让前端拿到明确提示。
app.post('/api/ai/translate-station', auth, aiLimiter, asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ message: '请提供要翻译的站名' });
  if (name.length > 64) return res.status(400).json({ message: '站名过长' });
  if (!ai.hasKey()) {
    return res.status(503).json({ message: 'AI 功能未配置（管理员未设置 DEEPSEEK_API_KEY）' });
  }

  // System prompt 锁死输出格式；约束 LLM 只回拼音 / 英文，不带任何额外文字。
  const result = await ai.chatCompletion({
    messages: [
      {
        role: 'system',
        content:
          '你是一个专业的轨道交通站名翻译。\n' +
          '规则：\n' +
          '1. 把用户给的中文站名翻译为常见的英文 / 拼音写法（用于地铁线路图）。\n' +
          '2. 通用规则：地名用拼音首字母大写（如 "北京西站" → "Beijing West Railway Station"）；\n' +
          '   含通用词的（机场、火车站、公园、广场、医院等）用英文意译 + 拼音地名。\n' +
          '3. 只输出最终英文 / 拼音，不要任何解释、引号、标点。\n' +
          '4. 严格控制在一行内，60 字符以内。'
      },
      { role: 'user', content: name }
    ],
    temperature: 0.2,
    maxTokens: 64
  });

  if (!result.ok) {
    return res.status(502).json({ message: `翻译失败（${result.reason}），请稍后重试` });
  }
  const choice = result.data?.choices?.[0]?.message?.content || '';
  // 防御性裁剪：模型偶尔会回带引号 / 多行的输出
  const english = String(choice)
    .split('\n')[0]
    .replace(/^["'""]+|["'""]+$/g, '')
    .trim()
    .slice(0, 80);
  if (!english) {
    return res.status(502).json({ message: '翻译返回为空，请重试' });
  }
  res.json({ name, english });
}));

// ── AI Phase B: 自然语言编辑 ─────────────────────────────────────────────
// 思路：用户用中文描述意图 → DeepSeek tool calling 把它拆成一组结构化操作
// → 后端做必要校验（id 存在、颜色合法、长度限制）→ 前端直接 apply（用现有 mutation 路径，
// 走 pushHistory 拿到统一 undo）。本路由本身不修改地图持久化，只翻译意图。
const AI_EDIT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_line',
      description: '创建一条新线路；stationIds 必须按线路顺序排列，至少 2 个；所有 id 必须是当前地图中已存在的站点。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '线路名，如"2号线"' },
          color: { type: 'string', description: '6 位十六进制颜色，如 #ffaa00' },
          stationIds: { type: 'array', items: { type: 'string' }, description: '站点 id 顺序数组' }
        },
        required: ['name', 'color', 'stationIds']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_line_via_extension',
      description: '新建一条线路，以一个已存在的站点为起点（锚点 / 换乘站），然后追加若干全新站点。锚点之外的站点会沿"远离 directionAwayFromStationId"的方向等距外推；不传则前端会在锚点所在的其他线路上找邻站作为方向参照，否则默认向 +x 方向。适合"新建 X 线，从 Y 站（与 Z 线换乘）出发，途经 A、B、C..."这类场景。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '新线路名' },
          color: { type: 'string', description: '6 位十六进制颜色' },
          anchorStationId: { type: 'string', description: '已存在的锚点站 id，会作为新线路的第一站，通常用于换乘' },
          newStationNames: {
            type: 'array',
            items: { type: 'string' },
            description: '要新建的站点名列表，按线路顺序、紧接锚点之后排列。最少 1 个，建议不超过 20 个。'
          },
          directionAwayFromStationId: {
            type: 'string',
            description: '可选：已存在的站点 id。新线路会从锚点向"远离此站"的方向延伸（用作方向参照点）。不传则前端自动找。'
          }
        },
        required: ['name', 'color', 'anchorStationId', 'newStationNames']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recolor_line',
      description: '修改某条线路的颜色',
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'string' },
          color: { type: 'string', description: '6 位十六进制' }
        },
        required: ['lineId', 'color']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rename_line',
      description: '重命名某条线路',
      parameters: {
        type: 'object',
        properties: { lineId: { type: 'string' }, name: { type: 'string' } },
        required: ['lineId', 'name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_line',
      description: '删除某条线路（站点保留，只移除线路 + 经过的区间）',
      parameters: {
        type: 'object',
        properties: { lineId: { type: 'string' } },
        required: ['lineId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'attach_station_to_line',
      description: '把已存在的站点接到某条线路的端点（开头或末尾）',
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'string' },
          stationId: { type: 'string' },
          position: { type: 'string', enum: ['start', 'end'] }
        },
        required: ['lineId', 'stationId', 'position']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_station_between',
      description: '在某条线路上、两个相邻站点之间插入一个或多个新站点。多个站点会沿 after → before 方向等距分布。',
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'string' },
          afterStationId: { type: 'string', description: '插入位置前一站的 id' },
          beforeStationId: { type: 'string', description: '插入位置后一站的 id' },
          names: {
            type: 'array',
            items: { type: 'string' },
            description: '要插入的新站点名字列表，按从 after 到 before 的顺序。最少 1 个，建议不超过 10 个。'
          }
        },
        required: ['lineId', 'afterStationId', 'beforeStationId', 'names']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_station_at_line_end',
      description: '在线路的端点（start = 起点之前 / end = 终点之后）新建一个或多个全新站点并自动连上区间。多个站点会沿线路延伸方向、等距外推。线路必须至少已有 2 个站点。',
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'string' },
          position: { type: 'string', enum: ['start', 'end'], description: 'start = 接到起点之前，end = 接到终点之后' },
          names: {
            type: 'array',
            items: { type: 'string' },
            description: '要追加的新站点名字列表，按从端点向外的顺序。最少 1 个，建议不超过 10 个。'
          }
        },
        required: ['lineId', 'position', 'names']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rename_station',
      description: '重命名站点',
      parameters: {
        type: 'object',
        properties: { stationId: { type: 'string' }, name: { type: 'string' } },
        required: ['stationId', 'name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_station',
      description: '删除站点（会从所有经过它的线路中移除）',
      parameters: {
        type: 'object',
        properties: { stationId: { type: 'string' } },
        required: ['stationId']
      }
    }
  }
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// 后端做防御性校验：LLM 偶尔幻觉出不存在的 id 或离谱的颜色，必须在我们这一层挡掉。
function validateAIOperation(op, lineIds, stationIds) {
  const inLines = (id) => lineIds.has(id);
  const inStations = (id) => stationIds.has(id);
  const checkName = (n) => typeof n === 'string' && n.trim().length > 0 && [...n].length <= 32;
  const checkColor = (c) => typeof c === 'string' && HEX_COLOR_RE.test(c);
  switch (op.type) {
    case 'create_line':
      if (!checkName(op.name) || !checkColor(op.color)) return false;
      if (!Array.isArray(op.stationIds) || op.stationIds.length < 2) return false;
      return op.stationIds.every(inStations);
    case 'create_line_via_extension': {
      if (!checkName(op.name) || !checkColor(op.color)) return false;
      if (!inStations(op.anchorStationId)) return false;
      if (!Array.isArray(op.newStationNames) || op.newStationNames.length < 1 || op.newStationNames.length > 30) return false;
      if (!op.newStationNames.every(checkName)) return false;
      // directionAwayFromStationId 是可选；如果给了，必须存在
      if (op.directionAwayFromStationId !== undefined && op.directionAwayFromStationId !== null) {
        if (!inStations(op.directionAwayFromStationId)) return false;
        if (op.directionAwayFromStationId === op.anchorStationId) return false;
      }
      return true;
    }
    case 'recolor_line':
      return inLines(op.lineId) && checkColor(op.color);
    case 'rename_line':
      return inLines(op.lineId) && checkName(op.name);
    case 'delete_line':
      return inLines(op.lineId);
    case 'attach_station_to_line':
      return inLines(op.lineId) && inStations(op.stationId) && ['start', 'end'].includes(op.position);
    case 'create_station_between': {
      if (!inLines(op.lineId) || !inStations(op.afterStationId) || !inStations(op.beforeStationId)) return false;
      if (!Array.isArray(op.names) || op.names.length < 1 || op.names.length > 20) return false;
      return op.names.every(checkName);
    }
    case 'create_station_at_line_end': {
      if (!inLines(op.lineId) || !['start', 'end'].includes(op.position)) return false;
      if (!Array.isArray(op.names) || op.names.length < 1 || op.names.length > 20) return false;
      return op.names.every(checkName);
    }
    case 'rename_station':
      return inStations(op.stationId) && checkName(op.name);
    case 'delete_station':
      return inStations(op.stationId);
    default:
      return false;
  }
}

const AI_EDIT_SYSTEM_PROMPT =
  '你是一个地铁线路图设计助手。\n' +
  '规则：\n' +
  '1. 用户用中文描述编辑意图，你把它翻译成对当前地图的具体工具调用。\n' +
  '2. 引用线路 / 站点必须用它们的 id（如 "abc123"），不要用名字。\n' +
  '3. 颜色必须是 6 位十六进制（如 "#ff0000"）。\n' +
  '4. 创建新线路时 stationIds 必须按线路顺序、全部是已存在的站点 id。\n' +
  '5. 区分"新建站点"和"已存在站点"：\n' +
  '   - 用户要"在线路终点之外加一个或多个新站点"（名字是新的）→ 用 create_station_at_line_end，names 传完整列表\n' +
  '   - 用户要"在 A、B 之间加一个或多个新站点"（名字是新的、A B 已存在）→ 用 create_station_between，names 传完整列表\n' +
  '   - 用户要"把已存在的 X 站接到线路尾巴"（X 已经在地图上）→ 用 attach_station_to_line\n' +
  '   - **用户要"新建一条线路，从 Y 站（已存在）出发，途经 A、B、C... 等新站点"** → 用 create_line_via_extension，anchorStationId = Y，newStationNames = [A, B, C, ...]。如果用户说"与 Z 线换乘"，Y 通常是 Z 线上的某个站；如果能从地图状态看出 Z 线上 Y 的邻站，可把那个邻站填进 directionAwayFromStationId 让新线路朝远离的方向延伸。\n' +
  '   - 不要用 create_line 去处理"新站点未存在"的情况 —— create_line 的 stationIds 必须全是已存在的 id。\n' +
  '6. **批量优先**：用户一次说要加 N 个站点，**必须用一次工具调用 + names 数组**，不要拆成 N 次单独调用。\n' +
  '7. 如果用户的请求无法用工具完成（比如线路只有 1 个站还要端点延伸 / 站点不存在），直接用中文解释为什么做不了，不要瞎调工具。\n' +
  '8. 一次可以连续调用多个不同工具（比如"改颜色 + 加站点"），按操作顺序排列。\n' +
  '9. 多轮对话：用户可以连续追问，比如"刚刚那条线再延伸 3 个站"。结合上下文 + 最新地图状态做判断；不确定就反问。';

// 共享的请求预处理：校验 messages + 组装 LLM payload + 收集 id 集合。
// 返回 { error, status } 表示校验失败；否则 { llmMessages, lineIds, stationIds }。
// /api/ai/edit（一次性）和 /api/ai/edit-stream（流式）共用。
function prepareAiEdit(req) {
  let history = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!history) {
    const single = String(req.body?.message || '').trim();
    if (!single) return { error: '请描述你想做的修改', status: 400 };
    history = [{ role: 'user', content: single }];
  }
  if (history.length === 0) return { error: '消息列表为空', status: 400 };
  if (history.length > 40) {
    return { error: '对话过长（>40 条），请点击"新建对话"重新开始', status: 400 };
  }
  for (const m of history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return { error: '消息格式无效：role 必须是 user 或 assistant', status: 400 };
    }
    if (typeof m.content !== 'string') return { error: '消息 content 必须是字符串', status: 400 };
    if (m.content.length > 2000) return { error: '单条消息过长（>2000 字）', status: 400 };
  }
  if (history[history.length - 1].role !== 'user') {
    return { error: '最后一条消息必须是用户消息', status: 400 };
  }
  if (!ai.hasKey()) {
    return { error: 'AI 功能未配置（管理员未设置 DEEPSEEK_API_KEY）', status: 503 };
  }

  const mapState = req.body?.mapState || {};
  const linesArr = Array.isArray(mapState.lines) ? mapState.lines : [];
  const stationsArr = Array.isArray(mapState.stations) ? mapState.stations : [];
  const lineIds = new Set(linesArr.map((l) => String(l.id)));
  const stationIds = new Set(stationsArr.map((s) => String(s.id)));

  const stateLines = linesArr
    .slice(0, 50)
    .map(
      (l) => `- {id: "${l.id}", name: "${l.name}", color: "${l.color}", stationIds: [${(l.stationIds || []).map((s) => `"${s}"`).join(', ')}]}`
    )
    .join('\n');
  const stateStations = stationsArr
    .slice(0, 200)
    .map((s) => `- {id: "${s.id}", name: "${s.name}"}`)
    .join('\n');

  const llmMessages = [
    { role: 'system', content: AI_EDIT_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `【当前地图状态（始终是最新的，先于任何对话历史）】\n` +
        `线路:\n${stateLines || '（无）'}\n\n` +
        `站点:\n${stateStations || '（无）'}`
    },
    { role: 'assistant', content: '收到当前地图状态。请告诉我你想做的修改。' },
    ...history.map((m) => ({ role: m.role, content: m.content }))
  ];

  return { llmMessages, lineIds, stationIds };
}

// 把 tool calls（可能来自一次性 message.tool_calls，也可能来自流式累加的 {name,arguments}）
// 解析 + 校验成 operations[]，非法的进 skipped。
function toolCallsToOperations(toolCalls, lineIds, stationIds) {
  const operations = [];
  const skipped = [];
  for (const tc of toolCalls) {
    // 一次性版本：{ type:'function', function:{name, arguments} }
    // 流式版本：    { name, arguments }
    const name = tc.function?.name ?? tc.name;
    const rawArgs = tc.function?.arguments ?? tc.arguments;
    if (!name) continue;
    let args;
    try {
      args = JSON.parse(rawArgs || '{}');
    } catch {
      skipped.push({ name, reason: 'invalid_json' });
      continue;
    }
    const op = { type: name, ...args };
    if (!validateAIOperation(op, lineIds, stationIds)) {
      skipped.push({ name, reason: 'validation_failed' });
      continue;
    }
    operations.push(op);
  }
  return { operations, skipped };
}

// 一次性（非流式）AI 编辑路由。保留给老前端 / curl 测试。
app.post('/api/ai/edit', auth, aiLimiter, asyncHandler(async (req, res) => {
  const prepared = prepareAiEdit(req);
  if (prepared.error) return res.status(prepared.status).json({ message: prepared.error });

  const result = await ai.chatCompletion({
    messages: prepared.llmMessages,
    tools: AI_EDIT_TOOLS,
    toolChoice: 'auto',
    temperature: 0.1,
    maxTokens: 800
  });
  if (!result.ok) {
    return res.status(502).json({ message: `AI 调用失败（${result.reason}），请稍后重试` });
  }
  const msg = result.data?.choices?.[0]?.message;
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  const explanation = (msg?.content || '').trim();
  const { operations, skipped } = toolCallsToOperations(toolCalls, prepared.lineIds, prepared.stationIds);
  res.json({ operations, explanation, skipped });
}));

// 流式 AI 编辑路由（SSE）。前端默认走这个，文字 token 实时吐，工具调用在流尾汇总成 operations。
// 事件格式（每条 data: 一个 JSON）：
//   { type: 'delta', text }                          文本增量
//   { type: 'done', operations, explanation, skipped } 流结束 + 解析结果
//   { type: 'error', message }                        出错
app.post('/api/ai/edit-stream', auth, aiLimiter, asyncHandler(async (req, res) => {
  const prepared = prepareAiEdit(req);
  if (prepared.error) return res.status(prepared.status).json({ message: prepared.error });

  // SSE headers。X-Accel-Buffering 关掉反向代理缓冲，保证 token 实时到达
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let fullText = '';
  const result = await ai.chatCompletionStream({
    messages: prepared.llmMessages,
    tools: AI_EDIT_TOOLS,
    toolChoice: 'auto',
    temperature: 0.1,
    maxTokens: 800,
    onDelta: (token) => {
      fullText += token;
      send({ type: 'delta', text: token });
    }
  });

  if (!result.ok) {
    send({ type: 'error', message: `AI 调用失败（${result.reason}），请稍后重试` });
    return res.end();
  }
  const { operations, skipped } = toolCallsToOperations(result.toolCalls, prepared.lineIds, prepared.stationIds);
  send({ type: 'done', operations, explanation: (result.content || fullText).trim(), skipped });
  res.end();
}));

app.get('/api/maps', auth, asyncHandler(async (req, res) => {
  const maps = await storage.listMaps(req.userId);
  res.json({ maps });
}));

app.get('/api/maps/:id', auth, asyncHandler(async (req, res) => {
  const map = await storage.getMap(req.userId, req.params.id);
  if (!map) return res.status(404).json({ message: '地图不存在' });
  res.json({ map: { ...map, mapSettings: normalizeMapSettings(map.mapSettings) } });
}));

app.post('/api/maps', auth, asyncHandler(async (req, res) => {
  const { name, lines, stations, sections, mapSettings } = req.body || {};
  if (!name || !Array.isArray(lines) || !Array.isArray(stations) || !Array.isArray(sections)) {
    return res.status(400).json({ message: '地图数据不完整' });
  }
  const map = await storage.createMap(req.userId, { name, lines, stations, sections, mapSettings });
  res.json({ map });
}));

app.put('/api/maps/:id', auth, asyncHandler(async (req, res) => {
  const { name, lines, stations, sections, mapSettings } = req.body || {};
  const map = await storage.updateMap(req.userId, req.params.id, { name, lines, stations, sections, mapSettings });
  if (!map) return res.status(404).json({ message: '地图不存在' });
  res.json({ map });
}));

app.delete('/api/maps/:id', auth, asyncHandler(async (req, res) => {
  const deleted = await storage.deleteMap(req.userId, req.params.id);
  if (!deleted) return res.status(404).json({ message: '地图不存在' });
  res.json({ ok: true });
}));

app.use((error, req, res, _next) => {
  // CORS 拒绝的 origin 走错误中间件，单独返回 403 + 明确信息（不算 500）
  if (error && /CORS/i.test(error.message || '')) {
    return res.status(403).json({ message: '来源不允许', requestId: req.requestId });
  }
  // 完整堆栈写日志，响应只透 requestId，方便用户提交工单时定位
  console.error(`[500] reqId=${req.requestId} ${req.method} ${req.originalUrl}`, error);
  res.status(500).json({
    message: '服务器错误，请稍后重试',
    requestId: req.requestId
  });
});

if (!pgPool) ensureJsonDb();
app.listen(PORT, () => {
  console.log(`Metro backend running at http://localhost:${PORT} (${pgPool ? 'postgres' : 'json'} storage)`);
});
