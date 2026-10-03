'use strict';
/* SALVAGE INTEGRATION — 4 live clients, full haul lifecycle. */
const { WebSocket } = require('ws');
const assert = require('assert');
const { spawn } = require('child_process');
const PORT = process.env.TEST_PORT || 3002;
const URL = `ws://127.0.0.1:${PORT}`;
let serverProcess = null;
let passed = 0, failed = 0;
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
class SClient {
  constructor(name) { this.name = name; this.ws = null; this.id = null; this.token = null; this.code = null; this.state = null; this.errors = []; this._waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', raw => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.t === 'joined') { this.id = m.id; this.token = m.token; this.code = m.code; }
        else if (m.t === 'state') { this.state = m.s; }
        else if (m.t === 'error') { this.errors.push(m.msg); }
        for (let i = this._waiters.length - 1; i >= 0; i--) {
          if (this._waiters[i].check(m)) { this._waiters[i].resolve(m); this._waiters.splice(i, 1); }
        }
      });
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  waitFor(check, t = 9000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout (${this.name})`)), t);
      this._waiters.push({ check, resolve: m => { clearTimeout(timer); resolve(m); } });
    });
  }
  waitPhase(ph, t = 15000) {
    if (this.state && this.state.phase === ph) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timeout ${ph}, at ${this.state && this.state.phase}`)), t);
      this._waiters.push({ check: m => m.t === 'state' && m.s.phase === ph, resolve: m => { clearTimeout(timer); resolve(m.s); } });
    });
  }
  close() { if (this.ws) this.ws.close(); }
}
async function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = d => { out += String(d); if (out.includes('Server listening')) { clearTimeout(timer); serverProcess.stdout.off('data', onData); resolve(); } };
    const timer = setTimeout(() => reject(new Error('start timeout: ' + out.slice(-300))), 12000);
    serverProcess.stdout.on('data', onData);
    serverProcess.on('error', reject);
  });
}
function stopServer() { if (serverProcess) { serverProcess.kill(); serverProcess = null; } }
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
}
function myPart(c) { const sv = c.state && c.state.salvage; return sv && sv.parts ? sv.parts.find(p => p.id === c.id) : null; }
async function main() {
  console.log('SALVAGE INTEGRATION — 4 clients, full haul lifecycle');
  try {
    await startServer();
    const clients = [new SClient('A'), new SClient('B'), new SClient('C'), new SClient('D')];
    await Promise.all(clients.map(c => c.connect()));
    const A = clients[0], B = clients[1], C = clients[2], D = clients[3];
    await test('A creates room, BCD join, salvage mode, ready', async () => {
      A.send({ t: 'create', name: 'A' });
      await A.waitFor(m => m.t === 'joined');
      const code = A.code;
      for (const c of [B, C, D]) { c.send({ t: 'join', name: c.name, code }); await c.waitFor(m => m.t === 'joined'); }
      A.send({ t: 'mode', v: 'salvage' });
      await wait(300);
      assert.strictEqual(A.state.mode, 'salvage');
      for (const c of [B, C, D]) c.send({ t: 'ready', v: true });
      await wait(300);
    });
    await test('non-host start rejected; host starts to staging', async () => {
      B.send({ t: 'start' });
      await wait(300);
      assert.ok(B.errors.some(e => /host/i.test(e)), 'B rejected: ' + B.errors.join('|'));
      A.send({ t: 'start' });
      await Promise.all(clients.map(c => c.waitPhase('salvage-staging')));
    });
    await test('stale haul action rejected; haul opens to run', async () => {
      A.send({ t: 'move', x: 100, y: 100, haulId: 'stale-id' });
      await wait(300);
      assert.ok(A.errors.some(e => /stale/i.test(e)), 'stale rejected');
      A.send({ t: 'haul_open' });
      await Promise.all(clients.map(c => c.waitPhase('salvage-run')));
    });
    await test('movement + A banks first cell + B grabs loot', async () => {
      for (const c of clients) c.send({ t: 'move', x: 200, y: 300, haulId: c.state.roundId });
      await wait(1100);
      const cell = A.state.salvage.items.find(i => i.kind === 'cell');
      assert.ok(cell, 'cell exists');
      A.send({ t: 'move', x: cell.x, y: cell.y, haulId: A.state.roundId });
      await wait(900);
      A.send({ t: 'grab', item: cell.id, haulId: A.state.roundId });
      await wait(400);
      assert.ok((A.state.carry || []).length >= 1, 'A carries: ' + JSON.stringify(A.state.carry));
      const depot = A.state.salvage.depot;
      A.send({ t: 'move', x: depot.x, y: depot.y, haulId: A.state.roundId });
      await wait(900);
      A.send({ t: 'bank', haulId: A.state.roundId });
      await wait(500);
      assert.ok(A.state.salvage.mission >= 1, 'mission=' + A.state.salvage.mission);
      const relic = B.state.salvage.items.find(i => i.kind === 'relic');
      assert.ok(relic, 'relic exists');
      B.send({ t: 'move', x: relic.x, y: relic.y, haulId: B.state.roundId });
      await wait(900);
      B.send({ t: 'grab', item: relic.id, haulId: B.state.roundId });
      await wait(400);
      assert.ok((B.state.carry || []).length >= 1, 'B carries loot');
    });
    await test('hooks private; fake item rejected', async () => {
      assert.ok(A.state.hook, 'A hook present');
      assert.ok(!JSON.stringify(A.state.salvage).includes('personal'), 'no personal leak');
      C.send({ t: 'grab', item: 'fake-item', haulId: C.state.roundId });
      await wait(300);
      assert.ok(C.errors.some(e => /no such|not/i.test(e)), 'fake rejected');
    });
    await test('second cell banks; extraction opens', async () => {
      const cell = A.state.salvage.items.find(i => i.kind === 'cell');
      assert.ok(cell, 'second cell, mission=' + A.state.salvage.mission);
      A.send({ t: 'move', x: cell.x, y: cell.y, haulId: A.state.roundId });
      await wait(900);
      A.send({ t: 'grab', item: cell.id, haulId: A.state.roundId });
      await wait(400);
      const depot = A.state.salvage.depot;
      A.send({ t: 'move', x: depot.x, y: depot.y, haulId: A.state.roundId });
      await wait(900);
      A.send({ t: 'bank', haulId: A.state.roundId });
      await wait(800);
      assert.ok(['salvage-extract', 'salvage-debrief'].includes(A.state.phase), 'phase=' + A.state.phase);
    });
    await test('dock run reaches debrief; rematch to staging', async () => {
      for (const c of clients) { try { const d = c.state.salvage.dock; c.send({ t: 'move', x: d.x, y: d.y, haulId: c.state.roundId }); } catch (e) {} }
      await Promise.all(clients.map(c => c.waitPhase('salvage-debrief', 90000)));
      assert.ok(A.state.salvage.result && A.state.salvage.result.out.length >= 1, 'someone out');
      A.send({ t: 'grab', item: 'cell-m0', haulId: A.state.roundId });
      await wait(300);
      assert.ok(A.errors.some(e => /over|not allowed|no such/i.test(e)), 'post-debrief rejected');
      A.send({ t: 'again_haul' });
      await Promise.all(clients.map(c => c.waitPhase('salvage-staging', 12000)));
    });
    clients.forEach(c => c.close());
  } catch (e) { console.error('Fatal:', e); failed++; }
  finally { stopServer(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main();


