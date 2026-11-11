// Structure-of-arrays pools so that tens of thousands of agents stay cheap.

export const P_FREE = 0,
  P_WALK_TO_STOP = 1,
  P_WAITING = 2,
  P_RIDING = 3,
  P_WALK_TO_DEST = 4;

/** Transit passengers (citizens that chose public transport). */
export class PassengerPool {
  cap: number;
  count = 0; // high-water mark
  active = 0;
  state: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  dx: Float32Array;
  dy: Float32Array;
  leg: Uint8Array;
  t0: Float32Array; // trip start (game minutes)
  waitStart: Float32Array;
  city: Int16Array; // origin city index
  destCity: Int16Array; // city index of destination (-1 = finish on arrival)
  intercity: Uint8Array;
  plans: (Int32Array | null)[]; // legs: [lineId, dir, boardIdx, alightIdx] *
  free: number[] = [];

  constructor(cap = 4096) {
    this.cap = cap;
    this.state = new Uint8Array(cap);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.tx = new Float32Array(cap);
    this.ty = new Float32Array(cap);
    this.dx = new Float32Array(cap);
    this.dy = new Float32Array(cap);
    this.leg = new Uint8Array(cap);
    this.t0 = new Float32Array(cap);
    this.waitStart = new Float32Array(cap);
    this.city = new Int16Array(cap);
    this.destCity = new Int16Array(cap);
    this.intercity = new Uint8Array(cap);
    this.plans = new Array(cap).fill(null);
  }

  private grow(): void {
    const n = this.cap * 2;
    const g = <T extends Float32Array | Uint8Array | Int16Array>(a: T, C: new (n: number) => T): T => {
      const b = new C(n);
      b.set(a);
      return b;
    };
    this.state = g(this.state, Uint8Array);
    this.x = g(this.x, Float32Array);
    this.y = g(this.y, Float32Array);
    this.tx = g(this.tx, Float32Array);
    this.ty = g(this.ty, Float32Array);
    this.dx = g(this.dx, Float32Array);
    this.dy = g(this.dy, Float32Array);
    this.leg = g(this.leg, Uint8Array);
    this.t0 = g(this.t0, Float32Array);
    this.waitStart = g(this.waitStart, Float32Array);
    this.city = g(this.city, Int16Array);
    this.destCity = g(this.destCity, Int16Array);
    this.intercity = g(this.intercity, Uint8Array);
    this.plans.length = n;
    this.plans.fill(null, this.cap);
    this.cap = n;
  }

  alloc(): number {
    let i: number;
    if (this.free.length) i = this.free.pop()!;
    else {
      if (this.count >= this.cap) this.grow();
      i = this.count++;
    }
    this.active++;
    return i;
  }

  release(i: number): void {
    if (this.state[i] === P_FREE) return;
    this.state[i] = P_FREE;
    this.plans[i] = null;
    this.active--;
    this.free.push(i);
  }

  /** lower the high-water mark when the top slots are free (call occasionally) */
  trim(): void {
    let c = this.count;
    while (c > 0 && this.state[c - 1] === P_FREE) c--;
    if (c !== this.count) {
      this.count = c;
      this.free = this.free.filter((i) => i < c);
    }
  }
}

/** FIFO queue of passenger ids (amortised O(1) push / shift, no per-call allocation). */
export class PaxQueue {
  buf = new Int32Array(8);
  head = 0;
  tail = 0;
  get length(): number {
    return this.tail - this.head;
  }
  at(i: number): number {
    return this.buf[this.head + i];
  }
  push(p: number): void {
    if (this.tail >= this.buf.length) {
      const n = this.tail - this.head;
      if (this.head > 0 && n < this.buf.length >> 1) {
        this.buf.copyWithin(0, this.head, this.tail);
      } else {
        const b = new Int32Array(this.buf.length * 2);
        b.set(this.buf.subarray(this.head, this.tail));
        this.buf = b;
      }
      this.head = 0;
      this.tail = n;
    }
    this.buf[this.tail++] = p;
  }
  /** drop the first n entries */
  shift(n: number): void {
    this.head += n;
    if (this.head >= this.tail) this.head = this.tail = 0;
  }
  clear(): void {
    this.head = this.tail = 0;
  }
}

/** Cars and bikes driving on the road graph. */
export class TrafficPool {
  cap: number;
  count = 0;
  active = 0;
  alive: Uint8Array;
  mode: Uint8Array; // 0 car, 1 bike
  arcIdx: Int32Array;
  s: Float32Array;
  wait: Float32Array;
  hint: Int32Array;
  x: Float32Array;
  y: Float32Array;
  h: Float32Array;
  moved: Uint8Array; // position needs recomputing
  paths: (Int32Array | null)[];
  free: number[] = [];

  constructor(cap = 4096) {
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.moved = new Uint8Array(cap);
    this.mode = new Uint8Array(cap);
    this.arcIdx = new Int32Array(cap);
    this.s = new Float32Array(cap);
    this.wait = new Float32Array(cap);
    this.hint = new Int32Array(cap);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.h = new Float32Array(cap);
    this.paths = new Array(cap).fill(null);
  }

  private grow(): void {
    const n = this.cap * 2;
    const g = <T extends Float32Array | Uint8Array | Int32Array>(a: T, C: new (n: number) => T): T => {
      const b = new C(n);
      b.set(a);
      return b;
    };
    this.alive = g(this.alive, Uint8Array);
    this.moved = g(this.moved, Uint8Array);
    this.mode = g(this.mode, Uint8Array);
    this.arcIdx = g(this.arcIdx, Int32Array);
    this.s = g(this.s, Float32Array);
    this.wait = g(this.wait, Float32Array);
    this.hint = g(this.hint, Int32Array);
    this.x = g(this.x, Float32Array);
    this.y = g(this.y, Float32Array);
    this.h = g(this.h, Float32Array);
    this.paths.length = n;
    this.paths.fill(null, this.cap);
    this.cap = n;
  }

  alloc(): number {
    let i: number;
    if (this.free.length) i = this.free.pop()!;
    else {
      if (this.count >= this.cap) this.grow();
      i = this.count++;
    }
    this.active++;
    this.alive[i] = 1;
    this.moved[i] = 1;
    return i;
  }

  release(i: number): void {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.paths[i] = null;
    this.active--;
    this.free.push(i);
  }

  /** lower the high-water mark when the top slots are free (call occasionally) */
  trim(): void {
    let c = this.count;
    while (c > 0 && !this.alive[c - 1]) c--;
    if (c !== this.count) {
      this.count = c;
      this.free = this.free.filter((i) => i < c);
    }
  }
}
