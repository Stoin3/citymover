// Global equirectangular projection (metres) shared by all cities so that
// intercity lines use the same coordinate space as local ones.
export const LON0 = 5.3;
export const LAT0 = 51.9;
const MLAT = 110574;
const MLON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

export function toX(lon: number): number {
  return (lon - LON0) * MLON;
}
export function toY(lat: number): number {
  return (lat - LAT0) * MLAT;
}
export function toLon(x: number): number {
  return x / MLON + LON0;
}
export function toLat(y: number): number {
  return y / MLAT + LAT0;
}
export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx,
    dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Simple spatial hash for point lookups. */
export class Grid {
  cell: number;
  map = new Map<number, number[]>();
  constructor(cell: number) {
    this.cell = cell;
  }
  key(cx: number, cy: number): number {
    return (cx + 50000) * 100000 + (cy + 50000);
  }
  add(x: number, y: number, id: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let a = this.map.get(k);
    if (!a) this.map.set(k, (a = []));
    a.push(id);
  }
  /** visit ids in cells overlapping the radius */
  query(x: number, y: number, r: number, fn: (id: number) => void): void {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c),
      x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c),
      y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const a = this.map.get(this.key(cx, cy));
        if (a) for (const id of a) fn(id);
      }
  }
}
