// Public transport: stops, lines, route geometry and vehicles.
import { MODES, ModeDef, ModeId, TIME_BLOCKS } from '../config';
import { RoadGraph, RouteKind } from './graph';
import { PaxQueue } from './agents';

export interface StopData {
  id: number;
  name: string;
  x: number;
  y: number;
  city: string;
  mode: ModeId;
}

export interface LineData {
  id: number;
  name: string;
  mode: ModeId;
  color: [number, number, number];
  stops: number[];
  fareBase: number;
  fareKm: number;
  freq: number[]; // vehicles per hour per time block (per direction)
  fleet: number;
}

export class Stop {
  d: StopData;
  j = -1; // junction in road graph (bus/tram/coach) or rail graph (train)
  waiting = 0;
  boardedToday = 0;
  constructor(d: StopData) {
    this.d = d;
  }
  get x() {
    return this.d.x;
  }
  get y() {
    return this.d.y;
  }
}

export class LineDir {
  stops: Stop[] = [];
  pts = new Float64Array(0); // x,y
  cum = new Float64Array(0);
  ptZ: Float32Array | null = null; // altitude for planes
  arcs = new Int32Array(0); // graph arcs or -1 for straight pieces
  arcStart = new Float64Array(1);
  arcG: (RoadGraph | null)[] = [];
  stopDist = new Float64Array(0);
  segTime = new Float64Array(0); // expected seconds stop k -> k+1 (incl. dwell at k)
  waiting: PaxQueue[] = [];
  /** smoothed load factor when leaving stop k ((on board + left behind) / capacity, up to 2) */
  load = new Float32Array(0);
  nextDispatch = 0;
  length = 0;
}

export interface Vehicle {
  id: number;
  line: Line;
  dir: number;
  s: number;
  arcIdx: number;
  ptHint: number;
  nextStop: number;
  dwell: number;
  delay: number;
  pax: number[];
  x: number;
  y: number;
  z: number;
  h: number;
  lastStopTime: number;
  speed: number;
}

export class Line {
  d: LineData;
  dirs: [LineDir, LineDir] = [new LineDir(), new LineDir()];
  def: ModeDef;
  vehicles: Vehicle[] = [];
  valid = false;
  error = '';
  shortage = 0;
  // statistics (today)
  paxToday = 0;
  revenueToday = 0;
  costToday = 0;
  paxYesterday = 0;
  revenueYesterday = 0;
  costYesterday = 0;
  loadSamples = 0;
  loadSum = 0;
  crowding = 0; // 0..1 recent load factor (>1: passengers left behind)
  crowdPeak = 0; // highest crowding today
  crowdPeakYesterday = 0;
  pendingCorridor = false;
  constructor(d: LineData) {
    this.d = d;
    this.def = MODES[d.mode];
  }
  get id() {
    return this.d.id;
  }
  get active() {
    return this.vehicles.length;
  }
  freqAt(block: number): number {
    return this.d.freq[block] || 0;
  }
  headwayMin(block: number): number {
    const f = this.freqAt(block);
    return f > 0 ? 60 / f : Infinity;
  }
  /** expected wait (minutes) - people check timetables at low frequencies */
  expectedWait(block: number): number {
    const h = this.headwayMin(block);
    if (!isFinite(h)) return Infinity;
    return Math.min(h / 2, 4 + h / 6);
  }
  fareFor(km: number): number {
    return this.d.fareBase + this.d.fareKm * km;
  }
  /** vehicles needed for the peak frequency */
  vehiclesNeeded(): number {
    const rt = (this.dirs[0].segTime.reduce((a, b) => a + b, 0) + this.dirs[1].segTime.reduce((a, b) => a + b, 0)) / 60;
    const fmax = Math.max(...this.d.freq);
    return Math.ceil((rt * fmax) / 60) + (fmax > 0 ? 1 : 0);
  }
}

export interface RouteContext {
  graphFor(stop: Stop, kind: RouteKind): RoadGraph | null;
  corridor(kind: 'rail' | 'road', a: Stop, b: Stop): RoadGraph | null | 'pending';
}

function kindFor(mode: ModeId): RouteKind {
  if (mode === 'tram') return 'tram';
  if (mode === 'train') return 'rail';
  return 'bus';
}

/** Build both directions' geometry for a line. */
export function buildLineRoute(line: Line, stops: Stop[], ctx: RouteContext): void {
  line.valid = false;
  line.error = '';
  line.pendingCorridor = false;
  if (stops.length < 2) {
    line.error = 'Een lijn heeft minimaal 2 haltes nodig.';
    return;
  }
  const def = line.def;
  const kind = kindFor(def.id);
  for (let d = 0; d < 2; d++) {
    const ordered = d === 0 ? stops.slice() : stops.slice().reverse();
    const dir = line.dirs[d];
    const pts: number[] = [];
    const arcs: number[] = [];
    const arcStart: number[] = [0];
    const arcG: (RoadGraph | null)[] = [];
    const stopDist: number[] = [0];
    let total = 0;
    const pushPoint = (x: number, y: number) => {
      const n = pts.length;
      if (n >= 2) {
        const dl = Math.hypot(x - pts[n - 2], y - pts[n - 1]);
        if (dl < 0.01) return;
        total += dl;
      }
      pts.push(x, y);
    };
    const addStraight = (a: Stop, b: Stop) => {
      if (pts.length === 0) pushPoint(a.x, a.y);
      const before = total;
      pushPoint(b.x, b.y);
      arcs.push(-1);
      arcG.push(null);
      arcStart.push(total);
      void before;
    };
    const addGraphPath = (G: RoadGraph, path: Int32Array, a: Stop, b: Stop): void => {
      if (pts.length === 0) pushPoint(a.x, a.y);
      // connector from stop to first junction
      const j0 = path.length ? G.arcFrom(path[0]) : -1;
      if (j0 >= 0 && Math.hypot(G.jx[j0] - a.x, G.jy[j0] - a.y) > 1) {
        pushPoint(G.jx[j0], G.jy[j0]);
        arcs.push(-1);
        arcG.push(null);
        arcStart.push(total);
      }
      const tmp: number[] = [];
      for (const arc of path) {
        tmp.length = 0;
        G.arcPoints(arc, tmp);
        for (let k = 2; k < tmp.length; k += 2) pushPoint(tmp[k], tmp[k + 1]);
        arcs.push(arc);
        arcG.push(G);
        // use exact graph length for the arc
        arcStart.push(total);
      }
      const jl = path.length ? G.arcTo(path[path.length - 1]) : -1;
      if (jl >= 0 && Math.hypot(G.jx[jl] - b.x, G.jy[jl] - b.y) > 1) {
        pushPoint(b.x, b.y);
        arcs.push(-1);
        arcG.push(null);
        arcStart.push(total);
      }
    };

    for (let k = 0; k + 1 < ordered.length; k++) {
      const a = ordered[k],
        b = ordered[k + 1];
      if (def.routing === 'road' || def.routing === 'tram') {
        if (a.d.city !== b.d.city) {
          line.error = `${def.name}lijnen kunnen niet tussen steden rijden. Gebruik een snelbus of trein.`;
          return;
        }
        const G = ctx.graphFor(a, kind);
        if (!G || a.j < 0 || b.j < 0) {
          line.error = 'Halte ligt niet aan een weg.';
          return;
        }
        const path = G.findPath(a.j, b.j, kind, 0, 400000, def.cruiseKmh);
        if (!path) {
          line.error = `Geen route van "${a.d.name}" naar "${b.d.name}" (eenrichtingsweg of afgesloten?).`;
          return;
        }
        addGraphPath(G, path, a, b);
      } else if (def.routing === 'rail' || def.routing === 'highway') {
        let done = false;
        if (a.d.city === b.d.city) {
          const G = ctx.graphFor(a, def.routing === 'rail' ? 'rail' : 'bus');
          if (G && a.j >= 0 && b.j >= 0) {
            const path = G.findPath(a.j, b.j, def.routing === 'rail' ? 'rail' : 'bus', 0, 400000, def.cruiseKmh);
            if (path) {
              addGraphPath(G, path, a, b);
              done = true;
            }
          }
        } else {
          const C = ctx.corridor(def.routing === 'rail' ? 'rail' : 'road', a, b);
          if (C === 'pending') line.pendingCorridor = true;
          else if (C) {
            const ja = C.nearestJunction(a.x, a.y, 4000);
            const jb = C.nearestJunction(b.x, b.y, 4000);
            const path = C.findPath(ja, jb, def.routing === 'rail' ? 'rail' : 'car', 0, 600000, def.cruiseKmh);
            if (path) {
              addGraphPath(C, path, a, b);
              done = true;
            }
          }
        }
        if (!done) {
          if (def.routing === 'rail' && a.d.city === b.d.city && Math.hypot(a.x - b.x, a.y - b.y) < 6000 && !line.pendingCorridor) {
            line.error = `Geen spoor tussen "${a.d.name}" en "${b.d.name}". Plaats stations op het bestaande spoor.`;
            return;
          }
          addStraight(a, b);
        }
      } else {
        addStraight(a, b);
      }
      stopDist.push(total);
    }
    dir.stops = ordered;
    dir.pts = Float64Array.from(pts);
    const cum = new Float64Array(pts.length / 2);
    for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    dir.cum = cum;
    dir.arcs = Int32Array.from(arcs);
    dir.arcStart = Float64Array.from(arcStart);
    dir.arcG = arcG;
    dir.stopDist = Float64Array.from(stopDist);
    dir.length = total;
    if (def.routing === 'air') {
      const z = new Float32Array(cum.length);
      dir.ptZ = z;
    } else dir.ptZ = null;
    // expected segment times
    const seg = new Float64Array(ordered.length - 1);
    for (let k = 0; k + 1 < ordered.length; k++) {
      seg[k] = estimateTime(dir, stopDist[k], stopDist[k + 1], def) + def.dwell + 8;
    }
    dir.segTime = seg;
    // waiting lists: keep for same stop sequence else reset
    if (dir.waiting.length !== ordered.length) dir.waiting = ordered.map(() => new PaxQueue());
    if (dir.load.length !== ordered.length) dir.load = new Float32Array(ordered.length);
  }
  line.valid = true;
}

function estimateTime(dir: LineDir, s0: number, s1: number, def: ModeDef): number {
  let t = 0;
  const cruise = def.cruiseKmh / 3.6;
  for (let i = 0; i < dir.arcs.length; i++) {
    const a0 = dir.arcStart[i],
      a1 = dir.arcStart[i + 1];
    const lo = Math.max(a0, s0),
      hi = Math.min(a1, s1);
    if (hi <= lo) continue;
    const arc = dir.arcs[i];
    const G = dir.arcG[i];
    let v = cruise;
    let jd = 0;
    if (arc >= 0 && G) {
      v = G.arcSpeed(arc, def.id === 'tram' ? 'tram' : G.isRail ? 'rail' : 'bus', 0, def.cruiseKmh);
      if (hi === a1) jd = G.junctionDelay(arc) * (def.id === 'tram' ? 0.6 : 1);
    } else if (def.routing === 'straight' || def.routing === 'air') v = cruise * (def.routing === 'air' ? 0.8 : 0.82);
    t += (hi - lo) / v + jd;
  }
  if (def.routing === 'air') t += 1200;
  return t;
}

/** Position along a direction's polyline. */
export function routePoint(dir: LineDir, s: number, hint: number, out: Float64Array): number {
  const cum = dir.cum;
  const n = cum.length;
  let k = Math.max(0, Math.min(hint, n - 2));
  while (k < n - 2 && cum[k + 1] < s) k++;
  while (k > 0 && cum[k] > s) k--;
  const seg = cum[k + 1] - cum[k] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[k]) / seg));
  const p = dir.pts;
  const x0 = p[k * 2],
    y0 = p[k * 2 + 1],
    x1 = p[k * 2 + 2],
    y1 = p[k * 2 + 3];
  out[0] = x0 + (x1 - x0) * t;
  out[1] = y0 + (y1 - y0) * t;
  out[2] = Math.atan2(y1 - y0, x1 - x0);
  return k;
}

export function newLineData(id: number, mode: ModeId, name: string, color: [number, number, number]): LineData {
  const def = MODES[mode];
  const freq =
    mode === 'plane' ? [0, 1, 0.5, 1, 0.5] : mode === 'train' || mode === 'coach' ? [0, 4, 2, 4, 2] : [1, 8, 4, 8, 3];
  return { id, name, mode, color, stops: [], fareBase: def.defaultFareBase, fareKm: def.defaultFareKm, freq, fleet: 0 };
}

export const BLOCK_COUNT = TIME_BLOCKS.length;
