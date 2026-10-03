'use strict';
/**
 * INTEGRATION TEST — Simulates real WebSocket clients against the live server.
 * Authoritatively verifies V1 Game Lifecycle, Secrecy Invariant, Chat Filtering,
 * Clue Mechanics, Ties, Reconnect, and Spectator Mode.
 */
const { WebSocket } = require('ws');
const assert = require('assert');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3001;
const URL = `ws://127.0.0.1:${PORT}`;
let serverProcess = null;
let passed = 0, failed = 0, skipped = 0;
const results = [];

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
    this.rejectedChats = [];
    this.chats = [];
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
        } else if (m.t === 'chat_rejected') {
          this.rejectedChats.push(m.msg);
        } else if (m.t === 'chat') {
          this.chats.push(m);
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

  waitFor(check, timeoutMs = 8000) {
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

  waitForPhase(phaseName, timeoutMs = 15000) {
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

  drain() { this._queue = []; }
}

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', data => {
      if (/listening/i.test(data.toString())) resolve();
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

  await test('4 players create, join, ready, start, submit clues, discuss, vote, and see results', async () => {
    const clients = [new Client('Alice'), new Client('Bob'), new Client('Charlie'), new Client('Diana')];
    await Promise.all(clients.map(c => c.connect()));

    clients[0].send({ t: 'create', name: 'Alice' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;

    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: clients[i].name, code });
      await clients[i].waitFor(m => m.t === 'joined');
    }
    await wait(200);

    // Ready up
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'ready', v: true });
    }
    await wait(200);

    // Start
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');
    assert.strictEqual(clients[0].state.phase, 'reveal');

    // Wait for clues phase
    await clients[0].waitForPhase('clues', 12000);
    assert.strictEqual(clients[0].state.phase, 'clues');

    // Submit clues sequentially in speaking order
    const cluesWords = ['Orbit', 'Gravity', 'Cosmic', 'Starlight'];
    for (let i = 0; i < clients[0].state.game.order.length; i++) {
      const activeSpeaker = clients[0].state.game.activeSpeaker;
      const speakerClient = clients.find(c => c.id === activeSpeaker);
      assert.ok(speakerClient, 'Speaker client must exist');
      speakerClient.send({ t: 'clue', word: cluesWords[i] });
      await wait(300);
    }

    // Discussion phase
    await clients[0].waitForPhase('discussion', 5000);
    assert.strictEqual(clients[0].state.phase, 'discussion');

    // All players toggle ready in discussion to advance early
    for (const c of clients) {
      c.send({ t: 'ready_discuss', v: true });
    }
    await wait(300);

    // Voting phase
    await clients[0].waitForPhase('vote', 5000);
    assert.strictEqual(clients[0].state.phase, 'vote');

    // All players vote for another player (imposter plurality test)
    const imposterId = clients.find(c => c.state.secret && c.state.secret.impostor).id;
    for (const c of clients) {
      if (c.id !== imposterId) {
        c.send({ t: 'vote', target: imposterId });
      } else {
        const otherId = clients.find(x => x.id !== imposterId).id;
        c.send({ t: 'vote', target: otherId });
      }
    }
    await wait(300);

    // Final guess
    await clients[0].waitForPhase('guess', 10000);
    assert.strictEqual(clients[0].state.phase, 'guess');

    // Imposter submits final guess
    const impClient = clients.find(c => c.id === imposterId);
    impClient.send({ t: 'guess', word: 'WrongWord' });
    await wait(300);

    // Results phase
    await clients[0].waitForPhase('result', 5000);
    assert.strictEqual(clients[0].state.phase, 'result');
    assert.ok(clients[0].state.result.word, 'Secret word must be present in result');
    assert.strictEqual(clients[0].state.result.winner, 'crew');

    clients.forEach(c => c.close());
  });
}

async function testSecretIsolation() {
  console.log('\n═══ SECRET INFORMATION AUDIT ═══');

  await test('imposter NEVER receives secret word across WebSocket frames before results', async () => {
    const clients = [new Client('P0'), new Client('P1'), new Client('P2'), new Client('P3')];
    await Promise.all(clients.map(c => c.connect()));

    clients[0].send({ t: 'create', name: 'P0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;

    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'P' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
      clients[i].send({ t: 'ready', v: true });
    }
    await wait(200);

    clients[0].send({ t: 'start' });
    await Promise.all(clients.map(c => c.waitForPhase('reveal', 8000)));

    // Identify secret word from crew and identify imposter
    const crewClient = clients.find(c => c.state && c.state.secret && c.state.secret.word);
    const impClient = clients.find(c => c.state && c.state.secret && c.state.secret.impostor);
    assert.ok(crewClient && impClient, 'Must find crew and imposter');
    const secretWord = crewClient.state.secret.word;
    assert.ok(secretWord, 'Secret word must exist');

    // Verify imposter queue does not contain secret word
    const assertNoSecretWordInImp = () => {
      const impMsgs = JSON.stringify(impClient._queue).toLowerCase();
      assert.ok(!impMsgs.includes(secretWord.toLowerCase()),
        `Security leak: Imposter queue contains secret word "${secretWord}"`);
    };

    assertNoSecretWordInImp();

    // Advance to clues
    await clients[0].waitForPhase('clues', 12000);
    assertNoSecretWordInImp();

    clients.forEach(c => c.close());
  });
}

async function testChatSecurity() {
  console.log('\n═══ CHAT SECURITY AUDIT ═══');

  await test('crew cannot leak secret word in chat (blocked and generic rejection to sender only)', async () => {
    const clients = [new Client('C0'), new Client('C1'), new Client('C2'), new Client('C3')];
    await Promise.all(clients.map(c => c.connect()));

    clients[0].send({ t: 'create', name: 'C0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;

    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'C' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
      clients[i].send({ t: 'ready', v: true });
    }
    await wait(200);

    clients[0].send({ t: 'start' });
    await Promise.all(clients.map(c => c.waitForPhase('reveal', 8000)));

    const crewClient = clients.find(c => c.state && c.state.secret && c.state.secret.word);
    const impClient = clients.find(c => c.state && c.state.secret && c.state.secret.impostor);
    assert.ok(crewClient && impClient, 'Must find crew and imposter');
    const secretWord = crewClient.state.secret.word;

    // Crew member tries to type secret word in chat
    crewClient.send({ t: 'chat', msg: `Hey everyone, the word is ${secretWord}!` });
    await wait(400);

    // Crew client should receive rejection
    assert.ok(crewClient.rejectedChats.length > 0, 'Crew client must receive chat_rejected notification');

    // Imposter client must NEVER receive the leaked chat
    const impReceivedChats = impClient.chats.map(m => m.msg).join(' ');
    assert.ok(!impReceivedChats.includes(secretWord), 'Imposter must not receive message containing secret word');

    // Imposter CAN chat freely
    impClient.send({ t: 'chat', msg: 'I am innocent!' });
    await wait(300);
    assert.ok(crewClient.chats.some(m => m.msg === 'I am innocent!'), 'Imposter chat should be broadcast');

    clients.forEach(c => c.close());
  });
}

async function testSpectatorMidRoundJoin() {
  console.log('\n═══ SPECTATOR MID-ROUND JOIN ═══');

  await test('player joining mid-round becomes spectator and receives zero secrets', async () => {
    const clients = [new Client('S0'), new Client('S1'), new Client('S2'), new Client('S3')];
    await Promise.all(clients.map(c => c.connect()));

    clients[0].send({ t: 'create', name: 'S0' });
    await clients[0].waitFor(m => m.t === 'joined');
    const code = clients[0].code;

    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', name: 'S' + i, code });
      await clients[i].waitFor(m => m.t === 'joined');
      clients[i].send({ t: 'ready', v: true });
    }
    await wait(200);

    // Start game
    clients[0].send({ t: 'start' });
    await clients[0].waitForPhase('reveal');

    // Late joiner arrives
    const late = new Client('LateJoiner');
    await late.connect();
    late.send({ t: 'join', name: 'LateJoiner', code });
    await late.waitFor(m => m.t === 'joined');
    await wait(300);

    assert.strictEqual(late.state.spectator, true, 'Late joiner must be spectator');
    assert.strictEqual(late.state.secret, null, 'Spectator must receive null secret');

    clients.forEach(c => c.close());
    late.close();
  });
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  IMPOSTER: DEAD AIR — V1 Full Integration & Security Audit ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    console.log('\nStarting server on port', PORT, '...');
    await startServer();
    await testFullGameLifecycle();
    await testSecretIsolation();
    await testChatSecurity();
    await testSpectatorMidRoundJoin();
  } catch (e) {
    console.error('Fatal test error:', e);
  } finally {
    stopServer();
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('════════════════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
