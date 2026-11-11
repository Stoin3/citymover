// Intercity layer: highway links between adjacent unlocked cities, intercity
// demand (car vs. transit), visual highway cars and highway accidents.
import type { HighwayLink, HighwayCar, HighwaySettings, ToastKind } from './api';
import type { CitySim, Accident } from '../sim/city';
import type { TransitNet } from '../sim/network';
import type { RoadGraph } from '../sim/graph';
import { neighbours, distanceKm, type CityDef } from '../data/cities';
import { HOURLY_DEMAND, BETA, VALUE_OF_TIME, CAR_COST_KM } from '../config';

export interface IntercityHost {
  readonly time: number;
  readonly cities: CitySim[];
  readonly net: TransitNet;
  toast(msg: string, kind: ToastKind): void;
  accident(a: Accident, where: string): void;
  changed(what: 'highways'): void;
  corridorGraph(kind: 'road' | 'rail', a: CityDef, b: CityDef): Promise<RoadGraph | null>;
  /** spawn an intercity transit passenger waiting at the first boarding stop */
  spawnIntercity(from: CitySim, to: CitySim, legs: Int32Array): boolean;
}

export const MAX_HIGHWAY_CARS = 4000;
export const HIGHWAY_SPEED_COST = 5_000;
export const HIGHWAY_LANE_COST = 6_000_000;
// daily trips between two cities = TRIP_FACTOR * popA * popB / max(15, km)^2 (agents ~1:1 with real trips)
const TRIP_FACTOR = 6e-5;
/** real vehicles per simulated highway car (through & freight traffic) */
const HIGHWAY_WEIGHT = 1.5;
/** accident probability per car trip at 100 km/h without congestion */
const HIGHWAY_RISK = 1.5e-6;

class HCar implements HighwayCar {
  link: HighwayLink;
  s: number;
  dir: 1 | -1;
  speed: number;
  x = 0;
  y = 0;
  h = 0;
  k = 0; // segment hint
  cum: Float64Array;
  L: number;
  constructor(link: HighwayLink, s: number, dir: 1 | -1, speed: number, cum: Float64Array) {
    this.link = link;
    this.s = s;
    this.dir = dir;
    this.speed = speed;
    this.cum = cum;
    this.L = cum.length ? cum[cum.length - 1] : 0;
  }
}

export function linkKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a;
}

export function defaultHighway(a: CityDef, b: CityDef): HighwaySettings {
  return { speed: 100, lanes: a.population > 300_000 && b.population > 300_000 ? 3 : 2 };
}

export interface IntercityStats {
  trips: number;
  car: number;
  pt: number;
  ptFailed: number;
  accidents: number;
}

export class Intercity {
  host: IntercityHost;
  links: HighwayLink[] = [];
  cars: HCar[] = [];
  accidents: Accident[] = [];
  /** saved settings (from save game) applied when a link is created */
  saved: Record<string, HighwaySettings> = {};
  stats: IntercityStats = { trips: 0, car: 0, pt: 0, ptFailed: 0, accidents: 0 };

  private cum = new Map<HighwayLink, Float64Array>();
  private acc = new Map<string, number>();
  private minuteCount = new Map<HighwayLink, number>();
  private n = 0;
  private ptCost = new Float32Array(0);
  private ptEnd = new Int32Array(0);
  private ptPred: (Int32Array | null)[] = [];
  private tmp = new Float64Array(3);

  constructor(host: IntercityHost) {
    this.host = host;
  }

  linkByKey(key: string): HighwayLink | undefined {
    return this.links.find((l) => l.key === key);
  }

  linkBetween(a: string, b: string): HighwayLink | undefined {
    return this.linkByKey(linkKey(a, b));
  }

  /** create links for every pair of unlocked adjacent cities */
  syncLinks(): void {
    const cs = this.host.cities;
    let added = false;
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        const A = cs[i],
          B = cs[j];
        if (!neighbours(A.def.id).includes(B.def.id)) continue;
        const key = linkKey(A.def.id, B.def.id);
        if (this.linkByKey(key)) continue;
        const [ca, cb] = A.def.id < B.def.id ? [A, B] : [B, A];
        const settings = this.saved[key] ? { ...this.saved[key] } : defaultHighway(ca.def, cb.def);
        const link: HighwayLink = {
          key,
          a: ca.def.id,
          b: cb.def.id,
          settings,
          pts: [ca.cx, ca.cy, cb.cx, cb.cy],
          congestion: 0,
          carsPerHour: 0,
          closedUntil: 0,
        };
        this.links.push(link);
        this.setPts(link, link.pts);
        added = true;
        this.loadCorridor(link, ca, cb);
      }
    if (added) this.host.changed('highways');
  }

  private loadCorridor(link: HighwayLink, A: CitySim, B: CitySim): void {
    this.host
      .corridorGraph('road', A.def, B.def)
      .then((C) => {
        if (!C || C.nJ === 0) return;
        const ja = C.nearestJunction(A.cx, A.cy, 15000);
        const jb = C.nearestJunction(B.cx, B.cy, 15000);
        if (ja < 0 || jb < 0) return;
        const path = C.findPath(ja, jb, 'car', 0, 800000, 130);
        if (!path || !path.length) return;
        const pts: number[] = [A.cx, A.cy];
        const tmp: number[] = [];
        for (const arc of path) {
          tmp.length = 0;
          C.arcPoints(arc, tmp);
          for (let k = 0; k < tmp.length; k += 2) {
            const n = pts.length;
            if (Math.abs(pts[n - 2] - tmp[k]) + Math.abs(pts[n - 1] - tmp[k + 1]) > 0.5) pts.push(tmp[k], tmp[k + 1]);
          }
        }
        pts.push(B.cx, B.cy);
        this.setPts(link, pts);
        // cars on the old geometry: drop them
        this.cars = this.cars.filter((c) => c.link !== link);
        this.host.changed('highways');
      })
      .catch(() => {});
  }

  private setPts(link: HighwayLink, pts: number[]): void {
    link.pts = pts;
    const n = pts.length / 2;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    this.cum.set(link, cum);
  }

  linkLength(link: HighwayLink): number {
    const c = this.cum.get(link);
    return c ? c[c.length - 1] : 0;
  }

  /** position along polyline; writes x,y,heading into out; returns segment index */
  pointAt(link: HighwayLink, s: number, hint: number, out: Float64Array, cumIn?: Float64Array): number {
    const cum = cumIn ?? this.cum.get(link)!;
    const p = link.pts;
    const n = cum.length;
    let k = Math.max(0, Math.min(hint, n - 2));
    while (k < n - 2 && cum[k + 1] < s) k++;
    while (k > 0 && cum[k] > s) k--;
    const seg = cum[k + 1] - cum[k] || 1;
    const t = Math.max(0, Math.min(1, (s - cum[k]) / seg));
    const x0 = p[k * 2],
      y0 = p[k * 2 + 1],
      x1 = p[k * 2 + 2],
      y1 = p[k * 2 + 3];
    out[0] = x0 + (x1 - x0) * t;
    out[1] = y0 + (y1 - y0) * t;
    out[2] = Math.atan2(y1 - y0, x1 - x0);
    return k;
  }

  carSpeed(link: HighwayLink, now: number): number {
    let v = (link.settings.speed * (1 - 0.6 * link.congestion)) / 3.6;
    if (link.closedUntil > now) v *= 0.25;
    return v;
  }

  // ------------------------------------------------------------------ skims

  /** recompute intercity transit costs; call right after net.build() */
  updateSkims(): void {
    const cs = this.host.cities;
    const net = this.host.net;
    const n = (this.n = cs.length);
    this.ptCost = new Float32Array(n * n).fill(Infinity);
    this.ptEnd = new Int32Array(n * n).fill(-1);
    this.ptPred = new Array(n).fill(null);
    const size = net.size;
    if (n < 2 || size === 0) return;
    const dist = new Float32Array(size);
    const egress = cs.map((B) => net.egressNodes(B.cx, B.cy, B.radius * 1.3, 10, B.def.id, true));
    for (let a = 0; a < n; a++) {
      const A = cs[a];
      const src = net.accessNodes(A.cx, A.cy, A.radius * 1.3, 12, A.def.id, true);
      if (!src.length) continue;
      const pred = new Int32Array(size);
      net.search(src, dist, pred, 600);
      let any = false;
      for (let b = 0; b < n; b++) {
        if (b === a) continue;
        let best = Infinity,
          bn = -1;
        for (const [node, c] of egress[b]) {
          if (pred[node] < 0) continue;
          const v = dist[node] + c;
          if (v < best) {
            best = v;
            bn = node;
          }
        }
        if (bn >= 0) {
          this.ptCost[a * n + b] = best;
          this.ptEnd[a * n + b] = bn;
          any = true;
        }
      }
      if (any) this.ptPred[a] = pred;
    }
  }

  transitCost(a: number, b: number): number {
    if (a >= this.n || b >= this.n) return Infinity;
    return this.ptCost[a * this.n + b];
  }

  // ------------------------------------------------------------------ simulation

  /** once per game minute */
  minute(now: number): void {
    const cs = this.host.cities;
    // link flows
    for (const link of this.links) {
      const cnt = this.minuteCount.get(link) || 0;
      this.minuteCount.set(link, 0);
      link.carsPerHour = link.carsPerHour * 0.9 + cnt * 60 * 0.1;
      link.congestion = Math.min(1, (link.carsPerHour * HIGHWAY_WEIGHT) / (link.settings.lanes * 1800));
    }
    for (const c of this.cars) c.speed = this.carSpeed(c.link, now);
    if (this.accidents.length) this.accidents = this.accidents.filter((a) => a.until > now);
    if (cs.length < 2) return;
    const hour = Math.floor((now / 60) % 24);
    const hf = HOURLY_DEMAND[hour] / 60;
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        const A = cs[i],
          B = cs[j];
        const key = A.def.id + '|' + B.def.id;
        const dKm = distanceKm(A.def, B.def);
        const daily = (TRIP_FACTOR * A.def.population * B.def.population) / Math.max(15, dKm) ** 2;
        let acc = (this.acc.get(key) || 0) + daily * hf;
        let guard = 0;
        while (acc >= 1 && guard++ < 2000) {
          acc -= 1;
          if (Math.random() < 0.5) this.trip(i, j, dKm, now);
          else this.trip(j, i, dKm, now);
        }
        this.acc.set(key, acc);
      }
  }

  private trip(a: number, b: number, dKm: number, now: number): void {
    const cs = this.host.cities;
    const A = cs[a],
      B = cs[b];
    this.stats.trips++;
    const link = this.linkBetween(A.def.id, B.def.id);
    const speed = link ? link.settings.speed : 100;
    const cong = link ? link.congestion : 0;
    let carMin = ((dKm * 1.15) / (speed * (1 - 0.6 * cong))) * 60;
    if (link && link.closedUntil > now) carMin *= 3;
    const uCar = -(carMin + 20) - (CAR_COST_KM * dKm + 5) / VALUE_OF_TIME - 8;
    const ptc = this.transitCost(a, b);
    const uPt = isFinite(ptc) ? -3 - ptc : -Infinity;
    const pPt = uPt === -Infinity ? 0 : 1 / (1 + Math.exp(BETA * (uCar - uPt)));
    if (Math.random() < pPt) {
      this.stats.pt++;
      const pred = this.ptPred[a];
      const end = this.ptEnd[a * this.n + b];
      if (!pred || end < 0) {
        this.stats.ptFailed++;
        return;
      }
      const legs = this.host.net.legs(pred, end);
      if (!this.host.spawnIntercity(A, B, legs)) this.stats.ptFailed++;
      return;
    }
    this.stats.car++;
    if (!link) return;
    this.minuteCount.set(link, (this.minuteCount.get(link) || 0) + 1);
    const L = this.linkLength(link);
    const forward = link.a === A.def.id;
    if (this.cars.length < MAX_HIGHWAY_CARS && L > 0) {
      const c = new HCar(link, forward ? 0 : L, forward ? 1 : -1, this.carSpeed(link, now), this.cum.get(link)!);
      c.k = forward ? 0 : link.pts.length / 2 - 2;
      this.cars.push(c);
    }
    // accident risk
    const p = HIGHWAY_RISK * (speed / 100) ** 4 * (1 + 2 * cong);
    if (Math.random() < p && link.closedUntil <= now && L > 0) {
      const out = this.tmp;
      this.pointAt(link, Math.random() * L, 0, out);
      link.closedUntil = now + 40;
      const acc: Accident = {
        x: out[0],
        y: out[1],
        t: now,
        until: now + 40,
        city: -1,
        cause: `ongeval op de snelweg (${speed} km/u${cong > 0.5 ? ', file' : ''})`,
        j: -1,
        e: -1,
      };
      this.accidents.push(acc);
      this.stats.accidents++;
      const na = cs.find((c) => c.def.id === link.a)?.def.name ?? link.a;
      const nb = cs.find((c) => c.def.id === link.b)?.def.name ?? link.b;
      this.host.accident(acc, `snelweg ${na} – ${nb}`);
    }
  }

  /** move cars; dt in seconds */
  tick(dt: number): void {
    const out = this.tmp;
    const cars = this.cars;
    let w = 0;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      c.s += c.dir * c.speed * dt;
      if (c.s < 0 || c.s > c.L) continue; // arrived
      c.k = this.pointAt(c.link, c.s, c.k, out, c.cum);
      const h = c.dir === 1 ? out[2] : out[2] + Math.PI;
      c.h = h;
      c.x = out[0] + Math.sin(h) * 4;
      c.y = out[1] - Math.cos(h) * 4;
      cars[w++] = c;
    }
    cars.length = w;
  }
}
