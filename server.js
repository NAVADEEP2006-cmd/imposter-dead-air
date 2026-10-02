'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./game.js');

// ─── Configuration ───
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const TURN_URL = process.env.TURN_URL || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

// ─── ICE Server config (sent to clients for WebRTC) ───
function iceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  if (TURN_URL) {
    servers.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
  }
  return servers;
}

// ─── Static file server ───
const PUB = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Health check endpoint for cloud platforms
  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()), rooms: G.rooms.size }));
  }

  const file = url === '/' ? 'index.html' : path.basename(url);

  // Prevent directory traversal
  if (file.includes('..') || file.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }

  fs.readFile(path.join(PUB, file), (e, buf) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    };
    // Inject categories and ICE config into HTML
    if (file === 'index.html') {
      let html = buf.toString();
      html = html.replace('__CATS__', JSON.stringify(Object.keys(require('./words.js'))));
      html = html.replace('__ICE__', JSON.stringify(iceServers()));
      buf = Buffer.from(html, 'utf-8');
      headers['Content-Length'] = buf.length;
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
});

// ─── WebSocket server ───
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });
const socks = new Map(); // playerId -> ws

const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

function push(room) {
  for (const p of room.players) {
    const w = socks.get(p.id);
    if (w) send(w, { t: 'state', s: G.viewFor(room, p.id) });
  }
}

function hookRoom(room) { room.onChange = () => push(room); }

const fail = (ws, e) => send(ws, { t: 'error', msg: e instanceof G.Err ? e.message : 'Something went wrong. Try again.' });

wss.on('connection', ws => {
  ws.ctx = null; ws.hits = 0;
  const rate = setInterval(() => { ws.hits = 0; }, 1000);

  ws.on('message', raw => {
    if (++ws.hits > 20) return;
    let m; try { m = JSON.parse(raw); } catch { return; }

    // Validate message is a non-null object and type is a known string
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

    try {
      if (m.t === 'create' || m.t === 'join' || m.t === 'resume') return enter(ws, m);
      if (!ws.ctx) throw new G.Err('Join a room first.');
      const room = G.rooms.get(ws.ctx.code); if (!room) throw new G.Err('Room not found.');
      const p = G.authPlayer(room, ws.ctx.id, ws.ctx.token); // identity always comes from the socket, never the message

      if (m.t === 'ready' && room.phase === 'lobby') p.ready = !!m.v;
      else if (m.t === 'category' && room.hostId === p.id && room.phase === 'lobby') room.category = String(m.v).slice(0, 30);
      else if (m.t === 'start') G.startGame(room, p.id);
      else if (m.t === 'endturn') G.endTurn(room, p.id);
      else if (m.t === 'vote') G.castVote(room, p.id, String(m.target));
      else if (m.t === 'next') G.nextRound(room, p.id);
      else if (m.t === 'again') G.playAgain(room, p.id);
      else if (m.t === 'leave') {
        G.removePlayer(room, p.id);
        socks.delete(p.id);
        ws.ctx = null;
        if (!room.players.length) G.rooms.delete(room.code);
      }
      else if (m.t === 'rtc' && typeof m.to === 'string' && room.players.some(x => x.id === m.to)) {
        const w = socks.get(m.to);
        if (w) send(w, { t: 'rtc', from: p.id, data: m.data });
        return; // Don't push state for RTC relay
      }
      else if (m.t === 'speaking') {
        for (const x of room.players) {
          const w = socks.get(x.id);
          if (w && x.id !== p.id) send(w, { t: 'speaking', id: p.id, v: !!m.v });
        }
        return; // Don't push state for speaking indicator
      }
      else if (m.t === 'chat') {
        const text = String(m.msg || '').trim().slice(0, 150);
        if (!text) return;
        const chatData = {
          t: 'chat',
          id: p.id,
          name: p.name,
          seed: p.seed,
          msg: text,
          time: Date.now()
        };
        for (const x of room.players) {
          const w = socks.get(x.id);
          if (w) send(w, chatData);
        }
        return; // Don't push full game state
      }
      push(room);
    } catch (e) { fail(ws, e); }
  });

  ws.on('close', () => {
    clearInterval(rate);
    if (!ws.ctx || socks.get(ws.ctx.id) !== ws) return;
    socks.delete(ws.ctx.id);
    const room = G.rooms.get(ws.ctx.code); const p = room && room.players.find(x => x.id === ws.ctx.id);
    if (!p) return;
    p.connected = false; p.leftAt = Date.now();
    if (room.hostId === p.id) G.migrateHost(room);
    if (room.phase === 'voting') G.maybeResolve(room);
    else if (room.phase === 'discussion' && room.game.order[room.game.turn] === p.id) G.endTurn(room, p.id);
    push(room);
  });
});

function enter(ws, m) {
  let room, p;
  if (m.t === 'create') { room = G.createRoom(); hookRoom(room); p = G.addPlayer(room, m.name); }
  else {
    room = G.rooms.get(String(m.code || '').toUpperCase());
    if (!room) throw new G.Err('Room not found.');
    if (m.t === 'resume') { p = G.authPlayer(room, m.id, m.token); }
    else p = G.addPlayer(room, m.name);
    if (!room.onChange || room.onChange.toString() === '() => {}') hookRoom(room);
  }
  const old = socks.get(p.id); if (old && old !== ws) { old.ctx = null; old.close(); } // duplicate connection: newest wins
  p.connected = true; p.leftAt = null;
  ws.ctx = { code: room.code, id: p.id, token: p.token }; socks.set(p.id, ws);
  send(ws, { t: 'joined', id: p.id, token: p.token, code: room.code });
  push(room);
}

// Sweep disconnected players past grace period
setInterval(() => G.sweep(), 5000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

function shutdown() {
  console.log('Shutting down server gracefully...');
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, wss };
