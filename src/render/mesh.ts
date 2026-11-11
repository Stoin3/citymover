// Plain-object meshes for deck.gl SimpleMeshLayer (non-indexed triangle lists).
// Mesh x-axis = vehicle forward, y = left, z = up.

export interface PlainMesh {
  positions: { value: Float32Array; size: 3 };
  normals: { value: Float32Array; size: 3 };
}

/** push an axis-aligned box [x0,x1]×[y0,y1]×[z0,z1] (12 triangles, outward normals) */
function pushBox(pos: number[], nrm: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    // two CCW triangles a-b-c, a-c-d (seen from outside)
    for (const p of [a, b, c, a, c, d]) {
      pos.push(p[0], p[1], p[2]);
      nrm.push(n[0], n[1], n[2]);
    }
  };
  const p000 = [x0, y0, z0], p100 = [x1, y0, z0], p110 = [x1, y1, z0], p010 = [x0, y1, z0];
  const p001 = [x0, y0, z1], p101 = [x1, y0, z1], p111 = [x1, y1, z1], p011 = [x0, y1, z1];
  quad(p001, p101, p111, p011, [0, 0, 1]); // top
  quad(p000, p010, p110, p100, [0, 0, -1]); // bottom
  quad(p100, p110, p111, p101, [1, 0, 0]); // front (+x)
  quad(p000, p001, p011, p010, [-1, 0, 0]); // back
  quad(p010, p011, p111, p110, [0, 1, 0]); // left (+y)
  quad(p000, p100, p101, p001, [0, -1, 0]); // right (-y)
}

function toMesh(pos: number[], nrm: number[]): PlainMesh {
  return {
    positions: { value: Float32Array.from(pos), size: 3 },
    normals: { value: Float32Array.from(nrm), size: 3 },
  };
}

/** unit box x∈[-.5,.5], y∈[-.5,.5], z∈[0,1] */
export function unitBox(): PlainMesh {
  const pos: number[] = [], nrm: number[] = [];
  pushBox(pos, nrm, -0.5, 0.5, -0.5, 0.5, 0, 1);
  return toMesh(pos, nrm);
}

/** unit car: body + cabin, scaled by [length, width, height] */
export function unitCar(): PlainMesh {
  const pos: number[] = [], nrm: number[] = [];
  pushBox(pos, nrm, -0.5, 0.5, -0.5, 0.5, 0.12, 0.6);
  pushBox(pos, nrm, -0.3, 0.2, -0.44, 0.44, 0.6, 1);
  return toMesh(pos, nrm);
}

/** simple aircraft in absolute metres (length 38, span 34), origin at centre, z from 0 */
export function planeMesh(): PlainMesh {
  const pos: number[] = [], nrm: number[] = [];
  pushBox(pos, nrm, -19, 19, -2, 2, 1, 5); // fuselage
  pushBox(pos, nrm, -4, 4, -17, 17, 2.4, 3.2); // wings
  pushBox(pos, nrm, -19, -14, -6.5, 6.5, 3.8, 4.4); // tailplane
  pushBox(pos, nrm, -19, -14.5, -0.4, 0.4, 5, 11); // fin
  return toMesh(pos, nrm);
}

/** deterministic realistic car colours */
export const CAR_COLORS: [number, number, number][] = [
  [235, 235, 235], [30, 30, 34], [150, 155, 160], [90, 95, 100], [180, 30, 35], [25, 60, 140], [210, 210, 200],
  [60, 90, 60], [120, 20, 30], [230, 170, 30], [70, 120, 180], [245, 245, 250], [45, 45, 50], [170, 120, 80],
];
