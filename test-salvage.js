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
  const run = r.salvage;
  const pid = run.roster[0];
  const core = run.world.items.find(i => i.kind === 'core');
  run.parts[pid].x = core.x; run.parts[pid].y = core.y;
  const before = core.score;
  SV.pickup(run, pid, core.id);
  assert.ok(SV.speedFor(run.parts[pid]) < 150);
  SV.dropItem(run, pid, core.id);
  assert.ok(core.score < before);
  clearTimeout(r.salvageTimer);
});

t('SALVAGE: patch kit revives a downed carrier nearby', () => {
  const { r } = salvageRoom(2);
  SV.beginRun(r);
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
  throwsSalvage(() => SV.movePlayer(run, pid, 900, 100), /too far/i);
  SV.movePlayer(run, pid, run.parts[pid].x + 40, run.parts[pid].y + 10);
  SV.stepRun(run, Date.now());
  assert.ok(Math.abs(run.parts[pid].x - 90) > 1);
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
