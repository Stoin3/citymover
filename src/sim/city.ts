// One playable city: road graph, zones, demand generation, cars & bikes, accidents.
import { CityDef } from '../data/cities';
import { CityData } from '../osm/parse';
import { toX, toY } from '../geo';
import { RoadGraph, CAR_WEIGHT, CTRL_NONE, CTRL_RIGHT, CTRL_PRIORITY, CTRL_STOP, CTRL_LIGHTS, CTRL_ROUNDABOUT } from './graph';
import { TrafficPool } from './agents';
import { TransitNet } from './network';
import {
  HOURLY_DEMAND, TRIPS_PER_RESIDENT, VALUE_OF_TIME, BETA, CAR_COST_KM, PARKING_CENTER, SAFE_SPEED, CLASS_RANK,
} from '../config';

export interface Zone {
  x: number;
  y: number;
  pop: number;
  jobs: number;
  shops: number;
  anchors: number[];
  parking: number;
}

export interface Accident {
  x: number;
  y: number;
  t: number;
  until: number;
  city: number;
  cause: string;
  j: number;
  e: number;
}

export interface RoadEdits {
  speed: [string, number][];
  oneway: [string, number][];
  lanes: [string, number][];
  bus: string[];
  ctrl: [string, number][];
}

export interface CityStats {
  trips: number;
  walk: number;
  bike: number;
  car: number;
  pt: number;
  ptFailed: number;
  accidents: number;
  delivered: number;
}

export function emptyStats(): CityStats {
  return { trips: 0, walk: 0, bike: 0, car: 0, pt: 0, ptFailed: 0, accidents: 0, delivered: 0 };
}

const ZONE_SIZE = 500;
// Accident probability per (scaled) vehicle passing a junction, per control type
const JRISK = [2.2e-4, 3.5e-5, 2.5e-5, 1.6e-5, 7e-6, 6e-6];
const PURPOSE_MIX_AM = [0.62, 0.04, 0.28, 0.06];
const PURPOSE_MIX_PM = [0.05, 0.52, 0.13, 0.3];
const PURPOSE_MIX_OFF = [0.12, 0.13, 0.4, 0.35];

function cumulative(w: Float64Array): Float64Array {
  const c = new Float64Array(w.length);
  let s = 0;
  for (let i = 0; i < w.length; i++) c[i] = s += w[i];
  return c;
}
function sampleCum(c: Float64Array, off = 0, n = c.length): number {
  const total = c[off + n - 1];
  if (!(total > 0)) return Math.floor(Math.random() * n);
  const r = Math.random() * total;
  let lo = 0,
    hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[off + mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function posKey(x: number, y: number): string {
  return Math.round(x) + '_' + Math.round(y);
}

export class CitySim {
  def: CityDef;
  data: CityData;
  index: number;
  G: RoadGraph;
  R: RoadGraph | null; // rail graph
  cx: number;
  cy: number;
  radius: number;
  zones: Zone[] = [];
  Z = 0;
  inCore!: Uint8Array;
  coreVersion = -1;

  cumOrigin: Float64Array[] = []; // [pop, jobs, shops]
  cumDest: Float64Array[] = []; // Z*Z rows for [jobs, pop, shops]

  carSkim!: Float32Array; // minutes
  ptCost!: Float32Array;
  ptEnd!: Int32Array;
  ptPred: Int32Array[] = [];
  ptNetVersion = -1;
  ptSkimTime = -999;

  traffic = new TrafficPool(2048);
  pathCache = new Map<number, Int32Array | null>();
  bikeCache = new Map<number, Int32Array | null>();
  cacheVersion = -1;

  accidents: Accident[] = [];
  jCount!: Float32Array;
  tripAcc = 0;
  reputation = 60;
  stats: CityStats = emptyStats();
  statsYesterday: CityStats = emptyStats();
  hourly: number[] = new Array(24).fill(0); // pt trips per hour today

  constructor(def: CityDef, data: CityData, index: number) {
    this.def = def;
    this.data = data;
    this.index = index;
    this.cx = toX(def.lon);
    this.cy = toY(def.lat);
    this.radius = data.radius * 1000;
    this.G = RoadGraph.build(data.nodes, data.ways, data.sig);
    const railWays = data.rails
      .filter((r) => r.t === 0 || r.t === 2)
      .map((r) => ({ n: r.n, c: r.t, o: 0, s: 0, l: 1 }));
    this.R = railWays.length ? RoadGraph.build(data.nodes, railWays, [], true) : null;
    this.jCount = new Float32Array(this.G.nJ);
    this.computeCore();
    this.buildZones();
  }

  contains(x: number, y: number, pad = 1.0): boolean {
    return Math.hypot(x - this.cx, y - this.cy) <= this.radius * pad;
  }

  /** Strongly connected core around the centre (for car routing). */
  computeCore(): void {
    const G = this.G;
    let start = G.nearestJunction(this.cx, this.cy, 3000, (j) => G.jDeg[j] >= 3);
    if (start < 0) start = 0;
    const fwd = new Uint8Array(G.nJ),
      bwd = new Uint8Array(G.nJ);
    const bfs = (mark: Uint8Array, forward: boolean) => {
      const q = [start];
      mark[start] = 1;
      while (q.length) {
        const u = q.pop()!;
        if (forward) {
          for (let k = G.adjStart[u]; k < G.adjStart[u + 1]; k++) {
            const a = G.adjArc[k];
            if (!G.arcAllowed(a)) continue;
            const v = G.arcTo(a);
            if (!mark[v]) {
              mark[v] = 1;
              q.push(v);
            }
          }
        } else {
          for (let k = G.inStart[u]; k < G.inStart[u + 1]; k++) {
            const a = G.inArc[k];
            if (!G.arcAllowed(a)) continue;
            const v = G.arcFrom(a);
            if (!mark[v]) {
              mark[v] = 1;
              q.push(v);
            }
          }
        }
      }
    };
    bfs(fwd, true);
    bfs(bwd, false);
    this.inCore = new Uint8Array(G.nJ);
    let n = 0;
    for (let j = 0; j < G.nJ; j++)
      if (fwd[j] && bwd[j]) {
        this.inCore[j] = 1;
        n++;
      }
    // If the start junction was poorly connected, retry from a busy junction
    if (n < G.nJ * 0.3 && G.nJ > 100) {
      void n;
    }
    this.coreVersion = G.version;
    if (this.zones.length) this.refreshAnchors();
  }

  private refreshAnchors(): void {
    const G = this.G;
    for (const z of this.zones) {
      const cand: number[] = [];
      G.grid.query(z.x, z.y, ZONE_SIZE * 0.6, (j) => {
        if (this.inCore[j] && G.jDeg[j] >= 2) cand.push(j);
      });
      cand.sort((a, b) => Math.hypot(G.jx[a] - z.x, G.jy[a] - z.y) - Math.hypot(G.jx[b] - z.x, G.jy[b] - z.y));
      // pick spread out anchors
      z.anchors = [];
      for (const j of cand) {
        if (z.anchors.length >= 6) break;
        if (z.anchors.every((k) => Math.hypot(G.jx[k] - G.jx[j], G.jy[k] - G.jy[j]) > 90)) z.anchors.push(j);
      }
      if (!z.anchors.length && cand.length) z.anchors.push(cand[0]);
    }
  }

  buildZones(): void {
    const G = this.G,
      d = this.data,
      R = this.radius;
    const n = Math.ceil(R / ZONE_SIZE);
    const cells = new Map<number, Zone>();
    const key = (x: number, y: number) => {
      const i = Math.floor((x - this.cx) / ZONE_SIZE),
        k = Math.floor((y - this.cy) / ZONE_SIZE);
      if (Math.abs(i) > n || Math.abs(k) > n) return -1;
      return (i + n) * (2 * n + 2) + (k + n);
    };
    const cell = (x: number, y: number): Zone | null => {
      const k = key(x, y);
      if (k < 0) return null;
      let z = cells.get(k);
      if (!z) {
        const i = Math.floor((x - this.cx) / ZONE_SIZE),
          kk = Math.floor((y - this.cy) / ZONE_SIZE);
        z = { x: this.cx + (i + 0.5) * ZONE_SIZE, y: this.cy + (kk + 0.5) * ZONE_SIZE, pop: 0, jobs: 0, shops: 0, anchors: [], parking: 0 };
        cells.set(k, z);
      }
      return z;
    };
    // roads
    for (let e = 0; e < G.nE; e++) {
      const a = G.eA[e],
        b = G.eB[e];
      const x = (G.jx[a] + G.jx[b]) / 2,
        y = (G.jy[a] + G.jy[b]) / 2;
      if (!this.contains(x, y, 1.02)) continue;
      const z = cell(x, y);
      if (!z) continue;
      const c = G.eCls[e],
        L = G.eLen[e];
      if (c === 6 || c === 7) z.pop += L * 40;
      else if (c >= 2 && c <= 5) {
        z.jobs += L * 6;
        z.pop += L * 10;
      }
    }
    for (let i = 0; i < d.land.length; i += 4) {
      const x = toX(d.land[i]),
        y = toY(d.land[i + 1]);
      const z = cell(x, y);
      if (!z) continue;
      const area = Math.min(d.land[i + 2], 600000);
      const k = d.land[i + 3];
      if (k === 0) z.pop += area * 0.5;
      else if (k === 1) {
        z.jobs += area * 0.4;
        z.shops += area * 0.2;
      } else z.jobs += area * 0.15;
    }
    for (let i = 0; i < d.pois.length; i += 3) {
      const x = toX(d.pois[i]),
        y = toY(d.pois[i + 1]);
      const z = cell(x, y);
      if (!z) continue;
      const k = d.pois[i + 2];
      if (k === 1) {
        z.jobs += 900;
        z.shops += 200;
      } else if (k === 2) {
        z.jobs += 500;
        z.shops += 900;
      } else if (k === 3) z.jobs += 4000;
      else if (k === 4) z.shops += 600;
    }
    let zones = [...cells.values()].filter((z) => this.contains(z.x, z.y, 1.05));
    // central business district bonus + parking costs
    for (const z of zones) {
      const dc = Math.hypot(z.x - this.cx, z.y - this.cy);
      z.jobs *= 1 + 1.5 * Math.exp(-dc / 1200);
      z.shops *= 1 + 2 * Math.exp(-dc / 1000);
      z.parking = dc < 1200 ? PARKING_CENTER : dc < 2200 ? PARKING_CENTER * 0.4 : 0;
    }
    this.zones = zones;
    this.refreshAnchors();
    zones = this.zones = zones.filter((z) => z.anchors.length > 0 && (z.pop > 0 || z.jobs > 0));
    const Z = (this.Z = zones.length);
    const tp = zones.reduce((s, z) => s + z.pop, 0) || 1;
    for (const z of zones) z.pop = (z.pop / tp) * this.def.population;
    const pop = new Float64Array(Z),
      jobs = new Float64Array(Z),
      shops = new Float64Array(Z);
    zones.forEach((z, i) => {
      pop[i] = z.pop + 1;
      jobs[i] = z.jobs + 1;
      shops[i] = z.shops + z.jobs * 0.1 + 1;
    });
    this.cumOrigin = [cumulative(pop), cumulative(jobs), cumulative(shops)];
    this.cumDest = [jobs, pop, shops].map((w) => {
      const m = new Float64Array(Z * Z);
      for (let o = 0; o < Z; o++) {
        let s = 0;
        for (let dd = 0; dd < Z; dd++) {
          const dist = o === dd ? 250 : Math.hypot(zones[o].x - zones[dd].x, zones[o].y - zones[dd].y);
          s += w[dd] * Math.exp(-dist / 2600);
          m[o * Z + dd] = s;
        }
      }
      return m;
    });
    this.carSkim = new Float32Array(Z * Z);
    for (let o = 0; o < Z; o++)
      for (let dd = 0; dd < Z; dd++) {
        const dist = Math.hypot(zones[o].x - zones[dd].x, zones[o].y - zones[dd].y) * 1.35 + 200;
        this.carSkim[o * Z + dd] = dist / 7.5 / 60 + 1.5;
      }
    this.ptCost = new Float32Array(Z * Z).fill(Infinity);
    this.ptEnd = new Int32Array(Z * Z).fill(-1);
  }

  zoneAt(x: number, y: number): number {
    let best = -1,
      bd = Infinity;
    for (let i = 0; i < this.Z; i++) {
      const z = this.zones[i];
      const d = (z.x - x) ** 2 + (z.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /** recompute transit generalized costs zone -> zone */
  updateTransitSkims(net: TransitNet): void {
    const Z = this.Z,
      n = net.size;
    this.ptCost.fill(Infinity);
    this.ptEnd.fill(-1);
    this.ptNetVersion = net.version;
    if (n === 0) {
      this.ptPred = [];
      return;
    }
    const dist = new Float32Array(n);
    const egress = this.zones.map((z) => net.egressNodes(z.x, z.y, 1200, 0, this.def.id));
    if (this.ptPred.length !== Z || (this.ptPred[0] && this.ptPred[0].length !== n)) {
      this.ptPred = Array.from({ length: Z }, () => new Int32Array(n));
    }
    for (let o = 0; o < Z; o++) {
      const z = this.zones[o];
      const src = net.accessNodes(z.x, z.y, 1200, 0, this.def.id);
      if (!src.length) continue;
      const pred = this.ptPred[o];
      net.search(src, dist, pred, 180);
      for (let dd = 0; dd < Z; dd++) {
        if (dd === o) continue;
        let best = Infinity,
          bn = -1;
        for (const [node, c] of egress[dd]) {
          const v = dist[node] + c;
          if (v < best) {
            best = v;
            bn = node;
          }
        }
        if (bn >= 0) {
          this.ptCost[o * Z + dd] = best;
          this.ptEnd[o * Z + dd] = bn;
        }
      }
    }
  }

  ensureCaches(): void {
    if (this.cacheVersion !== this.G.version) {
      this.pathCache.clear();
      this.bikeCache.clear();
      this.cacheVersion = this.G.version;
    }
    if (this.coreVersion !== this.G.version) this.computeCore();
  }

  getPath(oj: number, dj: number, bike: boolean, now: number, budget: { n: number }): Int32Array | null | undefined {
    const cache = bike ? this.bikeCache : this.pathCache;
    const k = oj * 1048576 + dj;
    if (cache.has(k)) return cache.get(k);
    if (budget.n <= 0) return undefined;
    budget.n--;
    const p = this.G.findPath(oj, dj, bike ? 'tram' : 'car', now, 60000);
    if (cache.size > 30000) cache.clear();
    cache.set(k, p);
    return p;
  }

  // ---------------- per-tick simulation ----------------

  /** demand: returns list of transit trip requests; spawns cars/bikes itself */
  generateTrips(now: number, dtMin: number, budget: { n: number }, maxTraffic: number, onTransit: (o: number, d: number, ox: number, oy: number, dx: number, dy: number) => boolean): void {
    if (this.Z < 2) return;
    const hour = Math.floor((now / 60) % 24);
    const daily = this.def.population * TRIPS_PER_RESIDENT;
    this.tripAcc += daily * HOURLY_DEMAND[hour] * (dtMin / 60);
    const mix = hour >= 6 && hour < 10 ? PURPOSE_MIX_AM : hour >= 15 && hour < 19 ? PURPOSE_MIX_PM : PURPOSE_MIX_OFF;
    const Z = this.Z;
    const G = this.G;
    let guard = 0;
    while (this.tripAcc >= 1 && guard++ < 2000) {
      this.tripAcc -= 1;
      const r = Math.random();
      const purpose = r < mix[0] ? 0 : r < mix[0] + mix[1] ? 1 : r < mix[0] + mix[1] + mix[2] ? 2 : 3;
      const oW = purpose === 0 || purpose === 2 ? 0 : purpose === 1 ? 1 : 2;
      const dW = purpose === 0 ? 0 : purpose === 2 ? 2 : 1;
      const o = sampleCum(this.cumOrigin[oW]);
      const d = sampleCum(this.cumDest[dW], o * Z, Z);
      const zo = this.zones[o],
        zd = this.zones[d];
      const oj = zo.anchors[(Math.random() * zo.anchors.length) | 0];
      const dj = zd.anchors[(Math.random() * zd.anchors.length) | 0];
      const ox = G.jx[oj] + (Math.random() - 0.5) * 80,
        oy = G.jy[oj] + (Math.random() - 0.5) * 80;
      const dx = G.jx[dj] + (Math.random() - 0.5) * 80,
        dy = G.jy[dj] + (Math.random() - 0.5) * 80;
      this.stats.trips++;
      const mode = this.chooseMode(o, d, Math.hypot(dx - ox, dy - oy));
      if (mode === 0) {
        this.stats.walk++;
      } else if (mode === 1 || mode === 2) {
        const bike = mode === 1;
        if (bike) this.stats.bike++;
        else this.stats.car++;
        if (this.traffic.active < maxTraffic && oj !== dj) {
          const p = this.getPath(oj, dj, bike, now, budget);
          if (p && p.length) {
            this.spawnTraffic(p, bike);
            if (!bike) {
              const t = G.pathTime(p, 'car', now) / 60 + 1.5;
              const k = o * Z + d;
              this.carSkim[k] = this.carSkim[k] * 0.7 + t * 0.3;
            }
          }
        }
      } else {
        this.stats.pt++;
        this.hourly[hour]++;
        if (!onTransit(o, d, ox, oy, dx, dy)) this.stats.ptFailed++;
      }
    }
  }

  /** multinomial logit: 0 walk, 1 bike, 2 car, 3 transit */
  chooseMode(o: number, d: number, dEuclid: number): number {
    const k = o * this.Z + d;
    const dNet = dEuclid * 1.3 + 100;
    const walkT = dNet / 1.3 / 60;
    const uWalk = -walkT - Math.max(0, walkT - 25) * 1.5;
    const bikeT = dNet / 4.4 / 60 + 2;
    const uBike = Math.random() < 0.78 ? -5 - 1.5 * bikeT - Math.max(0, bikeT - 20) * 0.8 : -Infinity;
    const carT = this.carSkim[k] + 5;
    const carCost = (dNet / 1000) * CAR_COST_KM + this.zones[d].parking;
    const uCar = Math.random() < 0.55 ? -7 - carT - carCost / VALUE_OF_TIME : -Infinity;
    const gc = this.ptCost[k];
    const uPt = isFinite(gc) ? -2 + (this.reputation - 60) / 12 - gc : -Infinity;
    const m = Math.max(uWalk, uBike, uCar, uPt);
    const eW = Math.exp(BETA * (uWalk - m)),
      eB = Math.exp(BETA * (uBike - m)),
      eC = Math.exp(BETA * (uCar - m)),
      eP = Math.exp(BETA * (uPt - m));
    const s = eW + eB + eC + eP;
    let r = Math.random() * s;
    if ((r -= eW) < 0) return 0;
    if ((r -= eB) < 0) return 1;
    if ((r -= eC) < 0) return 2;
    return 3;
  }

  /** share estimate for UI: probability of transit for an OD pair */
  transitShare(o: number, d: number): number {
    let n = 0;
    for (let i = 0; i < 200; i++) if (this.chooseMode(o, d, Math.hypot(this.zones[o].x - this.zones[d].x, this.zones[o].y - this.zones[d].y)) === 3) n++;
    return n / 200;
  }

  spawnTraffic(path: Int32Array, bike: boolean): void {
    const T = this.traffic;
    const i = T.alloc();
    T.mode[i] = bike ? 1 : 0;
    T.paths[i] = path;
    T.arcIdx[i] = 0;
    T.s[i] = 0;
    T.wait[i] = 0;
    T.hint[i] = -1;
    if (!bike) this.G.arcLoad[path[0]]++;
  }

  private tmp = new Float64Array(3);

  tickTraffic(dt: number, now: number, onAccident: (a: Accident) => void): void {
    const T = this.traffic,
      G = this.G;
    const tmp = this.tmp;
    for (let i = 0; i < T.count; i++) {
      if (!T.alive[i]) continue;
      const path = T.paths[i]!;
      const bike = T.mode[i] === 1;
      let arc = path[T.arcIdx[i]];
      if (T.wait[i] > 0) {
        T.wait[i] -= dt;
        continue;
      }
      const v = bike ? (G.arcBlock[arc] > now ? 2 : 4.4) : G.arcSpeed(arc, 'car', now);
      let s = T.s[i] + v * dt;
      let len = G.eLen[arc >> 1];
      let finished = false;
      while (s >= len) {
        s -= len;
        if (!bike) G.arcLoad[arc]--;
        const j = G.arcTo(arc);
        this.jCount[j] += bike ? 0.15 : 1;
        if (++T.arcIdx[i] >= path.length) {
          finished = true;
          break;
        }
        const next = path[T.arcIdx[i]];
        if (!bike) {
          G.arcLoad[next]++;
          if (G.jDeg[j] >= 3) {
            T.wait[i] = G.junctionDelay(arc) * (0.3 + Math.random() * 1.4);
            this.checkJunctionAccident(j, arc, now, onAccident);
          }
          this.checkEdgeAccident(next, now, onAccident);
        } else if (G.jDeg[j] >= 3) T.wait[i] = Math.random() * 4;
        arc = next;
        len = G.eLen[arc >> 1];
        T.hint[i] = -1;
        if (T.wait[i] > 0) {
          s = Math.min(s, 0.5);
          break;
        }
      }
      if (finished) {
        T.release(i);
        continue;
      }
      T.s[i] = s;
      T.hint[i] = G.pointOnArc(arc, s, tmp, T.hint[i]);
      const off = bike ? 3.6 : 1.7;
      const h = tmp[2];
      T.x[i] = tmp[0] + Math.sin(h) * off;
      T.y[i] = tmp[1] - Math.cos(h) * off;
      T.h[i] = h;
    }
  }

  /** once per game minute */
  minuteUpdate(now: number): void {
    const G = this.G;
    for (let j = 0; j < G.nJ; j++) {
      G.jLoad[j] = G.jLoad[j] * 0.85 + this.jCount[j] * CAR_WEIGHT * 0.15;
      this.jCount[j] = 0;
    }
    if (this.accidents.length) this.accidents = this.accidents.filter((a) => a.until > now);
  }

  private checkJunctionAccident(j: number, arc: number, now: number, onAccident: (a: Accident) => void): void {
    const G = this.G;
    const ctrl = G.jCtrl[j];
    const limit = G.eSpeed[arc >> 1];
    let p = JRISK[ctrl] * (1 + G.jLoad[j] / 25);
    if (ctrl === CTRL_NONE || ctrl === CTRL_RIGHT || ctrl === CTRL_PRIORITY || ctrl === CTRL_STOP) p *= Math.max(0.5, (limit / 40) ** 2);
    if (ctrl === CTRL_RIGHT && G.jMainRank[j] >= 7) p *= 3;
    if (ctrl === CTRL_ROUNDABOUT && limit > 60) p *= 2;
    if (Math.random() < p) {
      const cause =
        ctrl === CTRL_NONE
          ? 'kruispunt zonder voorrangsregeling'
          : ctrl === CTRL_RIGHT && (G.jMainRank[j] >= 7 || limit > 50)
            ? 'voorrang van rechts op een drukke/snelle weg'
            : ctrl === CTRL_LIGHTS
              ? 'roodlichtnegatie'
              : limit > (SAFE_SPEED[G.eCls[arc >> 1]] ?? 50)
                ? 'te hoge snelheid bij kruispunt'
                : 'voorrangsfout';
      this.addAccident(G.jx[j], G.jy[j], now, cause, j, -1, onAccident);
    }
  }

  private checkEdgeAccident(arc: number, now: number, onAccident: (a: Accident) => void): void {
    const G = this.G;
    const e = arc >> 1;
    const limit = G.eSpeed[e],
      safe = SAFE_SPEED[G.eCls[e]] ?? 50;
    if (limit <= safe) return;
    const p = 1.2e-6 * (G.eLen[e] / 100) * Math.exp((limit - safe) / 9) * (1 + G.arcLoad[arc] * 0.05);
    if (Math.random() < p) {
      const k = (G.ePt[e] + G.ePt[e + 1]) >> 1;
      this.addAccident(G.px[k], G.py[k], now, `te hoge maximumsnelheid (${limit} km/u)`, -1, e, onAccident);
    }
  }

  private addAccident(x: number, y: number, now: number, cause: string, j: number, e: number, cb: (a: Accident) => void): void {
    const G = this.G;
    const dur = 25 + Math.random() * 35;
    if (j >= 0) for (let k = G.inStart[j]; k < G.inStart[j + 1]; k++) G.arcBlock[G.inArc[k]] = now + dur;
    if (e >= 0) {
      G.arcBlock[e * 2] = now + dur;
      G.arcBlock[e * 2 + 1] = now + dur;
    }
    const a: Accident = { x, y, t: now, until: now + dur, city: this.index, cause, j, e };
    this.accidents.push(a);
    this.stats.accidents++;
    this.reputation = Math.max(0, this.reputation - 0.4);
    cb(a);
  }

  newDay(): void {
    this.statsYesterday = this.stats;
    this.stats = emptyStats();
    this.hourly.fill(0);
  }

  // ---------------- road edits ----------------

  edgeKey(e: number): string {
    const G = this.G;
    const a = G.eA[e],
      b = G.eB[e];
    const k = (G.ePt[e] + G.ePt[e + 1]) >> 1;
    return posKey(G.jx[a], G.jy[a]) + '|' + posKey(G.jx[b], G.jy[b]) + '|' + posKey(G.px[k], G.py[k]);
  }
  junctionKey(j: number): string {
    return posKey(this.G.jx[j], this.G.jy[j]);
  }

  serializeEdits(): RoadEdits {
    const G = this.G;
    const out: RoadEdits = { speed: [], oneway: [], lanes: [], bus: [], ctrl: [] };
    for (let e = 0; e < G.nE; e++) {
      if (!G.edgeIsModified(e)) continue;
      const k = this.edgeKey(e);
      if (G.eSpeed[e] !== G.eSpeedOsm[e]) out.speed.push([k, G.eSpeed[e]]);
      if (G.eOneway[e] !== G.eOnewayOsm[e]) out.oneway.push([k, G.eOneway[e]]);
      if (G.eLanes[e] !== G.eLanesOsm[e]) out.lanes.push([k, G.eLanes[e]]);
      if (G.eBus[e]) out.bus.push(k);
    }
    for (let j = 0; j < G.nJ; j++) if (G.jCtrl[j] !== G.jCtrlOsm[j]) out.ctrl.push([this.junctionKey(j), G.jCtrl[j]]);
    return out;
  }

  applyEdits(ed: RoadEdits | undefined): void {
    if (!ed) return;
    const G = this.G;
    const eIdx = new Map<string, number>();
    for (let e = 0; e < G.nE; e++) eIdx.set(this.edgeKey(e), e);
    const jIdx = new Map<string, number>();
    for (let j = 0; j < G.nJ; j++) jIdx.set(this.junctionKey(j), j);
    for (const [k, v] of ed.speed) {
      const e = eIdx.get(k);
      if (e !== undefined) G.eSpeed[e] = v;
    }
    for (const [k, v] of ed.oneway) {
      const e = eIdx.get(k);
      if (e !== undefined) G.eOneway[e] = v;
    }
    for (const [k, v] of ed.lanes) {
      const e = eIdx.get(k);
      if (e !== undefined) G.eLanes[e] = v;
    }
    for (const k of ed.bus) {
      const e = eIdx.get(k);
      if (e !== undefined) G.eBus[e] = 1;
    }
    for (const [k, v] of ed.ctrl) {
      const j = jIdx.get(k);
      if (j !== undefined) G.jCtrl[j] = v;
    }
    G.rebuildAdjacency();
    this.ensureCaches();
  }

  /** human readable road name for a junction */
  junctionName(j: number): string {
    const G = this.G;
    const names = new Set<string>();
    for (let k = G.adjStart[j]; k < G.adjStart[j + 1]; k++) {
      const n = G.eName[G.adjArc[k] >> 1];
      if (n) names.add(n);
    }
    const arr = [...names];
    if (arr.length >= 2) return arr[0] + ' / ' + arr[1];
    return arr[0] || 'Kruispunt';
  }

  mainRoadRank(e: number): number {
    return CLASS_RANK[this.G.eCls[e]] ?? 1;
  }
}

export { CTRL_LIGHTS };
