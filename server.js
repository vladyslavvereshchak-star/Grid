const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const channels = { 'общий': [], 'игры': [], 'фидбек': [] };
const onlineUsers = new Map(); // ws -> { name, tag, color, channel }
const dmHistory = new Map();   // "tag1|tag2" -> []

function dmKey(t1, t2) {
  return [t1, t2].sort().join('|');
}

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
    name: u.name, tag: u.tag, color: u.color, channel: u.channel
  }));
}

function findWsByTag(tag) {
  for (const [ws, u] of onlineUsers) {
    if (u.tag === tag) return ws;
  }
  return null;
}

wss.on('connection', (ws) => {
  console.log('+ подключение');

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {

      case 'join': {
        const tag = data.name.replace(/\s/g, '') + '#' + String(Math.floor(Math.random() * 9999)).padStart(4, '0');
        const colors = ['#4af0c0','#6ab4ff','#f0b44a','#c084fc','#f06a8a','#7af06a'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        onlineUsers.set(ws, { name: data.name, tag, color, channel: 'общий' });

        sendTo(ws, {
          type: 'welcome',
          name: data.name,
          tag,
          color,
          history: channels['общий'].slice(-50)
        });

        broadcast({ type: 'user_joined', name: data.name, tag, color, users: getUserList() });
        broadcast({ type: 'system', text: `${data.name} зашёл в сеть`, channel: 'общий' });
        console.log(`Вошёл: ${data.name} (${tag})`);
        break;
      }

      case 'message': {
        const user = onlineUsers.get(ws);
        if (!user) break;
        const ch = data.channel || user.channel;
        const msg = {
          type: 'message',
          id: Date.now() + Math.random(),
          name: user.name,
          tag: user.tag,
          color: user.color,
          text: data.text,
          channel: ch,
          time: new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
        };
        if (!channels[ch]) channels[ch] = [];
        channels[ch].push(msg);
        if (channels[ch].length > 200) channels[ch].shift();
        broadcast(msg);
        sendTo(ws, msg);
        break;
      }

      case 'dm': {
        // Личное сообщение
        const sender = onlineUsers.get(ws);
        if (!sender) break;
        const recipientWs = findWsByTag(data.to);
        const key = dmKey(sender.tag, data.to);
        const msg = {
          type: 'dm',
          id: Date.now() + Math.random(),
          from: sender.name,
          fromTag: sender.tag,
          fromColor: sender.color,
          to: data.to,
          text: data.text,
          time: new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
        };
        if (!dmHistory.has(key)) dmHistory.set(key, []);
        const hist = dmHistory.get(key);
        hist.push(msg);
        if (hist.length > 200) hist.shift();

        // Отправить отправителю
        sendTo(ws, msg);
        // Отправить получателю (если онлайн)
        if (recipientWs) sendTo(recipientWs, msg);
        break;
      }

      case 'dm_history': {
        // Запрос истории ЛС
        const user = onlineUsers.get(ws);
        if (!user) break;
        const key = dmKey(user.tag, data.withTag);
        const hist = dmHistory.get(key) || [];
        sendTo(ws, { type: 'dm_history', withTag: data.withTag, history: hist.slice(-50) });
        break;
      }

      case 'switch_channel': {
        const user = onlineUsers.get(ws);
        if (!user) break;
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
        const user = onlineUsers.get(ws);
        if (!user) break;
        if (data.dm) {
          const recipientWs = findWsByTag(data.to);
          if (recipientWs) sendTo(recipientWs, { type: 'dm_typing', from: user.name, fromTag: user.tag });
        } else {
          broadcast({ type: 'typing', name: user.name, channel: data.channel }, ws);
        }
        break;
      }

      case 'friend_request_send': {
        // Переслать заявку конкретному юзеру
        const sender = onlineUsers.get(ws);
        if (!sender) break;
        const targetWs = findWsByTag(data.toTag);
        if (targetWs) {
          sendTo(targetWs, {
            type: 'friend_request',
            from: sender.name,
            fromTag: sender.tag,
            fromColor: sender.color
          });
        }
        break;
      }

      case 'friend_accept': {
        // Сообщить отправителю что заявка принята
        const accepter = onlineUsers.get(ws);
        if (!accepter) break;
        const requesterWs = findWsByTag(data.toTag);
        if (requesterWs) {
          sendTo(requesterWs, {
            type: 'friend_accepted',
            name: accepter.name,
            tag: accepter.tag,
            color: accepter.color
          });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const user = onlineUsers.get(ws);
    if (user) {
      broadcast({ type: 'system', text: `${user.name} вышел`, channel: 'общий' });
      broadcast({ type: 'user_left', tag: user.tag, users: getUserList() });
      onlineUsers.delete(ws);
      console.log(`- вышел: ${user.name}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ Grid сервер запущен`);
  console.log(`📡 Открой в браузере: http://localhost:${PORT}`);
  console.log(`🌐 Друзья в сети: http://[ТВОЙ_IP]:${PORT}\n`);
});

// Патч: добавить обработку friend_request/accept в wss.on message
// (уже включено в основной server.js выше через switch-case)
