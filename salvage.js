'use strict';
/**
 * SALVAGE MODE — original co-op extraction vertical slice (part 1: state).
 * Server-authoritative 2D movement + pickup/deliver/rescue/extraction.
 * Legacy word game stays intact until this slice proves fun.
 */
const crypto = require('crypto');
const WORLD_W = 1000;
const WORLD_H = 620;
const MATCH_MS = 8 * 60 * 1000;
const EXTRACT_MS = 75 * 1000;
const TICK_MS = 100;
const BASE_SPEED = 150;
const INTERACT_R = 78;
const DOWN_REVIVE_R = 90;
const DOWN_MS = 25000;
const HEAVY_SLOW = 0.72;
const OVERLOADED_SLOW = 0.5;
const MAX_SLOTS = 3;
const MAX_WEIGHT = 3;
const DOWN_PENALTY_SLOTS = 1;
const CELLS = [
  { id: 'cell-a', name: 'CELL A — SPARE CELLS', x: 150, y: 430, need: 1 },
  { id: 'cell-b', name: 'CELL B — SPARE CELLS', x: 160, y: 150, need: 1 }
];
const STATION_NEED = CELLS.reduce((n, c) => n + c.need, 0);
const ITEM_DEFS = {
  cell: { kind: 'cell', name: 'POWER CELL', slots: 1, weight: 1, score: 120, heavy: false, fragile: false, volatile: false, mission: true },
  medkit: { kind: 'medkit', name: 'PATCH KIT', slots: 1, weight: 1, score: 25, heavy: false, fragile: false, volatile: false, mission: false, usable: true },
  relic: { kind: 'relic', name: 'GLOW RELIC', slots: 1, weight: 1, score: 220, heavy: false, fragile: true, volatile: false, mission: false },
  core: { kind: 'core', name: 'UNSTABLE CORE', slots: 2, weight: 2, score: 450, heavy: true, fragile: true, volatile: true, mission: false }
};
const SALVAGE_PHASES = ['staging', 'run', 'extract', 'debrief'];
const int = n => crypto.randomInt(n);
const pick = a => a[int(a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); };
class SalvageErr extends Error {}
function makeItem(kind, x, y, idSuffix) {
  const def = ITEM_DEFS[kind];
  return { id: `${kind}-${idSuffix}`, kind, name: def.name, x, y, carriedBy: null, banked: false, broken: false, slots: def.slots, weight: def.weight, score: def.score, heavy: def.heavy, fragile: def.fragile, volatile: def.volatile, mission: def.mission, usable: !!def.usable };
}
function buildWorld(playerCount) {
  const spots = [{ x: 830, y: 120 }, { x: 880, y: 220 }, { x: 820, y: 500 }, { x: 620, y: 470 }, { x: 700, y: 140 }, { x: 560, y: 300 }];
  const items = [];
  for (let i = 0; i < STATION_NEED + 1; i++) { const s = spots[i % spots.length]; items.push(makeItem('cell', s.x + (i * 23) % 60 - 30, s.y + (i * 31) % 60 - 30, `m${i}`)); }
  items.push(makeItem('medkit', 480, 180, 'k0'));
  items.push(makeItem('medkit', 500, 430, 'k1'));
  items.push(makeItem('relic', 880, 420, 'r0'));
  items.push(makeItem('relic', 760, 300, 'r1'));
  if (playerCount >= 5) items.push(makeItem('relic', 620, 120, 'r2'));
  items.push(makeItem('core', 900, 300, 'x0'));
  return { w: WORLD_W, h: WORLD_H, depot: { x: 90, y: 300, r: 90, name: 'SALVAGE DEPOT' }, dock: { x: 910, y: 90, r: 95, name: 'SKY DOCK' }, cells: CELLS.map(c => ({ ...c, filled: 0 })), items, hazards: [{ id: 'leak-1', x: 470, y: 300, r: 90, active: false, name: 'COOLANT LEAK' }, { id: 'leak-2', x: 760, y: 470, r: 80, active: false, name: 'COOLANT LEAK' }], quakeAt: Date.now() + 150000, quakeDone: false };
}
function playerStart(i, n) {
  const rows = Math.ceil(n / 2);
  const row = Math.floor(i / 2);
  const col = i % 2;
  return { x: 90 + col * 70, y: 190 + row * Math.max(60, 240 / Math.max(1, rows - 1 || 1)) };
}
function createRun(room, playerIds) {
  const world = buildWorld(playerIds.length);
  const parts = {};
  playerIds.forEach((id, i) => { const s = playerStart(i, playerIds.length); parts[id] = { id, x: s.x, y: s.y, tx: s.x, ty: s.y, alive: true, down: false, downAt: 0, rescuedBy: null, inv: [], rescued: 0, deliveredMission: 0, deliveredLoot: 0, bankedCoreBy: 0, bankedRelicBy: 0, risked: 0, lastMove: 0 }; });
  return { phase: 'staging', roundId: room.roundId, startedAt: Date.now(), extractAt: 0, endsAt: 0, world, parts, roster: [...playerIds], personal: {}, log: [{ t: Date.now(), msg: 'Haul crew staged. Grab cells, mind the weight.' }], result: null, timer: null };
}
function slotsUsed(part) { return part.inv.reduce((n, it) => n + (it.slots || 1), 0); }
function weightCarried(part) { return part.inv.reduce((n, it) => n + (it.weight || 1), 0); }
function speedFor(part) {
  let s = BASE_SPEED;
  const w = weightCarried(part);
  if (part.inv.some(i => i.heavy)) s *= HEAVY_SLOW;
  if (w > MAX_WEIGHT || slotsUsed(part) > MAX_SLOTS) s *= OVERLOADED_SLOW;
  if (part.down) s = 0;
  return s;
}
function pushLog(run, msg) { run.log.push({ t: Date.now(), msg }); while (run.log.length > 12) run.log.shift(); }
function missionDelivered(run) { return run.world.cells.reduce((n, c) => n + c.filled, 0); }
function near(a, b, r) { return dist2(a, b) <= r; }
function itemById(run, itemId) { return run.world.items.find(i => i.id === itemId); }
function nameOf(run, pid) { return (run.roomNames && run.roomNames[pid]) || 'Crew'; }
function requireSalvagePhase(run, allowed) {
  const ph = run.phase;
  if (!allowed.includes(ph)) {
    if (ph === 'staging') throw new SalvageErr('Haul has not opened yet.');
    if (ph === 'debrief') throw new SalvageErr('Haul is over.');
    throw new SalvageErr('Action not allowed in this phase.');
  }
}
function validateCarrier(run, pid) {
  const part = run.parts[pid];
  if (!part || !run.roster.includes(pid)) throw new SalvageErr('You are not on this haul.');
  if (!part.alive) throw new SalvageErr('You are out of this haul.');
  if (part.down) throw new SalvageErr('You are down. Ping for a patch-up.');
  return part;
}
function movePlayer(run, pid, x, y) {
  const part = run.parts[pid];
  if (!part || !run.roster.includes(pid)) throw new SalvageErr('You are not on this haul.');
  if (!part.alive) throw new SalvageErr('You are out of this haul.');
  if (part.down) return part;
  if (run.phase === 'debrief') throw new SalvageErr('Haul is over.');
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new SalvageErr('Bad coordinates.');
  x = clamp(x, 12, WORLD_W - 12);
  y = clamp(y, 12, WORLD_H - 12);
  if (dist2(part, { x, y }) > 420) throw new SalvageErr('Move target too far.');
  part.tx = x; part.ty = y;
  part.lastMove = Date.now();
  return part;
}
function downPlayer(run, pid, reason) {
  const part = run.parts[pid];
  if (!part || !part.alive || part.down) return;
  part.down = true; part.downAt = Date.now(); dropAll(run, pid);
  pushLog(run, `${nameOf(run, pid)} is down${reason ? ' — ' + reason : ''}. Someone bring a patch kit.`);
}
function dropAll(run, pid) {
  const part = run.parts[pid];
  if (!part) return;
  for (const it of part.inv) { it.carriedBy = null; it.x = clamp(part.x + int(50) - 25, 12, WORLD_W - 12); it.y = clamp(part.y + int(50) - 25, 12, WORLD_H - 12); }
  part.inv = [];
}
function stepRun(run, now) {
  const dt = TICK_MS / 1000;
  let moved = false;
  for (const id of run.roster) {
    const part = run.parts[id];
    if (!part || !part.alive || part.down) continue;
    const dx = part.tx - part.x, dy = part.ty - part.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 2) continue;
    const sp = speedFor(part) * dt;
    const k = Math.min(1, sp / d);
    part.x = clamp(part.x + dx * k, 12, WORLD_W - 12);
    part.y = clamp(part.y + dy * k, 12, WORLD_H - 12);
    moved = true;
  }
  if (run.phase === 'run' && !run.world.quakeDone && now >= run.world.quakeAt) {
    run.world.quakeDone = true;
    run.world.hazards.forEach(h => { h.active = true; });
    pushLog(run, 'QUAKE: coolant lines burst. Watch the vapor.');
  }
  if (run.phase === 'run' || run.phase === 'extract') {
    for (const id of run.roster) {
      const part = run.parts[id];
      if (!part || !part.alive || part.down) continue;
      for (const h of run.world.hazards) {
        if (h.active && dist2(part, h) <= h.r) { downPlayer(run, id, `caught by ${h.name}`); break; }
      }
    }
  }
  for (const id of run.roster) {
    const part = run.parts[id];
    if (part && part.down && now - part.downAt > DOWN_MS) {
      part.down = false; part.alive = false; dropAll(run, id);
      pushLog(run, `${nameOf(run, id)} went cold. Left where they fell.`);
    }
  }
  return moved;
}
function pickup(run, pid, itemId) {
  requireSalvagePhase(run, ['run', 'extract']);
  const part = validateCarrier(run, pid);
  const it = itemById(run, itemId);
  if (!it) throw new SalvageErr('No such item.');
  if (it.carriedBy || it.banked || it.broken) throw new SalvageErr('Already taken.');
  if (!near(part, it, INTERACT_R)) throw new SalvageErr('Get closer to grab it.');
  if (slotsUsed(part) + it.slots > MAX_SLOTS + DOWN_PENALTY_SLOTS) throw new SalvageErr('Hands full. Drop something.');
  it.carriedBy = pid;
  part.inv.push(it);
  if (it.volatile) { part.risked += 1; pushLog(run, `${nameOf(run, pid)} grabbed the UNSTABLE CORE.`); }
  return it;
}
function dropItem(run, pid, itemId) {
  if (run.phase === 'debrief') throw new SalvageErr('Haul is over.');
  const part = validateCarrier(run, pid);
  const ix = part.inv.findIndex(i => i.id === itemId);
  if (ix < 0) throw new SalvageErr('Not carrying that.');
  const [it] = part.inv.splice(ix, 1);
  it.carriedBy = null;
  it.x = clamp(part.x + 18, 12, WORLD_W - 12);
  it.y = clamp(part.y + 14, 12, WORLD_H - 12);
  if (it.fragile && it.volatile) { it.score = Math.floor(it.score / 2); pushLog(run, 'The core hit the deck. It is cracked and worth less.'); }
  return it;
}
function useKit(run, pid, targetId) {
  requireSalvagePhase(run, ['run', 'extract']);
  const part = validateCarrier(run, pid);
  const kitIx = part.inv.findIndex(i => i.kind === 'medkit');
  if (kitIx < 0) throw new SalvageErr('No patch kit in your hands.');
  const target = run.parts[targetId];
  if (!target || !run.roster.includes(targetId)) throw new SalvageErr('Nobody to patch.');
  if (!target.down) throw new SalvageErr('They are still on their feet.');
  if (!near(part, target, DOWN_REVIVE_R)) throw new SalvageErr('Get next to them to patch.');
  const [kit] = part.inv.splice(kitIx, 1);
  kit.carriedBy = null; kit.banked = true;
  target.down = false; target.rescuedBy = pid;
  run.parts[pid].rescued += 1;
  pushLog(run, `${nameOf(run, pid)} patched up ${nameOf(run, targetId)}.`);
  return target;
}
function deliver(run, pid) {
  requireSalvagePhase(run, ['run', 'extract']);
  const part = validateCarrier(run, pid);
  if (!near(part, run.world.depot, run.world.depot.r)) throw new SalvageErr('Haul it back to the depot circle.');
  if (!part.inv.length) throw new SalvageErr('Empty hands. Nothing to bank.');
  let mission = 0, loot = 0, score = 0;
  for (const it of part.inv) {
    if (it.mission) {
      const cell = run.world.cells.find(c => c.filled < c.need);
      if (cell) { cell.filled += 1; it.carriedBy = null; it.banked = true; it.bankedBy = pid; mission += 1; score += it.score; part.deliveredMission += 1; continue; }
    }
    it.carriedBy = null; it.banked = true; it.bankedBy = pid; loot += 1; score += it.score; part.deliveredLoot += 1;
    if (it.kind === 'core') part.bankedCoreBy += 1;
    if (it.kind === 'relic') part.bankedRelicBy += 1;
  }
  part.inv = [];
  if (missionDelivered(run) >= STATION_NEED && run.phase === 'run') pushLog(run, 'Station cells seated. Dock window opening…');
  return { mission, loot, score };
}
function runPhase(room) {
  const run = room.salvage;
  if (!run || room.phase === 'salvage-debrief') return 'debrief';
  if (room.phase === 'salvage-staging') return 'staging';
  if (room.phase === 'salvage-run') return 'run';
  if (room.phase === 'salvage-extract') return 'extract';
  if (room.phase === 'salvage-debrief') return 'debrief';
  return run.phase;
}
function assignPersonal(run) { for (const id of run.roster) run.personal[id] = pick(['relic', 'rescue', 'core']); }
function beginRun(room, requesterId) {
  if (room.phase !== 'lobby') throw new SalvageErr('Haul can only start from the lobby.');
  if (requesterId && room.hostId && requesterId !== room.hostId) throw new SalvageErr('Only the host can start the haul.');
  const active = room.players.filter(p => p.connected && !p.spectator);
  if (active.length < 2) throw new SalvageErr('Need at least 2 crew to haul.');
  room.round = (room.round || 0) + 1;
  room.roundId = crypto.randomBytes(8).toString('hex');
  const run = createRun(room, active.map(p => p.id));
  run.roomNames = {};
  active.forEach(p => { run.roomNames[p.id] = p.name; });
  assignPersonal(run);
  room.salvage = run; room.phase = 'salvage-staging'; room.game = null; room.notice = null;
  room.deadline = Date.now() + 20000;
  clearTimeout(room.salvageTimer);
  room.salvageTimer = setTimeout(() => { if (room.phase === 'salvage-staging') openHaul(room); }, 20000);
  if (room.salvageTimer.unref) room.salvageTimer.unref();
  return run;
}
function openHaul(room) {
  const run = room.salvage;
  if (!run || room.phase !== 'salvage-staging') return;
  run.phase = 'run'; run.startedAt = Date.now(); run.endsAt = run.startedAt + MATCH_MS;
  room.phase = 'salvage-run'; room.deadline = run.endsAt;
  clearTimeout(room.salvageTimer);
  room.salvageTimer = setTimeout(() => openExtract(room), MATCH_MS);
  clearInterval(room.salvageTick);
  room.salvageTick = setInterval(() => { stepRun(run, Date.now()); room.onChange(); }, TICK_MS);
  if (room.salvageTick.unref) room.salvageTick.unref();
  pushLog(run, 'Haul window open. Cells to the depot, then reach the dock.');
  room.onChange();
}
function openExtract(room) {
  const run = room.salvage;
  if (!run || room.phase !== 'salvage-run') return;
  run.phase = 'extract'; run.extractAt = Date.now();
  room.phase = 'salvage-extract'; room.deadline = run.extractAt + EXTRACT_MS;
  run.world.hazards.forEach(h => { h.active = true; });
  pushLog(run, 'DOCK WINDOW: 75 seconds. Get bodies and loot to the dock.');
  clearTimeout(room.salvageTimer);
  room.salvageTimer = setTimeout(() => finishRun(room, 'timer'), EXTRACT_MS);
  room.onChange();
}
function extractedIds(run) {
  return run.roster.filter(id => { const p = run.parts[id]; return p && p.alive && !p.down && near(p, run.world.dock, run.world.dock.r); });
}
function maybeEarlyFinish(room) {
  const run = room.salvage;
  if (!run || run.phase !== 'extract') return;
  const alive = run.roster.filter(id => run.parts[id] && run.parts[id].alive);
  const out = extractedIds(run);
  if (alive.length && out.length >= alive.length) finishRun(room, 'all-out');
}
function scoreRun(run) {
  let banked = 0; const mission = missionDelivered(run);
  for (const it of run.world.items) if (it.banked) banked += it.score;
  const out = extractedIds(run);
  let bonus = 0; const personalDone = {};
  for (const id of run.roster) {
    const p = run.parts[id]; const hook = run.personal[id]; let done = false;
    if (hook === 'rescue') done = p.rescued > 0;
    else if (hook === 'core') done = (p.bankedCoreBy || 0) > 0;
    else done = (p.bankedRelicBy || 0) > 0;
    personalDone[id] = done;
    if (done && out.includes(id)) bonus += 150;
  }
  return { banked, mission, out, bonus, total: banked + bonus, personalDone };
}
function finishRun(room, why) {
  const run = room.salvage;
  if (!run || room.phase === 'salvage-debrief') return;
  clearTimeout(room.salvageTimer); clearInterval(room.salvageTick);
  run.phase = 'debrief'; room.phase = 'salvage-debrief'; room.deadline = null;
  const s = scoreRun(run);
  const win = s.mission >= STATION_NEED && s.out.length > 0;
  let mvp = null, mvpScore = -1;
  for (const id of run.roster) { const p = run.parts[id]; const sc = p.deliveredMission * 3 + p.deliveredLoot * 1 + p.rescued * 2 + (s.personalDone[id] ? 1 : 0); if (sc > mvpScore) { mvpScore = sc; mvp = id; } }
  let greediest = null, gScore = -1;
  for (const id of run.roster) { const p = run.parts[id]; if (p.deliveredLoot > gScore) { gScore = p.deliveredLoot; greediest = id; } }
  run.result = { win, why, mission: s.mission, need: STATION_NEED, banked: s.banked, bonus: s.bonus, total: s.total, out: s.out, personalDone: s.personalDone, personal: run.personal, parts: run.roster.map(id => ({ id, name: nameOf(run, id), mission: run.parts[id].deliveredMission, loot: run.parts[id].deliveredLoot, rescues: run.parts[id].rescued, risked: run.parts[id].risked, out: s.out.includes(id), hookDone: !!s.personalDone[id] })), mvp, greediest, text: win ? `Station lit and ${s.out.length} made the dock. Split ${s.total} salvage.` : s.mission < STATION_NEED ? `Cells short (${s.mission}/${STATION_NEED}). The station went dark with the loot.` : 'Cells seated, but nobody reached the dock. The haul sits in the dark.' };
  room.onChange();
}
function quitToLobby(room) { clearTimeout(room.salvageTimer); clearInterval(room.salvageTick); room.salvage = null; room.phase = 'lobby'; room.game = null; room.roundId = null; room.deadline = null; room.players.forEach(p => { p.ready = false; p.spectator = false; }); }
function privateHook(room, run, pid) {
  if (!run || run.phase === 'debrief') return null;
  return run.personal[pid] || null;
}
function publicRun(room, run) {
  const items = run.world.items.filter(i => !i.banked && !i.carriedBy && !i.broken);
  const parts = run.roster.map(id => {
    const p = run.parts[id];
    return { id, x: Math.round(p.x), y: Math.round(p.y), alive: p.alive, down: p.down, slots: slotsUsed(p), weight: weightCarried(p), speed: Math.round(speedFor(p)), carry: p.inv.map(i => ({ id: i.id, kind: i.kind, name: i.name, heavy: i.heavy, volatile: i.volatile })) };
  });
  return { phase: run.phase, roundId: room.roundId || run.roundId, w: run.world.w, h: run.world.h, depot: run.world.depot, dock: run.world.dock, cells: run.world.cells, hazards: run.world.hazards, items: items.map(i => ({ id: i.id, kind: i.kind, name: i.name, x: Math.round(i.x), y: Math.round(i.y), heavy: i.heavy, fragile: i.fragile, volatile: i.volatile })), parts, need: STATION_NEED, mission: missionDelivered(run), deadline: room.deadline, log: run.log.slice(-6), result: run.phase === 'debrief' ? run.result : null };
}
module.exports = { SalvageErr, SALVAGE_PHASES, WORLD_W, WORLD_H, MAX_SLOTS, MAX_WEIGHT, INTERACT_R, MATCH_MS, EXTRACT_MS, TICK_MS, CELLS, STATION_NEED, ITEM_DEFS, int, pick, clamp, dist2, makeItem, buildWorld, playerStart, createRun, slotsUsed, weightCarried, speedFor, pushLog, missionDelivered, near, itemById, nameOf, DOWN_REVIVE_R, DOWN_MS, DOWN_PENALTY_SLOTS, validateCarrier, requireSalvagePhase, movePlayer, downPlayer, dropAll, stepRun, pickup, dropItem, useKit, deliver, runPhase, assignPersonal, beginRun, openHaul, openExtract, extractedIds, maybeEarlyFinish, scoreRun, finishRun, quitToLobby, publicRun, privateHook };
