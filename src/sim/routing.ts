// Car / bike route finding for the many individual citizens.
//
// Instead of one A* search per trip we keep destination-rooted shortest path
// trees: one reverse Dijkstra from a destination junction gives the best next
// arc towards that destination from EVERY junction. A city only has a few
// hundred destination anchors (zone anchors), so a handful of trees serves
// hundreds of thousands of trips per day.
//
// Trees are built time-sliced (a search can span several frames) inside a
// per-frame time budget, kept in an LRU bounded by memory and refreshed in
// the background (car trees follow congestion; bike trees are static).
import { RoadGraph } from './graph';
import { MinHeap } from './heap';

export const R_CAR = 0,
  R_BIKE = 1;
export const BIKE_SPEED = 4.4; // m/s
const COST_INF = 65535;
/** memory budget for trees per city (bytes) */
const TREE_BYTES = 64 * 1024 * 1024;
/** max cached extracted paths per tree */
const PATHS_PER_TREE = 96;

export class RouteTree {
  key: number;
  dest: number;
  mode: number;
  next: Int32Array; // arc to take from junction j towards dest (-1 = dest / unreachable)
  cost: Uint16Array; // travel time j -> dest in seconds (65535 = unreachable)
  built = -1e9; // game minutes
  version = -1; // graph version at build time
  lastUse = 0;
  paths = new Map<number, Int32Array | null>(); // origin junction -> extracted arc list
  constructor(key: number, next: Int32Array, cost: Uint16Array) {
    this.key = key;
    this.dest = key >> 1;
    this.mode = key & 1;
    this.next = next;
    this.cost = cost;
  }
}

export function treeKey(dest: number, mode: number): number {
  return dest * 2 + mode;
}

export class Router {
  G: RoadGraph;
  trees = new Map<number, RouteTree>();
  maxTrees: number;
  /** car trees older than this (game minutes) are rebuilt in the background */
  carTtl = 30;
  /** called whenever a tree finished building */
  onBuilt: ((t: RouteTree) => void) | null = null;
  stats = { built: 0, ms: 0, evicted: 0 };

  private hi: number[] = []; // missing trees (someone is waiting)
  private lo: number[] = []; // refreshes
  private queued = new Set<number>();
  private use = 0;

  // in-progress build
  private bKey = -1;
  private bNow = 0;
  private bVersion = -1;
  private bNext: Int32Array | null = null;
  private bCost: Uint16Array | null = null;
  private dist: Float64Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap = new MinHeap(4096);
  private pool: [Int32Array, Uint16Array][] = [];
  private scratch: Int32Array;

  constructor(G: RoadGraph) {
    this.G = G;
    const n = G.nJ;
    this.dist = new Float64Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.scratch = new Int32Array(Math.max(16, n + 1));
    this.maxTrees = Math.max(32, Math.floor(TREE_BYTES / Math.max(1, n * 6)));
  }

  get pendingBuilds(): number {
    return this.hi.length + this.lo.length + (this.bKey >= 0 ? 1 : 0);
  }

  /** ready tree for (dest, mode) or null; schedules refreshes of stale trees */
  get(dest: number, mode: number, now: number): RouteTree | null {
    const k = treeKey(dest, mode);
    const t = this.trees.get(k);
    if (!t) return null;
    t.lastUse = ++this.use;
    if (mode === R_CAR && (t.version !== this.G.version || now - t.built > this.carTtl)) this.enqueue(k, t.version !== this.G.version);
    return t;
  }

  has(dest: number, mode: number): boolean {
    return this.trees.has(treeKey(dest, mode));
  }

  /** ask for a tree that does not exist yet */
  request(dest: number, mode: number): void {
    const k = treeKey(dest, mode);
    if (this.trees.has(k)) return;
    this.enqueue(k, true);
  }

  private enqueue(k: number, urgent: boolean): void {
    if (this.queued.has(k) || this.bKey === k) return;
    this.queued.add(k);
    (urgent ? this.hi : this.lo).push(k);
  }

  clear(): void {
    this.trees.clear();
    this.hi.length = 0;
    this.lo.length = 0;
    this.queued.clear();
    this.bKey = -1;
  }

  /** arc list from junction `from` to the tree's destination (cached per tree) */
  path(from: number, t: RouteTree): Int32Array | null {
    const cached = t.paths.get(from);
    if (cached !== undefined) return cached;
    const G = this.G,
      next = t.next,
      buf = this.scratch;
    let n = 0;
    let j = from;
    let ok = true;
    while (j !== t.dest) {
      const a = next[j];
      if (a < 0 || n >= buf.length) {
        ok = false;
        break;
      }
      buf[n++] = a;
      j = G.arcTo(a);
    }
    const p = ok ? buf.slice(0, n) : null;
    if (t.paths.size >= PATHS_PER_TREE) t.paths.clear();
    t.paths.set(from, p);
    return p;
  }

  /**
   * Do queued tree builds until performance.now() reaches `deadline`.
   * Background refreshes (trees that exist but are stale) only run until `refreshDeadline`.
   */
  work(deadline: number, now: number, refreshDeadline = deadline): void {
    const t0 = performance.now();
    if (t0 >= deadline) return;
    for (;;) {
      if (this.bKey < 0) {
        let k = -1;
        if (this.hi.length) k = this.hi.shift()!;
        else if (this.lo.length && performance.now() < refreshDeadline) k = this.lo.shift()!;
        if (k < 0) break;
        this.queued.delete(k);
        this.start(k, now);
      }
      if (!this.stepBuild(deadline)) break;
      this.finish();
      if (performance.now() >= deadline) break;
    }
    this.stats.ms += performance.now() - t0;
  }

  /** build synchronously (used for warm-up) */
  buildNow(dest: number, mode: number, now: number): RouteTree | null {
    const k = treeKey(dest, mode);
    if (this.bKey >= 0) {
      // finish the running build first
      this.stepBuild(Infinity);
      this.finish();
    }
    this.queued.delete(k);
    this.start(k, now);
    this.stepBuild(Infinity);
    this.finish();
    return this.trees.get(k) ?? null;
  }

  private start(k: number, now: number): void {
    const G = this.G;
    this.bKey = k;
    this.bNow = now;
    this.bVersion = G.version;
    const buf = this.pool.pop();
    const nJ = G.nJ;
    this.bNext = buf ? buf[0] : new Int32Array(nJ);
    this.bCost = buf ? buf[1] : new Uint16Array(nJ);
    this.bNext.fill(-1);
    this.bCost.fill(COST_INF);
    const gen = ++this.gen;
    const dest = k >> 1;
    this.heap.clear();
    this.dist[dest] = 0;
    this.stamp[dest] = gen;
    this.heap.push(0, dest);
  }

  /** returns true when the running build is complete */
  private stepBuild(deadline: number): boolean {
    const G = this.G;
    const car = (this.bKey & 1) === R_CAR;
    const gen = this.gen,
      dist = this.dist,
      stamp = this.stamp,
      closed = this.closed,
      heap = this.heap,
      next = this.bNext!,
      cost = this.bCost!;
    const inStart = G.inStart,
      inArc = G.inArc,
      eLen = G.eLen,
      eCls = G.eCls,
      jDeg = G.jDeg,
      now = this.bNow;
    let n = 0;
    while (heap.size > 0) {
      if ((++n & 63) === 0 && performance.now() >= deadline) return false;
      const u = heap.pop();
      if (closed[u] === gen) continue;
      closed[u] = gen;
      const du = heap.lastPri;
      cost[u] = du < COST_INF - 1 ? Math.round(du) : COST_INF - 1;
      const jPen = jDeg[u] >= 3 ? 3 : 0;
      for (let k = inStart[u], ke = inStart[u + 1]; k < ke; k++) {
        const a = inArc[k];
        if (car && !G.arcAllowed(a)) continue;
        const v = G.arcFrom(a);
        if (closed[v] === gen) continue;
        const e = a >> 1;
        let c: number;
        if (car) c = du + eLen[e] / G.arcSpeed(a, 'car', now) + G.junctionDelay(a);
        else {
          const cls = eCls[e];
          // bikes avoid motorways / trunk roads and their ramps
          const slow = cls === 0 || cls === 1 || cls === 8 || cls === 9 ? 6 : 1;
          c = du + (eLen[e] * slow) / BIKE_SPEED + jPen;
        }
        if (stamp[v] !== gen || c < dist[v]) {
          stamp[v] = gen;
          dist[v] = c;
          next[v] = a;
          heap.push(c, v);
        }
      }
    }
    return true;
  }

  private finish(): void {
    const k = this.bKey;
    this.bKey = -1;
    if (k < 0) return;
    let t = this.trees.get(k);
    if (t) {
      // swap buffers: the old arrays go back to the pool
      this.pool.push([t.next, t.cost]);
      t.next = this.bNext!;
      t.cost = this.bCost!;
      t.paths.clear();
    } else {
      if (this.trees.size >= this.maxTrees) this.evict();
      t = new RouteTree(k, this.bNext!, this.bCost!);
      t.lastUse = ++this.use;
      this.trees.set(k, t);
    }
    this.bNext = null;
    this.bCost = null;
    t.built = this.bNow;
    t.version = this.bVersion;
    this.stats.built++;
    if (this.pool.length > 4) this.pool.length = 4;
    this.onBuilt?.(t);
  }

  private evict(): void {
    let worst: RouteTree | null = null;
    for (const t of this.trees.values()) if (!worst || t.lastUse < worst.lastUse) worst = t;
    if (!worst) return;
    this.trees.delete(worst.key);
    this.pool.push([worst.next, worst.cost]);
    this.stats.evicted++;
  }
}
