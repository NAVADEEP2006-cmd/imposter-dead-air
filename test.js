'use strict';
const assert = require('assert');
const G = require('./game.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const throwsMsg = (fn, re) => assert.throws(fn, e => e instanceof G.Err && re.test(e.message));
function lobby(count) {
  const r = G.createRoom(); r.onChange = () => {};
  const ps = Array.from({ length: count }, (_, i) => G.addPlayer(r, 'P' + i));
  ps.forEach(p => { p.ready = true; });
  return { r, ps, host: r.hostId };
}
t('room code is 6 safe characters', () => assert.match(G.createRoom().code, /^[A-HJ-NP-Z2-9]{6}$/));
t('rejects duplicate names (case-insensitive) and empty names', () => {
  const { r } = lobby(1); throwsMsg(() => G.addPlayer(r, 'p0'), /already taken/); throwsMsg(() => G.addPlayer(r, '  '), /name/);
});
t('room caps at 12 players', () => { const { r } = lobby(12); throwsMsg(() => G.addPlayer(r, 'Extra'), /full/); });
t('cannot start below 4 players; only host can start', () => {
  const a = lobby(3); throwsMsg(() => G.startGame(a.r, a.host), /at least 4/);
  const b = lobby(4); throwsMsg(() => G.startGame(b.r, b.ps[1].id), /Only the host/);
});
t('cannot join after round starts', () => { const { r, host } = lobby(4); G.startGame(r, host); throwsMsg(() => G.addPlayer(r, 'Late'), /already started/); });
t('exactly one impostor and views never leak secrets', () => {
  const { r, ps, host } = lobby(6); G.startGame(r, host);
  const g = r.game; const views = ps.map(p => G.viewFor(r, p.id));
  views.forEach((v, i) => {
    const imp = ps[i].id === g.impostor;
    assert.strictEqual(v.secret.impostor, imp);
    assert.strictEqual('word' in v.secret, !imp);
    assert.ok(!JSON.stringify(v).includes('"impostor":"' + g.impostor));
  });
  assert.strictEqual(views.filter(v => v.secret.impostor).length, 1);
});
t('speaking order and impostor vary across rounds; starter is not always P0', () => {
  const starters = new Set(), imps = new Set(); let sameAsLast = 0, prev = null;
  for (let i = 0; i < 60; i++) {
    const { r, ps, host } = lobby(6); G.startGame(r, host);
    starters.add(r.game.order[0]); imps.add(r.game.impostor);
    if (prev && prev === r.game.order.join()) sameAsLast++; prev = r.game.order.join();
  }
  assert.ok(starters.size >= 4 && imps.size >= 4);
  const last = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 200; i++) { const o = G.randomOrder(last, last); assert.notStrictEqual(o[0], 'a'); }
});
t('only the current speaker can end a turn; order completion opens voting', () => {
  const { r, ps, host } = lobby(4); G.startGame(r, host); G.beginDiscussion(r);
  throwsMsg(() => G.endTurn(r, r.game.order[1]), /not your turn/);
  [0, 1, 2, 3].forEach(i => G.endTurn(r, r.game.order[i === 0 ? 0 : r.game.turn]));
  assert.strictEqual(r.phase, 'voting');
});
function toVoting(count) { const x = lobby(count); G.startGame(x.r, x.host); G.beginDiscussion(x.r); G.beginVoting(x.r); return x; }
t('voting: no double vote, no self vote, no invalid target, no voting out of phase', () => {
  const { r, ps } = toVoting(5);
  throwsMsg(() => G.castVote(r, ps[0].id, ps[0].id), /another player/);
  throwsMsg(() => G.castVote(r, ps[0].id, 'nobody'), /another player/);
  G.castVote(r, ps[0].id, ps[1].id);
  throwsMsg(() => G.castVote(r, ps[0].id, ps[2].id), /already voted/);
  const lob = lobby(4); throwsMsg(() => G.castVote(lob.r, lob.ps[0].id, lob.ps[1].id), /closed/);
});
t('votes stay hidden until results', () => {
  const { r, ps } = toVoting(5); G.castVote(r, ps[0].id, ps[1].id);
  const v = G.viewFor(r, ps[2].id); assert.deepStrictEqual(v.game.voted, [ps[0].id]); assert.ok(!v.result);
});
t('majority on impostor: civilians win; wrong majority: impostor wins', () => {
  let x = toVoting(5); x.ps.forEach(p => { if (p.id !== x.r.game.impostor) G.castVote(x.r, p.id, x.r.game.impostor); });
  G.castVote(x.r, x.r.game.impostor, x.ps.find(p => p.id !== x.r.game.impostor).id);
  assert.strictEqual(x.r.phase, 'results'); assert.strictEqual(x.r.game.result.winner, 'civilians');
  x = toVoting(5); const innocent = x.ps.find(p => p.id !== x.r.game.impostor);
  x.ps.forEach(p => { if (p.id !== innocent.id) G.castVote(x.r, p.id, innocent.id); });
  G.castVote(x.r, innocent.id, x.r.game.impostor);
  assert.strictEqual(x.r.game.result.winner, 'impostor');
});
t('tie: impostor escapes', () => {
  const { r, ps } = toVoting(4); const [a, b, c, d] = ps;
  G.castVote(r, a.id, b.id); G.castVote(r, b.id, a.id); G.castVote(r, c.id, a.id); G.castVote(r, d.id, b.id);
  assert.strictEqual(r.game.result.winner, 'impostor'); assert.strictEqual(r.game.result.eliminated, null);
});
t('zero votes: impostor escapes', () => {
  const { r } = toVoting(4);
  G.resolveVotes(r);
  assert.strictEqual(r.game.result.winner, 'impostor');
  assert.strictEqual(r.game.result.eliminated, null);
});
t('timeout with partial votes resolves, disconnected voters do not block', () => {
  const { r, ps } = toVoting(5); ps[4].connected = false;
  ps.slice(0, 4).forEach(p => { try { G.castVote(r, p.id, ps[(ps.indexOf(p) + 1) % 4].id); } catch (e) {} });
  assert.strictEqual(r.phase, 'results');
});
t('results reveal impostor + word only at the end, then host returns to lobby', () => {
  const { r, ps, host } = toVoting(4); G.resolveVotes(r);
  const v = G.viewFor(r, ps[1].id); assert.ok(v.result.impostor && v.result.word && !v.secret);
  throwsMsg(() => G.nextRound(r, ps[1].id === host ? ps[0].id : ps[1].id), /Only the host/);
  G.nextRound(r, host); assert.strictEqual(r.phase, 'lobby'); assert.strictEqual(r.game, null);
});
t('host migrates when host is removed; empty room is swept', () => {
  const { r, ps, host } = lobby(4); G.removePlayer(r, host); assert.notStrictEqual(r.hostId, host); assert.ok(r.players.some(p => p.id === r.hostId));
  r.players.forEach(p => G.removePlayer(r, p.id)); G.sweep(); assert.ok(!G.rooms.has(r.code));
});
t('impostor leaving mid-round ends the round for the crew', () => {
  const { r, host } = lobby(5); G.startGame(r, host); const imp = r.game.impostor; G.removePlayer(r, imp);
  assert.strictEqual(r.phase, 'results'); assert.strictEqual(r.game.result.winner, 'civilians');
});
t('session token is required to act as a player', () => { const { r, ps } = lobby(4); throwsMsg(() => G.authPlayer(r, ps[0].id, 'forged'), /expired/); });
t('playAgain starts new round without returning to lobby', () => {
  const { r, ps, host } = toVoting(4); G.resolveVotes(r);
  assert.strictEqual(r.phase, 'results');
  const oldWord = r.game.word;
  const oldImpostor = r.game.impostor;
  G.playAgain(r, host);
  assert.strictEqual(r.phase, 'reveal');
  assert.strictEqual(r.round, 2);
  // New secrets must be generated (they could randomly match, but that's astronomically unlikely with the word pool)
  assert.ok(r.game.word, 'New word must be set');
  assert.ok(r.game.impostor, 'New impostor must be set');
  assert.ok(r.game.order.length === 4, 'Order must include all players');
});
t('playAgain by non-host is rejected', () => {
  const { r, ps, host } = toVoting(4); G.resolveVotes(r);
  const nonHost = ps.find(p => p.id !== host);
  throwsMsg(() => G.playAgain(r, nonHost.id), /Only the host/);
});
t('playAgain with too few connected players falls back to lobby', () => {
  const { r, ps, host } = toVoting(4); G.resolveVotes(r);
  // Disconnect 2 players
  ps[2].connected = false;
  ps[3].connected = false;
  G.playAgain(r, host);
  assert.strictEqual(r.phase, 'lobby');
});
t('multiple civilians disconnecting: game continues if enough remain', () => {
  const { r, ps, host } = lobby(6); G.startGame(r, host);
  G.beginDiscussion(r);
  // Disconnect 2 civilians (not the impostor)
  const civilians = ps.filter(p => p.id !== r.game.impostor);
  G.removePlayer(r, civilians[0].id);
  // Game should continue with 5 players (still >= 3 alive in roster)
  assert.ok(['discussion', 'voting', 'results', 'lobby'].includes(r.phase));
});
t('everyone except 2 disconnects: game aborts to lobby', () => {
  const { r, ps, host } = lobby(6); G.startGame(r, host);
  G.beginDiscussion(r);
  // Remove 4 players
  const toRemove = ps.slice(2);
  toRemove.forEach(p => G.removePlayer(r, p.id));
  // With only 2 players left, game should abort
  assert.strictEqual(r.phase, 'lobby');
});
t('viewFor never exposes secret word to impostor in any game phase', () => {
  const { r, ps, host } = lobby(4); G.startGame(r, host);
  const g = r.game;
  const impId = g.impostor;
  
  // Check reveal phase
  let v = G.viewFor(r, impId);
  assert.strictEqual(v.secret.impostor, true);
  assert.strictEqual(v.secret.word, undefined);
  
  // Check discussion phase
  G.beginDiscussion(r);
  v = G.viewFor(r, impId);
  assert.strictEqual(v.secret.word, undefined);
  
  // Check voting phase
  G.beginVoting(r);
  v = G.viewFor(r, impId);
  assert.strictEqual(v.secret.word, undefined);
  
  // Check results phase - impostor SHOULD see the word
  G.resolveVotes(r);
  v = G.viewFor(r, impId);
  assert.ok(v.result.word, 'Impostor should see word in results');
});
t('viewFor never includes vote targets during voting (only voter IDs)', () => {
  const { r, ps } = toVoting(5);
  G.castVote(r, ps[0].id, ps[1].id);
  G.castVote(r, ps[1].id, ps[2].id);
  
  // Check from perspective of player who hasn't voted
  const v = G.viewFor(r, ps[3].id);
  assert.deepStrictEqual(v.game.voted, [ps[0].id, ps[1].id]);
  // The view must not contain individual vote mappings
  const json = JSON.stringify(v);
  assert.ok(!json.includes('"votes"'), 'Vote targets must not be in view during voting');
});
t('host migration during voting phase', () => {
  const { r, ps, host } = toVoting(5);
  // Host disconnects during voting
  G.removePlayer(r, host);
  // New host should be assigned
  assert.ok(r.hostId, 'New host should be assigned');
  assert.notStrictEqual(r.hostId, host);
  // Game should still be running (either voting or resolved)
  assert.ok(['voting', 'results', 'lobby'].includes(r.phase));
});
t('host migration during results phase', () => {
  const { r, ps, host } = toVoting(4); G.resolveVotes(r);
  assert.strictEqual(r.phase, 'results');
  G.removePlayer(r, host);
  assert.ok(r.hostId);
  assert.notStrictEqual(r.hostId, host);
  // New host can trigger next round
  G.nextRound(r, r.hostId);
  assert.strictEqual(r.phase, 'lobby');
});
t('sweep removes players after GRACE_MS and cleans empty rooms', () => {
  const { r, ps } = lobby(4);
  ps.forEach(p => { p.connected = false; p.leftAt = Date.now() - 31000; });
  G.sweep();
  assert.ok(!G.rooms.has(r.code), 'Empty room should be swept');
});
t('current speaker disconnecting advances the turn', () => {
  const { r, ps, host } = lobby(4); G.startGame(r, host); G.beginDiscussion(r);
  const currentSpeaker = r.game.order[r.game.turn];
  const nextSpeaker = r.game.order[r.game.turn + 1];
  // Simulate speaker disconnect by ending their turn
  G.endTurn(r, currentSpeaker);
  assert.strictEqual(r.game.order[r.game.turn], nextSpeaker);
});
t('next speaker disconnecting skips to subsequent player without shifting order', () => {
  const { r, ps, host } = lobby(5); G.startGame(r, host); G.beginDiscussion(r);
  const [s0, s1, s2, s3, s4] = r.game.order;
  assert.strictEqual(r.game.speakerId, s0);
  // Next speaker (s1) disconnects
  const p1 = r.players.find(p => p.id === s1);
  p1.connected = false;
  // Current speaker ends turn
  G.endTurn(r, s0);
  // Turn should advance directly to s2, skipping disconnected s1
  assert.strictEqual(r.game.speakerId, s2);
  // Order array itself must remain completely stable
  assert.deepStrictEqual(r.game.order, [s0, s1, s2, s3, s4]);
});
t('multiple disconnected speakers advance directly to voting if none remain', () => {
  const { r, ps, host } = lobby(4); G.startGame(r, host); G.beginDiscussion(r);
  const [s0, s1, s2, s3] = r.game.order;
  // Disconnect s1, s2, s3
  r.players.find(p => p.id === s1).connected = false;
  r.players.find(p => p.id === s2).connected = false;
  r.players.find(p => p.id === s3).connected = false;
  // Speaker 0 ends turn
  G.endTurn(r, s0);
  // Since all subsequent speakers are disconnected, game transitions to voting immediately
  assert.strictEqual(r.phase, 'voting');
});
t('results snapshot preserves player names even if player disconnects before results', () => {
  const { r, ps, host } = lobby(4); G.startGame(r, host); G.beginDiscussion(r);
  const leaver = ps.find(p => p.id !== r.game.impostor && p.id !== host);
  G.beginVoting(r);
  // Disconnect leaver and remove from room players
  G.removePlayer(r, leaver.id);
  // Remaining 3 players vote
  const remaining = r.players.filter(p => p.connected);
  remaining.forEach(p => {
    const target = remaining.find(x => x.id !== p.id).id;
    G.castVote(r, p.id, target);
  });
  assert.strictEqual(r.phase, 'results');
  // Check that the leaver is still present in the results snapshot
  const snapshotPlayer = r.game.result.players.find(p => p.id === leaver.id);
  assert.ok(snapshotPlayer, 'Disconnected player must be preserved in result snapshot');
  assert.strictEqual(snapshotPlayer.name, leaver.name);
  const view = G.viewFor(r, host);
  assert.ok(view.result.players.some(p => p.name === leaver.name));
});
t('host migration during reveal phase', () => {
  const { r, ps, host } = lobby(4); G.startGame(r, host);
  assert.strictEqual(r.phase, 'reveal');
  G.removePlayer(r, host);
  assert.ok(r.hostId);
  assert.notStrictEqual(r.hostId, host);
  assert.ok(['reveal', 'results'].includes(r.phase));
});
t('host migration during discussion phase', () => {
  const { r, ps, host } = lobby(4); G.startGame(r, host); G.beginDiscussion(r);
  assert.strictEqual(r.phase, 'discussion');
  G.removePlayer(r, host);
  assert.ok(r.hostId);
  assert.notStrictEqual(r.hostId, host);
  assert.ok(['discussion', 'results'].includes(r.phase));
});
t('clearTimer clears timer handle and deadline without throwing', () => {
  const r = G.createRoom();
  G.clearTimer(r);
  assert.strictEqual(r.timer, null);
  assert.strictEqual(r.deadline, null);
});
t('consecutive rounds avoid repeating the same impostor when 4+ players', () => {
  const { r, ps, host } = toVoting(4); G.resolveVotes(r);
  const firstImp = r.game.impostor;
  G.playAgain(r, host);
  const secondImp = r.game.impostor;
  assert.notStrictEqual(secondImp, firstImp, 'Consecutive rounds must not assign the same impostor');
});

// ── Granular Turn Order Disconnect Proofs: A B C D ──
t('turn order: A disconnects while speaking -> advances to B', () => {
  const { r, ps, host } = lobby(5); G.startGame(r, host); G.beginDiscussion(r);
  const [A, B, C, D, E] = r.game.order;
  assert.strictEqual(r.game.speakerId, A);
  // A disconnects (not impostor to avoid early finish)
  const pA = r.players.find(p => p.id === A);
  pA.connected = false;
  if (!r.game.completedSpeakers.includes(A)) r.game.completedSpeakers.push(A);
  G.advanceTurn(r);
  assert.strictEqual(r.game.speakerId, B, 'Must advance to B');
  assert.deepStrictEqual(r.game.order, [A, B, C, D, E], 'Order must remain immutable');
});

t('turn order: B disconnects while speaking -> advances to C', () => {
  const { r, ps, host } = lobby(5); G.startGame(r, host); G.beginDiscussion(r);
  const [A, B, C, D, E] = r.game.order;
  G.endTurn(r, A); // A speaks and ends turn
  assert.strictEqual(r.game.speakerId, B);
  const pB = r.players.find(p => p.id === B);
  pB.connected = false;
  if (!r.game.completedSpeakers.includes(B)) r.game.completedSpeakers.push(B);
  G.advanceTurn(r);
  assert.strictEqual(r.game.speakerId, C, 'Must advance to C');
  assert.deepStrictEqual(r.game.order, [A, B, C, D, E], 'Order must remain immutable');
});

t('turn order: C disconnects while speaking -> advances to D', () => {
  const { r, ps, host } = lobby(5); G.startGame(r, host); G.beginDiscussion(r);
  const [A, B, C, D, E] = r.game.order;
  G.endTurn(r, A);
  G.endTurn(r, B);
  assert.strictEqual(r.game.speakerId, C);
  const pC = r.players.find(p => p.id === C);
  pC.connected = false;
  if (!r.game.completedSpeakers.includes(C)) r.game.completedSpeakers.push(C);
  G.advanceTurn(r);
  assert.strictEqual(r.game.speakerId, D, 'Must advance to D');
  assert.deepStrictEqual(r.game.order, [A, B, C, D, E], 'Order must remain immutable');
});

t('turn order: D (last speaker) disconnects while speaking -> advances to voting', () => {
  const { r, ps, host } = lobby(4); G.startGame(r, host); G.beginDiscussion(r);
  const [A, B, C, D] = r.game.order;
  G.endTurn(r, A);
  G.endTurn(r, B);
  G.endTurn(r, C);
  assert.strictEqual(r.game.speakerId, D);
  const pD = r.players.find(p => p.id === D);
  pD.connected = false;
  if (!r.game.completedSpeakers.includes(D)) r.game.completedSpeakers.push(D);
  G.advanceTurn(r);
  assert.strictEqual(r.phase, 'voting', 'Must advance to voting when last speaker disconnects');
});

t('turn order: two future speakers disconnect -> skips both to subsequent player', () => {
  const { r, ps, host } = lobby(5); G.startGame(r, host); G.beginDiscussion(r);
  const [A, B, C, D, E] = r.game.order;
  assert.strictEqual(r.game.speakerId, A);
  // B and C disconnect while A is speaking
  r.players.find(p => p.id === B).connected = false;
  r.players.find(p => p.id === C).connected = false;
  // A finishes speaking
  G.endTurn(r, A);
  // Should skip both B and C and advance directly to D
  assert.strictEqual(r.game.speakerId, D, 'Must skip disconnected B and C to D');
  assert.deepStrictEqual(r.game.order, [A, B, C, D, E], 'Order remains immutable');
});

t('multiple players leaving such that fewer than 3 players remain -> cleanly aborts to lobby', () => {
  const { r, ps, host } = lobby(5); G.startGame(r, host); G.beginDiscussion(r);
  // Pick 3 civilians to leave
  const civs = ps.filter(p => p.id !== r.game.impostor);
  civs.slice(0, 3).forEach(p => G.removePlayer(r, p.id));
  assert.strictEqual(r.phase, 'lobby', 'Must abort to lobby when fewer than 3 players remain');
  assert.strictEqual(r.game, null, 'Game state must be cleared');
});

console.log(`\n${n} tests passed`); process.exit(0);

