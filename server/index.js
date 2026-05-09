const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'metro_designer_change_me';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const DEFAULT_MAP_SETTINGS = {
  mapStyle: 'classic-badge',
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
  }
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

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '10mb' }));

const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function ensureJsonDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify({ users: [], maps: [], seq: { user: 1, map: 1 } }, null, 2),
      'utf8'
    );
  }
}

function readJsonDb() {
  ensureJsonDb();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.users = Array.isArray(db.users) ? db.users : [];
  db.maps = Array.isArray(db.maps) ? db.maps : [];
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
    }
  };
}

function sanitizeUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    username: user.username,
    avatar: user.avatar || ''
  };
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    phone: row.phone,
    username: row.username,
    passwordHash: row.password_hash,
    avatar: row.avatar || '',
    createdAt: toIsoDate(row.created_at)
  };
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
        phone TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

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
    `);
  }
  await pgReadyPromise;
}

const storage = {
  async findUserByPhone(phone) {
    if (pgPool) {
      await ensurePgSchema();
      const { rows } = await pgPool.query('SELECT * FROM users WHERE phone = $1 LIMIT 1', [phone]);
      return rowToUser(rows[0]);
    }
    const db = readJsonDb();
    return db.users.find(user => normalizePhone(user.phone) === phone) || null;
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

  async createUser({ phone, username, passwordHash }) {
    const now = new Date().toISOString();
    if (pgPool) {
      await ensurePgSchema();
      const id = generateId();
      const { rows } = await pgPool.query(
        `INSERT INTO users (id, phone, username, password_hash, avatar, created_at)
         VALUES ($1, $2, $3, $4, '', $5)
         RETURNING *`,
        [id, phone, username, passwordHash, now]
      );
      return rowToUser(rows[0]);
    }

    const db = readJsonDb();
    const user = {
      id: String(db.seq.user++),
      phone,
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
        passwordHash: updates.passwordHash ?? current.passwordHash
      };
      const { rows } = await pgPool.query(
        `UPDATE users
         SET username = $2, avatar = $3, password_hash = $4
         WHERE id = $1
         RETURNING *`,
        [userId, next.username, next.avatar, next.passwordHash]
      );
      return rowToUser(rows[0]);
    }

    const db = readJsonDb();
    const user = db.users.find(item => item.id === userId);
    if (!user) return null;
    Object.assign(user, updates);
    writeJsonDb(db);
    return user;
  },

  async listMaps(userId) {
    if (pgPool) {
      await ensurePgSchema();
      const { rows } = await pgPool.query(
        `SELECT id, name, created_at, updated_at
         FROM maps
         WHERE user_id = $1
         ORDER BY updated_at DESC`,
        [userId]
      );
      return rows.map(row => ({
        id: String(row.id),
        name: row.name,
        createdAt: toIsoDate(row.created_at),
        updatedAt: toIsoDate(row.updated_at)
      }));
    }

    const db = readJsonDb();
    return db.maps
      .filter(map => map.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(map => ({ id: map.id, name: map.name, updatedAt: map.updatedAt, createdAt: map.createdAt }));
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
  }
};

function auth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (_e) {
    return res.status(401).json({ message: '登录已过期' });
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, storage: pgPool ? 'postgres' : 'json' });
});

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '').trim();
  const username = String(req.body?.username || '').trim();
  if (!phone || !password || !username) {
    return res.status(400).json({ message: '参数不完整' });
  }
  const existingUser = await storage.findUserByPhone(phone);
  if (existingUser) {
    return res.status(409).json({ message: '手机号已注册' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await storage.createUser({ phone, username, passwordHash });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(user) });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  const trimmedPassword = password.trim();
  if (!phone || !password) return res.status(400).json({ message: '参数不完整' });
  const user = await storage.findUserByPhone(phone);
  if (!user) return res.status(401).json({ message: '手机号或密码错误' });
  const ok =
    (user.passwordHash && await bcrypt.compare(password, user.passwordHash)) ||
    (user.passwordHash && trimmedPassword !== password && await bcrypt.compare(trimmedPassword, user.passwordHash)) ||
    (typeof user.password === 'string' && (password === user.password || trimmedPassword === user.password.trim()));
  if (!ok) return res.status(401).json({ message: '手机号或密码错误' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(user) });
}));

app.get('/api/me', auth, asyncHandler(async (req, res) => {
  const user = await storage.findUserById(req.userId);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  res.json({ user: sanitizeUser(user) });
}));

app.put('/api/me', auth, asyncHandler(async (req, res) => {
  const { username, avatar, password } = req.body || {};
  const user = await storage.findUserById(req.userId);
  if (!user) return res.status(404).json({ message: '用户不存在' });

  const updates = {};
  if (typeof username === 'string' && username.trim()) updates.username = username.trim();
  if (typeof avatar === 'string') updates.avatar = avatar;
  if (typeof password === 'string' && password.trim()) {
    updates.passwordHash = await bcrypt.hash(password.trim(), 10);
  }

  const updatedUser = await storage.updateUser(req.userId, updates);
  res.json({ user: sanitizeUser(updatedUser) });
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

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: '服务器错误，请稍后重试' });
});

if (!pgPool) ensureJsonDb();
app.listen(PORT, () => {
  console.log(`Metro backend running at http://localhost:${PORT} (${pgPool ? 'postgres' : 'json'} storage)`);
});
