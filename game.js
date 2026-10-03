'use strict';
const crypto = require('crypto');
const WORDS = require('./words.js');
const { normalize, levenshtein } = require('./scripts/validate-words.js');

const MIN = 4, MAX = 10;
const REVEAL_MS = 10000;
const CLUE_CAP_MS = 25000;
const VOTE_MS = 30000;
const TIE_DEFENSE_MS = 15000;
const TIE_REVOTE_MS = 20000;
const VERDICT_MS = 5000;
const FINAL_GUESS_MS = 30000;
const GRACE_MS = 30000;

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const int = n => crypto.randomInt(n);
const pick = a => a[int(a.length)];
function shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
const token = () => crypto.randomBytes(16).toString('hex');
const clean = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);

class Err extends Error {}
const rooms = new Map();

// Global telemetry collection
const telemetry = {
  rounds: [],
  imposterWins: 0,
  crewWins: 0,
  voidedRounds: 0,
  imposterDisconnects: 0
};

function makeCode() {
  let c;
  do {
    c = Array.from({ length: 6 }, () => ALPHA[int(ALPHA.length)]).join('');
  } while (rooms.has(c));
  return c;
}

function createRoom() {
  const room = {
    code: makeCode(),
    phase: 'lobby',
    players: [],
    hostId: null,
    round: 0,
    game: null,
    lastOrder: null,
    lastImpostor: null,
    lastCategory: null,
    category: 'RANDOM',
    usedWords: new Set(),
    timer: null,
    deadline: null,
    timerToken: null,
    timerPhase: null,
    notice: null,
    stats: {
      clueRejections: 0,
      clueTimeouts: 0,
      duplicateRejections: 0,
      ties: 0
    },
    onChange: () => {}
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name) {
  name = clean(name);
  if (!name) throw new Err('Enter a name first.');
  if (room.players.length >= MAX) throw new Err('Room is full.');
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Err('That name is already taken.');
  }

  const isSpectator = room.phase !== 'lobby';
  const p = {
    id: token().slice(0, 8),
    token: token(),
    name,
    ready: false,
    discussReady: false,
    connected: true,
    spectator: isSpectator,
    seed: int(1e6),
    leftAt: null
  };

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
  const p = room.players.find(x => x.id === id);
  room.players = room.players.filter(x => x.id !== id);

  if (room.game) {
    delete room.game.votes[id];
    delete room.game.revotes[id];

    // Clue turn disconnect handling
    if (room.phase === 'clues' && room.game.order[room.game.clueIndex] === id) {
      recordClue(room, id, 'NO CLUE', true);
      advanceClue(room);
    }
  }

  if (room.hostId === id) migrateHost(room);
  if (room.phase !== 'lobby') checkAbort(room, p);
}

function migrateHost(room) {
  const next = room.players.find(p => p.connected) || room.players[0];
  room.hostId = next ? next.id : null;
}

function checkAbort(room, leftPlayer) {
  const g = room.game;
  if (!g) return;

  const connectedActive = room.players.filter(p => g.roster.includes(p.id) && p.connected);

  // If Imposter leaves permanently or disconnects mid-round without returning
  if (leftPlayer && leftPlayer.id === g.impostor) {
    telemetry.imposterDisconnects++;
    telemetry.voidedRounds++;
    return toLobby(room, 'The imposter left the game. Round voided.');
  }

  // Fewer than 4 players remaining -> round voided
  if (connectedActive.length < MIN) {
    telemetry.voidedRounds++;
    return toLobby(room, 'Fewer than 4 players remain. Round voided.');
  }

  if (room.phase === 'voting') maybeResolveVotes(room);
  if (room.phase === 'tie_revote') maybeResolveRevotes(room);
  if (room.phase === 'discussion') maybeResolveDiscussionReady(room);
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  room.deadline = null;
  room.timerToken = null;
  room.timerPhase = null;
}

function armPhase(room, phase, ms, fn) {
  clearTimer(room);
  const r = room.round;
  const tokenInstance = crypto.randomBytes(8).toString('hex');
  room.phase = phase;
  room.timerPhase = phase;
  room.timerToken = tokenInstance;
  room.deadline = Date.now() + ms;

  room.timer = setTimeout(() => {
    if (room.round === r && room.phase === phase && room.timerToken === tokenInstance) {
      fn();
    }
  }, ms);
}

function toLobby(room, notice) {
  clearTimer(room);
  room.phase = 'lobby';
  room.game = null;
  room.notice = notice || null;
  room.players = room.players.filter(p => p.connected);
  room.players.forEach(p => {
    p.ready = false;
    p.discussReady = false;
    p.spectator = false;
  });
  if (!room.players.some(p => p.id === room.hostId && p.connected)) {
    migrateHost(room);
  }
}

function randomOrder(ids, last) {
  let o, tries = 0;
  do {
    o = shuffle(ids);
    tries++;
  } while (last && ids.length > 2 && tries < 20 && (o[0] === last[0] || o.join() === last.join()));
  return o;
}

function selectCategoryAndWord(room) {
  const cats = Object.keys(WORDS);
  let availableCats = cats;
  if (room.lastCategory && cats.length > 1) {
    availableCats = cats.filter(c => c !== room.lastCategory);
  }

  const category = (room.category !== 'RANDOM' && WORDS[room.category])
    ? room.category
    : pick(availableCats);

  room.lastCategory = category;

  const pool = WORDS[category];
  let unplayed = pool.filter(w => !room.usedWords.has(w.word));
  if (!unplayed.length) {
    // Reset used words for this category once exhausted
    pool.forEach(w => room.usedWords.delete(w.word));
    unplayed = pool;
  }

  const wordObj = pick(unplayed);
  room.usedWords.add(wordObj.word);
  return { category, wordObj };
}

function startGame(room, byId) {
  if (room.hostId !== byId) throw new Err('Only the host can start.');
  if (room.phase !== 'lobby') throw new Err('A round is already running.');

  const readyPlayers = room.players.filter(p => p.connected && !p.spectator);
  if (readyPlayers.length < MIN) throw new Err(`You need at least ${MIN} players to start.`);
  if (readyPlayers.some(p => p.id !== room.hostId && !p.ready)) {
    throw new Err('Waiting for everyone to get ready.');
  }

  room.players = readyPlayers;
  room.round++;

  const { category, wordObj } = selectCategoryAndWord(room);
  const ids = readyPlayers.map(p => p.id);
  const order = randomOrder(ids, room.lastOrder);
  room.lastOrder = order;

  let impCandidates = ids;
  if (room.lastImpostor && ids.length > 1) {
    const withoutLast = ids.filter(x => x !== room.lastImpostor);
    if (withoutLast.length) impCandidates = withoutLast;
  }
  const impostor = pick(impCandidates);
  room.lastImpostor = impostor;

  const rosterSnapshot = readyPlayers.map(p => ({ id: p.id, name: p.name, seed: p.seed }));

  room.game = {
    category,
    wordObj,
    word: wordObj.word,
    impostor,
    roster: [...ids],
    rosterSnapshot,
    order: [...order],
    clueIndex: 0,
    clues: [],
    clueRejections: {},
    discussionStart: null,
    votes: {},
    tiedCandidates: [],
    revotes: {},
    finalGuess: null,
    result: null,
    startTime: Date.now()
  };

  room.notice = null;
  armPhase(room, 'reveal', REVEAL_MS, () => beginClues(room));
}

// ─── CLUES PHASE ───
function beginClues(room) {
  if (room.phase !== 'reveal') return;
  room.phase = 'clues';
  room.game.clueIndex = 0;
  armClueTurn(room);
  room.onChange();
}

function armClueTurn(room) {
  const g = room.game;
  if (!g || g.clueIndex >= g.order.length) {
    return beginDiscussion(room);
  }

  const currentSpeaker = g.order[g.clueIndex];
  const p = room.players.find(x => x.id === currentSpeaker);

  // If current speaker is disconnected, record NO CLUE immediately and advance
  if (!p || !p.connected) {
    recordClue(room, currentSpeaker, 'NO CLUE', true);
    advanceClue(room);
    return;
  }

  armPhase(room, 'clues', CLUE_CAP_MS, () => {
    room.stats.clueTimeouts++;
    recordClue(room, currentSpeaker, 'NO CLUE', true);
    advanceClue(room);
  });
}

function recordClue(room, pid, text, timedOut) {
  const g = room.game;
  g.clues.push({
    pid,
    text: text.trim(),
    position: g.clueIndex,
    timedOut: !!timedOut,
    time: Date.now()
  });
}

function advanceClue(room) {
  const g = room.game;
  if (!g) return;
  g.clueIndex++;
  if (g.clueIndex < g.order.length) {
    armClueTurn(room);
    room.onChange();
  } else {
    beginDiscussion(room);
  }
}

function submitClue(room, pid, text) {
  const g = room.game;
  if (room.phase !== 'clues') throw new Err('Not the clues phase.');
  if (g.order[g.clueIndex] !== pid) throw new Err("It's not your turn to submit a clue.");

  const clue = String(text || '').trim();
  // Clue requirement: exactly one alphabetic token, reasonable length limit (<= 24 chars)
  if (!clue || !/^[A-Za-z]+$/.test(clue) || clue.length > 24) {
    throw new Err('Clue must be a single word containing only letters (max 24 characters).');
  }

  const norm = normalize(clue);

  // Duplicate detection with lightweight normalization
  const isDuplicate = g.clues.some(c => normalize(c.text) === norm);
  if (isDuplicate) {
    room.stats.duplicateRejections++;
    throw new Err('That clue was already used. Choose another word.');
  }

  // SECRET WORD PROTECTION FOR CREW:
  // Secret word and configured forbidden variants are rejected.
  // Response shown ONLY to the submitting player. Never reveal why it was rejected.
  if (pid !== g.impostor) {
    const targetNorm = normalize(g.wordObj.word);
    const forbiddenNorms = (g.wordObj.forbiddenVariants || []).map(normalize);
    const aliasNorms = (g.wordObj.aliases || []).map(normalize);

    if (norm === targetNorm || forbiddenNorms.includes(norm) || aliasNorms.includes(norm)) {
      room.stats.clueRejections++;
      throw new Err('Invalid clue. Choose another word.');
    }
  }
  // IMPOSTER: NEVER run secret-word validation. Their clue behaves normally.

  recordClue(room, pid, clue, false);
  advanceClue(room);
}

// ─── DISCUSSION PHASE ───
function beginDiscussion(room) {
  if (room.phase !== 'clues' && room.phase !== 'reveal') return;
  const g = room.game;
  room.phase = 'discussion';

  const count = g.roster.length;
  // Dynamic duration: 4-5 players: 90s; 6-8 players: 120s; 9-10 players: 150s
  let durationMs = 120000;
  if (count <= 5) durationMs = 90000;
  else if (count >= 9) durationMs = 150000;

  g.discussionStart = Date.now();
  room.players.forEach(p => { p.discussReady = false; });

  armPhase(room, 'discussion', durationMs, () => beginVoting(room));
  room.onChange();
}

function readyDiscussion(room, pid, v) {
  if (room.phase !== 'discussion') throw new Err('Not the discussion phase.');
  const p = room.players.find(x => x.id === pid);
  if (!p || !room.game.roster.includes(pid)) throw new Err('You are not active in this round.');

  p.discussReady = !!v;
  maybeResolveDiscussionReady(room);
  room.onChange();
}

function maybeResolveDiscussionReady(room) {
  if (room.phase !== 'discussion') return;
  const activeConnected = room.players.filter(p => room.game.roster.includes(p.id) && p.connected);
  if (activeConnected.length > 0 && activeConnected.every(p => p.discussReady)) {
    beginVoting(room);
  }
}

// ─── VOTING PHASE ───
function beginVoting(room) {
  if (!['discussion', 'clues'].includes(room.phase)) return;
  room.phase = 'voting';
  room.game.votes = {};
  armPhase(room, 'voting', VOTE_MS, () => resolveVotes(room));
  room.onChange();
}

function castVote(room, id, target) {
  const g = room.game;
  if (room.phase !== 'voting') throw new Err('Voting is closed.');
  if (!g.roster.includes(id)) throw new Err('You are not in this round.');
  if (id in g.votes) throw new Err('You already voted.');
  if (target === id || !g.roster.includes(target)) throw new Err('Pick another player.');

  g.votes[id] = target;
  maybeResolveVotes(room);
  room.onChange();
}

function maybeResolveVotes(room) {
  const g = room.game;
  if (!g || room.phase !== 'voting') return;
  const voters = room.players.filter(p => g.roster.includes(p.id) && p.connected);
  if (voters.length > 0 && voters.every(p => p.id in g.votes)) {
    resolveVotes(room);
  }
}

function resolveVotes(room) {
  if (room.phase !== 'voting') return;
  const g = room.game;
  const tally = {};
  Object.values(g.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });

  const totalVotes = Object.keys(g.votes).length;

  // If everybody abstains, Imposter wins immediately
  if (totalVotes === 0) {
    return finish(room, 'impostor', null, 'Everyone abstained. The imposter slips away.', tally);
  }

  const top = Math.max(0, ...Object.values(tally));
  const leaders = Object.keys(tally).filter(k => tally[k] === top);

  // TIE HANDLING: All player counts use the same rule
  if (leaders.length > 1) {
    room.stats.ties++;
    return beginTieDefense(room, leaders, tally);
  }

  const eliminated = leaders[0];
  if (eliminated === g.impostor) {
    // Plurality on Imposter -> Imposter gets Final Guess!
    return beginVerdict(room, eliminated, tally);
  } else {
    // Plurality on innocent -> Imposter wins immediately
    return finish(room, 'impostor', eliminated, 'The crew voted out an innocent. The imposter wins!', tally);
  }
}

// ─── TIE DEFENSE & REVOTE ───
function beginTieDefense(room, tiedCandidates, tally) {
  room.phase = 'tie_defense';
  room.game.tiedCandidates = tiedCandidates;
  room.game.tally = tally;
  armPhase(room, 'tie_defense', TIE_DEFENSE_MS, () => beginTieRevote(room));
  room.onChange();
}

function beginTieRevote(room) {
  if (room.phase !== 'tie_defense') return;
  room.phase = 'tie_revote';
  room.game.revotes = {};
  armPhase(room, 'tie_revote', TIE_REVOTE_MS, () => resolveTieRevote(room));
  room.onChange();
}

function castRevote(room, id, target) {
  const g = room.game;
  if (room.phase !== 'tie_revote') throw new Err('Revoting is closed.');
  if (!g.roster.includes(id)) throw new Err('You are not in this round.');
  if (id in g.revotes) throw new Err('You already voted.');
  if (!g.tiedCandidates.includes(target)) throw new Err('You can only vote for a tied player.');
  if (target === id) throw new Err('Tied players cannot vote for themselves.');

  g.revotes[id] = target;
  maybeResolveRevotes(room);
  room.onChange();
}

function maybeResolveRevotes(room) {
  const g = room.game;
  if (!g || room.phase !== 'tie_revote') return;
  const voters = room.players.filter(p => g.roster.includes(p.id) && p.connected);
  if (voters.length > 0 && voters.every(p => p.id in g.revotes)) {
    resolveTieRevote(room);
  }
}

function resolveTieRevote(room) {
  if (room.phase !== 'tie_revote') return;
  const g = room.game;
  const tally = {};
  Object.values(g.revotes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });

  const totalRevotes = Object.keys(g.revotes).length;
  if (totalRevotes === 0) {
    return finish(room, 'impostor', null, 'Everyone abstained in the revote. The imposter slips away.', tally);
  }

  const top = Math.max(0, ...Object.values(tally));
  const leaders = Object.keys(tally).filter(k => tally[k] === top);

  // Second tie = Imposter wins immediately
  if (leaders.length !== 1) {
    return finish(room, 'impostor', null, 'Second tie. The imposter slips away.', tally);
  }

  const eliminated = leaders[0];
  if (eliminated === g.impostor) {
    return beginVerdict(room, eliminated, tally);
  } else {
    return finish(room, 'impostor', eliminated, 'The crew voted out an innocent in the revote. The imposter wins!', tally);
  }
}

// ─── VERDICT & FINAL GUESS ───
function beginVerdict(room, caughtId, tally) {
  room.phase = 'verdict';
  room.game.caughtId = caughtId;
  room.game.tally = tally;
  armPhase(room, 'verdict', VERDICT_MS, () => beginFinalGuess(room));
  room.onChange();
}

function beginFinalGuess(room) {
  if (room.phase !== 'verdict') return;
  room.phase = 'final_guess';
  room.game.finalGuess = null;
  armPhase(room, 'final_guess', FINAL_GUESS_MS, () => resolveFinalGuess(room, null));
  room.onChange();
}

function evaluateFinalGuess(guess, wordObj) {
  if (!guess || typeof guess !== 'string') return false;
  const gNorm = normalize(guess);
  if (!gNorm) return false;

  const validTargets = [
    wordObj.word,
    ...(wordObj.aliases || []),
    ...(wordObj.compoundVariants || [])
  ];

  for (const t of validTargets) {
    const tNorm = normalize(t);
    if (gNorm === tNorm) return true;
    // Controlled fuzzy matching
    const minLen = Math.min(gNorm.length, tNorm.length);
    if (minLen >= 5) {
      const d = levenshtein(gNorm, tNorm);
      if (d <= 1) return true;
      if (minLen >= 8 && d <= 2) return true;
    }
  }
  return false;
}

function submitFinalGuess(room, pid, guessWord) {
  const g = room.game;
  if (room.phase !== 'final_guess') throw new Err('Not the final guess phase.');
  if (pid !== g.impostor) throw new Err('Only the caught imposter can make the final guess.');
  if (g.finalGuess !== null) throw new Err('Final guess has already been submitted.');

  const cleanGuess = String(guessWord || '').trim().slice(0, 30);
  resolveFinalGuess(room, cleanGuess);
}

function resolveFinalGuess(room, guessWord) {
  if (room.phase !== 'final_guess') return;
  const g = room.game;
  const correct = evaluateFinalGuess(guessWord, g.wordObj);

  g.finalGuess = {
    attempted: !!guessWord,
    word: guessWord || null,
    correct
  };

  if (correct) {
    finish(room, 'impostor', g.impostor, `The imposter was caught, but correctly guessed "${g.word}"! Imposter wins!`, g.tally);
  } else {
    finish(room, 'crew', g.impostor, `The crew successfully caught the imposter! The word was "${g.word}".`, g.tally);
  }
}

// ─── RESULTS & TELEMETRY ───
function finish(room, winner, eliminated, text, tally) {
  clearTimer(room);
  room.phase = 'results';
  const g = room.game;

  g.result = {
    winner,
    eliminated,
    text,
    tally: tally || {},
    votes: { ...g.votes },
    revotes: { ...g.revotes },
    finalGuess: g.finalGuess,
    players: g.rosterSnapshot
  };

  // Record Telemetry
  const imposterIndex = g.order.indexOf(g.impostor);
  const discussionTimeSec = g.discussionStart ? Math.round((Date.now() - g.discussionStart) / 1000) : 0;

  telemetry.rounds.push({
    round: room.round,
    playerCount: g.roster.length,
    category: g.category,
    word: g.word,
    winner,
    imposterSpeakingPosition: imposterIndex,
    finalGuessAttempted: g.finalGuess ? g.finalGuess.attempted : false,
    finalGuessSuccess: g.finalGuess ? g.finalGuess.correct : false,
    tieCount: room.stats.ties,
    clueTimeouts: room.stats.clueTimeouts,
    clueRejections: room.stats.clueRejections,
    duplicateRejections: room.stats.duplicateRejections,
    discussionTimeUsedSec: discussionTimeSec,
    imposterDisconnected: false
  });

  if (winner === 'impostor') telemetry.imposterWins++;
  else if (winner === 'crew') telemetry.crewWins++;

  room.onChange();
}

function nextRound(room, byId) {
  if (room.hostId !== byId) throw new Err('Only the host can continue.');
  if (room.phase !== 'results') throw new Err('The round is not over yet.');
  toLobby(room);
}

function playAgain(room, byId) {
  if (room.hostId !== byId) throw new Err('Only the host can continue.');
  if (room.phase !== 'results') throw new Err('The round is not over yet.');
  const ready = room.players.filter(p => p.connected && !p.spectator);
  if (ready.length < MIN) {
    toLobby(room, `Not enough players to continue. Need ${MIN}.`);
    return;
  }
  toLobby(room);
  // Auto-ready players and start
  room.players.forEach(p => { p.ready = true; });
  startGame(room, byId);
  room.onChange();
}

// ─── PER-PLAYER AUTHORITATIVE PROJECTION (INFORMATION BARRIER) ───
// The secret word MUST NEVER be sent to the Imposter before Results.
function viewFor(room, pid) {
  const g = room.game;
  const p = room.players.find(x => x.id === pid);
  const isSpectator = p ? !!p.spectator : false;

  const v = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    you: pid,
    spectator: isSpectator,
    category: room.category,
    deadline: room.deadline || null,
    notice: room.notice || null,
    players: room.players.map(x => ({
      id: x.id,
      name: x.name,
      ready: x.ready,
      discussReady: x.discussReady,
      connected: x.connected,
      spectator: x.spectator,
      seed: x.seed
    }))
  };

  if (!g) return v;

  const isImp = g.impostor === pid;

  v.game = {
    category: g.category,
    order: [...g.order],
    clueIndex: g.clueIndex,
    activeSpeaker: room.phase === 'clues' ? g.order[g.clueIndex] : null,
    clues: g.clues.map(c => ({ pid: c.pid, text: c.text, timedOut: c.timedOut })),
    voted: Object.keys(g.votes),
    revoted: Object.keys(g.revotes),
    tiedCandidates: g.tiedCandidates ? [...g.tiedCandidates] : [],
    roster: [...g.roster]
  };

  // REVEAL, CLUES, DISCUSSION, VOTING, TIE_DEFENSE, TIE_REVOTE, VERDICT, FINAL_GUESS:
  // Crew receives role + category + secret word + notes
  // Imposter receives role + category ONLY (NO WORD)
  // Spectator receives public state only (NO WORD, NO ROLE)
  if (room.phase !== 'results') {
    if (isSpectator) {
      v.secret = null;
    } else if (isImp) {
      v.secret = { impostor: true };
    } else {
      v.secret = {
        impostor: false,
        word: g.word,
        notes: g.wordObj.notes
      };
    }
  }

  // RESULTS: Complete round information unmasked for all
  if (room.phase === 'results') {
    v.result = {
      ...g.result,
      impostor: g.impostor,
      word: g.word,
      players: g.rosterSnapshot
    };
  }

  return v;
}

function sweep(now = Date.now()) {
  for (const [code, room] of rooms) {
    const expired = room.players.filter(p => !p.connected && p.leftAt && (now - p.leftAt > GRACE_MS));
    expired.forEach(p => removePlayer(room, p.id));
    if (!room.players.length) {
      clearTimer(room);
      rooms.delete(code);
    } else if (expired.length) {
      room.onChange();
    }
  }
}

module.exports = {
  Err,
  rooms,
  telemetry,
  createRoom,
  addPlayer,
  authPlayer,
  removePlayer,
  startGame,
  beginClues,
  submitClue,
  advanceClue,
  beginDiscussion,
  readyDiscussion,
  beginVoting,
  castVote,
  resolveVotes,
  beginTieDefense,
  beginTieRevote,
  castRevote,
  resolveTieRevote,
  beginVerdict,
  beginFinalGuess,
  submitFinalGuess,
  resolveFinalGuess,
  evaluateFinalGuess,
  nextRound,
  playAgain,
  viewFor,
  randomOrder,
  sweep,
  migrateHost,
  clearTimer,
  armPhase,
  checkAbort,
  MIN,
  MAX
};
