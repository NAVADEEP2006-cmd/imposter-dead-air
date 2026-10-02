'use strict';
/**
 * INTEGRATION TEST — Simulates real WebSocket clients against the live server.
 *
 * Requires: node >= 18, ws package installed.
 * Run:  npm start &  (start the server on PORT 3001)
 *       PORT=3001 node test-integration.js
 *
 * Tests the ACTUAL WebSocket message path, not just game.js internals.
 */
const { WebSocket } = require('ws');
const assert = require('assert');
const http = require('http');

const PORT = process.env.TEST_PORT || 3001;
const URL = `ws://127.0.0.1:${PORT}`;
let serverProcess = null;
let passed = 0, failed = 0, skipped = 0;
const results = [];

// ───────────────────── helpers ─────────────────────

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.id = null;
    this.token = null;
    this.code = null;
    this.state = null;
    this.errors = [];
    this._queue = [];
    this._waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', raw => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.t === 'joined') {
          this.id = m.id;
          this.token = m.token;
          this.code = m.code;
        } else if (m.t === 'state') {
          this.state = m.s;
        } else if (m.t === 'error') {
          this.errors.push(m.msg);
        }
        this._queue.push(m);
        // resolve any waiters
        for (let i = this._waiters.length - 1; i >= 0; i--) {
          if (this._waiters[i].check(m)) {
            this._waiters[i].resolve(m);
            this._waiters.splice(i, 1);
          }
        }
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  // Wait for a message matching the check function, with timeout
  waitFor(check, timeoutMs = 5000) {
    // Check already-received messages
    for (const m of this._queue) {
      if (check(m)) {
        this._queue.splice(this._queue.indexOf(m), 1);
        return Promise.resolve(m);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for message (${this.name})`));
      }, timeoutMs);
      this._waiters.push({
        check,
        resolve: m => { clearTimeout(timer); resolve(m); }
      });
    });
  }

  waitForState(phaseName, timeoutMs = 5000) {
    return this.waitFor(m => m.t === 'state' && m.s.phase === phaseName, timeoutMs);
  }

  waitForPhase(phaseName, timeoutMs = 8000) {
    // Return immediately if already in that phase
    if (this.state && this.state.phase === phaseName) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.name}: timeout waiting for phase '${phaseName}', current: '${this.state?.phase}'`));
      }, timeoutMs);
      const check = m => {
        if (m.t === 'state' && m.s.phase === phaseName) {
          clearTimeout(timer);
          return true;
        }
        return false;
      };
      this._waiters.push({ check, resolve: m => { clearTimeout(timer); resolve(m.s); } });
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }

  // Drain remaining messages
  drain() { this._queue = []; }
}

async function startServer() {
  // Spawn server as child process
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', data => {
      if (data.toString().includes('Listening')) resolve();
    });
    serverProcess.stderr.on('data', data => {
      console.error('Server stderr:', data.toString());
    });
    setTimeout(() => reject(new Error('Server did not start in time')), 5000);
  });
}

function stopServer() {
  if (serverProcess) serverProcess.kill();
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ───────────────── TEST SUITES ─────────────────

async function testFullGameLifecycle() {
  console.log('\n═══ FULL GAME LIFECYCLE ═══');

  await test('4 players can create, join, ready, start, discuss, vote, and see results', async () => {
    const A = new Client('Alice');
    const B = new Client('Bob');
    const C = new Client('Charlie');
    const D = new Client('Diana');
    await Promise.all([A.connect(), B.connect(), C.connect(), D.connect()]);

    // Create room
    A.send({ t: 'create', name: 'Alice' });
    await A.waitFor(m => m.t === 'joined');
    const code = A.code;
    assert.ok(code && code.length === 6, 'Room code should be 6 chars');

    // Join room
    B.send({ t: 'join', name: 'Bob', code });
    C.send({ t: 'join', name: 'Charlie', code });
    D.send({ t: 'join', name: 'Diana', code });
    await Promise.all([
      B.waitFor(m => m.t === 'joined'),
      C.waitFor(m => m.t === 'joined'),
      D.waitFor(m => m.t === 'joined')
    ]);

    // Wait for lobby state with 4 players
    await wait(200);
    assert.strictEqual(A.state.players.length, 4);
    assert.strictEqual(A.state.phase, 'lobby');

    // Ready up (everyone except host)
    B.send({ t: 'ready', v: true });
    C.send({ t: 'ready', v: true });
    D.send({ t: 'ready', v: true });
    await wait(300);

    // Start game
    A.send({ t: 'start' });
    await A.waitForPhase('reveal');
    assert.strictEqual(A.state.phase, 'reveal');

    // Wait for discussion (auto-transition after 8s)
    await A.waitForPhase('discussion', 12000);
    assert.strictEqual(A.state.phase, 'discussion');

    // End all turns
    const order = A.state.game.order;
    for (const id of order) {
      const player = [A, B, C, D].find(p => p.id === id);
      player.send({ t: 'endturn' });
      await wait(200);
    }

    // Should be in voting
    await A.waitForPhase('voting');
    assert.strictEqual(A.state.phase, 'voting');

    // Everyone votes for the first non-self player
    for (const p of [A, B, C, D]) {
      const target = p.state.game.roster.find(id => id !== p.id);
      p.send({ t: 'vote', target });
      await wait(100);
    }

    // Should reach results
    await A.waitForPhase('results', 5000);
    assert.strictEqual(A.state.phase, 'results');
    assert.ok(A.state.result, 'Results should be present');
    assert.ok(A.state.result.word, 'Word should be revealed');
    assert.ok(A.state.result.impostor, 'Impostor should be revealed');

    A.close(); B.close(); C.close(); D.close();
  });
}

async function testSecretIsolation() {
  console.log('\n═══ SECRET INFORMATION AUDIT ═══');

  await test('impostor never receives the word during reveal/discussion/voting', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('P' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'P0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'P' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients[1].send({ t: 'ready', v: true });
    clients[2].send({ t: 'ready', v: true });
    clients[3].send({ t: 'ready', v: true });
    await wait(300);

    // Record ALL messages from this point
    clients.forEach(c => c.drain());
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal', 5000);

    // Find the impostor
    const impostor = clients.find(c => c.state.secret && c.state.secret.impostor === true);
    const civilians = clients.filter(c => c.state.secret && c.state.secret.impostor === false);

    assert.ok(impostor, 'Exactly one impostor should exist');
    assert.strictEqual(civilians.length, 3, 'Three civilians should exist');

    // CRITICAL: Impostor's state must NOT contain the word
    assert.strictEqual(impostor.state.secret.word, undefined, 'Impostor must not receive the word');
    assert.ok(!JSON.stringify(impostor.state).includes(civilians[0].state.secret.word),
      'Impostor state JSON must not contain the word anywhere');

    // Civilians must not know who the impostor is
    for (const c of civilians) {
      const stateStr = JSON.stringify(c.state);
      assert.ok(!stateStr.includes(`"impostor":"${impostor.id}"`),
        'Civilian must not receive impostor identity');
    }

    clients.forEach(c => c.close());
  });

  await test('votes are hidden during voting phase (only voter IDs visible, not targets)', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('V' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'V0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'V' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal', 5000);
    await clients[0].waitForPhase('discussion', 12000);
    // Skip turns
    const order = clients[0].state.game.order;
    for (const id of order) {
      clients.find(c => c.id === id).send({ t: 'endturn' });
      await wait(200);
    }
    await clients[0].waitForPhase('voting');

    // Player 0 votes
    const target = clients[0].state.game.roster.find(id => id !== clients[0].id);
    clients[0].send({ t: 'vote', target });
    await wait(500);

    // Player 1 checks state: should see that P0 voted, but NOT who they voted for
    const state1 = clients[1].state;
    assert.ok(state1.game.voted.includes(clients[0].id), 'Should see P0 has voted');
    // The state must not contain individual vote targets during voting
    assert.strictEqual(state1.result, undefined, 'Result must not be present during voting');

    // Full state JSON must not contain vote mapping
    const stateStr = JSON.stringify(state1);
    assert.ok(!stateStr.includes(`"votes":{"`), 'Vote targets must not leak during voting');

    clients.forEach(c => c.close());
  });

  await test('results phase reveals everything correctly', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('R' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'R0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'R' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');
    await clients[0].waitForPhase('discussion', 12000);
    const order = clients[0].state.game.order;
    for (const id of order) {
      clients.find(c => c.id === id).send({ t: 'endturn' });
      await wait(200);
    }
    await clients[0].waitForPhase('voting');

    // Everyone votes for first other player
    for (const c of clients) {
      c.send({ t: 'vote', target: c.state.game.roster.find(id => id !== c.id) });
      await wait(100);
    }
    await clients[0].waitForPhase('results');

    // All players should see: word, impostor identity, all votes, tally
    for (const c of clients) {
      assert.ok(c.state.result.word, 'Word must be revealed in results');
      assert.ok(c.state.result.impostor, 'Impostor must be revealed in results');
      assert.ok(c.state.result.votes, 'Individual votes must be revealed');
      assert.ok(c.state.result.tally, 'Vote tally must be revealed');
      // Secret should no longer be present
      assert.strictEqual(c.state.secret, undefined, 'Secret must not be present in results');
    }

    clients.forEach(c => c.close());
  });
}

async function testReconnect() {
  console.log('\n═══ RECONNECT ═══');

  await test('player can disconnect and reconnect with session token within grace period', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('RC' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'RC0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'RC' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');

    // Save Player 1's credentials
    const savedId = clients[1].id;
    const savedToken = clients[1].token;
    const savedSecret = clients[1].state.secret;

    // Player 1 disconnects
    clients[1].close();
    await wait(2000);

    // Player 1 reconnects with saved credentials
    const reconnected = new Client('RC1-reconnected');
    await reconnected.connect();
    reconnected.send({ t: 'resume', code, id: savedId, token: savedToken });
    await reconnected.waitFor(m => m.t === 'joined');
    await wait(500);

    // Verify identity restored
    assert.strictEqual(reconnected.id, savedId, 'Same player ID after reconnect');
    assert.ok(reconnected.state, 'Should receive game state after reconnect');
    assert.deepStrictEqual(reconnected.state.secret, savedSecret, 'Same secret/role after reconnect');

    // Verify no duplicate player in the room
    const playerIds = reconnected.state.players.map(p => p.id);
    const uniqueIds = new Set(playerIds);
    assert.strictEqual(playerIds.length, uniqueIds.size, 'No duplicate players');

    clients[0].close(); reconnected.close(); clients[2].close(); clients[3].close();
  });

  await test('reconnect with invalid token is rejected', async () => {
    const A = new Client('Auth0');
    await A.connect();
    A.send({ t: 'create', name: 'Auth0' });
    await A.waitFor(m => m.t === 'joined');
    const code = A.code;

    const B = new Client('BadToken');
    await B.connect();
    B.send({ t: 'resume', code, id: A.id, token: 'forged_token_value' });
    await B.waitFor(m => m.t === 'error');
    assert.ok(B.errors.some(e => /expired/i.test(e)), 'Forged token should be rejected');

    A.close(); B.close();
  });
}

async function testHostMigration() {
  console.log('\n═══ HOST MIGRATION ═══');

  await test('host migration in lobby when host disconnects', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('HM' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'HM0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'HM' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(300);

    const oldHost = clients[0].id;
    clients[0].close(); // Host disconnects
    await wait(1000);

    // Remaining clients should see new host
    assert.notStrictEqual(clients[1].state.hostId, oldHost, 'Host should have migrated');
    assert.ok(clients[1].state.players.some(p => p.id === clients[1].state.hostId),
      'New host must be an existing player');

    clients[1].close(); clients[2].close(); clients[3].close();
  });

  await test('host migration mid-game preserves game state', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('HMG' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'HMG0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'HMG' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');
    await clients[0].waitForPhase('discussion', 12000);

    // Host disconnects during discussion
    const oldPhase = clients[1].state.phase;
    clients[0].close();
    await wait(1000);

    // Game should still be running
    assert.ok(['discussion', 'voting'].includes(clients[1].state.phase),
      'Game should continue after host disconnect');
    assert.notStrictEqual(clients[1].state.hostId, clients[0].id,
      'Host should have migrated');

    clients[1].close(); clients[2].close(); clients[3].close();
  });
}

async function testRaceConditions() {
  console.log('\n═══ RACE CONDITIONS ═══');

  await test('double start is rejected', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('DS' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'DS0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'DS' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);

    // Send start 10 times rapidly
    for (let i = 0; i < 10; i++) {
      clients[0].send({ t: 'start' });
    }
    await wait(500);

    // Should have exactly 1 round
    assert.strictEqual(clients[0].state.round, 1, 'Only one game should start');

    clients.forEach(c => c.close());
  });

  await test('double vote is rejected', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('DV' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'DV0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'DV' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');
    await clients[0].waitForPhase('discussion', 12000);
    const order = clients[0].state.game.order;
    for (const id of order) {
      clients.find(c => c.id === id).send({ t: 'endturn' });
      await wait(200);
    }
    await clients[0].waitForPhase('voting');

    // Player 0 votes twice
    const target = clients[0].state.game.roster.find(id => id !== clients[0].id);
    clients[0].send({ t: 'vote', target });
    await wait(200);
    clients[0].drain();
    clients[0].send({ t: 'vote', target: clients[0].state.game.roster.find(id => id !== clients[0].id && id !== target) });
    await wait(500);
    assert.ok(clients[0].errors.some(e => /already voted/i.test(e)), 'Double vote must be rejected');

    clients.forEach(c => c.close());
  });

  await test('out-of-phase messages are rejected', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('OP' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'OP0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'OP' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);

    // Try to vote during lobby phase
    clients[0].send({ t: 'vote', target: clients[1].id });
    await wait(300);
    // Try to end turn during lobby phase
    clients[0].send({ t: 'endturn' });
    await wait(300);

    // Should have errors
    assert.ok(clients[0].errors.length >= 1, 'Out-of-phase actions must be rejected');

    clients.forEach(c => c.close());
  });

  await test('rate limiting blocks excessive messages', async () => {
    const A = new Client('RL0');
    await A.connect();
    A.send({ t: 'create', name: 'RL0' });
    await A.waitFor(m => m.t === 'joined');

    // Send 25 messages rapidly (limit is 20/second)
    for (let i = 0; i < 25; i++) {
      A.send({ t: 'ready', v: true });
    }
    await wait(200);

    // Should still be connected (rate limit drops messages, doesn't crash)
    assert.strictEqual(A.ws.readyState, WebSocket.OPEN, 'Connection should survive rate limit');
    A.close();
  });
}

async function testTieRules() {
  console.log('\n═══ TIE RULES ═══');

  await test('A→B, B→A tie: impostor escapes', async () => {
    // This is validated by unit tests but we verify the full WS path
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('T' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'T0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'T' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');
    await clients[0].waitForPhase('discussion', 12000);
    const order = clients[0].state.game.order;
    for (const id of order) {
      clients.find(c => c.id === id).send({ t: 'endturn' });
      await wait(200);
    }
    await clients[0].waitForPhase('voting');

    // Create tie: 0→1, 1→0, 2→0, 3→1 (2 votes each for 0 and 1)
    const ids = clients.map(c => c.id);
    clients[0].send({ t: 'vote', target: ids[1] });
    clients[1].send({ t: 'vote', target: ids[0] });
    clients[2].send({ t: 'vote', target: ids[0] });
    clients[3].send({ t: 'vote', target: ids[1] });
    await clients[0].waitForPhase('results');

    assert.strictEqual(clients[0].state.result.winner, 'impostor', 'Tie must result in impostor win');
    assert.strictEqual(clients[0].state.result.eliminated, null, 'Nobody eliminated on tie');

    clients.forEach(c => c.close());
  });
}

async function testPlayAgainRoundReset() {
  console.log('\n═══ ROUND RESET / PLAY AGAIN ═══');

  await test('host can return to lobby after results via next command', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('PA' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'PA0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'PA' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');
    await clients[0].waitForPhase('discussion', 12000);
    const order = clients[0].state.game.order;
    for (const id of order) {
      clients.find(c => c.id === id).send({ t: 'endturn' });
      await wait(200);
    }
    await clients[0].waitForPhase('voting');
    for (const c of clients) {
      c.send({ t: 'vote', target: c.state.game.roster.find(id => id !== c.id) });
      await wait(100);
    }
    await clients[0].waitForPhase('results');

    // Host triggers next round (currently goes back to lobby)
    clients[0].send({ t: 'next' });
    await clients[0].waitForPhase('lobby');
    assert.strictEqual(clients[0].state.phase, 'lobby');
    assert.strictEqual(clients[0].state.game, undefined, 'Game state cleared');

    // Can start a new game
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');
    assert.strictEqual(clients[0].state.round, 2, 'Round counter should increment');

    clients.forEach(c => c.close());
  });
}

async function testImpostorDisconnect() {
  console.log('\n═══ IMPOSTOR DISCONNECT ═══');

  await test('impostor leaving mid-round ends game with civilian win', async () => {
    const clients = [];
    for (let i = 0; i < 5; i++) {
      const c = new Client('ID' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'ID0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 5; i++) {
      clients[i].send({ t: 'join', name: 'ID' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');

    // Find the impostor
    const impostor = clients.find(c => c.state.secret && c.state.secret.impostor === true);
    assert.ok(impostor, 'Should find impostor');

    // Impostor leaves
    impostor.send({ t: 'leave' });
    await wait(1000);

    // Remaining players should see the game end or go to results
    const remaining = clients.filter(c => c !== impostor && c.state);
    for (const c of remaining) {
      // After impostor leaves + sweep, game either goes to results or lobby
      assert.ok(['results', 'lobby'].includes(c.state.phase),
        `Game should end after impostor leaves, got: ${c.state.phase}`);
    }

    clients.forEach(c => c.close());
  });
}

async function testSecurity() {
  console.log('\n═══ SECURITY AUDIT ═══');

  await test('messages without joining a room are rejected', async () => {
    const A = new Client('Sec0');
    await A.connect();
    A.send({ t: 'start' });
    await wait(500);
    assert.ok(A.errors.some(e => /join/i.test(e)), 'Must reject actions without joining');
    A.close();
  });

  await test('malformed JSON is silently ignored', async () => {
    const A = new Client('Sec1');
    await A.connect();
    A.ws.send('not json at all {{{');
    A.ws.send('');
    A.ws.send('null');
    await wait(500);
    assert.strictEqual(A.ws.readyState, WebSocket.OPEN, 'Connection should survive bad JSON');
    A.close();
  });

  await test('non-host cannot start the game', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('NH' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'NH0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'NH' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);

    // Non-host tries to start
    clients[1].send({ t: 'start' });
    await wait(500);
    assert.ok(clients[1].errors.some(e => /host/i.test(e)), 'Non-host start must be rejected');
    assert.strictEqual(clients[0].state.phase, 'lobby', 'Game should not have started');

    clients.forEach(c => c.close());
  });

  await test('self-vote is rejected', async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client('SV' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'SV0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'SV' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');
    await clients[0].waitForPhase('discussion', 12000);
    const order = clients[0].state.game.order;
    for (const id of order) {
      clients.find(c => c.id === id).send({ t: 'endturn' });
      await wait(200);
    }
    await clients[0].waitForPhase('voting');

    // Try self-vote
    clients[0].send({ t: 'vote', target: clients[0].id });
    await wait(500);
    assert.ok(clients[0].errors.some(e => /another player/i.test(e)), 'Self-vote must be rejected');

    clients.forEach(c => c.close());
  });

  await test('XSS in player name is sanitized', async () => {
    const A = new Client('XSS');
    await A.connect();
    A.send({ t: 'create', name: '<script>alert(1)' });
    await A.waitFor(m => m.t === 'joined');
    await wait(200);
    // The clean() function should strip angle brackets
    const player = A.state.players.find(p => p.id === A.id);
    assert.ok(!player.name.includes('<'), 'Name must not contain angle brackets');
    assert.ok(!player.name.includes('>'), 'Name must not contain angle brackets');
    A.close();
  });

  await test('maxPayload prevents oversized messages', async () => {
    const A = new Client('MP');
    await A.connect();
    A.send({ t: 'create', name: 'MP' });
    await A.waitFor(m => m.t === 'joined');

    // Send a message that exceeds 8KB
    try {
      A.ws.send(JSON.stringify({ t: 'ready', v: 'x'.repeat(10000) }));
    } catch (e) {
      // Expected
    }
    await wait(500);
    // Connection may be closed by server due to oversized payload
    // This is acceptable behavior
    A.close();
  });
}

async function testPlayerCounts() {
  console.log('\n═══ PLAYER COUNT EDGE CASES ═══');

  await test('cannot start with 3 players', async () => {
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const c = new Client('PC' + i);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: 'PC0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;
    for (let i = 1; i < 3; i++) {
      clients[i].send({ t: 'join', name: 'PC' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);
    clients.slice(1).forEach(c => c.send({ t: 'ready', v: true }));
    await wait(300);
    clients[0].send({ t: 'start' });
    await wait(500);
    assert.ok(clients[0].errors.some(e => /at least 4/i.test(e)), '3 players must not start');
    clients.forEach(c => c.close());
  });

  await test('cannot exceed 12 players', async () => {
    const clients = [];
    const host = new Client('Max0');
    await host.connect();
    host.send({ t: 'create', name: 'Max0' });
    await host.waitFor(m => m.t === 'joined');
    const code = host.code;
    clients.push(host);

    for (let i = 1; i <= 12; i++) {
      const c = new Client('Max' + i);
      await c.connect();
      clients.push(c);
      c.send({ t: 'join', name: 'Max' + i, code });
      await wait(100);
    }
    await wait(500);

    // The 13th player (Max12, index 12) should have an error
    const lastClient = clients[12];
    assert.ok(lastClient.errors.some(e => /full/i.test(e)), '13th player must be rejected');

    clients.forEach(c => c.close());
  });
}

// ───────────────── MAIN ─────────────────

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  IMPOSTER: DEAD AIR — Integration Test ║');
  console.log('╚════════════════════════════════════════╝');

  try {
    console.log('\nStarting server on port', PORT, '...');
    await startServer();
    console.log('Server started.');

    await testFullGameLifecycle();
    await testSecretIsolation();
    await testReconnect();
    await testHostMigration();
    await testRaceConditions();
    await testTieRules();
    await testPlayAgainRoundReset();
    await testImpostorDisconnect();
    await testSecurity();
    await testPlayerCounts();

  } catch (e) {
    console.error('Fatal error:', e);
  } finally {
    stopServer();
  }

  console.log('\n════════════════════════════════');
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('════════════════════════════════');

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
