/** Binary min-heap over (priority, value) pairs using typed arrays. */
export class MinHeap {
  pri: Float64Array;
  val: Int32Array;
  size = 0;
  constructor(cap = 1024) {
    this.pri = new Float64Array(cap);
    this.val = new Int32Array(cap);
  }
  clear(): void {
    this.size = 0;
  }
  push(p: number, v: number): void {
    if (this.size >= this.pri.length) {
      const np = new Float64Array(this.pri.length * 2);
      np.set(this.pri);
      const nv = new Int32Array(this.val.length * 2);
      nv.set(this.val);
      this.pri = np;
      this.val = nv;
    }
    let i = this.size++;
    const pri = this.pri,
      val = this.val;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      pri[i] = pri[parent];
      val[i] = val[parent];
      i = parent;
    }
    pri[i] = p;
    val[i] = v;
  }
  /** returns value of min element; priority available in lastPri */
  lastPri = 0;
  pop(): number {
    const pri = this.pri,
      val = this.val;
    const top = val[0];
    this.lastPri = pri[0];
    const n = --this.size;
    if (n > 0) {
      const p = pri[n],
        v = val[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pri[c + 1] < pri[c]) c++;
        if (pri[c] >= p) break;
        pri[i] = pri[c];
        val[i] = val[c];
        i = c;
      }
      pri[i] = p;
      val[i] = v;
    }
    return top;
  }
}
