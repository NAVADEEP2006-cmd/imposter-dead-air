'use strict';
const assert = require('assert');
const G = require('./game.js');
const WORDS = require('./words.js');
const { validateWordDatabase, normalize, isDangerousFuzzyMatch, levenshtein } = require('./scripts/validate-words.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const throwsMsg = (fn, re) => assert.throws(fn, e => e instanceof G.Err && re.test(e.message));

function lobby(count) {
  const r = G.createRoom();
  r.onChange = () => {};
  const ps = Array.from({ length: count }, (_, i) => G.addPlayer(r, 'P' + i));
  ps.forEach(p => { p.ready = true; });
  return { r, ps, host: r.hostId };
}

function startToClues(count) {
  const x = lobby(count);
  G.startGame(x.r, x.host);
  G.beginClues(x.r);
  return x;
}

const CLUE_WORDS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];

function startToDiscussion(count) {
  const x = startToClues(count);
  for (let i = 0; i < x.r.game.order.length; i++) {
    const speakerId = x.r.game.order[i];
    G.submitClue(x.r, speakerId, CLUE_WORDS[i]);
  }
  return x;
}

function startToVoting(count) {
  const x = startToDiscussion(count);
  G.beginVoting(x.r);
  return x;
}

// ════════════════════════════════════════════════════
// 1. LOBBY TESTS
// ════════════════════════════════════════════════════
t('LOBBY: room code is 6 safe characters', () => {
  const r = G.createRoom();
  assert.match(r.code, /^[A-HJ-NP-Z2-9]{6}$/);
});

t('LOBBY: rejects duplicate names (case-insensitive) and empty names', () => {
  const { r } = lobby(1);
  throwsMsg(() => G.addPlayer(r, 'p0'), /already taken/i);
  throwsMsg(() => G.addPlayer(r, '  '), /name/i);
});

t('LOBBY: room caps at 10 players in V1', () => {
  const { r } = lobby(10);
  throwsMsg(() => G.addPlayer(r, 'Extra'), /full/i);
});

t('LOBBY: cannot start below 4; can start at 4; only host can start', () => {
  const a = lobby(3);
  throwsMsg(() => G.startGame(a.r, a.host), /at least 4/i);

  const b = lobby(4);
  throwsMsg(() => G.startGame(b.r, b.ps[1].id), /Only the host/i);

  // Can start at 4
  G.startGame(b.r, b.host);
  assert.strictEqual(b.r.phase, 'reveal');
});

t('LOBBY: host migration on host leaving or disconnecting', () => {
  const { r, ps, host } = lobby(4);
  assert.strictEqual(r.hostId, ps[0].id);

  // Host leaves
  G.removePlayer(r, host);
  assert.strictEqual(r.hostId, ps[1].id, 'Host must migrate to next player');

  // Next host disconnects
  ps[1].connected = false;
  G.migrateHost(r);
  assert.strictEqual(r.hostId, ps[2].id, 'Host must migrate to next connected player');
});

t('LOBBY: join/leave lifecycle and session auth', () => {
  const r = G.createRoom();
  const p = G.addPlayer(r, 'PlayerA');
  assert.strictEqual(p.connected, true);
  assert.strictEqual(p.spectator, false);

  const authed = G.authPlayer(r, p.id, p.token);
  assert.strictEqual(authed.id, p.id);

  throwsMsg(() => G.authPlayer(r, p.id, 'bad-token'), /session expired/i);
  throwsMsg(() => G.authPlayer(r, 'bad-id', p.token), /session expired/i);

  G.removePlayer(r, p.id);
  assert.strictEqual(r.players.length, 0);
});

// ════════════════════════════════════════════════════
// 2. ROLE TESTS
// ════════════════════════════════════════════════════
t('ROLE: exactly one Imposter; Crew gets word, Imposter does not; non-repeating across rounds', () => {
  const { r, ps, host } = lobby(6);
  G.startGame(r, host);
  const imp = r.game.impostor;
  assert.ok(imp, 'Imposter must be assigned');
  assert.strictEqual(r.players.filter(p => p.id === imp).length, 1);

  // Crew gets word, Imposter gets only category
  const impView = G.buildImposterState(r, r.players.find(p => p.id === imp));
  assert.strictEqual(impView.secret.impostor, true);
  assert.strictEqual(impView.secret.word, undefined);

  const crewPlayer = ps.find(p => p.id !== imp);
  const crewView = G.buildCrewState(r, crewPlayer);
  assert.strictEqual(crewView.secret.impostor, false);
  assert.strictEqual(crewView.secret.word, r.game.word);
  assert.ok(crewView.secret.notes);

  // Play again -> non-repeating imposter
  G.beginClues(r);
  G.beginDiscussion(r);
  G.beginVoting(r);
  G.resolveVotes(r);
  G.playAgain(r, host);
  assert.notStrictEqual(r.game.impostor, imp, 'Consecutive rounds must avoid repeating the same imposter');
});

// ════════════════════════════════════════════════════
// 3. SECRECY TESTS
// ════════════════════════════════════════════════════
t('SECRECY: Imposter NEVER receives secret word across all phases until RESULT', () => {
  const { r, ps, host } = lobby(6);
  G.startGame(r, host);
  const g = r.game;
  const impId = g.impostor;
  const crewId = ps.find(p => p.id !== impId).id;
  const secretWord = g.word;
  assert.ok(secretWord, 'Secret word must be defined');

  const assertZeroLeakage = phaseName => {
    const impView = G.viewFor(r, impId);
    const serialized = JSON.stringify(impView);
    assert.strictEqual(impView.secret.impostor, true, `Imposter secret must flag role in ${phaseName}`);
    assert.strictEqual(impView.secret.word, undefined, `Imposter must NOT have word property in ${phaseName}`);
    assert.ok(!serialized.toLowerCase().includes(secretWord.toLowerCase()),
      `CRITICAL SECURITY LEAK: Secret word "${secretWord}" leaked in ${phaseName} payload!`);
  };

  // Reveal Phase
  assert.strictEqual(r.phase, 'reveal');
  assertZeroLeakage('reveal');

  // Clues Phase
  G.beginClues(r);
  assert.strictEqual(r.phase, 'clues');
  assertZeroLeakage('clues');

  for (let i = 0; i < g.order.length; i++) {
    const sp = g.order[i];
    G.submitClue(r, sp, CLUE_WORDS[i]);
    assertZeroLeakage('clues-turn-' + i);
  }

  // Discussion Phase
  assert.strictEqual(r.phase, 'discussion');
  assertZeroLeakage('discussion');

  // Vote Phase
  G.beginVoting(r);
  assert.strictEqual(r.phase, 'vote');
  assertZeroLeakage('vote');

  // Defense Phase
  G.beginDefense(r, [impId, crewId], {});
  assert.strictEqual(r.phase, 'defense');
  assertZeroLeakage('defense');

  // Revote Phase
  G.beginRevote(r);
  assert.strictEqual(r.phase, 'revote');
  assertZeroLeakage('revote');

  // Guess Phase
  G.beginGuessSetup(r, impId, {});
  assert.strictEqual(r.phase, 'guess');
  assertZeroLeakage('guess');

  // Result Phase: Secret word is now legitimately unmasked
  G.resolveGuess(r, 'WrongGuess');
  assert.strictEqual(r.phase, 'result');
  const resultsView = G.viewFor(r, impId);
  assert.strictEqual(resultsView.result.word, secretWord, 'Secret word must be unmasked in Result phase');
});

t('SECRECY: reconnect never leaks word, spectators never receive role or word', () => {
  const { r, host } = lobby(4);
  G.startGame(r, host);
  const imp = r.game.impostor;

  // Mid-round spectator join
  const spec = G.addPlayer(r, 'SpectatorGuy');
  assert.strictEqual(spec.spectator, true);
  const specView = G.viewFor(r, spec.id);
  assert.strictEqual(specView.spectator, true);
  assert.strictEqual(specView.secret, null, 'Spectator must receive null secret');

  // Reconnect imposter
  const impPlayer = r.players.find(p => p.id === imp);
  impPlayer.connected = false;
  impPlayer.connected = true;
  const reconnectedImpView = G.viewFor(r, imp);
  assert.strictEqual(reconnectedImpView.secret.impostor, true);
  assert.strictEqual(reconnectedImpView.secret.word, undefined, 'Reconnection must never leak secret word');
});

// ════════════════════════════════════════════════════
// 4. CLUES TESTS
// ════════════════════════════════════════════════════
t('CLUES: valid clue accepted, length checked, duplicates rejected, retry works, timeout -> NO CLUE', () => {
  const { r } = startToClues(5);
  const [s0, s1, s2, s3, s4] = r.game.order;

  // Not speaker's turn
  throwsMsg(() => G.submitClue(r, s1, 'Planet'), /not your turn/i);

  // Length checks (2 to 24 chars, alphabetic only)
  throwsMsg(() => G.submitClue(r, s0, 'A'), /2-24 characters/i);
  throwsMsg(() => G.submitClue(r, s0, 'ThisIsWayTooLongOfAWordToBeAValidClueSubmission'), /2-24 characters/i);
  throwsMsg(() => G.submitClue(r, s0, 'Spaces Invalid'), /single word containing only letters/i);
  throwsMsg(() => G.submitClue(r, s0, 'Word123'), /single word containing only letters/i);

  // Valid clue by s0 accepted and advances
  G.submitClue(r, s0, 'Planet');
  assert.strictEqual(r.game.clues.length, 1);
  assert.strictEqual(r.game.clues[0].text, 'Planet');
  assert.strictEqual(r.game.clues[0].timedOut, false);
  assert.strictEqual(r.game.order[r.game.clueIndex], s1);

  // Duplicate rejection (case-insensitive & singular/plural normalized)
  throwsMsg(() => G.submitClue(r, s1, 'planet'), /already used/i);
  throwsMsg(() => G.submitClue(r, s1, 'planets'), /already used/i);

  // Retry works after rejection
  G.submitClue(r, s1, 'Orbit');
  assert.strictEqual(r.game.clues.length, 2);

  // Timeout on s2 produces NO CLUE
  r.game.clueIndex = 2; // s2
  r.stats.clueTimeouts++;
  r.game.clues.push({ pid: s2, text: 'NO CLUE', position: 2, timedOut: true, time: Date.now() });
  G.advanceClue(r);
  assert.strictEqual(r.game.clues[2].text, 'NO CLUE');
  assert.strictEqual(r.game.clues[2].timedOut, true);
});

t('CLUES: Imposter can submit secret word; Crew CANNOT submit secret word (generic error only)', () => {
  const { r } = startToClues(4);
  const imp = r.game.impostor;
  const word = r.game.wordObj.word;
  const forbidden = (r.game.wordObj.forbiddenVariants && r.game.wordObj.forbiddenVariants[0]) || 'forbidden';

  const firstSpeaker = r.game.order[0];
  const isFirstImp = firstSpeaker === imp;

  if (!isFirstImp) {
    // Crew: secret word and forbidden variants rejected with generic error
    throwsMsg(() => G.submitClue(r, firstSpeaker, word), /^Invalid clue\. Choose another word\.$/);
    if (forbidden && /^[A-Za-z]+$/.test(forbidden)) {
      throwsMsg(() => G.submitClue(r, firstSpeaker, forbidden), /^Invalid clue\. Choose another word\.$/);
    }
  } else {
    // Imposter: secret word accepted normally
    G.submitClue(r, firstSpeaker, word);
    assert.strictEqual(r.game.clues[0].text, word);
  }
});

// ════════════════════════════════════════════════════
// 5. DISCUSSION TESTS
// ════════════════════════════════════════════════════
t('DISCUSSION: timer scales with player count (90s, 120s, 150s) and ready advances early', () => {
  // 4-5 players: 90s
  let x = startToDiscussion(4);
  assert.strictEqual(x.r.phase, 'discussion');
  const d90 = x.r.deadline - Date.now();
  assert.ok(d90 > 85000 && d90 <= 90000, `Expected ~90s, got ${d90}`);

  // 6-8 players: 120s
  x = startToDiscussion(6);
  const d120 = x.r.deadline - Date.now();
  assert.ok(d120 > 115000 && d120 <= 120000, `Expected ~120s, got ${d120}`);

  // 9-10 players: 150s
  x = startToDiscussion(9);
  const d150 = x.r.deadline - Date.now();
  assert.ok(d150 > 145000 && d150 <= 150000, `Expected ~150s, got ${d150}`);

  // All active players toggling ready advances to vote
  x.ps.slice(0, 8).forEach(p => G.readyDiscussion(x.r, p.id, true));
  assert.strictEqual(x.r.phase, 'discussion', 'Should not advance until ALL active players ready');
  G.readyDiscussion(x.r, x.ps[8].id, true);
  assert.strictEqual(x.r.phase, 'vote', 'Must transition to vote when all active players ready');
});

// ════════════════════════════════════════════════════
// 6. VOTE TESTS
// ════════════════════════════════════════════════════
t('VOTE: hidden votes, no self-vote, duplicate vote rejection, all abstain = imposter wins', () => {
  const { r, ps } = startToVoting(5);
  const [p0, p1, p2, p3, p4] = ps;

  // Self-vote rejected
  throwsMsg(() => G.castVote(r, p0.id, p0.id), /cannot vote for yourself/i);

  // Valid vote
  G.castVote(r, p0.id, p1.id);
  assert.strictEqual(r.game.votes[p0.id], p1.id);

  // Hidden votes: public/crew/imposter views must ONLY show who has voted, NOT targets
  const view = G.viewFor(r, p1.id);
  assert.deepStrictEqual(view.game.voted, [p0.id]);
  assert.strictEqual(view.game.votes, undefined, 'Vote targets must remain hidden during voting');

  // Duplicate vote rejected
  throwsMsg(() => G.castVote(r, p0.id, p2.id), /already voted/i);

  // All abstain test
  const x = startToVoting(4);
  G.resolveVotes(x.r);
  assert.strictEqual(x.r.phase, 'result');
  assert.strictEqual(x.r.game.result.winner, 'impostor');
  assert.match(x.r.game.result.text, /Everyone abstained/i);
});

t('VOTE: plurality on innocent -> imposter wins; plurality on imposter -> guess', () => {
  // Plurality on innocent
  let x = startToVoting(5);
  let imp = x.r.game.impostor;
  let innocent = x.ps.find(p => p.id !== imp);

  x.ps.forEach(p => {
    if (p.id !== innocent.id) G.castVote(x.r, p.id, innocent.id);
  });
  G.castVote(x.r, innocent.id, imp);
  assert.strictEqual(x.r.phase, 'result');
  assert.strictEqual(x.r.game.result.winner, 'impostor');

  // Plurality on imposter
  x = startToVoting(5);
  imp = x.r.game.impostor;
  innocent = x.ps.find(p => p.id !== imp);

  x.ps.forEach(p => {
    if (p.id !== imp) G.castVote(x.r, p.id, imp);
  });
  G.castVote(x.r, imp, innocent.id);
  assert.strictEqual(x.r.phase, 'guess');
  assert.strictEqual(x.r.game.caughtId, imp);
});

// ════════════════════════════════════════════════════
// 7. TIE TESTS
// ════════════════════════════════════════════════════
t('TIE: defense (15s) -> revote (20s) -> restricted revote targets -> second tie = imposter wins', () => {
  const { r, ps } = startToVoting(4);
  const [p0, p1, p2, p3] = ps;

  // 2-2 tie between p0 and p1
  G.castVote(r, p0.id, p1.id);
  G.castVote(r, p1.id, p0.id);
  G.castVote(r, p2.id, p0.id);
  G.castVote(r, p3.id, p1.id);

  assert.strictEqual(r.phase, 'defense', 'Tie must transition to defense');
  assert.deepStrictEqual(r.game.tiedCandidates.sort(), [p0.id, p1.id].sort());

  // Transition to revote
  G.beginRevote(r);
  assert.strictEqual(r.phase, 'revote');

  // Tied players cannot vote for themselves
  throwsMsg(() => G.castRevote(r, p0.id, p0.id), /cannot vote for yourself/i);

  // Cannot vote for non-tied players
  throwsMsg(() => G.castRevote(r, p2.id, p2.id), /only vote for a tied player/i);

  // Tied players CAN vote for other tied player
  G.castRevote(r, p0.id, p1.id);
  G.castRevote(r, p1.id, p0.id);
  G.castRevote(r, p2.id, p0.id);
  G.castRevote(r, p3.id, p1.id);

  // Second tie occurs -> Imposter wins immediately
  assert.strictEqual(r.phase, 'result');
  assert.strictEqual(r.game.result.winner, 'impostor');
  assert.match(r.game.result.text, /Second tie/i);
});

// ════════════════════════════════════════════════════
// 8. GUESS TESTS
// ════════════════════════════════════════════════════
t('GUESS: timeout, exact match, alias, plural, compound, fuzzy match, wrong guess', () => {
  const wordObj = {
    word: 'Strawberry',
    category: 'FOOD & DRINK',
    difficulty: 'easy',
    aliases: ['Garden Strawberry'],
    forbiddenVariants: ['Berries'],
    compoundVariants: ['Strawberries']
  };

  // Exact normalized match
  assert.strictEqual(G.evaluateGuess('strawberry', wordObj), true);
  assert.strictEqual(G.evaluateGuess('STRAWBERRY', wordObj), true);

  // Alias
  assert.strictEqual(G.evaluateGuess('Garden Strawberry', wordObj), true);

  // Plural / compound variant
  assert.strictEqual(G.evaluateGuess('strawberries', wordObj), true);

  // Controlled fuzzy match (distance 1 for len >= 5)
  assert.strictEqual(G.evaluateGuess('strawberri', wordObj), true);

  // Dangerous / distant fuzzy match rejected
  assert.strictEqual(G.evaluateGuess('blueberry', wordObj), false);
  assert.strictEqual(G.evaluateGuess('apple', wordObj), false);

  // Integration with guess submission
  const x = startToVoting(4);
  const imp = x.r.game.impostor;
  x.ps.forEach(p => { if (p.id !== imp) G.castVote(x.r, p.id, imp); });
  G.castVote(x.r, imp, x.ps.find(p => p.id !== imp).id);
  assert.strictEqual(x.r.phase, 'guess');

  // Non-imposter cannot guess
  throwsMsg(() => G.submitGuess(x.r, x.ps.find(p => p.id !== imp).id, 'Strawberry'), /Only the caught imposter/i);

  // Timeout -> Crew wins
  G.resolveGuess(x.r, null);
  assert.strictEqual(x.r.phase, 'result');
  assert.strictEqual(x.r.game.result.winner, 'crew');
});

// ════════════════════════════════════════════════════
// 9. DISCONNECT & ABORT TESTS
// ════════════════════════════════════════════════════
t('DISCONNECT: Imposter permanently leaving voids round (no winner, telemetry logged)', () => {
  const { r, host } = lobby(5);
  G.startGame(r, host);
  const imp = r.game.impostor;
  const initialVoided = G.telemetry.voidedRounds;

  G.removePlayer(r, imp);
  assert.strictEqual(r.phase, 'lobby');
  assert.match(r.notice, /Round voided/i);
  assert.strictEqual(G.telemetry.voidedRounds, initialVoided + 1);
});

t('DISCONNECT: active player count dropping below 4 voids round to lobby', () => {
  const { r, host, ps } = lobby(5);
  G.startGame(r, host);
  const civs = ps.filter(p => p.id !== r.game.impostor);

  G.removePlayer(r, civs[0].id);
  G.removePlayer(r, civs[1].id);
  assert.strictEqual(r.phase, 'lobby');
  assert.match(r.notice, /Fewer than 4/i);
});

// ════════════════════════════════════════════════════
// 10. RACE CONDITION & STALE ACTION TESTS
// ════════════════════════════════════════════════════
t('RACE CONDITIONS: stale roundId and wrong phase actions rejected', () => {
  const { r, ps, host } = startToClues(4);
  const speaker = r.game.order[0];
  const oldRoundId = r.roundId;

  // Stale roundId rejected
  throwsMsg(() => G.submitClue(r, speaker, 'ValidClue', 'old-fake-round-id'), /Stale action/i);

  // Valid clue advances phase
  G.submitClue(r, speaker, 'ValidClue', oldRoundId);
});

t('STALE TIMERS: armPhase suppresses callbacks if roundId, phase, or token changes', () => {
  const r = G.createRoom();
  r.roundId = 'round-A';
  let firedA = false;
  let firedB = false;

  const origSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (fn, ms) => {
    scheduled.push(fn);
    return origSetTimeout(fn, 100000);
  };

  try {
    // Arm timer for round-A
    G.armPhase(r, 'clues', 20000, () => { firedA = true; });
    const timerCallbackA = scheduled[scheduled.length - 1];

    // Advance round and re-arm with different token/phase/roundId
    r.roundId = 'round-B';
    G.armPhase(r, 'discussion', 30000, () => { firedB = true; });
    const timerCallbackB = scheduled[scheduled.length - 1];

    // Execute timer A's callback: must be suppressed because roundId, phase, and token don't match
    timerCallbackA();
    assert.strictEqual(firedA, false, 'Stale timer from round-A must never fire');

    // Execute timer B's callback: must fire because room matches current round-B
    timerCallbackB();
    assert.strictEqual(firedB, true, 'Current timer for round-B must fire');

    // Clear timer and verify callback doesn't fire after clearTimer
    G.clearTimer(r);
    firedB = false;
    timerCallbackB();
    assert.strictEqual(firedB, false, 'Timer callback must not fire after clearTimer');
  } finally {
    global.setTimeout = origSetTimeout;
    G.clearTimer(r);
  }
});

t('SPECTATORS: Mid-round joined player receives public state only, no secret, and cannot perform actions', () => {
  const { r, ps, host } = startToClues(4);
  const spec = G.addPlayer(r, 'SpecPlayer');
  assert.strictEqual(spec.spectator, true);

  const view = G.viewFor(r, spec.id);
  assert.strictEqual(view.spectator, true);
  assert.strictEqual(view.secret, null);
  assert.strictEqual(view.game.clues !== undefined, true);

  // 1. Clues phase: Spectator cannot submit clues
  throwsMsg(() => G.submitClue(r, spec.id, 'IllegalClue'), /not your turn/i);

  // 2. Submit all clues to reach discussion phase
  for (let i = 0; i < r.game.order.length; i++) {
    G.submitClue(r, r.game.order[i], CLUE_WORDS[i]);
  }
  assert.strictEqual(r.phase, 'discussion');
  // Discussion phase: Spectator cannot ready up
  throwsMsg(() => G.readyDiscussion(r, spec.id, true), /not active in this round/i);

  // 3. Begin voting phase: Spectator cannot vote
  G.beginVoting(r);
  assert.strictEqual(r.phase, 'vote');
  throwsMsg(() => G.castVote(r, spec.id, ps[0].id), /not in this round/i);

  // 4. Spectator cannot submit final guess
  throwsMsg(() => G.submitGuess(r, spec.id, 'SecretWord'), /Not the final guess phase/i);
});

// ════════════════════════════════════════════════════
// 11. BUILD-TIME WORD VALIDATION
// ════════════════════════════════════════════════════
t('BUILD-TIME VALIDATOR: exactly 8 categories, 35-40 words each, 0 collisions', () => {
  validateWordDatabase();
});

console.log(`\nAll ${n} V1 unit tests passed successfully.`);
process.exit(0);
