// Standalone dev harness for the renderer: open /render-harness.html with `npx vite`.
// Builds a minimal fake IGame around a real CitySim (Delft) with synthetic traffic,
// two transit lines with moving vehicles, passengers, a highway and an accident.
// URL params: ?n=6000 (cars+bikes), ?mode=roads|view|build, ?overlay=congestion|safety|demand
import { createRenderer } from './renderer';
import type { IGame, GameEventMap, HighwayLink, HighwayCar, Ledger, MapMode, Overlay } from '../game/api';
import { CitySim } from '../sim/city';
import type { Accident } from '../sim/city';
import { CITY_BY_ID, distanceKm } from '../data/cities';
import type { CityData } from '../osm/parse';
import { PassengerPool, P_WAITING, P_WALK_TO_STOP } from '../sim/agents';
import { TransitNet } from '../sim/network';
import { Line, Stop, buildLineRoute, newLineData, routePoint } from '../sim/transit';
import type { Vehicle } from '../sim/transit';
import { cityUnlockCost } from '../config';
import type { ModeId } from '../config';
import { toX, toY } from '../geo';

const params = new URLSearchParams(location.search);
const TARGET = Number(params.get('n') || 6000);
const statusEl = document.getElementById('status')!;
const setStatus = (s: string) => (statusEl.textContent = s);

function emptyLedger(): Ledger {
  return { fares: 0, subsidy: 0, operations: 0, construction: 0, vehicles: 0, accidents: 0 };
}

async function main(): Promise<void> {
  setStatus('Delft laden…');
  const def = CITY_BY_ID.get('delft')!;
  const data = (await (await fetch('data/delft.json')).json()) as CityData;
  const city = new CitySim(def, data, 0);
  const G = city.G;
  setStatus(`Delft: ${G.nJ} kruispunten, ${G.nE} wegen, ${city.Z} zones`);

  // ---------------- fake transit
  const stops = new Map<number, Stop>();
  const lines = new Map<number, Line>();
  let nextId = 1;
  const mkStop = (dx: number, dy: number, mode: ModeId, name: string): Stop => {
    const j = G.nearestJunction(city.cx + dx, city.cy + dy, 800, (jj) => G.jDeg[jj] >= 3 && city.inCore[jj] === 1);
    const s = new Stop({ id: nextId++, name, x: G.jx[j], y: G.jy[j], city: 'delft', mode });
    s.j = j;
    s.waiting = Math.floor(Math.random() * 40);
    stops.set(s.d.id, s);
    return s;
  };
  const ctx = { graphFor: () => G, corridor: () => null };
  const mkLine = (mode: ModeId, name: string, color: [number, number, number], st: Stop[]): Line => {
    const line = new Line(newLineData(nextId++, mode, name, color));
    line.d.stops = st.map((s) => s.d.id);
    buildLineRoute(line, st, ctx);
    if (!line.valid) console.warn('line invalid', line.error);
    lines.set(line.id, line);
    return line;
  };
  const l1 = mkLine('bus', 'Lijn 40', [230, 57, 70], [
    mkStop(-1300, -700, 'bus', 'Station Delft Zuid'),
    mkStop(-500, -150, 'bus', 'Prinsenhof'),
    mkStop(250, 250, 'bus', 'Markt'),
    mkStop(1100, 650, 'bus', 'TU Delft Aula'),
  ]);
  const l2 = mkLine('tram', 'Tram 1', [255, 183, 3], [
    mkStop(-900, 900, 'tram', 'Hof van Delft'),
    mkStop(-100, 300, 'tram', 'Delft Station'),
    mkStop(600, -500, 'tram', 'Tanthof'),
  ]);
  const vehicles: Vehicle[] = [];
  let vid = 1;
  for (const line of [l1, l2]) {
    if (!line.valid) continue;
    for (let k = 0; k < 6; k++) {
      const dir = k % 2;
      const v: Vehicle = {
        id: vid++, line, dir, s: (line.dirs[dir].length * k) / 6, arcIdx: 0, ptHint: 0, nextStop: 0, dwell: 0, delay: 0,
        pax: [], x: 0, y: 0, z: 0, h: 0, lastStopTime: 0, speed: line.def.cruiseKmh / 3.6 * 0.5,
      };
      vehicles.push(v);
      line.vehicles.push(v);
    }
  }

  // ---------------- passengers
  const passengers = new PassengerPool(1024);
  for (const s of stops.values()) {
    for (let k = 0; k < 25; k++) {
      const i = passengers.alloc();
      passengers.state[i] = P_WAITING;
      passengers.x[i] = s.x + (Math.random() - 0.5) * 14;
      passengers.y[i] = s.y + (Math.random() - 0.5) * 14;
    }
    for (let k = 0; k < 25; k++) {
      const i = passengers.alloc();
      passengers.state[i] = P_WALK_TO_STOP;
      const a = Math.random() * Math.PI * 2,
        r = 60 + Math.random() * 300;
      passengers.x[i] = s.x + Math.cos(a) * r;
      passengers.y[i] = s.y + Math.sin(a) * r;
      passengers.tx[i] = s.x;
      passengers.ty[i] = s.y;
    }
  }

  // ---------------- highway Delft - Rotterdam
  const rdam = CITY_BY_ID.get('rotterdam')!;
  const hw: HighwayLink = {
    key: 'delft|rotterdam', a: 'delft', b: 'rotterdam', settings: { speed: 130, lanes: 3 },
    pts: [city.cx + 900, city.cy - 1500, toX(4.40), toY(51.96), toX(rdam.lon), toY(rdam.lat)],
    congestion: 0.35, carsPerHour: 1200, closedUntil: 0,
  };
  const hwLen: number[] = [0];
  for (let k = 2; k < hw.pts.length; k += 2) hwLen.push(hwLen[hwLen.length - 1] + Math.hypot(hw.pts[k] - hw.pts[k - 2], hw.pts[k + 1] - hw.pts[k - 1]));
  const hwTotal = hwLen[hwLen.length - 1];
  const highwayCars: HighwayCar[] = [];
  for (let k = 0; k < 400; k++) {
    highwayCars.push({ link: hw, s: Math.random() * hwTotal, dir: k % 2 ? 1 : -1, speed: 28 + Math.random() * 8, x: 0, y: 0, h: 0 });
  }
  const placeHwCar = (c: HighwayCar) => {
    let k = 0;
    while (k < hwLen.length - 2 && hwLen[k + 1] < c.s) k++;
    const t = (c.s - hwLen[k]) / (hwLen[k + 1] - hwLen[k] || 1);
    const x0 = hw.pts[k * 2], y0 = hw.pts[k * 2 + 1], x1 = hw.pts[k * 2 + 2], y1 = hw.pts[k * 2 + 3];
    let h = Math.atan2(y1 - y0, x1 - x0);
    if (c.dir < 0) h += Math.PI;
    const off = 6;
    c.x = x0 + (x1 - x0) * t + Math.sin(h) * off;
    c.y = y0 + (y1 - y0) * t - Math.cos(h) * off;
    c.h = h;
  };

  // ---------------- an accident
  const jAcc = G.nearestJunction(city.cx + 300, city.cy - 200, 800, (j) => G.jDeg[j] >= 3);
  city.accidents.push({ x: G.jx[jAcc], y: G.jy[jAcc], t: 0, until: 1e9, city: 0, cause: 'test', j: jAcc, e: -1 });

  // ---------------- fake game
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  let time = 8 * 60;
  const game: IGame = {
    money: 1_500_000, xp: 0, level: 4, get time() { return time; }, speed: 1,
    cities: [city], startCity: 'delft', stops, lines, vehicles, passengers,
    highways: [hw], highwayCars, net: new TransitNet(),
    ledgerToday: emptyLedger(), ledgerYesterday: emptyLedger(), totalDelivered: 0, maxEntities: 20000,
    hour: () => (time / 60) % 24,
    day: () => Math.floor(time / 1440),
    hasFeature: () => true,
    modeUnlocked: () => true,
    cityById: (id) => (id === 'delft' ? city : undefined),
    cityAt: (x, y) => (city.contains(x, y) ? city : undefined),
    allAccidents: (): Accident[] => city.accidents,
    canUnlockCity: (id) => {
      const d = CITY_BY_ID.get(id)!;
      const cost = cityUnlockCost(d.population);
      const far = distanceKm(d, def) > 30;
      return { ok: !far, reason: far ? 'Te duur' : '', cost };
    },
    lineCostEstimate: () => 0,
    unlockCity: async () => 'n.v.t.',
    addStop: () => 'n.v.t.',
    removeStop: () => null,
    renameStop: () => {},
    createLine: () => 'n.v.t.',
    setLineStops: () => null,
    updateLine: () => {},
    deleteLine: () => {},
    buyVehicles: () => null,
    sellVehicles: () => null,
    setEdgeSpeed: () => null,
    setEdgeOneway: () => null,
    setEdgeLanes: () => null,
    setEdgeBusLane: () => null,
    setJunctionControl: () => null,
    setHighway: () => null,
    tick: () => {},
    serialize: () => { throw new Error('n.v.t.'); },
    on<K extends keyof GameEventMap>(ev: K, cb: (p: GameEventMap[K]) => void) {
      let s = listeners.get(ev);
      if (!s) listeners.set(ev, (s = new Set()));
      s.add(cb as (p: unknown) => void);
      return () => s!.delete(cb as (p: unknown) => void);
    },
  };

  const container = document.getElementById('map')!;
  const renderer = createRenderer(container, game);
  const m = params.get('mode') as MapMode | null;
  if (m) renderer.setMode(m, (params.get('build') as ModeId) || 'bus');
  const o = params.get('overlay') as Overlay | null;
  if (o) renderer.setOverlay(o);
  renderer.onClick((c) => {
    console.log('click', JSON.stringify(c.pick), c.lon.toFixed(5), c.lat.toFixed(5));
    setStatus('Klik: ' + JSON.stringify(c.pick));
    renderer.setSelection(c.pick.kind === 'map' || c.pick.kind === 'city' ? null : c.pick);
  });
  if (params.get('draft')) renderer.setDraftLine([...stops.keys()].slice(0, 3), 'bus');

  // ---------------- traffic spawning
  const coreJ: number[] = [];
  for (const z of city.zones) for (const a of z.anchors) coreJ.push(a);
  const paths: Int32Array[] = [];
  let lastAlloc = -1;
  const spawnSome = (budget: number) => {
    const T = city.traffic;
    let n = 0;
    while (T.active < TARGET && n < budget) {
      let p: Int32Array | null = null;
      if (paths.length < 400 || Math.random() < 0.15) {
        const a = coreJ[(Math.random() * coreJ.length) | 0], b = coreJ[(Math.random() * coreJ.length) | 0];
        if (a === b) continue;
        p = G.findPath(a, b, 'car', time, 60000);
        if (p && p.length > 2) paths.push(p);
      } else p = paths[(Math.random() * paths.length) | 0];
      n++;
      if (!p || p.length < 2) continue;
      const bike = Math.random() < 0.3;
      city.spawnTraffic(p, bike);
      // spread spawned agents along their path (keeping arcLoad bookkeeping consistent)
      const idx = lastAlloc;
      if (idx >= 0) {
        const k = (Math.random() * p.length) | 0;
        if (!bike) {
          G.arcLoad[p[0]]--;
          G.arcLoad[p[k]]++;
        }
        T.arcIdx[idx] = k;
        T.s[idx] = Math.random() * G.eLen[p[k] >> 1] * 0.9;
      }
    }
  };
  const origAlloc = city.traffic.alloc.bind(city.traffic);
  city.traffic.alloc = () => (lastAlloc = origAlloc());

  // ---------------- loop
  let last = performance.now();
  let minuteAcc = 0;
  const tmp = new Float64Array(3);
  let fps = 0, fpsN = 0, fpsT = last, frameMs = 0;
  let running = true;
  const loop = (now: number) => {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    spawnSome(250);
    city.tickTraffic(dt, time, () => {});
    time += dt / 60;
    minuteAcc += dt;
    if (minuteAcc > 1) {
      minuteAcc = 0;
      city.minuteUpdate(time);
      for (const s of stops.values()) s.waiting = Math.max(0, s.waiting + ((Math.random() * 7) | 0) - 3);
      hw.congestion = 0.5 + 0.5 * Math.sin(now / 5000);
    }
    for (const v of vehicles) {
      const dir = v.line.dirs[v.dir];
      if (!dir.length) continue;
      v.s += v.speed * dt;
      if (v.s > dir.length) v.s -= dir.length;
      v.ptHint = routePoint(dir, v.s, v.ptHint, tmp);
      const off = 1.7;
      v.x = tmp[0] + Math.sin(tmp[2]) * off;
      v.y = tmp[1] - Math.cos(tmp[2]) * off;
      v.h = tmp[2];
    }
    const P = passengers;
    for (let i = 0; i < P.count; i++) {
      if (P.state[i] !== P_WALK_TO_STOP) continue;
      const dx = P.tx[i] - P.x[i], dy = P.ty[i] - P.y[i];
      const d = Math.hypot(dx, dy);
      if (d < 3) {
        const a = Math.random() * Math.PI * 2, r = 80 + Math.random() * 300;
        P.x[i] = P.tx[i] + Math.cos(a) * r;
        P.y[i] = P.ty[i] + Math.sin(a) * r;
      } else {
        P.x[i] += (dx / d) * 1.3 * dt * 5;
        P.y[i] += (dy / d) * 1.3 * dt * 5;
      }
    }
    for (const c of highwayCars) {
      c.s += c.speed * dt * c.dir;
      if (c.s > hwTotal) c.s -= hwTotal;
      if (c.s < 0) c.s += hwTotal;
      placeHwCar(c);
    }
    const tf = performance.now();
    if (!params.get('noframe')) renderer.frame();
    frameMs += performance.now() - tf;
    fpsN++;
    if (now - fpsT > 1000) {
      fps = (fpsN * 1000) / (now - fpsT);
      fpsT = now;
      setStatus(`fps ${fps.toFixed(0)} · frame() ${(frameMs / Math.max(1, fpsN)).toFixed(1)}ms · auto/fiets ${city.traffic.active} · voertuigen ${vehicles.length} · reizigers ${P.active}`);
      fpsN = 0;
      frameMs = 0;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  (window as unknown as Record<string, unknown>).harness = {
    game, renderer, city, map: (renderer as unknown as { map: unknown }).map,
    ready: () => city.traffic.active >= TARGET * 0.95,
    /** stop simulation + frame updates (for screenshots with software GL) */
    stop: () => {
      running = false;
    },
    start: () => {
      if (running) return;
      running = true;
      last = performance.now();
      requestAnimationFrame(loop);
    },
  };
}

main().catch((e) => {
  console.error(e);
  setStatus('Fout: ' + (e as Error).message);
});
