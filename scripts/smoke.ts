// Headless smoke test of the game core.
//   npx tsx scripts/smoke.ts            (2 game days with a starter bus network)
//   npx tsx scripts/smoke.ts --days 3
// Loads public/data/delft.json directly, so no network / IndexedDB is needed.
import { readFileSync } from 'node:fs';
import { createGameFromData, type Game } from '../src/game/game.ts';
import type { CityData } from '../src/osm/parse.ts';
import { CTRL_NONE } from '../src/sim/graph.ts';
import { toX, toY } from '../src/geo.ts';
import { P_WALK_TO_STOP, P_WAITING, P_RIDING, P_WALK_TO_DEST } from '../src/sim/agents.ts';

const argDays = process.argv.indexOf('--days');
const DAYS = argDays > 0 ? Number(process.argv[argDays + 1]) : 2;
const data = JSON.parse(readFileSync(new URL('../public/data/delft.json', import.meta.url), 'utf8')) as CityData;

const eur = (n: number) => '€' + Math.round(n).toLocaleString('nl-NL');
const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '-');

function newGame(): Game {
  const t0 = performance.now();
  const g = createGameFromData(null, [data], 'delft');
  console.log(`game built in ${(performance.now() - t0).toFixed(0)} ms: ${g.cities[0].G.nJ} junctions, ${g.cities[0].G.nE} edges, ${g.cities[0].Z} zones`);
  return g;
}

/** place bus stops every ~spacing m along the fastest bus path between two points */
function stopsAlong(g: Game, x0: number, y0: number, x1: number, y1: number, spacing: number): number[] {
  const c = g.cities[0];
  const G = c.G;
  const core = (j: number) => c.inCore[j] === 1 && G.jDeg[j] >= 3;
  const a = G.nearestJunction(x0, y0, 600, core);
  const b = G.nearestJunction(x1, y1, 600, core);
  const path = G.findPath(a, b, 'bus', 0, 400000, 70);
  if (!path) return [];
  const ids: number[] = [];
  const tryAdd = (j: number) => {
    const s = g.addStop('bus', G.jx[j], G.jy[j]);
    if (typeof s === 'string') return false;
    ids.push(s.d.id);
    return true;
  };
  tryAdd(a);
  let acc = 0;
  for (let i = 0; i < path.length; i++) {
    acc += G.eLen[path[i] >> 1];
    const j = G.arcTo(path[i]);
    if ((acc >= spacing && G.jDeg[j] >= 3) || i === path.length - 1) {
      if (tryAdd(j)) acc = 0;
    }
  }
  return ids;
}

function setupNetwork(g: Game, extended = false): void {
  const c = g.cities[0];
  const lines: [number, number, number, number][] = [
    [c.cx - 2000, c.cy - 300, c.cx + 1900, c.cy + 300], // west - east through centre
    [c.cx - 200, c.cy - 2000, c.cx + 200, c.cy + 2000], // south - north
  ];
  if (extended)
    lines.push(
      [c.cx - 1500, c.cy - 1500, c.cx + 1500, c.cy + 1500], // SW - NE
      [c.cx - 1500, c.cy + 1500, c.cx + 1500, c.cy - 1500], // NW - SE
      [c.cx - 1800, c.cy + 1000, c.cx + 1800, c.cy + 1100], // north W - E
      [c.cx - 1800, c.cy - 1100, c.cx + 1800, c.cy - 1000], // south W - E
    );
  for (const [x0, y0, x1, y1] of lines) {
    const stops = stopsAlong(g, x0, y0, x1, y1, extended ? 450 : 550);
    if (stops.length < 2) continue;
    const line = g.createLine('bus');
    if (typeof line === 'string') throw new Error(line);
    const err = g.setLineStops(line.id, stops);
    if (err) throw new Error(err);
    const need = line.vehiclesNeeded();
    const e2 = g.buyVehicles(line.id, need);
    if (e2) throw new Error(e2);
    console.log(
      `line ${line.d.name}: ${stops.length} stops (${stops.map((id) => g.stops.get(id)!.d.name).join(' | ')}), ` +
        `${(line.dirs[0].length / 1000).toFixed(2)} km, run ${(line.dirs[0].segTime.reduce((a, b) => a + b, 0) / 60).toFixed(1)} min, ${need} buses`,
    );
  }
}

interface Bucket {
  n: number;
  served: number;
  servedPt: number;
  pt: number;
  car: number;
  bike: number;
  walk: number;
}

function instrument(g: Game) {
  const c = g.cities[0];
  const buckets: Record<string, Bucket> = {};
  const orig = c.chooseMode.bind(c);
  c.chooseMode = (o: number, d: number, dist: number) => {
    const m = orig(o, d, dist);
    const k = dist < 1000 ? '<1km' : dist < 2000 ? '1-2km' : dist < 3000 ? '2-3km' : '>3km';
    const b = (buckets[k] ??= { n: 0, served: 0, servedPt: 0, pt: 0, car: 0, bike: 0, walk: 0 });
    b.n++;
    if (isFinite(c.ptCost[o * c.Z + d])) {
      b.served++;
      if (m === 3) b.servedPt++;
    }
    if (m === 0) b.walk++;
    else if (m === 1) b.bike++;
    else if (m === 2) b.car++;
    else b.pt++;
    return m;
  };
  return buckets;
}

interface Peaks {
  cars: number;
  bikes: number;
  walk: number;
  wait: number;
  ride: number;
  pax: number;
}

function sample(g: Game, pk: Peaks): void {
  let cars = 0,
    bikes = 0;
  for (const c of g.cities.slice(0, 1)) {
    const T = c.traffic;
    for (let i = 0; i < T.count; i++) if (T.alive[i]) (T.mode[i] === 1 ? bikes++ : cars++);
  }
  const P = g.passengers;
  const cnt = [0, 0, 0, 0, 0];
  for (let i = 0; i < P.count; i++) cnt[P.state[i]]++;
  const walk = cnt[P_WALK_TO_STOP] + cnt[P_WALK_TO_DEST];
  pk.cars = Math.max(pk.cars, cars);
  pk.bikes = Math.max(pk.bikes, bikes);
  pk.walk = Math.max(pk.walk, walk);
  pk.wait = Math.max(pk.wait, cnt[P_WAITING]);
  pk.ride = Math.max(pk.ride, cnt[P_RIDING]);
  pk.pax = Math.max(pk.pax, walk + cnt[P_WAITING] + cnt[P_RIDING]);
}

/** emulate browser frames (1/60 s) at a game speed; returns frame time stats */
function bench(g: Game, speed: number, frames: number, label: string): void {
  const prev = g.speed;
  g.speed = speed;
  const ts: number[] = [];
  const h0 = g.hour();
  for (let i = 0; i < frames; i++) {
    const t = performance.now();
    g.tick(1 / 60);
    ts.push(performance.now() - t);
  }
  g.speed = prev;
  ts.sort((a, b) => a - b);
  const avg = ts.reduce((a, b) => a + b, 0) / ts.length;
  const c = g.cities[0];
  console.log(
    `  [${label}] FRAME speed ${speed}: ${frames} frames ${h0.toFixed(2)}h-${g.hour().toFixed(2)}h | avg ${avg.toFixed(2)} ms, p50 ${ts[ts.length >> 1].toFixed(2)}, p95 ${ts[Math.floor(ts.length * 0.95)].toFixed(2)}, max ${ts[ts.length - 1].toFixed(2)} ms` +
      ` | effective speed ${g.effectiveSpeed.toFixed(1)} | cars+bikes ${c.traffic.active}, pax ${g.passengers.active}`,
  );
}

function run(g: Game, days: number, label: string, onDay?: (d: number) => void, benchAt = -1): number {
  let accidents = 0;
  const unsub = g.on('accident', () => accidents++);
  const toasts: Record<string, number> = {};
  const u2 = g.on('toast', (t) => {
    const k = t.kind + ': ' + t.msg.replace(/\d[\d.,]*/g, '#').slice(0, 60);
    toasts[k] = (toasts[k] || 0) + 1;
  });
  const u3 = g.on('levelup', (l) => console.log(`  [${label}] LEVEL UP -> ${l.level} at day ${g.day()} ${g.hour().toFixed(1)}h: ${l.unlocked.join(', ')}`));
  const u4 = g.on('day', (d) => onDay?.(d.day));
  g.speed = 30;
  const endTime = g.time + days * 1440;
  const t0 = performance.now();
  let mark = Math.floor(g.time / 5);
  const pk: Peaks = { cars: 0, bikes: 0, walk: 0, wait: 0, ride: 0, pax: 0 };
  let benchMs = 0;
  let peakHourMs = 0;
  while (g.time < endTime) {
    const tb = performance.now();
    if (benchAt >= 0 && g.time >= benchAt) {
      benchAt = -1;
      bench(g, 1, 1800, label);
      bench(g, 10, 600, label);
      bench(g, 30, 300, label);
      benchMs += performance.now() - tb;
      continue;
    }
    g.tick(1 / 60);
    const h = g.hour();
    if (h >= 17 && h < 18) peakHourMs += performance.now() - tb;
    const m = Math.floor(g.time / 5);
    if (m !== mark) {
      mark = m;
      sample(g, pk);
    }
  }
  const ms = performance.now() - t0 - benchMs;
  unsub();
  u2();
  u3();
  u4();
  const c0 = g.cities[0];
  console.log(
    `  [${label}] ${(ms / (days * 24)).toFixed(1)} ms per simulated game hour (avg), 17-18h: ${(peakHourMs / days).toFixed(0)} ms` +
      ` => at speed 1 ~${(ms / (days * 24) / 3600).toFixed(3)} ms/frame avg, ${(peakHourMs / days / 3600).toFixed(3)} ms/frame in the evening peak`,
  );
  console.log(
    `  [${label}] PEAKS: cars ${pk.cars}, bikes ${pk.bikes} (cars+bikes ${pk.cars + pk.bikes}) | passengers ${pk.pax}: walking ${pk.walk}, waiting ${pk.wait}, riding ${pk.ride}` +
      ` | route trees ${c0.router.trees.size} built ${c0.router.stats.built} (${c0.router.stats.ms.toFixed(0)} ms), dropped trips ${c0.droppedTrips}`,
  );
  const top = Object.entries(toasts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length) console.log(`  [${label}] toasts: ` + top.map(([k, n]) => `${n}x "${k}"`).join('; '));
  return accidents;
}

function report(g: Game, day: number): void {
  const c = g.cities[0];
  const s = c.statsYesterday;
  const L = g.ledgerYesterday;
  const net = L.fares + L.subsidy - L.operations - L.construction - L.vehicles - L.accidents;
  const P = g.passengers;
  const cnt = [0, 0, 0, 0, 0];
  for (let i = 0; i < P.count; i++) cnt[P.state[i]]++;
  console.log(
    `DAY ${day - 1} done | trips ${s.trips} | walk ${pct(s.walk, s.trips)} bike ${pct(s.bike, s.trips)} car ${pct(s.car, s.trips)} pt ${pct(s.pt, s.trips)}` +
      ` | pt failed ${s.ptFailed} | delivered ${s.delivered} | accidents ${s.accidents} | rep ${c.reputation.toFixed(1)}`,
  );
  console.log(
    `   ledger: fares ${eur(L.fares)} subsidy ${eur(L.subsidy)} ops -${eur(L.operations)} constr -${eur(L.construction)} veh -${eur(L.vehicles)} acc -${eur(L.accidents)} => ${eur(net)}` +
      ` | money ${eur(g.money)} | xp ${g.xp} lvl ${g.level}`,
  );
  console.log(
    `   now: cars+bikes ${c.traffic.active}, pax walk ${cnt[P_WALK_TO_STOP]} wait ${cnt[P_WAITING]} ride ${cnt[P_RIDING]} walkDest ${cnt[P_WALK_TO_DEST]}, vehicles ${g.vehicles.length}` +
      ` | lines: ` +
      [...g.lines.values()].map((l) => `${l.d.name}: ${l.paxYesterday} pax, rev ${eur(l.revenueYesterday)}, cost ${eur(l.costYesterday)}, crowd peak ${(l.crowdPeakYesterday * 100).toFixed(0)}% (max seg ${(Math.max(...l.dirs.map((d) => Math.max(0, ...d.load))) * 100).toFixed(0)}% now), short ${l.shortage}`).join(' ; '),
  );
}

// ---------------------------------------------------------------- scenario 1
console.log('=== Scenario 1: starter bus network in Delft ===');
const g = newGame();
setupNetwork(g);
console.log(`money after setup: ${eur(g.money)}`);
const buckets = instrument(g);
const acc1 = run(g, DAYS, 'starter', (d) => report(g, d), DAYS >= 2 ? 1440 + 16.5 * 60 : -1);
console.log(`accidents total: ${acc1}, total delivered ${g.totalDelivered}`);
console.log('transit share by trip distance:');
for (const k of ['<1km', '1-2km', '2-3km', '>3km']) {
  const b = buckets[k];
  if (b) console.log(`   ${k.padEnd(6)} n=${String(b.n).padStart(6)}  walk ${pct(b.walk, b.n)}  bike ${pct(b.bike, b.n)}  car ${pct(b.car, b.n)}  pt ${pct(b.pt, b.n)} | served by transit ${pct(b.served, b.n)}, pt share there ${pct(b.servedPt, b.served)}`);
}

// save / load round trip
const save = g.serialize();
const g2 = createGameFromData(JSON.parse(JSON.stringify(save)), [data]);
console.log(
  `save/load: ${JSON.stringify(save).length} bytes, stops ${g2.stops.size}, lines ${g2.lines.size} valid=${[...g2.lines.values()].map((l) => l.valid).join(',')}, money ${eur(g2.money)}, day ${g2.day()}`,
);

// ---------------------------------------------------------------- scenario 1b
console.log('\n=== Scenario 1b: "good play" - 6 bus lines, fleet & frequency managed daily ===');
{
  const gp = newGame();
  gp.money = 1e9;
  setupNetwork(gp, true);
  gp.money = 0;
  const manage = () => {
    for (const l of gp.lines.values()) {
      const peak = Math.max(l.d.freq[1], l.d.freq[3]);
      if (l.crowdPeakYesterday > 0.6 && peak < 20) gp.updateLine(l.id, { freq: l.d.freq.map((f, i) => (i === 1 || i === 3 ? f + 4 : i === 2 ? f + 2 : f)) });
      const need = l.vehiclesNeeded();
      if (need > l.d.fleet) gp.buyVehicles(l.id, need - l.d.fleet);
    }
  };
  manage();
  console.log(`fleet: ${[...gp.lines.values()].map((l) => `${l.d.name}:${l.d.fleet}`).join(' ')} | money ${eur(gp.money)} (setup cost not counted)`);
  run(gp, Math.max(3, DAYS), 'goodplay', (d) => {
    report(gp, d);
    manage();
  });
}

// ---------------------------------------------------------------- scenario 1c
console.log('\n=== Scenario 1c: stress - Delft roads with the population of Amsterdam (931k), starter buses, until 19:00 ===');
{
  const gs = newGame();
  const cs = gs.cities[0];
  cs.def = { ...cs.def, population: 931_000 };
  setupNetwork(gs);
  console.log(`maxEntities ${gs.maxEntities}`);
  run(gs, (19 - 6) / 24, 'stress', undefined, 16.5 * 60);
  console.log(`stress: trips so far ${cs.stats.trips}, cars+bikes now ${cs.traffic.active} (high-water ${cs.traffic.count}), pax ${gs.passengers.active}, accidents ${cs.stats.accidents}`);
}

// ---------------------------------------------------------------- scenario 2
if (process.argv.includes('--quick')) process.exit(0);
console.log('\n=== Scenario 2: default roads, no transit (1 day) ===');
const gb = newGame();
const accBase = run(gb, 1, 'baseline');
console.log(`accidents: ${accBase}`);

console.log('\n=== Scenario 3: all junction control removed + 100 km/h on residential streets (1 day) ===');
const gu = newGame();
gu.money = 1e12;
const G = gu.cities[0].G;
let nj = 0,
  ne = 0;
for (let j = 0; j < G.nJ; j++) if (G.jDeg[j] >= 3 && G.jCtrl[j] !== CTRL_NONE && !gu.setJunctionControl(0, j, CTRL_NONE)) nj++;
for (let e = 0; e < G.nE; e++) if ((G.eCls[e] === 6 || G.eCls[e] === 5) && !gu.setEdgeSpeed(0, e, 100)) ne++;
console.log(`changed ${nj} junctions to 'geen regeling', ${ne} streets to 100 km/h`);
const accUnsafe = run(gu, 1, 'unsafe');
console.log(`accidents: ${accUnsafe}`);
for (const variant of ['junctions only', 'speeds only'] as const) {
  const gv = newGame();
  gv.money = 1e12;
  const Gv = gv.cities[0].G;
  if (variant === 'junctions only') {
    for (let j = 0; j < Gv.nJ; j++) if (Gv.jDeg[j] >= 3) gv.setJunctionControl(0, j, CTRL_NONE);
  } else for (let e = 0; e < Gv.nE; e++) if (Gv.eCls[e] === 6 || Gv.eCls[e] === 5) gv.setEdgeSpeed(0, e, 100);
  console.log(`unsafe (${variant}): ${run(gv, 1, variant)} accidents`);
}

// ---------------------------------------------------------------- scenario 4
console.log('\n=== Scenario 4: road edits, second city (Delft data shifted to Den Haag), coach + train, intercity (1 day) ===');
{
  const gi = newGame();
  setupNetwork(gi);
  gi.money = 50_000_000;
  // oneway on an edge used by line 1 (against its direction) -> line must re-route or break
  const l1 = [...gi.lines.values()][0];
  const arcIdx = l1.dirs[0].arcs.findIndex((a, i) => a >= 0 && l1.dirs[0].arcG[i] === gi.cities[0].G);
  const arc = l1.dirs[0].arcs[arcIdx];
  const toasts: string[] = [];
  gi.on('toast', (t) => toasts.push(t.kind + ': ' + t.msg));
  console.log('oneway against line 1:', gi.setEdgeOneway(0, arc >> 1, arc & 1 ? 1 : -1) ?? 'ok', `| line valid=${l1.valid} len=${(l1.dirs[0].length / 1000).toFixed(2)} km`, toasts.slice(-1));
  console.log('lanes before level 2:', gi.setEdgeLanes(0, arc >> 1, 4));
  gi.xp = 300_000; // jump to a high level for testing
  console.log('level', gi.level, '| lanes:', gi.setEdgeLanes(0, arc >> 1, 4) ?? 'ok', '| buslane:', gi.setEdgeBusLane(0, arc >> 1, true) ?? 'ok', '| lights:', gi.setJunctionControl(0, gi.cities[0].G.arcTo(arc), 4) ?? 'ok');
  console.log('unlock rotterdam (no data available offline)? ', gi.canUnlockCity('rotterdam'));
  // fake Den Haag from shifted Delft data
  const def = { lon: 4.3113, lat: 52.0799 };
  const dl = def.lon - data.center[0],
    dt = def.lat - data.center[1];
  const shift = (a: number[], stride: number) => a.map((v, i) => (i % stride === 0 ? v + dl : i % stride === 1 ? v + dt : v));
  const dh: CityData = {
    ...data,
    id: 'denhaag',
    center: [def.lon, def.lat],
    nodes: shift(data.nodes, 2),
    pois: shift(data.pois, 3),
    land: shift(data.land, 4),
    stations: data.stations.map((s) => ({ ...s, nm: 'Den Haag HS', lon: s.lon + dl, lat: s.lat + dt })),
  };
  const gi2 = createGameFromData(gi.serialize(), [data, dh]);
  gi2.on('toast', (t) => toasts.push(t.kind + ': ' + t.msg));
  console.log('canUnlock denhaag:', gi2.canUnlockCity('denhaag'));
  const err = await gi2.unlockCity('denhaag');
  console.log('unlock denhaag:', err ?? 'ok', '| cities', gi2.cities.map((c) => c.def.id).join(','), '| highways', gi2.highways.map((h) => `${h.key} ${h.settings.speed}km/h ${h.settings.lanes}l`).join(';'));
  const [A, B] = gi2.cities;
  const nearCentre = (c: typeof A): [number, number] => {
    const j = c.G.nearestJunction(c.cx, c.cy, 1500, (k) => c.inCore[k] === 1 && c.G.jDeg[k] >= 3);
    return [c.G.jx[j], c.G.jy[j]];
  };
  const coach = [A, B].map((c) => gi2.addStop('coach', ...nearCentre(c)));
  const train = [A, B].map((c) => gi2.addStop('train', toXY(c.data.stations[0])[0], toXY(c.data.stations[0])[1]));
  console.log('coach stops:', coach.map((s) => (typeof s === 'string' ? s : s.d.name)), '| train stations:', train.map((s) => (typeof s === 'string' ? s : s.d.name)));
  for (const [mode, st] of [['coach', coach], ['train', train]] as const) {
    if (st.some((s) => typeof s === 'string')) continue;
    const ln = gi2.createLine(mode);
    if (typeof ln === 'string') {
      console.log(ln);
      continue;
    }
    const e = gi2.setLineStops(ln.id, st.map((s) => (s as { d: { id: number } }).d.id));
    gi2.buyVehicles(ln.id, Math.max(2, ln.vehiclesNeeded()));
    console.log(`${mode} line ${ln.d.name}:`, e ?? 'ok', `${(ln.dirs[0].length / 1000).toFixed(1)} km, fleet ${ln.d.fleet}, pending corridor ${ln.pendingCorridor}`);
  }
  // tram + metro in Delft
  for (const mode of ['tram', 'metro'] as const) {
    const ids: number[] = [];
    for (const [dx, dy] of [[-1200, -600], [-400, -300], [300, 0], [1000, 300]]) {
      const s = gi2.addStop(mode, A.cx + dx, A.cy + dy);
      if (typeof s !== 'string') ids.push(s.d.id);
      else console.log(`${mode} stop:`, s);
    }
    const ln = gi2.createLine(mode) as import('../src/sim/transit.ts').Line;
    const m0 = gi2.money;
    const e = gi2.setLineStops(ln.id, ids);
    gi2.buyVehicles(ln.id, ln.vehiclesNeeded());
    console.log(`${mode} line ${ln.d.name}: ${e ?? 'ok'}, ${ids.length} stops, ${(ln.dirs[0].length / 1000).toFixed(2)} km, track cost ${eur(m0 - gi2.money - ln.d.fleet * ln.def.vehiclePrice)}, estimate was ${eur(gi2.lineCostEstimate(mode, ids))}, fleet ${ln.d.fleet}`);
  }
  // a local bus line in Den Haag too
  const bstops: number[] = [];
  for (const [dx, dy] of [[-1500, 0], [-800, 100], [0, 0], [800, -100], [1500, 0]]) {
    const s = gi2.addStop('bus', B.cx + dx, B.cy + dy);
    if (typeof s !== 'string') bstops.push(s.d.id);
  }
  const bl = gi2.createLine('bus') as import('../src/sim/transit.ts').Line;
  console.log('den haag bus line:', gi2.setLineStops(bl.id, bstops) ?? 'ok', gi2.buyVehicles(bl.id, bl.vehiclesNeeded()) ?? 'ok');
  console.log('highway upgrade:', gi2.setHighway(gi2.highways[0].key, { speed: 130, lanes: 3 }) ?? 'ok', JSON.stringify(gi2.highways[0].settings));
  const accI = run(gi2, 1, 'intercity', (d) => report(gi2, d));
  const ic = gi2.intercity.stats;
  console.log(`intercity: trips ${ic.trips}, car ${ic.car}, transit ${ic.pt} (failed ${ic.ptFailed}), highway accidents ${ic.accidents}; highway cars now ${gi2.highwayCars.length}, congestion ${gi2.highways.map((h) => h.congestion.toFixed(2)).join(',')}`);
  console.log('lines:', [...gi2.lines.values()].map((l) => `${l.d.mode} ${l.d.name}: ${l.paxYesterday} pax`).join(' ; '), '| accidents', accI);
  console.log('den haag stats:', JSON.stringify(B.statsYesterday));
  console.log('last toasts:', toasts.slice(-4));
  const sv = gi2.serialize();
  const gi3 = createGameFromData(JSON.parse(JSON.stringify(sv)), [data, dh]);
  console.log(`reload: cities ${gi3.cities.length}, lines valid ${[...gi3.lines.values()].map((l) => l.valid).join(',')}, edits ${JSON.stringify(sv.edits.delft).length} bytes`);
}

function toXY(s: { lon: number; lat: number }): [number, number] {
  return [toX(s.lon), toY(s.lat)];
}
