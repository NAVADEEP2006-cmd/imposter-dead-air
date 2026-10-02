'use strict';
const crypto = require('crypto');
const WORDS = require('./words.js');

const MIN = 4, MAX = 12, VOTE_MS = 60000, DISC_MS = 120000, GRACE_MS = 30000;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const int = n => crypto.randomInt(n);
const pick = a => a[int(a.length)];
function shuffle(a) { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = int(i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; }
const token = () => crypto.randomBytes(16).toString('hex');
const clean = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);

class Err extends Error {}
const rooms = new Map();

function makeCode() { let c; do { c = Array.from({ length: 6 }, () => ALPHA[int(ALPHA.length)]).join(''); } while (rooms.has(c)); return c; }

function createRoom() {
  const room = { code: makeCode(), phase: 'lobby', players: [], hostId: null, round: 0, game: null, lastOrder: null, category: 'RANDOM', timer: null, onChange: () => {} };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name) {
  name = clean(name);
  if (!name) throw new Err('Enter a name first.');
  if (room.phase !== 'lobby') throw new Err('That game already started.');
  if (room.players.length >= MAX) throw new Err('Room is full.');
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Err('That name is already taken.');
  const p = { id: token().slice(0, 8), token: token(), name, ready: false, connected: true, seed: int(1e6), leftAt: null };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

function authPlayer(room, id, tok) {
  const p = room.players.find(x => x.id === id);
  if (!p || p.token !== tok) throw new Err('Your session expired. Rejoin the room.');
  return p;
}

function removePlayer(room, id) {
  room.players = room.players.filter(p => p.id !== id);
  if (room.game) { room.game.order = room.game.order.filter(x => x !== id); delete room.game.votes[id]; }
  if (room.hostId === id) migrateHost(room);
  if (room.phase !== 'lobby') checkAbort(room);
}

function migrateHost(room) {
  const next = room.players.find(p => p.connected) || room.players[0];
  room.hostId = next ? next.id : null;
}

function checkAbort(room) {
  const g = room.game; if (!g) return;
  const alive = room.players.filter(p => g.roster.includes(p.id));
  if (alive.length < 3 || !alive.some(p => p.id !== g.impostor)) return toLobby(room, 'Too many players left. Back to the lobby.');
  if (!g.roster.includes(g.impostor) || !room.players.some(p => p.id === g.impostor)) return finish(room, 'civilians', null, 'The impostor left the game.');
  if (room.phase === 'voting') maybeResolve(room);
}

function clearTimer(room) { clearTimeout(room.timer); room.timer = null; }
function arm(room, ms, fn) { clearTimer(room); const r = room.round; room.deadline = Date.now() + ms; room.timer = setTimeout(() => { if (room.round === r) fn(); }, ms); }

function toLobby(room, notice) {
  clearTimer(room); room.phase = 'lobby'; room.game = null; room.deadline = null; room.notice = notice || null;
  room.players = room.players.filter(p => p.connected); room.players.forEach(p => { p.ready = false; });
  if (!room.players.some(p => p.id === room.hostId)) migrateHost(room);
}

// Speaking order is a fresh CSPRNG shuffle; reshuffle if it equals last round's order or opens with last round's starter.
function randomOrder(ids, last) {
  let o, tries = 0;
  do { o = shuffle(ids); tries++; } while (last && ids.length > 2 && tries < 20 && (o[0] === last[0] || o.join() === last.join()));
  return o;
}

function startGame(room, byId) {
  if (room.hostId !== byId) throw new Err('Only the host can start.');
  if (room.phase !== 'lobby') throw new Err('A round is already running.');
  const ready = room.players.filter(p => p.connected);
  if (ready.length < MIN) throw new Err(`You need at least ${MIN} players to start.`);
  if (ready.some(p => p.id !== room.hostId && !p.ready)) throw new Err('Waiting for everyone to get ready.');
  room.players = ready; room.round++;
  const cats = Object.keys(WORDS);
  const category = room.category !== 'RANDOM' && WORDS[room.category] ? room.category : pick(cats);
  const word = pick(WORDS[category].split(';')).split('|')[0];
  const ids = ready.map(p => p.id);
  const order = randomOrder(ids, room.lastOrder); room.lastOrder = order;
  room.game = { category, word, impostor: pick(ids), roster: ids, order, turn: 0, votes: {}, revealedTo: new Set(), result: null };
  room.phase = 'reveal'; room.notice = null;
  arm(room, 8000, () => beginDiscussion(room));
}

function beginDiscussion(room) {
  if (room.phase !== 'reveal') return;
  room.phase = 'discussion'; room.game.turn = 0;
  arm(room, DISC_MS, () => beginVoting(room));
  room.onChange();
}

function endTurn(room, id) {
  const g = room.game;
  if (room.phase !== 'discussion') throw new Err('Not the discussion phase.');
  if (g.order[g.turn] !== id) throw new Err("It's not your turn.");
  g.turn++;
  if (g.turn >= g.order.length) beginVoting(room);
}

function beginVoting(room) {
  if (room.phase !== 'discussion') return;
  room.phase = 'voting'; room.game.votes = {};
  arm(room, VOTE_MS, () => resolveVotes(room));
  room.onChange();
}

function castVote(room, id, target) {
  const g = room.game;
  if (room.phase !== 'voting') throw new Err('Voting is closed.');
  if (!g.roster.includes(id)) throw new Err('You are not in this round.');
  if (id in g.votes) throw new Err('You already voted.');
  if (target === id || !g.roster.includes(target)) throw new Err('Pick another player.');
  g.votes[id] = target;
  maybeResolve(room);
}

function maybeResolve(room) {
  const g = room.game;
  const voters = room.players.filter(p => g.roster.includes(p.id) && p.connected);
  if (voters.every(p => p.id in g.votes)) resolveVotes(room);
}

// Tie rule: the impostor escapes. No votes at all: the impostor escapes.
function resolveVotes(room) {
  if (room.phase !== 'voting') return;
  const g = room.game, tally = {};
  Object.values(g.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
  const top = Math.max(0, ...Object.values(tally));
  const leaders = Object.keys(tally).filter(k => tally[k] === top);
  if (!top || leaders.length !== 1) return finish(room, 'impostor', null, 'The vote was tied. The impostor slips away.', tally);
  const caught = leaders[0] === g.impostor;
  finish(room, caught ? 'civilians' : 'impostor', leaders[0], caught ? 'The crew found the impostor.' : 'The crew voted out an innocent.', tally);
}

function finish(room, winner, eliminated, text, tally) {
  clearTimer(room); room.phase = 'results'; room.deadline = null;
  room.game.result = { winner, eliminated, text, tally: tally || {}, votes: { ...room.game.votes } };
  room.onChange();
}

function nextRound(room, byId) {
  if (room.hostId !== byId) throw new Err('Only the host can continue.');
  if (room.phase !== 'results') throw new Err('The round is not over yet.');
  toLobby(room);
}

// NEW: Play Again — same players, new secrets, skip lobby
function playAgain(room, byId) {
  if (room.hostId !== byId) throw new Err('Only the host can continue.');
  if (room.phase !== 'results') throw new Err('The round is not over yet.');
  const ready = room.players.filter(p => p.connected);
  if (ready.length < MIN) {
    toLobby(room, `Not enough players to continue. Need ${MIN}.`);
    return;
  }
  // Remove disconnected players
  room.players = ready;
  room.round++;
  const cats = Object.keys(WORDS);
  const category = room.category !== 'RANDOM' && WORDS[room.category] ? room.category : pick(cats);
  const word = pick(WORDS[category].split(';')).split('|')[0];
  const ids = ready.map(p => p.id);
  const order = randomOrder(ids, room.lastOrder); room.lastOrder = order;
  room.game = { category, word, impostor: pick(ids), roster: ids, order, turn: 0, votes: {}, revealedTo: new Set(), result: null };
  room.phase = 'reveal'; room.notice = null;
  arm(room, 8000, () => beginDiscussion(room));
  room.onChange();
}

// Public view for one player. Secrets (word, impostor, individual votes) are only ever included when that player is entitled to them.
function viewFor(room, pid) {
  const g = room.game;
  const v = { code: room.code, phase: room.phase, round: room.round, hostId: room.hostId, you: pid, category: room.category, deadline: room.deadline || null, notice: room.notice || null,
    players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, connected: p.connected, seed: p.seed })) };
  if (!g) return v;
  const isImp = g.impostor === pid;
  v.game = { category: g.category, order: g.order, turn: g.turn, speaker: room.phase === 'discussion' ? g.order[g.turn] : null, voted: Object.keys(g.votes), roster: g.roster };
  if (['reveal', 'discussion', 'voting'].includes(room.phase)) v.secret = isImp ? { impostor: true } : { impostor: false, word: g.word };
  if (room.phase === 'results') v.result = { ...g.result, impostor: g.impostor, word: g.word };
  return v;
}

function sweep(now = Date.now()) {
  for (const [code, room] of rooms) {
    room.players.filter(p => !p.connected && p.leftAt && now - p.leftAt > GRACE_MS).forEach(p => removePlayer(room, p.id));
    if (!room.players.length) { clearTimer(room); rooms.delete(code); } else room.onChange();
  }
}

module.exports = { maybeResolve, Err, rooms, createRoom, addPlayer, authPlayer, removePlayer, startGame, endTurn, castVote, resolveVotes, nextRound, playAgain, beginDiscussion, beginVoting, viewFor, randomOrder, sweep, migrateHost, MIN, MAX };
