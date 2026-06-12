// Читаем .env вручную без dotenv
const fs = require('fs');
try {
  const env = fs.readFileSync('.env', 'utf8');
  env.split('\n').forEach(line => {
    const [key, ...val] = line.trim().split('=');
    if (key && val.length) process.env[key] = val.join('=');
  });
} catch(e) {}

const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, maxPayload: 10 * 1024 * 1024 }); // 10MB max (was 70MB)

// ══════════════════════════════════════════════════════════════
//  SECURITY CONFIG
// ══════════════════════════════════════════════════════════════

const JWT_SECRET = process.env.JWT_SECRET || 'grid-secret-key-change-in-prod';
if (!process.env.JWT_SECRET) console.warn('⚠️  JWT_SECRET not set — using default (insecure in production!)');

const JWT_EXPIRES_IN = '30d';   // tokens expire after 30 days
const BCRYPT_ROUNDS  = 12;      // stronger than default 10

// ── Security Headers ──────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(self)');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── Rate Limiter (in-memory, no redis needed) ──────────────────
class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs    = windowMs;
    this.maxRequests = maxRequests;
    this.store       = new Map();
    // Cleanup every 5 minutes
    setInterval(() => {
      const now = Date.now();
      for (const [key, data] of this.store) {
        if (now - data.windowStart > this.windowMs * 2) this.store.delete(key);
      }
    }, 5 * 60 * 1000);
  }

  check(ip) {
    const now = Date.now();
    let data  = this.store.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      data = { windowStart: now, count: 0 };
    }
    data.count++;
    this.store.set(ip, data);
    return data.count <= this.maxRequests;
  }

  middleware() {
    return (req, res, next) => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      if (!this.check(ip)) {
        return res.status(429).json({ error: 'Слишком много запросов. Подожди немного.' });
      }
      next();
    };
  }
}

// Auth endpoints: 10 requests per 15 minutes per IP
const authLimiter = new RateLimiter(15 * 60 * 1000, 10);
// Avatar/profile: 20 per 10 minutes
const profileLimiter = new RateLimiter(10 * 60 * 1000, 20);

// ── WS Auth Timeout — close unauthenticated connections ───────
const WS_AUTH_TIMEOUT_MS = 10000; // 10 seconds to send auth

// ── Input sanitization ────────────────────────────────────────
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  // Strip null bytes and control chars (keep newlines/tabs)
  return text.replace(/\0/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function isValidUsername(username) {
  // 3-30 chars, alphanumeric + underscore + hyphen only
  return /^[a-zA-Z0-9_\-а-яА-ЯёЁ]{3,30}$/.test(username);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

// ── Auth middleware for HTTP routes ───────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.jwtUser = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

// ══════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' })); // was 70mb — no reason to allow that

// ══════════════════════════════════════════════════════════════
//  DATABASE
// ══════════════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      color VARCHAR(20) NOT NULL,
      avatar TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS friends (
      user1_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      user2_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (user1_id, user2_id)
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT NULL;`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      msg_id TEXT UNIQUE,
      channel VARCHAR(100) NOT NULL,
      username VARCHAR(50) NOT NULL,
      color VARCHAR(20) NOT NULL,
      avatar TEXT DEFAULT NULL,
      text TEXT NOT NULL,
      time VARCHAR(10),
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS dm_messages (
      id BIGSERIAL PRIMARY KEY,
      msg_id TEXT UNIQUE,
      from_user VARCHAR(50) NOT NULL,
      to_user VARCHAR(50) NOT NULL,
      from_color VARCHAR(20),
      from_avatar TEXT DEFAULT NULL,
      text TEXT NOT NULL,
      time VARCHAR(10),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ БД готова');
}
initDB().catch(console.error);

// ══════════════════════════════════════════════════════════════
//  HTTP API
// ══════════════════════════════════════════════════════════════

app.post('/api/register', authLimiter.middleware(), async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Введи логин и пароль' });
  if (!isValidUsername(username))
    return res.status(400).json({ error: 'Логин: 3–30 символов, только буквы/цифры/_ и -' });
  if (!isValidPassword(password))
    return res.status(400).json({ error: 'Пароль: минимум 8 символов, максимум 128' });

  try {
    const colors = ['#4af0c0','#6ab4ff','#f0b44a','#c084fc','#f06a8a','#7af06a'];
    const color  = colors[Math.floor(Math.random() * colors.length)];
    const hash   = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, color) VALUES ($1, $2, $3) RETURNING id, username, color',
      [username.trim(), hash, color]
    );
    const user  = result.rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, color: user.color },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({ token, username: user.username, color: user.color });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Такой логин уже занят' });
    console.error('register error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', authLimiter.middleware(), async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Введи логин и пароль' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    // Always run bcrypt even if user not found — prevents timing attacks
    const fakeHash = '$2a$12$invalidhashfortimingreasonxxxxxxxxxxxxxxxxxxxxxxxxx';
    const user = result.rows[0] || null;
    const hash = user ? user.password_hash : fakeHash;
    const ok   = await bcrypt.compare(password, hash);

    if (!user || !ok)
      return res.status(401).json({ error: 'Неверный логин или пароль' });

    const token = jwt.sign(
      { id: user.id, username: user.username, color: user.color },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({ token, username: user.username, color: user.color, avatar: user.avatar || null });
  } catch(e) {
    console.error('login error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/change-password', requireAuth, profileLimiter.middleware(), async (req, res) => {
  const { password } = req.body;
  if (!isValidPassword(password))
    return res.status(400).json({ error: 'Пароль: минимум 8 символов, максимум 128' });
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.jwtUser.id]);
    res.json({ ok: true });
  } catch(e) {
    console.error('change-password error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/avatar', requireAuth, profileLimiter.middleware(), async (req, res) => {
  const { avatar } = req.body;
  if (avatar !== null && avatar !== undefined) {
    if (typeof avatar !== 'string' || !avatar.startsWith('data:image/'))
      return res.status(400).json({ error: 'Неверный формат изображения' });
    // Only allow jpeg/png/webp/gif
    if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/.test(avatar))
      return res.status(400).json({ error: 'Разрешены только JPEG, PNG, WebP, GIF' });
    if (avatar.length > 200000)
      return res.status(400).json({ error: 'Изображение слишком большое' });
  }
  try {
    await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [avatar || null, req.jwtUser.id]);
    const avatarUpdate = JSON.stringify({ type: 'avatar_update', username: req.jwtUser.username, avatar: avatar || null });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(avatarUpdate);
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('avatar error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/ice-servers', (req, res) => {
  const servers = [];
  if (process.env.TURN_URL) {
    const entry = { urls: process.env.TURN_URL };
    if (process.env.TURN_USERNAME) entry.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) entry.credential = process.env.TURN_CREDENTIAL;
    servers.push(entry);
    if (!process.env.TURN_URL.includes('transport=')) {
      const tcpEntry = { urls: process.env.TURN_URL + '?transport=tcp' };
      if (process.env.TURN_USERNAME) tcpEntry.username = process.env.TURN_USERNAME;
      if (process.env.TURN_CREDENTIAL) tcpEntry.credential = process.env.TURN_CREDENTIAL;
      servers.push(tcpEntry);
    }
  }
  if (process.env.TURN_URL_2) {
    const entry2 = { urls: process.env.TURN_URL_2 };
    if (process.env.TURN_USERNAME_2) entry2.username = process.env.TURN_USERNAME_2;
    if (process.env.TURN_CREDENTIAL_2) entry2.credential = process.env.TURN_CREDENTIAL_2;
    servers.push(entry2);
  }
  res.json({ iceServers: servers });
});

// ══════════════════════════════════════════════════════════════
//  CHAT STATE
// ══════════════════════════════════════════════════════════════
const channels      = { 'общий': [], 'игры': [], 'фидбек': [] };
const onlineUsers   = new Map();  // ws → user object
const dmHistory     = new Map();  // key → messages[]
const voiceChannels = { 'голос-1': new Set(), 'голос-2': new Set() };
const groupCallRooms = new Map(); // roomId → { members: Set, soloTimer }

// ── WS rate limiting ──────────────────────────────────────────
// Per-connection message limits to prevent flood
const WS_MSG_LIMIT    = 30;   // messages per window
const WS_MSG_WINDOW   = 5000; // 5 second window

async function loadHistory() {
  try {
    const res = await pool.query(`SELECT * FROM messages ORDER BY created_at DESC LIMIT 500`);
    res.rows.reverse().forEach(row => {
      const ch = row.channel;
      if (!channels[ch]) channels[ch] = [];
      channels[ch].push({
        type: 'message', id: row.msg_id, username: row.username,
        color: row.color, avatar: row.avatar, text: row.text,
        channel: ch, time: row.time, edited: row.edited
      });
    });
    const dmRes = await pool.query(`SELECT * FROM dm_messages ORDER BY created_at DESC LIMIT 1000`);
    dmRes.rows.reverse().forEach(row => {
      const key = [row.from_user, row.to_user].sort().join('|');
      if (!dmHistory.has(key)) dmHistory.set(key, []);
      dmHistory.get(key).push({
        type: 'dm', id: row.msg_id, from: row.from_user, to: row.to_user,
        fromColor: row.from_color, fromAvatar: row.from_avatar,
        text: row.text, time: row.time
      });
    });
    console.log('✅ История загружена из БД');
  } catch(e) { console.error('load history error', e); }
}
loadHistory();

// ══════════════════════════════════════════════════════════════
//  HEARTBEAT — keeps Railway WS alive
// ══════════════════════════════════════════════════════════════
const HEARTBEAT_INTERVAL = 20000;
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function dmKey(a, b) { return [a, b].sort().join('|'); }

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) client.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getUserList() {
  return Array.from(onlineUsers.values()).map(u => ({
    username: u.username, color: u.color, avatar: u.avatar || null,
    channel: u.channel, voiceChannel: u.voiceChannel || null
  }));
}

function findWsByUsername(username) {
  for (const [ws, u] of onlineUsers) {
    if (u.username === username) return ws;
  }
  return null;
}

function getVoiceChannelList() {
  const result = {};
  for (const [ch, members] of Object.entries(voiceChannels)) {
    result[ch] = Array.from(members).map(username => {
      const u = Array.from(onlineUsers.values()).find(x => x.username === username);
      return { username, color: u ? u.color : '#4af0c0', avatar: u ? u.avatar || null : null };
    });
  }
  return result;
}

function broadcastVoiceState() {
  broadcast({ type: 'voice_state', channels: getVoiceChannelList() });
}

// ══════════════════════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════════════════════
wss.on('connection', (ws, req) => {
  ws.isAlive    = true;
  ws.isAuthed   = false;
  ws.msgCount   = 0;
  ws.msgWindowStart = Date.now();

  ws.on('pong', () => { ws.isAlive = true; });

  // ── Auth timeout — close if no auth within 10 seconds ──
  const authTimeout = setTimeout(() => {
    if (!ws.isAuthed) {
      sendTo(ws, { type: 'auth_error', error: 'Таймаут авторизации' });
      ws.terminate();
    }
  }, WS_AUTH_TIMEOUT_MS);

  ws.on('message', async (raw) => {
    // ── Size guard ──
    if (raw.length > 512 * 1024) return; // 512KB max per WS message

    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── Rate limiting per connection ──
    const now = Date.now();
    if (now - ws.msgWindowStart > WS_MSG_WINDOW) {
      ws.msgCount = 0;
      ws.msgWindowStart = now;
    }
    ws.msgCount++;
    if (ws.msgCount > WS_MSG_LIMIT) {
      // Silent drop — don't inform the spammer
      return;
    }

    // ── Auth ────────────────────────────────────────────────
    if (data.type === 'auth') {
      try {
        const user = jwt.verify(data.token, JWT_SECRET);
        const result = await pool.query('SELECT avatar FROM users WHERE id=$1', [user.id]);
        if (!result.rows[0]) throw new Error('User not found');
        const avatar = result.rows[0].avatar || null;

        clearTimeout(authTimeout);
        ws.isAuthed = true;

        // Kick existing session for same user
        for (const [existingWs, existingUser] of onlineUsers) {
          if (existingUser.username === user.username && existingWs !== ws) {
            sendTo(existingWs, { type: 'kicked', reason: 'New session opened' });
            existingWs.terminate();
            onlineUsers.delete(existingWs);
            break;
          }
        }

        onlineUsers.set(ws, {
          id: user.id, username: user.username, color: user.color,
          avatar, channel: 'общий', voiceChannel: null
        });

        const friendsResult = await pool.query(`
          SELECT u.username, u.color, u.avatar FROM users u
          JOIN friends f ON (f.user1_id = u.id OR f.user2_id = u.id)
          WHERE (f.user1_id = $1 OR f.user2_id = $1) AND u.id != $1
        `, [user.id]);

        sendTo(ws, {
          type: 'welcome',
          username: user.username,
          color: user.color,
          avatar,
          friends: friendsResult.rows.map(f => ({ username: f.username, color: f.color, avatar: f.avatar || null })),
          history: channels['общий'].slice(-50),
          voiceChannels: getVoiceChannelList()
        });
        broadcast({ type: 'user_joined', username: user.username, color: user.color, avatar, users: getUserList() });
        broadcast({ type: 'system', text: `${user.username} зашёл в сеть`, channel: 'общий' });
      } catch(e) {
        console.error('auth error:', e.message);
        sendTo(ws, { type: 'auth_error', error: 'Неверный токен' });
        ws.terminate();
      }
      return;
    }

    // ── All other messages require auth ─────────────────────
    const user = onlineUsers.get(ws);
    if (!user) return;

    switch (data.type) {

      case 'ping': break; // keepalive

      case 'message': {
        const ch = data.channel || user.channel;
        if (!data.text || typeof data.text !== 'string') break;
        const text = sanitizeText(data.text);
        if (!text || text.length > 4000) break;
        if (!channels[ch]) break; // only allow existing channels
        const msg = {
          type: 'message',
          id: Date.now() + Math.random(),
          username: user.username,
          color: user.color,
          avatar: user.avatar || null,
          text,
          channel: ch,
          time: new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
        };
        channels[ch].push(msg);
        if (channels[ch].length > 200) channels[ch].shift();
        broadcast(msg);
        pool.query(
          `INSERT INTO messages (msg_id, channel, username, color, avatar, text, time) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [String(msg.id), ch, msg.username, msg.color, msg.avatar || null, msg.text, msg.time]
        ).catch(console.error);
        break;
      }

      case 'dm': {
        if (!data.text || typeof data.text !== 'string') break;
        const text = sanitizeText(data.text);
        if (!text || text.length > 4000) break;
        if (!data.to || typeof data.to !== 'string') break;
        const recipientWs = findWsByUsername(data.to);
        const key = dmKey(user.username, data.to);
        const msg = {
          type: 'dm',
          id: Date.now() + Math.random(),
          from: user.username,
          fromColor: user.color,
          fromAvatar: user.avatar || null,
          to: data.to,
          text,
          time: new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
        };
        if (!dmHistory.has(key)) dmHistory.set(key, []);
        const hist = dmHistory.get(key);
        hist.push(msg);
        if (hist.length > 200) hist.shift();
        sendTo(ws, msg);
        if (recipientWs) sendTo(recipientWs, msg);
        pool.query(
          `INSERT INTO dm_messages (msg_id, from_user, to_user, from_color, from_avatar, text, time) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [String(msg.id), msg.from, msg.to, msg.fromColor, msg.fromAvatar || null, msg.text, msg.time]
        ).catch(console.error);
        break;
      }

      case 'dm_history': {
        if (!data.withUsername || typeof data.withUsername !== 'string') break;
        const key = dmKey(user.username, data.withUsername);
        sendTo(ws, { type: 'dm_history', withUsername: data.withUsername, history: (dmHistory.get(key) || []).slice(-50) });
        break;
      }

      case 'switch_channel': {
        if (!channels[data.channel]) break; // only allow valid channels
        user.channel = data.channel;
        broadcast({ type: 'users', users: getUserList() });
        sendTo(ws, { type: 'channel_history', channel: data.channel, history: (channels[data.channel] || []).slice(-50) });
        break;
      }

      case 'edit_message': {
        const ch = data.channel || user.channel;
        const text = sanitizeText(data.text || '');
        if (!text || text.length > 4000) break;
        if (channels[ch]) {
          const m = channels[ch].find(m => String(m.id) === String(data.msgId));
          // Only the author can edit their own message
          if (m && m.username === user.username) {
            m.text = text;
            m.edited = true;
          } else if (m && m.username !== user.username) {
            break; // silently reject edits from non-authors
          }
        }
        broadcast({ type: 'edit_message', msgId: data.msgId, text });
        pool.query(`UPDATE messages SET text=$1, edited=TRUE WHERE msg_id=$2 AND username=$3`, [text, String(data.msgId), user.username]).catch(console.error);
        pool.query(`UPDATE dm_messages SET text=$1 WHERE msg_id=$2 AND from_user=$3`, [text, String(data.msgId), user.username]).catch(console.error);
        break;
      }

      case 'delete_message': {
        // Only author can delete — enforce on server
        if (data.channel && channels[data.channel]) {
          const msg = channels[data.channel].find(m => String(m.id) === String(data.msgId));
          if (msg && msg.username !== user.username) break;
          channels[data.channel] = channels[data.channel].filter(m => String(m.id) !== String(data.msgId));
        }
        broadcast({ type: 'delete_message', msgId: data.msgId });
        pool.query(`DELETE FROM messages WHERE msg_id=$1 AND username=$2`, [String(data.msgId), user.username]).catch(console.error);
        pool.query(`DELETE FROM dm_messages WHERE msg_id=$1 AND from_user=$2`, [String(data.msgId), user.username]).catch(console.error);
        break;
      }

      case 'typing': {
        if (data.dm) {
          if (!data.to || typeof data.to !== 'string') break;
          const recipientWs = findWsByUsername(data.to);
          if (recipientWs) sendTo(recipientWs, { type: 'dm_typing', from: user.username });
        } else {
          broadcast({ type: 'typing', username: user.username, channel: data.channel }, ws);
        }
        break;
      }

      case 'friend_request_send': {
        if (!data.toUsername || typeof data.toUsername !== 'string') break;
        if (data.toUsername === user.username) break; // can't friend yourself
        const targetWs = findWsByUsername(data.toUsername);
        if (targetWs) sendTo(targetWs, { type: 'friend_request', from: user.username, fromColor: user.color });
        break;
      }

      case 'friend_accept': {
        if (!data.toUsername || typeof data.toUsername !== 'string') break;
        const requesterWs = findWsByUsername(data.toUsername);
        if (requesterWs) sendTo(requesterWs, { type: 'friend_accepted', username: user.username, color: user.color });
        try {
          const r1 = await pool.query('SELECT id FROM users WHERE username=$1', [user.username]);
          const r2 = await pool.query('SELECT id FROM users WHERE username=$1', [data.toUsername]);
          if (r1.rows[0] && r2.rows[0]) {
            const id1 = Math.min(r1.rows[0].id, r2.rows[0].id);
            const id2 = Math.max(r1.rows[0].id, r2.rows[0].id);
            await pool.query('INSERT INTO friends (user1_id, user2_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id1, id2]);
          }
        } catch(e) { console.error('friend save error:', e.message); }
        break;
      }

      case 'friend_remove': {
        if (!data.toUsername || typeof data.toUsername !== 'string') break;
        try {
          const r1 = await pool.query('SELECT id FROM users WHERE username=$1', [user.username]);
          const r2 = await pool.query('SELECT id FROM users WHERE username=$1', [data.toUsername]);
          if (r1.rows[0] && r2.rows[0]) {
            const id1 = Math.min(r1.rows[0].id, r2.rows[0].id);
            const id2 = Math.max(r1.rows[0].id, r2.rows[0].id);
            await pool.query('DELETE FROM friends WHERE user1_id=$1 AND user2_id=$2', [id1, id2]);
          }
        } catch(e) { console.error('friend remove error:', e.message); }
        break;
      }

      case 'call_invite':
      case 'call_accept':
      case 'call_decline':
      case 'call_end':
      case 'call_widget':
      case 'call_offer':
      case 'call_answer':
      case 'call_ice': {
        if (!data.to || typeof data.to !== 'string') break;
        const targetWs = findWsByUsername(data.to);
        if (targetWs) sendTo(targetWs, { ...data, from: user.username, fromColor: user.color, fromAvatar: user.avatar || null });
        break;
      }

      // ── GROUP CALL ──────────────────────────────────────────
      case 'group_call_create': {
        const roomId  = data.roomId;
        const invitees = Array.isArray(data.invitees) ? data.invitees.slice(0, 7) : [];
        if (!roomId || typeof roomId !== 'string') break;
        const room = { members: new Set([user.username]), soloTimer: null };
        groupCallRooms.set(roomId, room);
        invitees.forEach(username => {
          if (typeof username !== 'string') return;
          const tWs = findWsByUsername(username);
          if (tWs) sendTo(tWs, {
            type: 'group_call_invite', roomId, from: user.username,
            fromColor: user.color, fromAvatar: user.avatar || null,
            invitees: [user.username, ...invitees]
          });
        });
        break;
      }

      case 'group_call_accept': {
        const roomId = data.roomId;
        if (!roomId || typeof roomId !== 'string') break;
        const room = groupCallRooms.get(roomId);
        if (!room) break;
        if (room.soloTimer) { clearTimeout(room.soloTimer); room.soloTimer = null; }
        room.members.add(user.username);
        room.members.forEach(memberName => {
          if (memberName === user.username) return;
          const mWs = findWsByUsername(memberName);
          if (mWs) sendTo(mWs, { type: 'group_call_peer_joined', roomId, username: user.username, color: user.color, avatar: user.avatar || null });
        });
        const existingMembers = Array.from(room.members)
          .filter(u => u !== user.username)
          .map(u => {
            const ud = Array.from(onlineUsers.values()).find(x => x.username === u);
            return { username: u, color: ud ? ud.color : '#4af0c0', avatar: ud ? ud.avatar || null : null };
          });
        sendTo(ws, { type: 'group_call_joined', roomId, members: existingMembers });
        break;
      }

      case 'group_call_decline': {
        if (!data.roomId || typeof data.to !== 'string') break;
        const targetWs = findWsByUsername(data.to);
        if (targetWs) sendTo(targetWs, { type: 'group_call_decline', roomId: data.roomId, from: user.username });
        break;
      }

      case 'group_call_leave': {
        const roomId = data.roomId;
        if (!roomId) break;
        const room = groupCallRooms.get(roomId);
        if (!room) break;
        room.members.delete(user.username);
        room.members.forEach(memberName => {
          const mWs = findWsByUsername(memberName);
          if (mWs) sendTo(mWs, { type: 'group_call_peer_left', roomId, username: user.username });
        });
        if (room.members.size === 1) {
          if (room.soloTimer) clearTimeout(room.soloTimer);
          room.soloTimer = setTimeout(() => {
            const lastMember = Array.from(room.members)[0];
            if (lastMember) { const lWs = findWsByUsername(lastMember); if (lWs) sendTo(lWs, { type: 'group_call_solo_timeout', roomId }); }
            groupCallRooms.delete(roomId);
          }, 30000);
        } else if (room.members.size === 0) {
          if (room.soloTimer) clearTimeout(room.soloTimer);
          groupCallRooms.delete(roomId);
        }
        break;
      }

      case 'group_call_offer':
      case 'group_call_answer':
      case 'group_call_ice': {
        if (!data.to || typeof data.to !== 'string') break;
        const targetWs = findWsByUsername(data.to);
        if (targetWs) sendTo(targetWs, { ...data, from: user.username });
        break;
      }
      // ── END GROUP CALL ──────────────────────────────────────

      case 'voice_join': {
        if (user.voiceChannel && voiceChannels[user.voiceChannel]) {
          voiceChannels[user.voiceChannel].delete(user.username);
        }
        const vch = data.channel;
        if (!voiceChannels[vch]) break;
        user.voiceChannel = vch;
        voiceChannels[vch].add(user.username);
        const existingMembers = Array.from(voiceChannels[vch]).filter(u => u !== user.username);
        existingMembers.forEach(memberName => {
          const memberWs = findWsByUsername(memberName);
          if (memberWs) sendTo(memberWs, { type: 'voice_peer_joined', username: user.username, color: user.color, avatar: user.avatar || null, channel: vch });
        });
        sendTo(ws, {
          type: 'voice_joined', channel: vch,
          members: Array.from(voiceChannels[vch]).filter(u => u !== user.username).map(u => {
            const ud = Array.from(onlineUsers.values()).find(x => x.username === u);
            return { username: u, color: ud ? ud.color : '#4af0c0', avatar: ud ? ud.avatar || null : null };
          })
        });
        broadcastVoiceState();
        broadcast({ type: 'users', users: getUserList() });
        break;
      }

      case 'voice_leave': {
        if (user.voiceChannel && voiceChannels[user.voiceChannel]) {
          voiceChannels[user.voiceChannel].delete(user.username);
          voiceChannels[user.voiceChannel].forEach(memberName => {
            const memberWs = findWsByUsername(memberName);
            if (memberWs) sendTo(memberWs, { type: 'voice_peer_left', username: user.username });
          });
        }
        user.voiceChannel = null;
        broadcastVoiceState();
        broadcast({ type: 'users', users: getUserList() });
        break;
      }

      case 'voice_offer':
      case 'voice_answer':
      case 'voice_ice': {
        if (!data.to || typeof data.to !== 'string') break;
        const targetWs = findWsByUsername(data.to);
        if (targetWs) sendTo(targetWs, { ...data, from: user.username });
        break;
      }

      case 'read_receipt': {
        if (!data.to || typeof data.to !== 'string') break;
        const targetWs = findWsByUsername(data.to);
        if (targetWs) sendTo(targetWs, { type: 'read_receipt', msgId: data.msgId });
        break;
      }

      case 'reaction': {
        const reactionMsg = { ...data, from: user.username };
        if (data.dm && data.to && typeof data.to === 'string') {
          const targetWs = findWsByUsername(data.to);
          if (targetWs) sendTo(targetWs, reactionMsg);
        } else {
          broadcast(reactionMsg, ws);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    const user = onlineUsers.get(ws);
    if (user) {
      if (user.voiceChannel && voiceChannels[user.voiceChannel]) {
        voiceChannels[user.voiceChannel].delete(user.username);
        voiceChannels[user.voiceChannel].forEach(memberName => {
          const memberWs = findWsByUsername(memberName);
          if (memberWs) sendTo(memberWs, { type: 'voice_peer_left', username: user.username });
        });
        broadcastVoiceState();
      }
      groupCallRooms.forEach((room, roomId) => {
        if (!room.members.has(user.username)) return;
        room.members.delete(user.username);
        room.members.forEach(memberName => {
          const mWs = findWsByUsername(memberName);
          if (mWs) sendTo(mWs, { type: 'group_call_peer_left', roomId, username: user.username });
        });
        if (room.members.size === 1) {
          if (room.soloTimer) clearTimeout(room.soloTimer);
          room.soloTimer = setTimeout(() => {
            const last = Array.from(room.members)[0];
            if (last) { const lWs = findWsByUsername(last); if (lWs) sendTo(lWs, { type: 'group_call_solo_timeout', roomId }); }
            groupCallRooms.delete(roomId);
          }, 30000);
        } else if (room.members.size === 0) {
          if (room.soloTimer) clearTimeout(room.soloTimer);
          groupCallRooms.delete(roomId);
        }
      });
      broadcast({ type: 'system', text: `${user.username} вышел`, channel: 'общий' });
      broadcast({ type: 'user_left', username: user.username, users: getUserList() });
      onlineUsers.delete(ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ Grid сервер запущен на порту ${PORT}`);
});
