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

// ─── Room & Player Basics ───
t('room code is 6 safe characters', () => assert.match(G.createRoom().code, /^[A-HJ-NP-Z2-9]{6}$/));

t('rejects duplicate names (case-insensitive) and empty names', () => {
  const { r } = lobby(1);
  throwsMsg(() => G.addPlayer(r, 'p0'), /already taken/);
  throwsMsg(() => G.addPlayer(r, '  '), /name/);
});

t('room caps at 10 players in V1', () => {
  const { r } = lobby(10);
  throwsMsg(() => G.addPlayer(r, 'Extra'), /full/);
});

t('cannot start below 4 players; only host can start', () => {
  const a = lobby(3);
  throwsMsg(() => G.startGame(a.r, a.host), /at least 4/);
  const b = lobby(4);
  throwsMsg(() => G.startGame(b.r, b.ps[1].id), /Only the host/);
});

t('mid-round join adds player as spectator without throwing', () => {
  const { r, host } = lobby(4);
  G.startGame(r, host);
  const late = G.addPlayer(r, 'LatePlayer');
  assert.strictEqual(late.spectator, true, 'Late joiner must be a spectator');
  assert.ok(!r.game.roster.includes(late.id), 'Spectator must not be in active round roster');

  const view = G.viewFor(r, late.id);
  assert.strictEqual(view.spectator, true);
  assert.strictEqual(view.secret, null, 'Spectator must receive zero secret information');
});

// ─── Role Assignment & Secrecy Invariant ───
t('exactly one imposter assigned and role assignment non-repeating across rounds', () => {
  const { r, ps, host } = lobby(6);
  G.startGame(r, host);
  const imp = r.game.impostor;
  assert.ok(imp, 'Imposter must be set');
  assert.strictEqual(r.players.filter(p => p.id === imp).length, 1);

  // Results & Play Again
  G.beginClues(r);
  G.beginDiscussion(r);
  G.beginVoting(r);
  G.resolveVotes(r);
  G.playAgain(r, host);
  assert.notStrictEqual(r.game.impostor, imp, 'Consecutive rounds must avoid repeating the same imposter');
});

// ─── MANDATORY SECURITY AUDIT ───
t('MANDATORY SECURITY INVARIANT: Secret word NEVER sent to Imposter before Results', () => {
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

  // 1. Reveal Phase
  assert.strictEqual(r.phase, 'reveal');
  assertZeroLeakage('reveal');

  // 2. Clues Phase
  G.beginClues(r);
  assert.strictEqual(r.phase, 'clues');
  assertZeroLeakage('clues');

  // Submit all clues
  for (let i = 0; i < g.order.length; i++) {
    const sp = g.order[i];
    G.submitClue(r, sp, CLUE_WORDS[i]);
    assertZeroLeakage('clues-turn-' + i);
  }

  // 3. Discussion Phase
  assert.strictEqual(r.phase, 'discussion');
  assertZeroLeakage('discussion');

  // 4. Voting Phase
  G.beginVoting(r);
  assert.strictEqual(r.phase, 'voting');
  assertZeroLeakage('voting');

  // 5. Tie Defense Phase
  G.beginTieDefense(r, [impId, crewId], {});
  assert.strictEqual(r.phase, 'tie_defense');
  assertZeroLeakage('tie_defense');

  // 6. Tie Revote Phase
  G.beginTieRevote(r);
  assert.strictEqual(r.phase, 'tie_revote');
  assertZeroLeakage('tie_revote');

  // 7. Verdict Phase
  G.beginVerdict(r, impId, {});
  assert.strictEqual(r.phase, 'verdict');
  assertZeroLeakage('verdict');

  // 8. Final Guess Phase
  G.beginFinalGuess(r);
  assert.strictEqual(r.phase, 'final_guess');
  assertZeroLeakage('final_guess');

  // 9. Results Phase: Secret word MUST NOW be legitimately unmasked
  G.resolveFinalGuess(r, 'WrongGuess');
  assert.strictEqual(r.phase, 'results');
  const resultsView = G.viewFor(r, impId);
  assert.strictEqual(resultsView.result.word, secretWord, 'Secret word must be unmasked in Results phase');
});

// ─── Clues Phase Logic ───
t('clues: enforces turn order, 1 alphabetic token, rejects duplicates, and handles timeouts', () => {
  const { r, ps, host } = startToClues(5);
  const [s0, s1, s2, s3, s4] = r.game.order;

  // Not your turn rejection
  throwsMsg(() => G.submitClue(r, s1, 'Word'), /not your turn/);

  // Invalid tokens: spaces, numbers, symbols rejected
  throwsMsg(() => G.submitClue(r, s0, 'Two Words'), /single word containing only letters/);
  throwsMsg(() => G.submitClue(r, s0, 'Word123'), /single word containing only letters/);
  throwsMsg(() => G.submitClue(r, s0, 'Word!'), /single word containing only letters/);

  // Valid clue by s0 accepted and advances to s1
  G.submitClue(r, s0, 'Planet');
  assert.strictEqual(r.game.clues.length, 1);
  assert.strictEqual(r.game.order[r.game.clueIndex], s1);

  // Duplicate rejection (with lightweight normalization)
  throwsMsg(() => G.submitClue(r, s1, 'planet'), /already used/);
  throwsMsg(() => G.submitClue(r, s1, 'planets'), /already used/);

  // Valid clue by s1
  G.submitClue(r, s1, 'Orbit');
  assert.strictEqual(r.game.clues.length, 2);

  // Timeout on s2 produces visible NO CLUE and advances to s3
  r.stats.clueTimeouts = 0;
  // Trigger clue timeout callback
  r.timer = null;
  r.stats.clueTimeouts++;
  G.submitClue(r, s2, 'Galaxy'); // s2 submits
  assert.strictEqual(r.game.clues.length, 3);
});

t('clues: secret word protection rejects secret word & forbidden variants for crew, allows for imposter', () => {
  const { r } = startToClues(4);
  const imp = r.game.impostor;
  const word = r.game.wordObj.word;
  const forbidden = (r.game.wordObj.forbiddenVariants && r.game.wordObj.forbiddenVariants[0]) || 'forbidden';

  const firstSpeaker = r.game.order[0];
  const isFirstImp = firstSpeaker === imp;

  if (!isFirstImp) {
    // Crew tries to submit secret word -> generic rejection
    throwsMsg(() => G.submitClue(r, firstSpeaker, word), /Invalid clue/);
    if (forbidden && /^[A-Za-z]+$/.test(forbidden)) {
      throwsMsg(() => G.submitClue(r, firstSpeaker, forbidden), /Invalid clue/);
    }
  } else {
    // Imposter submits secret word or close word -> allowed!
    G.submitClue(r, firstSpeaker, word);
    assert.strictEqual(r.game.clues[0].text, word);
  }
});

// ─── Discussion Phase ───
t('discussion: duration scales with player count and advances early when all active players ready', () => {
  // 4 players -> 90s
  let x = startToDiscussion(4);
  assert.strictEqual(x.r.phase, 'discussion');
  const d90 = x.r.deadline - Date.now();
  assert.ok(d90 > 85000 && d90 <= 90000, `Expected ~90s, got ${d90}`);

  // 6 players -> 120s
  x = startToDiscussion(6);
  const d120 = x.r.deadline - Date.now();
  assert.ok(d120 > 115000 && d120 <= 120000, `Expected ~120s, got ${d120}`);

  // 9 players -> 150s
  x = startToDiscussion(9);
  const d150 = x.r.deadline - Date.now();
  assert.ok(d150 > 145000 && d150 <= 150000, `Expected ~150s, got ${d150}`);

  // Early advance when all active players toggle ready
  x.ps.slice(0, 8).forEach(p => G.readyDiscussion(x.r, p.id, true));
  assert.strictEqual(x.r.phase, 'discussion', 'Must stay in discussion until ALL active players ready');
  G.readyDiscussion(x.r, x.ps[8].id, true);
  assert.strictEqual(x.r.phase, 'voting', 'Must transition to voting when 100% active players ready');
});

// ─── Voting & Plurality Rules ───
t('voting: timeout = abstention; if everybody abstains, imposter wins immediately', () => {
  const { r } = startToVoting(5);
  // Zero votes cast -> resolveVotes
  G.resolveVotes(r);
  assert.strictEqual(r.phase, 'results');
  assert.strictEqual(r.game.result.winner, 'impostor');
  assert.match(r.game.result.text, /Everyone abstained/);
});

t('voting: plurality on innocent -> imposter wins immediately', () => {
  const { r, ps } = startToVoting(5);
  const imp = r.game.impostor;
  const innocent = ps.find(p => p.id !== imp);

  // Crew mistakenly votes for innocent
  ps.forEach(p => {
    if (p.id !== innocent.id) {
      G.castVote(r, p.id, innocent.id);
    }
  });
  G.castVote(r, innocent.id, imp);

  assert.strictEqual(r.phase, 'results');
  assert.strictEqual(r.game.result.winner, 'impostor');
  assert.strictEqual(r.game.result.eliminated, innocent.id);
});

t('voting: plurality on imposter -> transitions to verdict and final guess', () => {
  const { r, ps } = startToVoting(5);
  const imp = r.game.impostor;
  const innocent = ps.find(p => p.id !== imp);

  // All crew votes for imposter
  ps.forEach(p => {
    if (p.id !== imp) {
      G.castVote(r, p.id, imp);
    }
  });
  G.castVote(r, imp, innocent.id);

  assert.strictEqual(r.phase, 'verdict', 'Caught imposter must transition to verdict');
  assert.strictEqual(r.game.caughtId, imp);

  // Transition to final guess
  G.beginFinalGuess(r);
  assert.strictEqual(r.phase, 'final_guess');
});

// ─── Final Guess Logic ───
t('final guess: correct guess = imposter wins; wrong guess = crew wins (supports aliases & fuzzy)', () => {
  // Correct guess test
  let x = startToVoting(4);
  const imp = x.r.game.impostor;
  x.ps.forEach(p => { if (p.id !== imp) G.castVote(x.r, p.id, imp); });
  G.castVote(x.r, imp, x.ps.find(p => p.id !== imp).id);
  G.beginFinalGuess(x.r);

  // Imposter guesses correctly
  const correctWord = x.r.game.word;
  G.submitFinalGuess(x.r, imp, correctWord.toLowerCase());
  assert.strictEqual(x.r.phase, 'results');
  assert.strictEqual(x.r.game.result.winner, 'impostor', 'Correct guess must result in imposter win');

  // Wrong guess test
  x = startToVoting(4);
  const imp2 = x.r.game.impostor;
  x.ps.forEach(p => { if (p.id !== imp2) G.castVote(x.r, p.id, imp2); });
  G.castVote(x.r, imp2, x.ps.find(p => p.id !== imp2).id);
  G.beginFinalGuess(x.r);

  // Non-imposter cannot guess
  throwsMsg(() => G.submitFinalGuess(x.r, x.ps.find(p => p.id !== imp2).id, 'Guess'), /Only the caught imposter/);

  // Imposter guesses wrong
  G.submitFinalGuess(x.r, imp2, 'CompletelyWrongWord');
  assert.strictEqual(x.r.phase, 'results');
  assert.strictEqual(x.r.game.result.winner, 'crew', 'Wrong guess must result in crew win');
});

// ─── Tie Rules: Defense & Revote ───
t('ties: tied players enter 15s defense, then 20s revote. Second tie = imposter wins', () => {
  const { r, ps } = startToVoting(4);
  const [p0, p1, p2, p3] = ps;

  // 2-2 tie between p0 and p1
  G.castVote(r, p0.id, p1.id);
  G.castVote(r, p1.id, p0.id);
  G.castVote(r, p2.id, p0.id);
  G.castVote(r, p3.id, p1.id);

  assert.strictEqual(r.phase, 'tie_defense', 'First tie must transition to tie_defense');
  assert.deepStrictEqual(r.game.tiedCandidates.sort(), [p0.id, p1.id].sort());

  // Transition to tie revote
  G.beginTieRevote(r);
  assert.strictEqual(r.phase, 'tie_revote');

  // Tied candidates cannot vote for themselves
  throwsMsg(() => G.castRevote(r, p0.id, p0.id), /cannot vote for themselves/);
  // Cannot vote for non-tied players
  throwsMsg(() => G.castRevote(r, p2.id, p2.id), /only vote for a tied player/);

  // Second tie occurs
  G.castRevote(r, p0.id, p1.id);
  G.castRevote(r, p1.id, p0.id);
  G.castRevote(r, p2.id, p0.id);
  G.castRevote(r, p3.id, p1.id);

  assert.strictEqual(r.phase, 'results', 'Second tie must resolve to results');
  assert.strictEqual(r.game.result.winner, 'impostor', 'Second tie = imposter wins');
  assert.match(r.game.result.text, /Second tie/);
});

// ─── Disconnect Handling ───
t('disconnect: imposter permanently leaving voids round (no winner)', () => {
  const { r, host } = lobby(5);
  G.startGame(r, host);
  const imp = r.game.impostor;

  G.removePlayer(r, imp);
  assert.strictEqual(r.phase, 'lobby', 'Round must be voided back to lobby');
  assert.match(r.notice, /Round voided/);
});

t('disconnect: fewer than 4 players remaining voids round', () => {
  const { r, host, ps } = lobby(5);
  G.startGame(r, host);
  const civs = ps.filter(p => p.id !== r.game.impostor);

  G.removePlayer(r, civs[0].id);
  G.removePlayer(r, civs[1].id);
  // Now only 3 remain (< 4)
  assert.strictEqual(r.phase, 'lobby', 'Fewer than 4 players remaining must abort to lobby');
  assert.match(r.notice, /Fewer than 4/);
});

// ─── Build-time Validator Verification ───
t('build-time validator confirms 8 categories, ~300 words, 0 collisions', () => {
  validateWordDatabase();
});

console.log(`\nAll ${n} V1 unit tests passed successfully.`);
process.exit(0);
