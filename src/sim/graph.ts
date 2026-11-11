// Road / rail network built from OpenStreetMap ways.
// Junctions = graph nodes, edges = polylines between junctions.
// Arcs (directed) are encoded as edge*2 + dir (dir 0 = A->B, 1 = B->A).
import { toX, toY, Grid } from '../geo';
import { MinHeap } from './heap';
import { CLASS_RANK, DEFAULT_LANES, DEFAULT_SPEED } from '../config';

export interface WayInput {
  n: number[];
  c: number;
  o: number;
  s: number;
  l: number;
  nm?: string;
  r?: number;
}

export const CTRL_NONE = 0,
  CTRL_RIGHT = 1,
  CTRL_PRIORITY = 2,
  CTRL_STOP = 3,
  CTRL_LIGHTS = 4,
  CTRL_ROUNDABOUT = 5;

export type RouteKind = 'car' | 'bus' | 'tram' | 'rail';

export class RoadGraph {
  nJ = 0;
  jx!: Float64Array;
  jy!: Float64Array;
  jDeg!: Uint8Array;
  jCtrl!: Uint8Array;
  jCtrlOsm!: Uint8Array;
  jMainRank!: Uint8Array;
  jLoad!: Float32Array; // smoothed vehicles per minute through junction
  jOsmNode!: Int32Array;

  nE = 0;
  eA!: Int32Array;
  eB!: Int32Array;
  eLen!: Float32Array;
  eCls!: Uint8Array;
  eOneway!: Int8Array;
  eOnewayOsm!: Int8Array;
  eSpeed!: Uint8Array;
  eSpeedOsm!: Uint8Array;
  eLanes!: Uint8Array;
  eLanesOsm!: Uint8Array;
  eBus!: Uint8Array;
  eName: string[] = [];
  eWay!: Int32Array;

  ePt!: Int32Array; // CSR start into px/py/pc
  px!: Float64Array;
  py!: Float64Array;
  pc!: Float32Array; // cumulative distance at point

  arcLoad!: Float32Array; // vehicles currently on arc
  arcBlock!: Float64Array; // blocked until game-time (minutes)

  adjStart!: Int32Array;
  adjArc!: Int32Array;
  inStart!: Int32Array;
  inArc!: Int32Array;

  version = 0;
  grid = new Grid(120);
  isRail = false;

  // pathfinding buffers
  private g!: Float64Array;
  private parent!: Int32Array;
  private stamp!: Uint32Array;
  private closed!: Uint32Array;
  private gen = 1;
  private heap = new MinHeap(4096);

  static build(nodesLonLat: number[], ways: WayInput[], signals: number[], isRail = false): RoadGraph {
    const G = new RoadGraph();
    G.isRail = isRail;
    const nN = nodesLonLat.length / 2;
    const uses = new Uint16Array(nN);
    for (const w of ways) {
      for (let i = 0; i < w.n.length; i++) {
        const k = w.n[i];
        uses[k] += i === 0 || i === w.n.length - 1 ? 2 : 1;
      }
    }
    const jIndex = new Int32Array(nN).fill(-1);
    const jList: number[] = [];
    const getJ = (k: number) => {
      if (jIndex[k] < 0) {
        jIndex[k] = jList.length;
        jList.push(k);
      }
      return jIndex[k];
    };
    const edges: { a: number; b: number; pts: number[]; w: number }[] = [];
    ways.forEach((w, wi) => {
      let start = 0;
      for (let i = 1; i < w.n.length; i++) {
        if (uses[w.n[i]] >= 2 || i === w.n.length - 1) {
          const pts = w.n.slice(start, i + 1);
          if (pts.length >= 2 && !(pts.length === 2 && pts[0] === pts[1])) {
            edges.push({ a: getJ(pts[0]), b: getJ(pts[pts.length - 1]), pts, w: wi });
          }
          start = i;
        }
      }
    });

    const nJ = (G.nJ = jList.length);
    G.jx = new Float64Array(nJ);
    G.jy = new Float64Array(nJ);
    G.jDeg = new Uint8Array(nJ);
    G.jCtrl = new Uint8Array(nJ);
    G.jCtrlOsm = new Uint8Array(nJ);
    G.jMainRank = new Uint8Array(nJ);
    G.jLoad = new Float32Array(nJ);
    G.jOsmNode = new Int32Array(jList);
    for (let j = 0; j < nJ; j++) {
      const k = jList[j];
      G.jx[j] = toX(nodesLonLat[k * 2]);
      G.jy[j] = toY(nodesLonLat[k * 2 + 1]);
      G.grid.add(G.jx[j], G.jy[j], j);
    }
    const nE = (G.nE = edges.length);
    G.eA = new Int32Array(nE);
    G.eB = new Int32Array(nE);
    G.eLen = new Float32Array(nE);
    G.eCls = new Uint8Array(nE);
    G.eOneway = new Int8Array(nE);
    G.eOnewayOsm = new Int8Array(nE);
    G.eSpeed = new Uint8Array(nE);
    G.eSpeedOsm = new Uint8Array(nE);
    G.eLanes = new Uint8Array(nE);
    G.eLanesOsm = new Uint8Array(nE);
    G.eBus = new Uint8Array(nE);
    G.eWay = new Int32Array(nE);
    let nP = 0;
    for (const e of edges) nP += e.pts.length;
    G.ePt = new Int32Array(nE + 1);
    G.px = new Float64Array(nP);
    G.py = new Float64Array(nP);
    G.pc = new Float32Array(nP);
    let p = 0;
    const roundaboutJ = new Uint8Array(nJ);
    edges.forEach((e, i) => {
      const w = ways[e.w];
      G.eA[i] = e.a;
      G.eB[i] = e.b;
      G.eWay[i] = e.w;
      G.eCls[i] = w.c;
      G.eOneway[i] = G.eOnewayOsm[i] = w.o;
      const sp = w.s || (isRail ? (w.c === 3 ? 50 : w.c === 1 ? 80 : 130) : DEFAULT_SPEED[w.c] ?? 50);
      G.eSpeed[i] = G.eSpeedOsm[i] = Math.min(255, sp);
      const lanes = w.l || (w.o !== 0 ? Math.max(1, (DEFAULT_LANES[w.c] ?? 2) / (w.c === 0 ? 0.5 : 2)) : DEFAULT_LANES[w.c] ?? 2);
      G.eLanes[i] = G.eLanesOsm[i] = Math.max(1, Math.min(8, Math.round(lanes)));
      G.eName[i] = w.nm || '';
      G.ePt[i] = p;
      let cum = 0;
      for (let k = 0; k < e.pts.length; k++) {
        const nk = e.pts[k];
        const x = toX(nodesLonLat[nk * 2]),
          y = toY(nodesLonLat[nk * 2 + 1]);
        if (k > 0) cum += Math.hypot(x - G.px[p - 1], y - G.py[p - 1]);
        G.px[p] = x;
        G.py[p] = y;
        G.pc[p] = cum;
        p++;
      }
      G.eLen[i] = Math.max(1, cum);
      G.jDeg[e.a]++;
      G.jDeg[e.b]++;
      const rank = isRail ? 1 : CLASS_RANK[w.c] ?? 1;
      G.jMainRank[e.a] = Math.max(G.jMainRank[e.a], rank);
      G.jMainRank[e.b] = Math.max(G.jMainRank[e.b], rank);
      if (w.r) {
        roundaboutJ[e.a] = 1;
        roundaboutJ[e.b] = 1;
      }
    });
    G.ePt[nE] = p;
    const sigSet = new Set(signals);
    for (let j = 0; j < nJ; j++) {
      let c = CTRL_RIGHT;
      if (roundaboutJ[j]) c = CTRL_ROUNDABOUT;
      else if (sigSet.has(jList[j])) c = CTRL_LIGHTS;
      else if (G.jDeg[j] >= 3) c = CTRL_PRIORITY; // most NL junctions have a priority road
      G.jCtrl[j] = G.jCtrlOsm[j] = c;
    }
    // Junctions with all roads of equal low rank default to priority-to-the-right
    const rankCount = new Uint8Array(nJ);
    for (let i = 0; i < nE; i++) {
      const r = CLASS_RANK[G.eCls[i]] ?? 1;
      if (r === G.jMainRank[G.eA[i]]) rankCount[G.eA[i]]++;
      if (r === G.jMainRank[G.eB[i]]) rankCount[G.eB[i]]++;
    }
    for (let j = 0; j < nJ; j++) {
      if (G.jCtrl[j] === CTRL_PRIORITY && (rankCount[j] > 2 || G.jMainRank[j] <= 3)) G.jCtrl[j] = G.jCtrlOsm[j] = CTRL_RIGHT;
    }

    G.arcLoad = new Float32Array(nE * 2);
    G.arcBlock = new Float64Array(nE * 2);
    G.g = new Float64Array(nJ);
    G.parent = new Int32Array(nJ);
    G.stamp = new Uint32Array(nJ);
    G.closed = new Uint32Array(nJ);
    G.rebuildAdjacency();
    return G;
  }

  arcFrom(a: number): number {
    return a & 1 ? this.eB[a >> 1] : this.eA[a >> 1];
  }
  arcTo(a: number): number {
    return a & 1 ? this.eA[a >> 1] : this.eB[a >> 1];
  }
  arcAllowed(a: number, kind: RouteKind = 'car'): boolean {
    if (kind === 'tram' || kind === 'rail') return true;
    const o = this.eOneway[a >> 1];
    return o === 0 || (o === 1 && (a & 1) === 0) || (o === -1 && (a & 1) === 1);
  }
  lanesDir(e: number): number {
    const l = this.eLanes[e];
    return this.eOneway[e] !== 0 ? l : Math.max(1, Math.floor(l / 2));
  }
  carLanesDir(e: number): number {
    return Math.max(1, this.lanesDir(e) - (this.eBus[e] ? 1 : 0));
  }

  rebuildAdjacency(): void {
    const nJ = this.nJ,
      nE = this.nE;
    const outCnt = new Int32Array(nJ + 1);
    const inCnt = new Int32Array(nJ + 1);
    for (let a = 0; a < nE * 2; a++) {
      outCnt[this.arcFrom(a)]++;
      inCnt[this.arcTo(a)]++;
    }
    this.adjStart = new Int32Array(nJ + 1);
    this.inStart = new Int32Array(nJ + 1);
    for (let j = 0; j < nJ; j++) {
      this.adjStart[j + 1] = this.adjStart[j] + outCnt[j];
      this.inStart[j + 1] = this.inStart[j] + inCnt[j];
    }
    this.adjArc = new Int32Array(nE * 2);
    this.inArc = new Int32Array(nE * 2);
    const fo = this.adjStart.slice(0, nJ),
      fi = this.inStart.slice(0, nJ);
    for (let a = 0; a < nE * 2; a++) {
      this.adjArc[fo[this.arcFrom(a)]++] = a;
      this.inArc[fi[this.arcTo(a)]++] = a;
    }
    this.version++;
  }

  /** congestion factor 0..1 for cars on arc */
  congestion(a: number): number {
    const e = a >> 1;
    const cap = (this.carLanesDir(e) * this.eLen[e]) / 7.5;
    const dens = (this.arcLoad[a] * CAR_WEIGHT) / Math.max(1, cap);
    return Math.max(0.07, 1 - 0.9 * Math.min(1, dens));
  }

  /** speed in m/s for a vehicle kind on arc */
  arcSpeed(a: number, kind: RouteKind, now: number, vmaxKmh = 200): number {
    const e = a >> 1;
    let v = Math.min(this.eSpeed[e], vmaxKmh) / 3.6;
    if (this.isRail) return v;
    const cls = this.eCls[e];
    v *= cls === 6 || cls === 7 ? 0.8 : cls <= 1 ? 0.95 : 0.88;
    if (kind === 'car' || (kind === 'bus' && !this.eBus[e])) v *= this.congestion(a);
    else if (kind === 'bus') v *= 0.95;
    if (this.arcBlock[a] > now) v *= 0.15;
    return Math.max(0.8, v);
  }

  /** average junction delay (s) when traversing arc a into its end junction */
  junctionDelay(a: number): number {
    const j = this.arcTo(a);
    if (this.isRail || this.jDeg[j] < 3) return 0;
    const lf = Math.min(3, this.jLoad[j] / 25);
    const main = (CLASS_RANK[this.eCls[a >> 1]] ?? 1) >= this.jMainRank[j];
    switch (this.jCtrl[j]) {
      case CTRL_NONE:
        return 0.5 + lf * 2;
      case CTRL_RIGHT:
        return 3 + lf * 4;
      case CTRL_PRIORITY:
        return main ? 0.8 : 5 + lf * 8;
      case CTRL_STOP:
        return main ? 0.8 : 8 + lf * 6;
      case CTRL_LIGHTS:
        return 14 + lf * 6;
      case CTRL_ROUNDABOUT:
        return 4 + lf * 3;
    }
    return 2;
  }

  nearestJunction(x: number, y: number, maxR = 800, filter?: (j: number) => boolean): number {
    let best = -1,
      bd = Infinity;
    for (let r = 120; r <= maxR * 2; r *= 2) {
      this.grid.query(x, y, Math.min(r, maxR), (j) => {
        if (this.jDeg[j] === 0) return;
        if (filter && !filter(j)) return;
        const d = (this.jx[j] - x) ** 2 + (this.jy[j] - y) ** 2;
        if (d < bd) {
          bd = d;
          best = j;
        }
      });
      if (best >= 0 || r >= maxR) break;
    }
    return bd <= maxR * maxR ? best : -1;
  }

  /** A* shortest time path. Returns list of arcs or null. */
  findPath(from: number, to: number, kind: RouteKind, now = 0, maxNodes = 200000, vmaxKmh = 200): Int32Array | null {
    if (from < 0 || to < 0) return null;
    if (from === to) return new Int32Array(0);
    const gen = ++this.gen;
    const g = this.g,
      parent = this.parent,
      stamp = this.stamp,
      closed = this.closed,
      heap = this.heap;
    heap.clear();
    const tx = this.jx[to],
      ty = this.jy[to];
    const hv = 1 / (Math.min(vmaxKmh, this.isRail ? 160 : 130) / 3.6);
    g[from] = 0;
    stamp[from] = gen;
    parent[from] = -1;
    heap.push(Math.hypot(this.jx[from] - tx, this.jy[from] - ty) * hv, from);
    let expanded = 0;
    while (heap.size > 0) {
      const u = heap.pop();
      if (closed[u] === gen) continue;
      closed[u] = gen;
      if (u === to) break;
      if (++expanded > maxNodes) return null;
      const gu = g[u];
      for (let k = this.adjStart[u], ke = this.adjStart[u + 1]; k < ke; k++) {
        const a = this.adjArc[k];
        if (!this.arcAllowed(a, kind)) continue;
        // no immediate U-turn on the same edge
        if (parent[u] >= 0 && parent[u] >> 1 === a >> 1) continue;
        const v = this.arcTo(a);
        if (closed[v] === gen) continue;
        const cost = gu + this.eLen[a >> 1] / this.arcSpeed(a, kind, now, vmaxKmh) + this.junctionDelay(a);
        if (stamp[v] !== gen || cost < g[v]) {
          stamp[v] = gen;
          g[v] = cost;
          parent[v] = a;
          heap.push(cost + Math.hypot(this.jx[v] - tx, this.jy[v] - ty) * hv, v);
        }
      }
    }
    if (closed[to] !== gen) return null;
    const out: number[] = [];
    let v = to;
    while (v !== from) {
      const a = parent[v];
      out.push(a);
      v = this.arcFrom(a);
    }
    out.reverse();
    return Int32Array.from(out);
  }

  /** time (s) of a path */
  pathTime(path: Int32Array, kind: RouteKind, now = 0, vmax = 200): number {
    let t = 0;
    for (const a of path) t += this.eLen[a >> 1] / this.arcSpeed(a, kind, now, vmax) + this.junctionDelay(a);
    return t;
  }
  pathLength(path: Int32Array): number {
    let l = 0;
    for (const a of path) l += this.eLen[a >> 1];
    return l;
  }

  /** point on arc at distance s from arc start; writes into out[0..2] = x,y,heading */
  pointOnArc(a: number, s: number, out: Float64Array, hint = -1): number {
    const e = a >> 1;
    const p0 = this.ePt[e],
      p1 = this.ePt[e + 1] - 1;
    const len = this.eLen[e];
    const d = a & 1 ? len - s : s; // distance from A
    // find segment k such that pc[k] <= d <= pc[k+1]
    let k = hint >= p0 && hint < p1 ? hint : p0;
    while (k < p1 - 1 && this.pc[k + 1] < d) k++;
    while (k > p0 && this.pc[k] > d) k--;
    const segLen = this.pc[k + 1] - this.pc[k] || 1;
    const t = Math.max(0, Math.min(1, (d - this.pc[k]) / segLen));
    const x0 = this.px[k],
      y0 = this.py[k],
      x1 = this.px[k + 1],
      y1 = this.py[k + 1];
    out[0] = x0 + (x1 - x0) * t;
    out[1] = y0 + (y1 - y0) * t;
    out[2] = a & 1 ? Math.atan2(y0 - y1, x0 - x1) : Math.atan2(y1 - y0, x1 - x0);
    return k;
  }

  /** polyline (x,y pairs) of arc in travel direction */
  arcPoints(a: number, out: number[]): void {
    const e = a >> 1;
    const p0 = this.ePt[e],
      p1 = this.ePt[e + 1];
    if (a & 1) for (let k = p1 - 1; k >= p0; k--) out.push(this.px[k], this.py[k]);
    else for (let k = p0; k < p1; k++) out.push(this.px[k], this.py[k]);
  }

  /** reset all player overrides to OSM values */
  edgeIsModified(e: number): boolean {
    return (
      this.eSpeed[e] !== this.eSpeedOsm[e] ||
      this.eOneway[e] !== this.eOnewayOsm[e] ||
      this.eLanes[e] !== this.eLanesOsm[e] ||
      this.eBus[e] !== 0
    );
  }
}

// Each simulated car agent represents this many real cars for congestion purposes
// (agents are ~1:1 with real trips; the extra accounts for through/freight traffic).
export const CAR_WEIGHT = 1.3;
