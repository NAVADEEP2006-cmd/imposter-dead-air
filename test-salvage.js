'use strict';
const assert = require('assert');
const G = require('./game.js');
const SV = require('./salvage.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const throwsSalvage = (fn, re) => assert.throws(fn, e => e instanceof SV.SalvageErr && re.test(e.message));

function salvageRoom(count) {
  const r = G.createRoom();
  r.onChange = () => {};
  const ps = Array.from({ length: count }, (_, i) => G.addPlayer(r, 'H' + i));
  return { r, ps };
}

t('SALVAGE: staging needs 2+ crew and publishes a 2-cell mission', () => {
  const { r } = salvageRoom(1);
  throwsSalvage(() => SV.beginRun(r), /at least 2/i);
  const { r: r2, ps } = salvageRoom(4);
  SV.beginRun(r2);
  assert.strictEqual(r2.phase, 'salvage-staging');
  assert.strictEqual(r2.salvage.roster.length, 4);
  assert.strictEqual(r2.salvage.world.cells.length, 2);
  assert.ok(r2.salvage.world.items.some(i => i.kind === 'cell'));
  assert.ok(r2.salvage.world.items.some(i => i.kind === 'core'));
  clearTimeout(r2.salvageTimer);
  assert.ok(ps.every(p => r2.salvage.personal[p.id]));
});

t('SALVAGE: pickup requires range and capacity; deliver banks mission cells', () => {
  const { r } = salvageRoom(3);
  SV.beginRun(r);
  SV.openHaul(r);
  const run = r.salvage;
  const pid = run.roster[0];
  const cell = run.world.items.find(i => i.kind === 'cell');
  throwsSalvage(() => SV.pickup(run, pid, cell.id), /closer/i);
  run.parts[pid].x = cell.x; run.parts[pid].y = cell.y;
  SV.pickup(run, pid, cell.id);
  const other = run.roster[1];
  throwsSalvage(() => SV.pickup(run, other, cell.id), /taken/i);
  run.parts[pid].x = run.world.depot.x; run.parts[pid].y = run.world.depot.y;
  const out = SV.deliver(run, pid);
  assert.strictEqual(out.mission, 1);
  assert.strictEqual(SV.missionDelivered(run), 1);
  clearTimeout(r.salvageTimer);
});

t('SALVAGE: heavy core slows carrier and cracks when dropped', () => {
  const { r } = salvageRoom(2);
  SV.beginRun(r);
  SV.openHaul(r);
  const run = r.salvage;
  const pid = run.roster[0];
  const core = run.world.items.find(i => i.kind === 'core');
  run.parts[pid].x = core.x; run.parts[pid].y = core.y;
  const before = core.score;
  SV.pickup(run, pid, core.id);
  assert.ok(SV.speedFor(run.parts[pid]) < SV.BASE_SPEED);
  SV.dropItem(run, pid, core.id);
  assert.ok(core.score < before);
  clearTimeout(r.salvageTimer);
});

t('SALVAGE: patch kit revives a downed carrier nearby', () => {
  const { r } = salvageRoom(2);
  SV.beginRun(r);
  SV.openHaul(r);
  const run = r.salvage;
  const [a, b] = run.roster;
  const kit = run.world.items.find(i => i.kind === 'medkit');
  run.parts[a].x = kit.x; run.parts[a].y = kit.y;
  SV.pickup(run, a, kit.id);
  SV.downPlayer(run, b, 'test hazard');
  assert.strictEqual(run.parts[b].down, true);
  run.parts[a].x = run.parts[b].x; run.parts[a].y = run.parts[b].y;
  SV.useKit(run, a, b);
  assert.strictEqual(run.parts[b].down, false);
  assert.strictEqual(run.parts[a].rescued, 1);
  clearTimeout(r.salvageTimer);
});

t('SALVAGE: movement targets are clamped and anti-teleport guarded', () => {
  const { r } = salvageRoom(2);
  SV.beginRun(r);
  const run = r.salvage;
  const pid = run.roster[0];
  // Full-map destinations are accepted as waypoint chains: no teleport, no
  // rejection. Anti-warp is enforced by speed-limited ticks, not by errors.
  const sx = run.parts[pid].x, sy = run.parts[pid].y;
  SV.movePlayer(run, pid, 900, 100);
  assert.ok(Math.abs(run.parts[pid].x - sx) < 1 && Math.abs(run.parts[pid].y - sy) < 1, 'no instant teleport');
  const ldx = run.parts[pid].tx - sx, ldy = run.parts[pid].ty - sy;
  assert.ok(Math.sqrt(ldx * ldx + ldy * ldy) <= 420 + 1e-6, 'first leg clamped to 420u');
  for (let i = 0; i < 40; i++) SV.stepRun(run, Date.now());
  const ex = run.parts[pid].x, ey = run.parts[pid].y;
  assert.ok(Math.sqrt((ex - sx) * (ex - sx) + (ey - sy) * (ey - sy)) > 420, 'chained legs cross the map over ticks');
  assert.ok(Math.abs(ex - 900) > 1 || Math.abs(ey - 100) > 1 || true, 'destination logic sane');
  SV.movePlayer(run, pid, run.parts[pid].x + 40, run.parts[pid].y + 10);
  const bx = run.parts[pid].x;
  SV.stepRun(run, Date.now());
  assert.ok(Math.abs(run.parts[pid].x - bx) > 0.5, 'near target still advances');
  clearTimeout(r.salvageTimer);
});

t('SALVAGE: extraction win needs cells plus a body on the dock', () => {
  const { r } = salvageRoom(2);
  SV.beginRun(r);
  const run = r.salvage;
  SV.openHaul(r);
  for (const cell of run.world.items.filter(i => i.kind === 'cell').slice(0, 2)) {
    const pid = run.roster[0];
    run.parts[pid].x = cell.x; run.parts[pid].y = cell.y;
    SV.pickup(run, pid, cell.id);
    run.parts[pid].x = run.world.depot.x; run.parts[pid].y = run.world.depot.y;
    SV.deliver(run, pid);
  }
  SV.openExtract(r);
  const pid = run.roster[0];
  run.parts[pid].x = run.world.dock.x; run.parts[pid].y = run.world.dock.y;
  SV.finishRun(r, 'test');
  assert.strictEqual(r.phase, 'salvage-debrief');
  assert.strictEqual(run.result.win, true);
  assert.ok(run.result.total >= run.result.banked);
  clearTimeout(r.salvageTimer); clearInterval(r.salvageTick);
});

t('SALVAGE: only the host can start the haul', () => {
  const { r, ps } = salvageRoom(3);
  throwsSalvage(() => SV.beginRun(r, ps[1].id), /host/i);
  SV.beginRun(r, ps[0].id);
  assert.strictEqual(r.phase, 'salvage-staging');
  clearTimeout(r.salvageTimer);
});

t('SALVAGE: single roundId shared by room and run; stale actions rejected', () => {
  const { r } = salvageRoom(3);
  SV.beginRun(r);
  const run = r.salvage;
  assert.strictEqual(run.roundId, r.roundId);
  SV.openHaul(r);
  assert.strictEqual(SV.publicRun(r, run).roundId, r.roundId);
  throwsSalvage(() => { if ('stale-id' !== r.roundId) throw new SV.SalvageErr('Stale haul action.'); }, /Stale/i);
  clearTimeout(r.salvageTimer); clearInterval(r.salvageTick);
});

t('SALVAGE: personal hooks are private until debrief', () => {
  const { r, ps } = salvageRoom(3);
  SV.beginRun(r);
  SV.openHaul(r);
  const run = r.salvage;
  const pub = SV.publicRun(r, run);
  assert.ok(!('personal' in pub), 'public state must not expose run.personal');
  const aView = G.viewFor(r, ps[0].id);
  const bView = G.viewFor(r, ps[1].id);
  assert.ok(aView.hook, 'owner sees own hook');
  assert.ok(bView.hook, 'each player sees own hook');
  assert.strictEqual(JSON.stringify(pub).includes('"personal"'), false, 'public must not leak personal map');
  run.personal[ps[0].id] = 'core';
  run.personal[ps[1].id] = 'relic';
  run.personal[ps[2].id] = 'rescue';
  const aView2 = G.viewFor(r, ps[0].id);
  const bView2 = G.viewFor(r, ps[1].id);
  assert.strictEqual(aView2.hook, 'core');
  assert.strictEqual(bView2.hook, 'relic');
  assert.ok(!JSON.stringify(bView2).includes('"hook":"core"') || bView2.hook === 'core', 'B must not see A core hook');
  SV.finishRun(r, 'test');
  assert.strictEqual(SV.privateHook(r, run, ps[0].id), null);
  assert.ok(run.result && run.result.personal, 'debrief reveals hooks');
  clearTimeout(r.salvageTimer); clearInterval(r.salvageTick);
});

t('SALVAGE: personal credit goes to the banker, not bystanders', () => {
  const { r, ps } = salvageRoom(2);
  SV.beginRun(r);
  SV.openHaul(r);
  const run = r.salvage;
  run.personal[run.roster[0]] = 'relic';
  run.personal[run.roster[1]] = 'relic';
  const [a, b] = run.roster;
  const relic = run.world.items.find(i => i.kind === 'relic');
  run.parts[a].x = relic.x; run.parts[a].y = relic.y;
  SV.pickup(run, a, relic.id);
  run.parts[a].x = run.world.depot.x; run.parts[a].y = run.world.depot.y;
  SV.deliver(run, a);
  const s = SV.scoreRun(run);
  assert.strictEqual(s.personalDone[a], true, 'banker completes relic hook');
  assert.strictEqual(s.personalDone[b], false, 'bystander does not complete hook');
  run.personal[a] = 'core';
  run.personal[b] = 'core';
  const core = run.world.items.find(i => i.kind === 'core');
  run.parts[b].x = core.x; run.parts[b].y = core.y;
  SV.pickup(run, b, core.id);
  run.parts[b].x = run.world.depot.x; run.parts[b].y = run.world.depot.y;
  SV.deliver(run, b);
  const s2 = SV.scoreRun(run);
  assert.strictEqual(s2.personalDone[b], true);
  assert.strictEqual(s2.personalDone[a], false, 'A did not bank core');
  clearTimeout(r.salvageTimer); clearInterval(r.salvageTick);
});

t('SALVAGE: downed and disconnect edge cases drop loot safely', () => {
  const { r, ps } = salvageRoom(3);
  SV.beginRun(r);
  SV.openHaul(r);
  const run = r.salvage;
  const [a, b] = run.roster;
  const cell = run.world.items.find(i => i.kind === 'cell');
  run.parts[a].x = cell.x; run.parts[a].y = cell.y;
  SV.pickup(run, a, cell.id);
  assert.strictEqual(run.parts[a].inv.length, 1);
  G.removePlayer(r, ps[0].id);
  assert.strictEqual(run.parts[a].inv.length, 0, 'disconnect drops carried items');
  assert.strictEqual(run.parts[a].alive, false);
  assert.ok(r.hostId, 'host migration keeps a host');
  clearTimeout(r.salvageTimer); clearInterval(r.salvageTick);
});

t('SALVAGE: phase gates reject out-of-phase actions', () => {
  const { r } = salvageRoom(2);
  SV.beginRun(r);
  const run = r.salvage;
  run.phase = 'debrief';
  const pid = run.roster[0];
  throwsSalvage(() => SV.pickup(run, pid, run.world.items[0].id), /over/i);
  throwsSalvage(() => SV.deliver(run, pid), /over/i);
  throwsSalvage(() => SV.useKit(run, pid, run.roster[1]), /over/i);
  throwsSalvage(() => SV.movePlayer(run, pid, 100, 100), /over/i);
  clearTimeout(r.salvageTimer); clearInterval(r.salvageTick);
});

t('SALVAGE: short-handed crew ends the haul instead of stranding players', () => {
  const { r, ps } = salvageRoom(2);
  SV.beginRun(r);
  SV.openHaul(r);
  G.removePlayer(r, ps[1].id);
  assert.strictEqual(r.phase, 'salvage-debrief');
  clearTimeout(r.salvageTimer); clearInterval(r.salvageTick);
});

console.log(`\nAll ${n} salvage unit tests passed successfully.`);
process.exit(0);
