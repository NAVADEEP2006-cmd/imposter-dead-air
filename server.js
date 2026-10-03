'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./game.js');
const SV = require('./salvage.js');
const { normalize } = require('./scripts/validate-words.js');

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

// ─── Static file server (Strictly from public/ directory) ───
const PUB = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Health check endpoint for cloud platforms (Render, Fly.io, etc.)
  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      rooms: G.rooms.size,
      hasTurn: !!TURN_URL
    }));
  }

  const file = url === '/' ? 'index.html' : path.basename(url);

  // Security: Prevent directory traversal and backend source file exposure
  if (file.includes('..') || file.includes('\0') || ['server.js', 'game.js', 'words.js', 'package.json'].includes(file)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const filePath = path.join(PUB, file);
  fs.readFile(filePath, (e, buf) => {
    if (e) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    };
    // Inject runtime configuration into HTML
    if (file === 'index.html') {
      let html = buf.toString();
      const appConfig = {
        categories: Object.keys(require('./words.js')),
        ice: {
          servers: iceServers(),
          hasTurn: !!TURN_URL
        }
      };
      const configScript = `<script id="app-config">\nwindow.APP_CONFIG = ${JSON.stringify(appConfig)};\n</script>`;
      if (html.includes('<script id="app-config">')) {
        html = html.replace(/<script id="app-config">[\s\S]*?<\/script>/, configScript);
      } else {
        html = html.replace('<script>', `${configScript}\n<script>`);
      }
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

wss.on('error', err => {
  console.warn('WebSocket server error:', err.message);
});

const send = (ws, m) => {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(m));
    } catch {}
  }
};

function push(room) {
  for (const p of room.players) {
    const w = socks.get(p.id);
    if (w) send(w, { t: 'state', s: G.viewFor(room, p.id) });
  }
}

function hookRoom(room) {
  room.onChange = () => push(room);
}

const fail = (ws, e) => send(ws, { t: 'error', msg: e instanceof G.Err ? e.message : 'Something went wrong. Try again.' });

// ─── Heartbeat mechanism (ping/pong dead socket detection) ───
const HEARTBEAT_INTERVAL = 30000;
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_INTERVAL);
heartbeatTimer.unref();

wss.on('connection', ws => {
  ws.ctx = null;
  ws.hits = 0;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('error', err => {
    console.warn('WebSocket client socket error:', err.message);
  });

  const rate = setInterval(() => { ws.hits = 0; }, 1000);

  ws.on('message', raw => {
    if (++ws.hits > 25) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

    // Heartbeat application-level ping/pong
    if (m.t === 'ping') {
      ws.isAlive = true;
      send(ws, { t: 'pong' });
      return;
    }

    try {
      if (m.t === 'create' || m.t === 'join' || m.t === 'resume') return enter(ws, m);
      if (!ws.ctx) throw new G.Err('Join a room first.');
      const room = G.rooms.get(ws.ctx.code);
      if (!room) throw new G.Err('Room not found.');
      const p = G.authPlayer(room, ws.ctx.id, ws.ctx.token);

      // Extract roundId from message for stale action prevention
      const rid = m.roundId || null;

      if (m.t === 'ready' && room.phase === 'lobby') {
        p.ready = !!m.v;
      } else if (m.t === 'mode' && room.hostId === p.id && room.phase === 'lobby') {
        const v = String(m.v || 'classic');
        room.mode = v === 'salvage' ? 'salvage' : 'classic';
      } else if (m.t === 'category' && room.hostId === p.id && room.phase === 'lobby') {
        room.category = String(m.v).slice(0, 30);
      } else if (m.t === 'start') {
        if (room.mode === 'salvage') {
          if (room.hostId !== p.id) throw new SV.SalvageErr('Only the host can start the haul.');
          SV.beginRun(room, p.id);
        }
        else G.startGame(room, p.id);
      } else if (m.t === 'haul_open' && room.hostId === p.id) {
        if (!room.salvage || room.phase !== 'salvage-staging') throw new SV.SalvageErr('Haul is not staging.');
        SV.openHaul(room);
      } else if (m.t === 'move' && room.salvage) {
        if ((rid || m.haulId) && (rid || m.haulId) !== room.roundId) throw new SV.SalvageErr('Stale haul action.');
        if (!room.salvage.roster.includes(p.id)) throw new SV.SalvageErr('You are not on this haul.');
        SV.movePlayer(room.salvage, p.id, Number(m.x), Number(m.y));
        push(room);
        return;
      } else if (m.t === 'grab' && room.salvage) {
        if ((rid || m.haulId) && (rid || m.haulId) !== room.roundId) throw new SV.SalvageErr('Stale haul action.');
        if (!room.salvage.roster.includes(p.id)) throw new SV.SalvageErr('You are not on this haul.');
        SV.pickup(room.salvage, p.id, String(m.item));
      } else if (m.t === 'drop' && room.salvage) {
        if ((rid || m.haulId) && (rid || m.haulId) !== room.roundId) throw new SV.SalvageErr('Stale haul action.');
        if (!room.salvage.roster.includes(p.id)) throw new SV.SalvageErr('You are not on this haul.');
        SV.dropItem(room.salvage, p.id, String(m.item));
      } else if (m.t === 'patch' && room.salvage) {
        if ((rid || m.haulId) && (rid || m.haulId) !== room.roundId) throw new SV.SalvageErr('Stale haul action.');
        if (!room.salvage.roster.includes(p.id)) throw new SV.SalvageErr('You are not on this haul.');
        SV.useKit(room.salvage, p.id, String(m.target));
      } else if (m.t === 'bank' && room.salvage) {
        if ((rid || m.haulId) && (rid || m.haulId) !== room.roundId) throw new SV.SalvageErr('Stale haul action.');
        if (!room.salvage.roster.includes(p.id)) throw new SV.SalvageErr('You are not on this haul.');
        SV.deliver(room.salvage, p.id);
      } else if (m.t === 'quit_haul' && room.hostId === p.id && room.salvage) {
        SV.quitToLobby(room);
      } else if (m.t === 'again_haul' && room.hostId === p.id && room.phase === 'salvage-debrief') {
        SV.quitToLobby(room);
        room.players.forEach(x => { x.ready = true; });
        SV.beginRun(room, p.id);
      } else if (m.t === 'clue') {
        G.submitClue(room, p.id, m.word, rid);
      } else if (m.t === 'ready_discuss') {
        G.readyDiscussion(room, p.id, m.v, rid);
      } else if (m.t === 'vote') {
        G.castVote(room, p.id, String(m.target), rid);
      } else if (m.t === 'revote') {
        G.castRevote(room, p.id, String(m.target), rid);
      } else if (m.t === 'guess') {
        G.submitGuess(room, p.id, String(m.word), rid);
      } else if (m.t === 'next') {
        G.nextRound(room, p.id);
      } else if (m.t === 'again') {
        G.playAgain(room, p.id);
      } else if (m.t === 'leave') {
        if (room.salvage && room.salvage.parts[p.id]) {
          try { SV.dropAll(room.salvage, p.id); } catch {}
        }
        G.removePlayer(room, p.id);
        socks.delete(p.id);
        ws.ctx = null;
        if (!room.players.length) {
          G.clearTimer(room);
          G.rooms.delete(room.code);
        }
      } else if (m.t === 'rtc' && typeof m.to === 'string' && room.players.some(x => x.id === m.to)) {
        const w = socks.get(m.to);
        if (w) send(w, { t: 'rtc', from: p.id, data: m.data });
        return;
      } else if (m.t === 'speaking') {
        for (const x of room.players) {
          const w = socks.get(x.id);
          if (w && x.id !== p.id) send(w, { t: 'speaking', id: p.id, v: !!m.v });
        }
        return;
      } else if (m.t === 'chat') {
        const text = String(m.msg || '').trim().slice(0, 150);
        if (!text) return;

        // Reject chat from spectators in active game phases (they can only observe)
        if (p.spectator && room.game && room.phase !== 'result') return;

        // Reject messages after certain phase transitions (e.g. invalid or terminated phases)
        const chatAllowedPhases = ['lobby', 'reveal', 'clues', 'discussion', 'vote', 'defense', 'revote', 'guess', 'result'];
        if (room.game && !chatAllowedPhases.includes(room.phase)) {
          send(ws, { t: 'chat_rejected', msg: 'Chat is not available during this phase.' });
          return;
        }

        // CHAT SECURITY:
        // CREW: Messages containing secret word / forbidden variants are rejected.
        // Generic rejection shown ONLY to sender. Message must never appear publicly.
        // IMPOSTER: Messages are NEVER filtered against the secret word.
        if (room.game && room.phase !== 'result' && p.id !== room.game.impostor && !p.spectator) {
          const targetNorm = normalize(room.game.word);
          const forbiddenNorms = (room.game.wordObj.forbiddenVariants || []).map(normalize);
          const aliasNorms = (room.game.wordObj.aliases || []).map(normalize);

          const tokens = text.toLowerCase().split(/[^a-z0-9]+/).map(t => normalize(t)).filter(Boolean);
          const normText = normalize(text);
          const containsForbidden = tokens.some(t => t === targetNorm || forbiddenNorms.includes(t) || aliasNorms.includes(t)) ||
                                    normText.includes(targetNorm);

          if (containsForbidden) {
            send(ws, { t: 'chat_rejected', msg: 'Message blocked: transmission contains restricted terms.' });
            return;
          }
        }

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
        return;
      }
      push(room);
    } catch (e) {
      if (e instanceof SV.SalvageErr) send(ws, { t: 'error', msg: e.message });
      else fail(ws, e);
    }
  });

  ws.on('close', () => {
    clearInterval(rate);
    if (!ws.ctx || socks.get(ws.ctx.id) !== ws) return;
    socks.delete(ws.ctx.id);
    const room = G.rooms.get(ws.ctx.code);
    if (!room) return;
    const p = room.players.find(x => x.id === ws.ctx.id);
    if (!p) return;
    p.connected = false;
    p.leftAt = Date.now();

    if (room.hostId === p.id) {
      G.migrateHost(room);
    }

    // Phase-specific disconnect handling
    if (room.game) {
      if (room.phase === 'clues' && room.game.order[room.game.clueIndex] === p.id) {
        // Don't call submitClue (it would validate); record NO CLUE directly
        const g = room.game;
        g.clues.push({ pid: p.id, text: 'NO CLUE', position: g.clueIndex, timedOut: true, time: Date.now() });
        G.advanceClue(room);
      }
      G.checkAbort(room, p);
    }
    push(room);
  });
});

function enter(ws, m) {
  let room, p;
  if (m.t === 'create') {
    room = G.createRoom();
    hookRoom(room);
    p = G.addPlayer(room, m.name);
  } else {
    room = G.rooms.get(String(m.code || '').toUpperCase());
    if (!room) throw new G.Err('Room not found.');
    if (m.t === 'resume') {
      p = G.authPlayer(room, m.id, m.token);
    } else {
      p = G.addPlayer(room, m.name);
    }
    if (!room.onChange || room.onChange.toString() === '() => {}') hookRoom(room);
  }

  // Duplicate connection handling: close old socket deterministically
  const old = socks.get(p.id);
  if (old && old !== ws) {
    old.ctx = null;
    try {
      old.close(1000, 'Replaced by newer session');
    } catch {}
  }

  p.connected = true;
  p.leftAt = null;

  // If room currently has no host or host is disconnected, assign host
  if (!room.hostId || !room.players.some(x => x.id === room.hostId && x.connected)) {
    G.migrateHost(room);
  }

  ws.ctx = { code: room.code, id: p.id, token: p.token };
  socks.set(p.id, ws);
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
  clearInterval(heartbeatTimer);
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
