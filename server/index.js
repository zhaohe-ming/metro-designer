const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'metro_designer_change_me';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const DEFAULT_MAP_SETTINGS = {
  mapStyle: 'classic-badge',
  canvasTheme: 'light'
};

const allowedOrigins = FRONTEND_ORIGIN
  ? FRONTEND_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : [];

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

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify({ users: [], maps: [], seq: { user: 1, map: 1 } }, null, 2),
      'utf8'
    );
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDb(db) {
  ensureDb();
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    username: user.username,
    avatar: user.avatar || ''
  };
}

function normalizeMapSettings(settings) {
  return {
    mapStyle: settings && settings.mapStyle === 'dot-label' ? 'dot-label' : 'classic-badge',
    canvasTheme: settings && settings.canvasTheme === 'dark' ? 'dark' : 'light'
  };
}

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
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const password = String(req.body?.password || '').trim();
  const username = String(req.body?.username || '').trim();
  if (!phone || !password || !username) {
    return res.status(400).json({ message: '参数不完整' });
  }
  const db = readDb();
  if (db.users.some(u => String(u.phone || '').trim() === phone)) {
    return res.status(409).json({ message: '手机号已注册' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: String(db.seq.user++),
    phone,
    username,
    passwordHash,
    avatar: '',
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeDb(db);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const password = String(req.body?.password || '');
  const trimmedPassword = password.trim();
  if (!phone || !password) return res.status(400).json({ message: '参数不完整' });
  const db = readDb();
  const user = db.users.find(u => String(u.phone || '').trim() === phone);
  if (!user) return res.status(401).json({ message: '手机号或密码错误' });
  const ok =
    await bcrypt.compare(password, user.passwordHash) ||
    (trimmedPassword !== password && await bcrypt.compare(trimmedPassword, user.passwordHash));
  if (!ok) return res.status(401).json({ message: '手机号或密码错误' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  res.json({ user: sanitizeUser(user) });
});

app.put('/api/me', auth, async (req, res) => {
  const { username, avatar, password } = req.body || {};
  const db = readDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  if (typeof username === 'string' && username.trim()) user.username = username.trim();
  if (typeof avatar === 'string') user.avatar = avatar;
  if (typeof password === 'string' && password.trim()) {
    user.passwordHash = await bcrypt.hash(password.trim(), 10);
  }
  writeDb(db);
  res.json({ user: sanitizeUser(user) });
});

app.get('/api/maps', auth, (req, res) => {
  const db = readDb();
  const maps = db.maps
    .filter(m => m.userId === req.userId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(m => ({ id: m.id, name: m.name, updatedAt: m.updatedAt, createdAt: m.createdAt }));
  res.json({ maps });
});

app.get('/api/maps/:id', auth, (req, res) => {
  const db = readDb();
  const map = db.maps.find(m => m.id === req.params.id && m.userId === req.userId);
  if (!map) return res.status(404).json({ message: '地图不存在' });
  res.json({ map: { ...map, mapSettings: normalizeMapSettings(map.mapSettings) } });
});

app.post('/api/maps', auth, (req, res) => {
  const { name, lines, stations, sections, mapSettings } = req.body || {};
  if (!name || !Array.isArray(lines) || !Array.isArray(stations) || !Array.isArray(sections)) {
    return res.status(400).json({ message: '地图数据不完整' });
  }
  const db = readDb();
  const now = new Date().toISOString();
  const map = {
    id: String(db.seq.map++),
    userId: req.userId,
    name: String(name).trim() || '未命名地图',
    lines,
    stations,
    sections,
    mapSettings: normalizeMapSettings(mapSettings || DEFAULT_MAP_SETTINGS),
    createdAt: now,
    updatedAt: now
  };
  db.maps.push(map);
  writeDb(db);
  res.json({ map: { id: map.id, name: map.name, createdAt: now, updatedAt: now } });
});

app.put('/api/maps/:id', auth, (req, res) => {
  const { name, lines, stations, sections, mapSettings } = req.body || {};
  const db = readDb();
  const map = db.maps.find(m => m.id === req.params.id && m.userId === req.userId);
  if (!map) return res.status(404).json({ message: '地图不存在' });
  if (typeof name === 'string' && name.trim()) map.name = name.trim();
  if (Array.isArray(lines)) map.lines = lines;
  if (Array.isArray(stations)) map.stations = stations;
  if (Array.isArray(sections)) map.sections = sections;
  if (mapSettings) map.mapSettings = normalizeMapSettings(mapSettings);
  map.updatedAt = new Date().toISOString();
  writeDb(db);
  res.json({ map: { id: map.id, name: map.name, updatedAt: map.updatedAt, createdAt: map.createdAt } });
});

app.delete('/api/maps/:id', auth, (req, res) => {
  const db = readDb();
  const index = db.maps.findIndex(m => m.id === req.params.id && m.userId === req.userId);
  if (index < 0) return res.status(404).json({ message: '地图不存在' });
  db.maps.splice(index, 1);
  writeDb(db);
  res.json({ ok: true });
});

ensureDb();
app.listen(PORT, () => {
  console.log(`Metro backend running at http://localhost:${PORT}`);
});
