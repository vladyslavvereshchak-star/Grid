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
const wss = new WebSocket.Server({ server, maxPayload: 70 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '70mb' }));

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

// ── ICE Servers API — позволяет настраивать TURN через Railway env vars ──
// Установи в Railway: TURN_URL, TURN_USERNAME, TURN_CREDENTIAL
// Например: TURN_URL=turn:your-server.com:3478
app.get('/api/ice-servers', (req, res) => {
  const servers = [];

  // Если в env есть кастомный TURN — добавляем его первым (высший приоритет)
  if (process.env.TURN_URL) {
    const entry = { urls: process.env.TURN_URL };
    if (process.env.TURN_USERNAME) entry.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) entry.credential = process.env.TURN_CREDENTIAL;
    servers.push(entry);

    // TCP fallback для того же сервера
    if (!process.env.TURN_URL.includes('transport=')) {
      const tcpEntry = { urls: process.env.TURN_URL + '?transport=tcp' };
      if (process.env.TURN_USERNAME) tcpEntry.username = process.env.TURN_USERNAME;
      if (process.env.TURN_CREDENTIAL) tcpEntry.credential = process.env.TURN_CREDENTIAL;
      servers.push(tcpEntry);
    }
  }

  // Если в env есть второй TURN — тоже добавляем
  if (process.env.TURN_URL_2) {
    const entry2 = { urls: process.env.TURN_URL_2 };
    if (process.env.TURN_USERNAME_2) entry2.username = process.env.TURN_USERNAME_2;
    if (process.env.TURN_CREDENTIAL_2) entry2.credential = process.env.TURN_CREDENTIAL_2;
    servers.push(entry2);
  }

  res.json({ iceServers: servers });
});

const channels = { 'общий': [], 'игры': [], 'фидбек': [] };
const onlineUsers = new Map();
const dmHistory = new Map();

// Load messages from DB into memory
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

const voiceChannels = { 'голос-1': new Set(), 'голос-2': new Set() };

// ── Group call rooms (DM group calls, up to 8 people) ──
// roomId → { members: Set<username>, soloTimer: null|timeout }
const groupCallRooms = new Map();

// ── Heartbeat — Railway kills idle WS after ~30s without activity ──
const HEARTBEAT_INTERVAL = 20000; // 20s ping
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

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
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'auth') {
      try {
        const user = jwt.verify(data.token, JWT_SECRET);
        const result = await pool.query('SELECT avatar FROM users WHERE id=$1', [user.id]);
        const avatar = result.rows[0]?.avatar || null;

        // ── Kick existing session for same user (prevents ghost WS) ──
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
        // Load friends from DB
        const friendsResult = await pool.query(`
          SELECT u.username, u.color, u.avatar FROM users u
          JOIN friends f ON (f.user1_id = u.id OR f.user2_id = u.id)
          WHERE (f.user1_id = $1 OR f.user2_id = $1) AND u.id != $1
        `, [user.id]);
        const friendsList = friendsResult.rows.map(f => ({
          username: f.username, color: f.color, avatar: f.avatar || null
        }));
        sendTo(ws, {
          type: 'welcome',
          username: user.username,
          color: user.color,
          avatar,
          friends: friendsList,
          history: channels['общий'].slice(-50),
          voiceChannels: getVoiceChannelList()
        });
        broadcast({ type: 'user_joined', username: user.username, color: user.color, avatar, users: getUserList() });
        broadcast({ type: 'system', text: `${user.username} зашёл в сеть`, channel: 'общий' });
      } catch(e) {
        console.error('auth error', e);
        sendTo(ws, { type: 'auth_error', error: 'Неверный токен' });
        ws.close();
      }
      return;
    }

    const user = onlineUsers.get(ws);
    if (!user) return;

    switch (data.type) {
      case 'ping': break; // client keepalive — no response needed, just keeps connection alive

      case 'message': {
        const ch = data.channel || user.channel;
        if (!data.text || typeof data.text !== 'string') break;
        if (data.text.length > 4000) break; // server-side length guard
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
        // Save to DB
        pool.query(
          `INSERT INTO messages (msg_id, channel, username, color, avatar, text, time) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [String(msg.id), ch, msg.username, msg.color, msg.avatar || null, msg.text, msg.time]
        ).catch(console.error);
        break;
      }

      case 'dm': {
        if (!data.text || typeof data.text !== 'string') break;
        if (data.text.length > 4000) break;
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
        const hist = dmHistory.get(key);
        hist.push(msg);
        if (hist.length > 200) hist.shift(); // cap DM history in memory
        sendTo(ws, msg);
        if (recipientWs) sendTo(recipientWs, msg);
        // Save to DB
        pool.query(
          `INSERT INTO dm_messages (msg_id, from_user, to_user, from_color, from_avatar, text, time) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [String(msg.id), msg.from, msg.to, msg.fromColor, msg.fromAvatar || null, msg.text, msg.time]
        ).catch(console.error);
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

      case 'edit_message': {
        const ch = data.channel || user.channel;
        if (channels[ch]) {
          const m = channels[ch].find(m => String(m.id) === String(data.msgId));
          if (m && m.username === user.username) {
            m.text = data.text;
            m.edited = true;
          }
        }
        broadcast({ type: 'edit_message', msgId: data.msgId, text: data.text });
        pool.query(`UPDATE messages SET text=$1, edited=TRUE WHERE msg_id=$2`, [data.text, String(data.msgId)]).catch(console.error);
        pool.query(`UPDATE dm_messages SET text=$1 WHERE msg_id=$2`, [data.text, String(data.msgId)]).catch(console.error);
        break;
      }

      case 'delete_message': {
        // Удаляем из истории канала если есть
        if (data.channel && channels[data.channel]) {
          channels[data.channel] = channels[data.channel].filter(m => String(m.id) !== String(data.msgId));
        }
        // Рассылаем всем чтобы удалили у себя
        broadcast({ type: 'delete_message', msgId: data.msgId });
        pool.query(`DELETE FROM messages WHERE msg_id=$1`, [String(data.msgId)]).catch(console.error);
        pool.query(`DELETE FROM dm_messages WHERE msg_id=$1`, [String(data.msgId)]).catch(console.error);
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
        // Save friendship to DB
        try {
          const r1 = await pool.query('SELECT id FROM users WHERE username=$1', [user.username]);
          const r2 = await pool.query('SELECT id FROM users WHERE username=$1', [data.toUsername]);
          if (r1.rows[0] && r2.rows[0]) {
            const id1 = Math.min(r1.rows[0].id, r2.rows[0].id);
            const id2 = Math.max(r1.rows[0].id, r2.rows[0].id);
            await pool.query(
              'INSERT INTO friends (user1_id, user2_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
              [id1, id2]
            );
          }
        } catch(e) { console.error('friend save error', e); }
        break;
      }

      case 'friend_remove': {
        try {
          const r1 = await pool.query('SELECT id FROM users WHERE username=$1', [user.username]);
          const r2 = await pool.query('SELECT id FROM users WHERE username=$1', [data.toUsername]);
          if (r1.rows[0] && r2.rows[0]) {
            const id1 = Math.min(r1.rows[0].id, r2.rows[0].id);
            const id2 = Math.max(r1.rows[0].id, r2.rows[0].id);
            await pool.query('DELETE FROM friends WHERE user1_id=$1 AND user2_id=$2', [id1, id2]);
          }
        } catch(e) { console.error('friend remove error', e); }
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

      // ── GROUP CALL ──────────────────────────────────────────
      case 'group_call_create': {
        // Инициатор создаёт комнату и приглашает всех
        const roomId = data.roomId;
        const invitees = Array.isArray(data.invitees) ? data.invitees.slice(0, 7) : [];
        if (!roomId) break;
        const room = { members: new Set([user.username]), soloTimer: null };
        groupCallRooms.set(roomId, room);
        invitees.forEach(username => {
          const tWs = findWsByUsername(username);
          if (tWs) sendTo(tWs, {
            type: 'group_call_invite',
            roomId,
            from: user.username,
            fromColor: user.color,
            fromAvatar: user.avatar || null,
            invitees: [user.username, ...invitees]
          });
        });
        break;
      }

      case 'group_call_accept': {
        const roomId = data.roomId;
        const room = groupCallRooms.get(roomId);
        if (!room) break;
        // Отменяем solo timer если он был
        if (room.soloTimer) { clearTimeout(room.soloTimer); room.soloTimer = null; }
        const wasAlone = room.members.size === 0;
        room.members.add(user.username);
        // Уведомляем всех участников в комнате что пришёл новый
        room.members.forEach(memberName => {
          if (memberName === user.username) return;
          const mWs = findWsByUsername(memberName);
          if (mWs) sendTo(mWs, {
            type: 'group_call_peer_joined',
            roomId,
            username: user.username,
            color: user.color,
            avatar: user.avatar || null
          });
        });
        // Новому участнику отдаём список текущих участников для WebRTC
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
        const roomId = data.roomId;
        const targetWs = findWsByUsername(data.to);
        if (targetWs) sendTo(targetWs, { type: 'group_call_decline', roomId, from: user.username });
        break;
      }

      case 'group_call_leave': {
        const roomId = data.roomId;
        const room = groupCallRooms.get(roomId);
        if (!room) break;
        room.members.delete(user.username);
        // Уведомляем оставшихся
        room.members.forEach(memberName => {
          const mWs = findWsByUsername(memberName);
          if (mWs) sendTo(mWs, { type: 'group_call_peer_left', roomId, username: user.username });
        });
        // Если остался 1 человек — запускаем 30сек solo timer
        if (room.members.size === 1) {
          if (room.soloTimer) clearTimeout(room.soloTimer);
          room.soloTimer = setTimeout(() => {
            const lastMember = Array.from(room.members)[0];
            if (lastMember) {
              const lWs = findWsByUsername(lastMember);
              if (lWs) sendTo(lWs, { type: 'group_call_solo_timeout', roomId });
            }
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

      case 'read_receipt': {
        const targetWs = findWsByUsername(data.to);
        if (targetWs) sendTo(targetWs, { type:'read_receipt', msgId: data.msgId });
        break;
      }

      case 'reaction': {
        // Broadcast to channel or DM peer
        const reactionMsg = { ...data, from: user.username };
        if (data.dm && data.to) {
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
      // Clean up group call rooms
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
