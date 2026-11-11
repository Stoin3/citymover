// Transit routing graph: nodes are (line, direction, stop index).
import { Grid } from '../geo';
import { MinHeap } from './heap';
import { Line, Stop } from './transit';
import { VALUE_OF_TIME, MODES, PT_WALK_WEIGHT, PT_WAIT_WEIGHT, PT_TRANSFER_PENALTY } from '../config';

export const WALK_SPEED = 1.3; // m/s
export const WALK_DETOUR = 1.25;
const TRANSFER_RADIUS = 320;

export function walkMin(d: number): number {
  return (d * WALK_DETOUR) / WALK_SPEED / 60;
}

export class TransitNet {
  nLines: Line[] = [];
  nodeLine: Line[] = [];
  nodeDir: Uint8Array = new Uint8Array(0);
  nodeK: Int32Array = new Int32Array(0);
  nodeStop: Stop[] = [];
  base = new Map<number, [number, number]>();
  outStart = new Int32Array(1);
  outTo = new Int32Array(0);
  outCost = new Float32Array(0);
  stopGrid = new Grid(400);
  stops: Stop[] = [];
  stopNodes = new Map<Stop, number[]>();
  block = 0;
  version = 0;
  private heap = new MinHeap(2048);

  get size(): number {
    return this.nodeStop.length;
  }

  build(lines: Line[], block: number): void {
    this.block = block;
    this.version++;
    this.base.clear();
    this.stopNodes.clear();
    const nodeLine: Line[] = [],
      nodeDir: number[] = [],
      nodeK: number[] = [],
      nodeStop: Stop[] = [];
    const usable = lines.filter((l) => l.valid && l.freqAt(block) > 0 && l.d.fleet > 0);
    this.nLines = usable;
    const stopSet = new Set<Stop>();
    for (const l of usable) {
      const b: [number, number] = [0, 0];
      for (let d = 0; d < 2; d++) {
        b[d] = nodeStop.length;
        const dir = l.dirs[d];
        dir.stops.forEach((s, k) => {
          const id = nodeStop.length;
          nodeLine.push(l);
          nodeDir.push(d);
          nodeK.push(k);
          nodeStop.push(s);
          stopSet.add(s);
          let a = this.stopNodes.get(s);
          if (!a) this.stopNodes.set(s, (a = []));
          a.push(id);
        });
      }
      this.base.set(l.id, b);
    }
    this.nodeLine = nodeLine;
    this.nodeDir = Uint8Array.from(nodeDir);
    this.nodeK = Int32Array.from(nodeK);
    this.nodeStop = nodeStop;
    this.stops = [...stopSet];
    this.stopGrid = new Grid(400);
    this.stops.forEach((s, i) => this.stopGrid.add(s.x, s.y, i));

    // edges
    const n = nodeStop.length;
    const lists: { to: number; c: number }[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      const l = nodeLine[i],
        d = nodeDir[i],
        k = nodeK[i];
      const dir = l.dirs[d];
      if (k + 1 < dir.stops.length) {
        const km = (dir.stopDist[k + 1] - dir.stopDist[k]) / 1000;
        const crowd = l.crowding > 0.85 ? 1 + (l.crowding - 0.85) * 3 : 1;
        lists[i].push({ to: i + 1, c: (dir.segTime[k] / 60) * crowd + (l.d.fareKm * km) / VALUE_OF_TIME });
      }
      if (k === 0) continue; // can't alight at the first stop
      const s = nodeStop[i];
      this.stopGrid.query(s.x, s.y, TRANSFER_RADIUS, (si) => {
        const s2 = this.stops[si];
        const dd = Math.hypot(s2.x - s.x, s2.y - s.y);
        if (dd > TRANSFER_RADIUS) return;
        for (const j of this.stopNodes.get(s2) || []) {
          const l2 = nodeLine[j];
          if (l2 === l && nodeDir[j] === d) continue;
          const dir2 = l2.dirs[nodeDir[j]];
          if (nodeK[j] >= dir2.stops.length - 1) continue; // can't board at last stop
          const c = walkMin(dd) * PT_WALK_WEIGHT + l2.expectedWait(block) * PT_WAIT_WEIGHT + PT_TRANSFER_PENALTY + l2.d.fareBase / VALUE_OF_TIME;
          lists[i].push({ to: j, c });
        }
      });
    }
    let m = 0;
    for (const a of lists) m += a.length;
    this.outStart = new Int32Array(n + 1);
    this.outTo = new Int32Array(m);
    this.outCost = new Float32Array(m);
    let p = 0;
    for (let i = 0; i < n; i++) {
      this.outStart[i] = p;
      for (const e of lists[i]) {
        this.outTo[p] = e.to;
        this.outCost[p] = e.c;
        p++;
      }
    }
    this.outStart[n] = p;
  }

  /** boarding options near a point: [node, cost] */
  accessNodes(x: number, y: number, maxWalk: number, extraMin = 0, cityFilter?: string, ignoreRadius = false): [number, number][] {
    const res: [number, number][] = [];
    this.stopGrid.query(x, y, maxWalk, (si) => {
      const s = this.stops[si];
      if (cityFilter && s.d.city !== cityFilter) return;
      const dd = Math.hypot(s.x - x, s.y - y);
      const r = ignoreRadius ? maxWalk : Math.min(maxWalk, radiusFor(s));
      if (dd > r) return;
      for (const j of this.stopNodes.get(s) || []) {
        const l = this.nodeLine[j];
        const dir = l.dirs[this.nodeDir[j]];
        if (this.nodeK[j] >= dir.stops.length - 1) continue;
        res.push([j, extraMin + walkMin(dd) * PT_WALK_WEIGHT + l.expectedWait(this.block) * PT_WAIT_WEIGHT + l.d.fareBase / VALUE_OF_TIME]);
      }
    });
    return res;
  }

  /** alighting options near a point: [node, egress cost] */
  egressNodes(x: number, y: number, maxWalk: number, extraMin = 0, cityFilter?: string, ignoreRadius = false): [number, number][] {
    const res: [number, number][] = [];
    this.stopGrid.query(x, y, maxWalk, (si) => {
      const s = this.stops[si];
      if (cityFilter && s.d.city !== cityFilter) return;
      const dd = Math.hypot(s.x - x, s.y - y);
      if (dd > (ignoreRadius ? maxWalk : Math.min(maxWalk, radiusFor(s)))) return;
      for (const j of this.stopNodes.get(s) || []) {
        if (this.nodeK[j] === 0) continue;
        res.push([j, extraMin + walkMin(dd) * PT_WALK_WEIGHT]);
      }
    });
    return res;
  }

  /** multi-source Dijkstra; fills dist and pred */
  search(sources: [number, number][], dist: Float32Array, pred: Int32Array, limit = 240): void {
    dist.fill(Infinity);
    pred.fill(-1);
    const h = this.heap;
    h.clear();
    for (const [n, c] of sources) {
      if (c < dist[n]) {
        dist[n] = c;
        pred[n] = -1;
        h.push(c, n);
      }
    }
    while (h.size) {
      const u = h.pop();
      const du = h.lastPri;
      if (du > dist[u] + 1e-3 || du > limit) continue; // dist is float32: allow rounding
      for (let k = this.outStart[u], ke = this.outStart[u + 1]; k < ke; k++) {
        const v = this.outTo[k];
        const c = du + this.outCost[k];
        if (c < dist[v]) {
          dist[v] = c;
          pred[v] = u;
          h.push(c, v);
        }
      }
    }
  }

  /** reconstruct legs from pred tree ending at node */
  legs(pred: Int32Array, end: number): Int32Array {
    const out: number[] = [];
    let cur = end;
    let alightK = this.nodeK[cur];
    let curLine = this.nodeLine[cur],
      curDir = this.nodeDir[cur];
    for (;;) {
      const p = pred[cur];
      const sameRun = p >= 0 && this.nodeLine[p] === curLine && this.nodeDir[p] === curDir && this.nodeK[p] === this.nodeK[cur] - 1;
      if (!sameRun) {
        out.push(curLine.id, curDir, this.nodeK[cur], alightK);
        if (p < 0) break;
        cur = p;
        alightK = this.nodeK[cur];
        curLine = this.nodeLine[cur];
        curDir = this.nodeDir[cur];
        continue;
      }
      cur = p;
    }
    // out holds legs in reverse order; drop zero-length legs (board == alight,
    // e.g. "walk to a stop and transfer on foot to another one")
    const nl = out.length / 4;
    let keep = 0;
    for (let i = 0; i < nl; i++) if (out[i * 4 + 3] > out[i * 4 + 2]) keep++;
    const legs = new Int32Array(keep * 4);
    let w = 0;
    for (let i = nl - 1; i >= 0; i--) {
      if (out[i * 4 + 3] <= out[i * 4 + 2]) continue;
      for (let q = 0; q < 4; q++) legs[w++] = out[i * 4 + q];
    }
    return legs;
  }
}

export function radiusFor(s: Stop): number {
  return MODES[s.d.mode]?.stopRadius || 3000;
}
