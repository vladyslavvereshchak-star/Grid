// Читаем .env вручную без dotenv
const fs = require('fs');
try {
  const env = fs.readFileSync('.env', 'utf8');
  env.split('\n').forEach(line => {
    const [key, ...val] = line.trim().split('=');
    if (key && val.length) process.env[key] = val.join('=');
  });
} catch(e) {}
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '3mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'grid-secret-key-change-in-prod';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
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
      user1_id INTEGER REFERENCES users(id),
      user2_id INTEGER REFERENCES users(id),
      PRIMARY KEY (user1_id, user2_id)
    );
  `);
  // Add avatar column if upgrading existing DB
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT NULL;
  `).catch(() => {});
  console.log('✅ БД готова');
}

initDB().catch(console.error);

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введи логин и пароль' });
  if (username.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

  try {
    const colors = ['#4af0c0','#6ab4ff','#f0b44a','#c084fc','#f06a8a','#7af06a'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, color) VALUES ($1, $2, $3) RETURNING id, username, color',
      [username, hash, color]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username, color: user.color }, JWT_SECRET);
    res.json({ token, username: user.username, color: user.color });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Такой логин уже занят' });
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введи логин и пароль' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = jwt.sign({ id: user.id, username: user.username, color: user.color }, JWT_SECRET);
    res.json({ token, username: user.username, color: user.color, avatar: user.avatar || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/change-password', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Нет токена' });
  try {
    const user = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(401).json({ error: 'Ошибка авторизации' });
  }
});

app.post('/api/avatar', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Нет токена' });
  try {
    const user = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    const { avatar } = req.body;

    if (avatar !== null && avatar !== undefined) {
      if (!avatar.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image format' });
      if (avatar.length > 200000) return res.status(400).json({ error: 'Image too large' });
    }

    await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [avatar || null, user.id]);

    const avatarUpdate = JSON.stringify({
      type: 'avatar_update',
      username: user.username,
      avatar: avatar || null
    });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(avatarUpdate);
    });

    res.json({ ok: true });
  } catch(e) {
    console.error(e);
    res.status(401).json({ error: 'Ошибка авторизации' });
  }
});

const channels = { 'общий': [], 'игры': [], 'фидбек': [] };
const onlineUsers = new Map();
const dmHistory = new Map();

const voiceChannels = { 'голос-1': new Set(), 'голос-2': new Set() };

function dmKey(a, b) { return [a, b].sort().join('|'); }

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(msg);
    }
  });
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
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

wss.on('connection', (ws, req) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'auth') {
      try {
        const user = jwt.verify(data.token, JWT_SECRET);
        pool.query('SELECT avatar FROM users WHERE id=$1', [user.id]).then(result => {
          const avatar = result.rows[0]?.avatar || null;
          onlineUsers.set(ws, {
            id: user.id, username: user.username, color: user.color,
            avatar, channel: 'общий', voiceChannel: null
          });
          sendTo(ws, {
            type: 'welcome',
            username: user.username,
            color: user.color,
            avatar,
            history: channels['общий'].slice(-50),
            voiceChannels: getVoiceChannelList()
          });
          broadcast({ type: 'user_joined', username: user.username, color: user.color, avatar, users: getUserList() });
          broadcast({ type: 'system', text: `${user.username} зашёл в сеть`, channel: 'общий' });
        }).catch(() => {
          onlineUsers.set(ws, { id: user.id, username: user.username, color: user.color, avatar: null, channel: 'общий', voiceChannel: null });
          sendTo(ws, { type: 'welcome', username: user.username, color: user.color, avatar: null, history: channels['общий'].slice(-50), voiceChannels: getVoiceChannelList() });
        });
      } catch {
        sendTo(ws, { type: 'auth_error', error: 'Неверный токен' });
        ws.close();
      }
      return;
    }

    const user = onlineUsers.get(ws);
    if (!user) return;

    switch (data.type) {
      case 'message': {
        const ch = data.channel || user.channel;
        const msg = {
          type: 'message',
          id: Date.now() + Math.random(),
          username: user.username,
          color: user.color,
          avatar: user.avatar || null,
          text: data.text,
          channel: ch,
          time: new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
        };
        if (!channels[ch]) channels[ch] = [];
        channels[ch].push(msg);
        if (channels[ch].length > 200) channels[ch].shift();
        broadcast(msg);
        break;
      }

      case 'dm': {
        const recipientWs = findWsByUsername(data.to);
        const key = dmKey(user.username, data.to);
        const msg = {
          type: 'dm',
          id: Date.now() + Math.random(),
          from: user.username,
          fromColor: user.color,
          fromAvatar: user.avatar || null,
          to: data.to,
          text: data.text,
          time: new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
        };
        if (!dmHistory.has(key)) dmHistory.set(key, []);
        dmHistory.get(key).push(msg);
        sendTo(ws, msg);
        if (recipientWs) sendTo(recipientWs, msg);
        break;
      }

      case 'dm_history': {
        const key = dmKey(user.username, data.withUsername);
        sendTo(ws, { type: 'dm_history', withUsername: data.withUsername, history: (dmHistory.get(key) || []).slice(-50) });
        break;
      }

      case 'switch_channel': {
        user.channel = data.channel;
        broadcast({ type: 'users', users: getUserList() });
        sendTo(ws, {
          type: 'channel_history',
          channel: data.channel,
          history: (channels[data.channel] || []).slice(-50)
        });
        break;
      }

      case 'typing': {
        if (data.dm) {
          const recipientWs = findWsByUsername(data.to);
          if (recipientWs) sendTo(recipientWs, { type: 'dm_typing', from: user.username });
        } else {
          broadcast({ type: 'typing', username: user.username, channel: data.channel }, ws);
        }
        break;
      }

      case 'friend_request_send': {
        const targetWs = findWsByUsername(data.toUsername);
        if (targetWs) {
          sendTo(targetWs, { type: 'friend_request', from: user.username, fromColor: user.color });
        }
        break;
      }

      case 'friend_accept': {
        const requesterWs = findWsByUsername(data.toUsername);
        if (requesterWs) {
          sendTo(requesterWs, { type: 'friend_accepted', username: user.username, color: user.color });
        }
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
        const targetWs = findWsByUsername(data.to);
        if (targetWs) {
          sendTo(targetWs, { ...data, from: user.username, fromColor: user.color, fromAvatar: user.avatar || null });
        }
        break;
      }

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
          if (memberWs) {
            sendTo(memberWs, { type: 'voice_peer_joined', username: user.username, color: user.color, avatar: user.avatar || null, channel: vch });
          }
        });

        sendTo(ws, {
          type: 'voice_joined',
          channel: vch,
          members: Array.from(voiceChannels[vch])
            .filter(u => u !== user.username)
            .map(u => {
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
        const targetWs = findWsByUsername(data.to);
        if (targetWs) {
          sendTo(targetWs, { ...data, from: user.username });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
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
