// CityMover renderer: MapLibre (OpenFreeMap vector tiles, 3D buildings) + deck.gl
// interleaved layers (depth-tested against the buildings).
// Implements the RENDERER CONTRACT from src/game/api.ts. Read-only towards the game.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 loads its tile worker from a sibling file; let Vite bundle it and hand us the URL
// (works both in the dev server's pre-bundled deps and in production builds).
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';

import type { IGame, IRenderer, MapClick, MapMode, Overlay, PickInfo, Unsub, HighwayLink } from '../game/api';
import type { CitySim, Zone, Accident } from '../sim/city';
import type { Line, Stop, Vehicle } from '../sim/transit';
import { P_WAITING, P_WALK_TO_DEST, P_WALK_TO_STOP } from '../sim/agents';
import { MODES, SAFE_SPEED } from '../config';
import type { ModeId } from '../config';
import { CITIES, CITY_BY_ID, neighbours } from '../data/cities';
import type { CityDef } from '../data/cities';
import { toLon, toLat, toX, toY, LON0, LAT0 } from '../geo';
import { unitBox, unitCar, planeMesh, CAR_COLORS } from './mesh';
import { injectRendererStyle } from './style';

export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** global game metres -> [lon, lat] */
export function geoToLonLat(x: number, y: number): [number, number] {
  return [toLon(x), toLat(y)];
}

type RGBA = [number, number, number, number];
type F32 = Float32Array<ArrayBuffer>;
type F64 = Float64Array<ArrayBuffer>;
type U8 = Uint8Array<ArrayBuffer>;
type Ramp = [number, number, number][];

// game metres per degree (see geo.ts) and deck.gl metres per degree (web-mercator EARTH_CIRCUMFERENCE)
const MLON = toX(LON0 + 1);
const MLAT = toY(LAT0 + 1);
const DECK_M_PER_DEG = 40.03e6 / 360;

const GREEN_RED: Ramp = [
  [46, 204, 113],
  [170, 220, 60],
  [255, 210, 50],
  [255, 130, 40],
  [220, 30, 40],
];
const HEAT: Ramp = [
  [40, 70, 200],
  [120, 60, 210],
  [230, 70, 110],
  [255, 150, 50],
  [255, 235, 90],
];
// CONTROL_NAMES order: none, right, priority, stop, lights, roundabout
const CTRL_COLORS: [number, number, number][] = [
  [255, 0, 255],
  [255, 255, 255],
  [255, 150, 30],
  [235, 30, 30],
  [40, 220, 80],
  [0, 220, 255],
];
const CTRL_RISK = [1.0, 0.45, 0.3, 0.25, 0.12, 0.1];

function ramp(r: Ramp, t: number, out: number[], alpha: number): number[] {
  t = Math.max(0, Math.min(1, t)) * (r.length - 1);
  const i = Math.min(r.length - 2, Math.floor(t));
  const f = t - i;
  const a = r[i],
    b = r[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  out[3] = alpha;
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hashIdx(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** flat x,y (global metres) -> flat lon,lat */
function ptsToLonLat(pts: ArrayLike<number>): Float64Array {
  const out = new Float64Array(pts.length);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    out[i] = toLon(pts[i]);
    out[i + 1] = toLat(pts[i + 1]);
  }
  return out;
}

function growF32(a: F32, n: number): F32 {
  if (a.length >= n) return a;
  let c = Math.max(1024, a.length);
  while (c < n) c *= 2;
  return new Float32Array(c);
}
function growF64(a: F64, n: number): F64 {
  if (a.length >= n) return a;
  let c = Math.max(1024, a.length);
  while (c < n) c *= 2;
  return new Float64Array(c);
}
function growU8(a: U8, n: number): U8 {
  if (a.length >= n) return a;
  let c = Math.max(1024, a.length);
  while (c < n) c *= 2;
  return new Uint8Array(c);
}

const CAR_L = 4.4,
  CAR_W = 1.8,
  CAR_H = 1.5;

interface RoadDatum {
  e: number;
  path: Float64Array;
}

/** Per-city cached geometry, accessors and traffic buffers. */
class CityRender {
  city: CitySim;
  origin: [number, number, number];
  sx: number;
  sy: number;
  roads: RoadDatum[] = [];
  edgePath: Float64Array[] = [];
  junctions = new Int32Array(0);
  junctionPos = new Float64Array(0);
  chevrons: Float64Array[] = [];
  accEdges = new Set<number>();
  accJunctions = new Set<number>();
  // traffic buffers (METER_OFFSETS around city centre)
  carPos: F32 = new Float32Array(0);
  carMat: F32 = new Float32Array(0);
  carCol: U8 = new Uint8Array(0);
  nCar = 0;
  bikePos: F32 = new Float32Array(0);
  nBike = 0;
  constructor(city: CitySim) {
    this.city = city;
    this.origin = [city.def.lon, city.def.lat, 0];
    this.sx = (DECK_M_PER_DEG * Math.cos((city.def.lat * Math.PI) / 180)) / MLON;
    this.sy = DECK_M_PER_DEG / MLAT;
    this.buildGeometry();
  }

  buildGeometry(): void {
    const G = this.city.G;
    this.roads = new Array(G.nE);
    this.edgePath = new Array(G.nE);
    for (let e = 0; e < G.nE; e++) {
      const p0 = G.ePt[e],
        p1 = G.ePt[e + 1];
      const path = new Float64Array((p1 - p0) * 2);
      for (let k = p0, o = 0; k < p1; k++, o += 2) {
        path[o] = toLon(G.px[k]);
        path[o + 1] = toLat(G.py[k]);
      }
      this.edgePath[e] = path;
      this.roads[e] = { e, path };
    }
    const js: number[] = [];
    for (let j = 0; j < G.nJ; j++) if (G.jDeg[j] >= 3) js.push(j);
    this.junctions = Int32Array.from(js);
    this.junctionPos = new Float64Array(js.length * 3);
    js.forEach((j, i) => {
      this.junctionPos[i * 3] = toLon(G.jx[j]);
      this.junctionPos[i * 3 + 1] = toLat(G.jy[j]);
      this.junctionPos[i * 3 + 2] = 0;
    });
    this.buildChevrons();
  }

  /** oneway arrows (small chevrons at each oneway edge's midpoint) - depends on edits */
  buildChevrons(): void {
    const G = this.city.G;
    const out: Float64Array[] = [];
    for (let e = 0; e < G.nE; e++) {
      const o = G.eOneway[e];
      if (!o || G.eLen[e] < 22) continue;
      const p0 = G.ePt[e],
        p1 = G.ePt[e + 1] - 1;
      const half = G.eLen[e] / 2;
      let k = p0;
      while (k < p1 - 1 && G.pc[k + 1] < half) k++;
      const segLen = G.pc[k + 1] - G.pc[k] || 1;
      const t = clamp01((half - G.pc[k]) / segLen);
      const mx = G.px[k] + (G.px[k + 1] - G.px[k]) * t;
      const my = G.py[k] + (G.py[k + 1] - G.py[k]) * t;
      let dx = (G.px[k + 1] - G.px[k]) / segLen,
        dy = (G.py[k + 1] - G.py[k]) / segLen;
      if (o < 0) {
        dx = -dx;
        dy = -dy;
      }
      const s = 2.6;
      const nx = -dy,
        ny = dx;
      out.push(
        ptsToLonLat([
          mx - dx * s + nx * s, my - dy * s + ny * s,
          mx + dx * s * 0.8, my + dy * s * 0.8,
          mx - dx * s - nx * s, my - dy * s - ny * s,
        ]),
      );
    }
    this.chevrons = out;
  }

  refreshAccidents(): void {
    this.accEdges.clear();
    this.accJunctions.clear();
    for (const a of this.city.accidents) {
      if (a.e >= 0) this.accEdges.add(a.e);
      if (a.j >= 0) this.accJunctions.add(a.j);
    }
  }

  fillTraffic(): void {
    const T = this.city.traffic;
    const n = T.count;
    this.carPos = growF32(this.carPos, n * 3);
    this.carMat = growF32(this.carMat, n * 12);
    this.carCol = growU8(this.carCol, n * 4);
    this.bikePos = growF32(this.bikePos, n * 3);
    const cp = this.carPos,
      cm = this.carMat,
      cc = this.carCol,
      bp = this.bikePos;
    const cx = this.city.cx,
      cy = this.city.cy,
      sx = this.sx,
      sy = this.sy;
    let nc = 0,
      nb = 0;
    const alive = T.alive,
      mode = T.mode,
      X = T.x,
      Y = T.y,
      H = T.h;
    const nCol = CAR_COLORS.length;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const x = (X[i] - cx) * sx,
        y = (Y[i] - cy) * sy;
      if (mode[i] === 1) {
        const o = nb * 3;
        bp[o] = x;
        bp[o + 1] = y;
        bp[o + 2] = 0.9;
        nb++;
      } else {
        let o = nc * 3;
        cp[o] = x;
        cp[o + 1] = y;
        cp[o + 2] = 0;
        const h = H[i];
        const c = Math.cos(h),
          s = Math.sin(h);
        o = nc * 12;
        cm[o] = CAR_L * c;
        cm[o + 1] = CAR_L * s;
        cm[o + 2] = 0;
        cm[o + 3] = -CAR_W * s;
        cm[o + 4] = CAR_W * c;
        cm[o + 5] = 0;
        cm[o + 6] = 0;
        cm[o + 7] = 0;
        cm[o + 8] = CAR_H;
        cm[o + 9] = 0;
        cm[o + 10] = 0;
        cm[o + 11] = 0;
        const col = CAR_COLORS[hashIdx(i) % nCol];
        o = nc * 4;
        cc[o] = col[0];
        cc[o + 1] = col[1];
        cc[o + 2] = col[2];
        cc[o + 3] = 255;
        nc++;
      }
    }
    this.nCar = nc;
    this.nBike = nb;
  }
}

interface LineDatum {
  line: Line;
  path: Float64Array; // lon,lat(,z) flat
  dim: 2 | 3;
  width: number;
  color: RGBA;
}

interface DraftData {
  dashes: Float64Array[];
  stops: Stop[];
  color: RGBA;
}

const MODE_LINE_WIDTH: Record<ModeId, number> = { bus: 5, tram: 6, metro: 9, train: 9, coach: 6, plane: 3 };
const MODE_STOP_RADIUS: Record<ModeId, number> = { bus: 7, tram: 8, metro: 14, train: 18, coach: 9, plane: 90 };

export function createRenderer(container: HTMLElement, game: IGame): IRenderer {
  injectRendererStyle();
  try {
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
  } catch {
    /* ignore */
  }
  const startDef: CityDef = game.cities[0]?.def ?? CITY_BY_ID.get(game.startCity) ?? CITIES[0];

  const map = new maplibregl.Map({
    container,
    style: MAP_STYLE_URL,
    center: [startDef.lon, startDef.lat],
    zoom: 14,
    pitch: 55,
    bearing: -20,
    maxPitch: 80,
    minZoom: 7,
    maxZoom: 19.5,
    attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors, OpenFreeMap' },
    canvasContextAttributes: { antialias: true },
  });
  // deck.gl 9.4's interleaved mode reads `map.transform` (removed from the public Map in MapLibre 6):
  // expose the camera's transform under the old name.
  if (!(map as unknown as { transform?: unknown }).transform) {
    try {
      Object.defineProperty(map, 'transform', {
        configurable: true,
        get: () => (map as unknown as { _camera?: { transform?: unknown } })._camera?.transform,
      });
    } catch {
      /* ignore */
    }
  }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  let overlay: MapboxOverlay | null = null;
  let ready = false;
  let destroyed = false;
  let beforeId: string | undefined;

  let mode: MapMode = 'view';
  let buildMode: ModeId | null = null;
  let overlayKind: Overlay = 'none';
  let selection: PickInfo | null = null;
  let draft: DraftData | null = null;
  const clickCbs = new Set<(c: MapClick) => void>();

  const cityRenders = new Map<CitySim, CityRender>();
  let staticDirty = true;
  let colorVersion = 0;
  let editVersion = 0;
  let lastSlow = 0;
  let markerClickAt = 0;
  let frameNo = 0;

  // static caches
  let lineData: LineDatum[] = [];
  let stopData: Stop[] = [];
  let zoneData: { z: Zone; t: number }[] = [];
  const highwayPathCache = new WeakMap<object, Float64Array>();
  const linePathCache = new WeakMap<object, Float64Array>();

  // dynamic buffers
  let paxPos: F64 = new Float64Array(0);
  let paxCol: U8 = new Uint8Array(0);
  let nPax = 0;
  let hwPos: F64 = new Float64Array(0);
  let hwMat: F32 = new Float32Array(0);
  let hwCol: U8 = new Uint8Array(0);
  let nHw = 0;

  const boxMesh = unitBox();
  const carMesh = unitCar();
  const airMesh = planeMesh();
  const tmpColor = [0, 0, 0, 0];

  // ------------------------------------------------------------------ style setup
  function setupStyle(): void {
    const style = map.getStyle();
    const layers = style.layers || [];
    let bIdx = layers.findIndex((l: { type: string }) => l.type === 'fill-extrusion');
    if (bIdx < 0 && map.getSource('openmaptiles')) {
      // style without 3D buildings: add our own extrusion layer before the first symbol layer
      const firstSymbol = layers.find((l: { type: string }) => l.type === 'symbol')?.id;
      map.addLayer(
        {
          id: 'cm-building-3d',
          type: 'fill-extrusion',
          source: 'openmaptiles',
          'source-layer': 'building',
          minzoom: 13,
          paint: {
            'fill-extrusion-color': 'hsl(35,8%,85%)',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.9,
          },
        },
        firstSymbol,
      );
    } else if (bIdx >= 0) {
      const id = layers[bIdx].id;
      try {
        map.setLayerZoomRange(id, 13, 24);
        map.setPaintProperty(id, 'fill-extrusion-opacity', 0.92);
        map.setPaintProperty(id, 'fill-extrusion-color', [
          'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0],
          0, 'hsl(35,10%,86%)', 30, 'hsl(30,8%,80%)', 80, 'hsl(215,12%,76%)',
        ]);
      } catch {
        /* ignore */
      }
    }
    const after = map.getStyle().layers || [];
    bIdx = after.findIndex((l: { type: string }) => l.type === 'fill-extrusion');
    beforeId = bIdx >= 0 && bIdx + 1 < after.length ? after[bIdx + 1].id : undefined;

    // dim mask outside unlocked cities
    map.addSource('cm-mask', { type: 'geojson', data: maskGeoJSON() });
    map.addLayer(
      { id: 'cm-mask', type: 'fill', source: 'cm-mask', paint: { 'fill-color': '#0a1024', 'fill-opacity': 0.5 } },
      beforeId,
    );
    map.addLayer(
      {
        id: 'cm-mask-edge',
        type: 'line',
        source: 'cm-mask',
        paint: { 'line-color': '#ffb703', 'line-width': 2, 'line-opacity': 0.75, 'line-dasharray': [3, 2] },
      },
      beforeId,
    );
    try {
      map.setSky({
        'sky-color': '#7fb2e8',
        'horizon-color': '#dde8f3',
        'fog-color': '#e6edf5',
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.7,
        'fog-ground-blend': 0.75,
        'atmosphere-blend': 0,
      } as Parameters<maplibregl.Map['setSky']>[0]);
    } catch {
      /* sky optional */
    }
  }

  function maskGeoJSON(): GeoJSON.Feature<GeoJSON.Polygon> {
    const rings: number[][][] = [
      [
        [-180, -85],
        [180, -85],
        [180, 85],
        [-180, 85],
        [-180, -85],
      ],
    ];
    for (const c of game.cities) {
      const d = c.def;
      const rKm = d.radius;
      const ring: number[][] = [];
      const N = 96;
      const kmLat = 1 / 110.574,
        kmLon = 1 / (111.32 * Math.cos((d.lat * Math.PI) / 180));
      // holes wound opposite to the outer ring
      for (let i = N; i >= 0; i--) {
        const a = (i / N) * Math.PI * 2;
        ring.push([d.lon + Math.cos(a) * rKm * kmLon, d.lat + Math.sin(a) * rKm * kmLat]);
      }
      rings.push(ring);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } };
  }

  function updateBounds(): void {
    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    const add = (lon: number, lat: number) => {
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    };
    const unlocked = new Set(game.cities.map((c) => c.def.id));
    for (const c of game.cities) {
      add(c.def.lon, c.def.lat);
      for (const nb of neighbours(c.def.id)) {
        const d = CITY_BY_ID.get(nb);
        if (d && !unlocked.has(nb)) add(d.lon, d.lat);
      }
    }
    if (!isFinite(w)) return;
    const mLat = 0.35,
      mLon = 0.55;
    map.setMaxBounds([
      [w - mLon, s - mLat],
      [e + mLon, n + mLat],
    ]);
  }

  function updateMask(): void {
    const src = map.getSource('cm-mask') as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(maskGeoJSON());
  }

  // ------------------------------------------------------------------ city markers
  const nf = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const markers = new Map<string, { m: maplibregl.Marker; el: HTMLDivElement; state: string }>();
  function createMarkers(): void {
    for (const def of CITIES) {
      // outer element belongs to MapLibre (it adds its own classes); we style the inner pill
      const outer = document.createElement('div');
      const el = document.createElement('div');
      el.className = 'cm-r-marker cm-r-locked';
      outer.appendChild(el);
      outer.addEventListener('click', (ev) => {
        ev.stopPropagation();
        markerClickAt = performance.now();
        const lon = def.lon,
          lat = def.lat;
        emitClick({ x: toX(lon), y: toY(lat), lon, lat, pick: { kind: 'city', cityId: def.id } });
      });
      const m = new maplibregl.Marker({ element: outer, anchor: 'bottom', offset: [0, -4] }).setLngLat([def.lon, def.lat]).addTo(map);
      markers.set(def.id, { m, el, state: '' });
    }
    updateMarkers();
  }
  function updateMarkers(): void {
    const unlocked = new Set(game.cities.map((c) => c.def.id));
    const unlockable = new Set<string>();
    for (const id of unlocked) for (const nb of neighbours(id)) if (!unlocked.has(nb)) unlockable.add(nb);
    const zoomedIn = map.getZoom() > 12.5;
    for (const def of CITIES) {
      const mk = markers.get(def.id);
      if (!mk) continue;
      let state: string, html: string, title: string;
      if (unlocked.has(def.id)) {
        state = 'unlocked' + (zoomedIn ? '-h' : '');
        html = `<span class="cm-r-dot"></span><span class="cm-r-name">${esc(def.name)}</span>`;
        title = def.name;
      } else if (unlockable.has(def.id)) {
        const u = game.canUnlockCity(def.id);
        state = 'unlockable' + (u.ok ? '' : '-n') + u.cost;
        html = `<span class="cm-r-ico">🔓</span><span class="cm-r-name">${esc(def.name)}</span><span class="cm-r-cost">${nf.format(u.cost)}</span>`;
        title = u.ok ? `Ontgrendel ${def.name} voor ${nf.format(u.cost)}` : `${def.name}: ${u.reason}`;
      } else {
        state = 'locked';
        html = `<span class="cm-r-ico">🔒</span><span class="cm-r-name">${esc(def.name)}</span>`;
        title = `${def.name} (vergrendeld)`;
      }
      if (state === mk.state) continue;
      mk.state = state;
      const cls = state.startsWith('unlockable')
        ? 'cm-r-unlockable' + (state.startsWith('unlockable-n') ? ' cm-r-noafford' : '')
        : state.startsWith('unlocked')
          ? 'cm-r-unlocked' + (zoomedIn ? ' cm-r-hidden' : '')
          : 'cm-r-locked';
      mk.el.className = 'cm-r-marker ' + cls;
      mk.el.innerHTML = html;
      mk.el.title = title;
    }
  }
  function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  }

  // ------------------------------------------------------------------ static data
  function cityRender(c: CitySim): CityRender {
    let cr = cityRenders.get(c);
    if (!cr) {
      cr = new CityRender(c);
      cityRenders.set(c, cr);
    }
    return cr;
  }

  function rebuildStatic(): void {
    staticDirty = false;
    editVersion++;
    colorVersion++;
    // drop renders of cities that are gone
    const live = new Set(game.cities);
    for (const c of [...cityRenders.keys()]) if (!live.has(c)) cityRenders.delete(c);
    for (const c of game.cities) {
      const cr = cityRender(c);
      cr.buildChevrons();
    }
    // transit lines
    lineData = [];
    for (const line of game.lines.values()) {
      const dir = line.dirs[0];
      if (!line.valid || dir.pts.length < 4) continue;
      const m = line.d.mode;
      const col = line.d.color;
      if (m === 'plane') {
        lineData.push({ line, path: planeArc(dir.pts), dim: 3, width: MODE_LINE_WIDTH.plane, color: [col[0], col[1], col[2], 220] });
      } else {
        let path = linePathCache.get(dir.pts);
        if (!path) {
          path = ptsToLonLat(dir.pts);
          linePathCache.set(dir.pts, path);
        }
        lineData.push({
          line,
          path,
          dim: 2,
          width: MODE_LINE_WIDTH[m],
          color: [col[0], col[1], col[2], m === 'metro' ? 140 : 235],
        });
      }
    }
    stopData = [...game.stops.values()];
    // demand zones
    zoneData = [];
    let max = 1;
    for (const c of game.cities) for (const z of c.zones) max = Math.max(max, z.pop + z.jobs);
    for (const c of game.cities) for (const z of c.zones) zoneData.push({ z, t: Math.sqrt((z.pop + z.jobs) / max) });
    updateMarkers();
  }

  function planeArc(pts: Float64Array): Float64Array {
    const n = pts.length / 2;
    const ax = pts[0],
      ay = pts[1],
      bx = pts[(n - 1) * 2],
      by = pts[(n - 1) * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const peak = Math.min(3500, len * 0.06);
    const N = 48;
    const out = new Float64Array((N + 1) * 3);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      out[i * 3] = toLon(ax + (bx - ax) * t);
      out[i * 3 + 1] = toLat(ay + (by - ay) * t);
      out[i * 3 + 2] = Math.sin(Math.PI * t) * peak;
    }
    return out;
  }

  function highwayPath(h: HighwayLink): Float64Array {
    let p = highwayPathCache.get(h.pts);
    if (!p) {
      p = ptsToLonLat(h.pts);
      highwayPathCache.set(h.pts, p);
    }
    return p;
  }

  function buildDraft(stopIds: number[], m: ModeId | null): DraftData | null {
    const stops = stopIds.map((id) => game.stops.get(id)).filter((s): s is Stop => !!s);
    if (!stops.length) return null;
    const c = m ? MODES[m].color : [255, 255, 255];
    const dashes: Float64Array[] = [];
    for (let k = 0; k + 1 < stops.length; k++) {
      const a = stops[k],
        b = stops[k + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const dash = Math.max(12, L / 150);
      const n = Math.max(1, Math.floor(L / (dash * 2)));
      for (let i = 0; i < n; i++) {
        const t0 = (i * 2 * dash) / L,
          t1 = Math.min(1, ((i * 2 + 1) * dash) / L);
        dashes.push(ptsToLonLat([a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0, a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1]));
      }
    }
    return { dashes, stops, color: [c[0], c[1], c[2], 255] };
  }

  // ------------------------------------------------------------------ dynamic data
  function fillPassengers(): void {
    const P = game.passengers;
    const n = P.count;
    paxPos = growF64(paxPos, n * 3);
    paxCol = growU8(paxCol, n * 4);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const st = P.state[i];
      if (st !== P_WAITING && st !== P_WALK_TO_STOP && st !== P_WALK_TO_DEST) continue;
      paxPos[k * 3] = toLon(P.x[i]);
      paxPos[k * 3 + 1] = toLat(P.y[i]);
      paxPos[k * 3 + 2] = 0.8;
      const o = k * 4;
      if (st === P_WAITING) {
        paxCol[o] = 255;
        paxCol[o + 1] = 214;
        paxCol[o + 2] = 10;
      } else {
        paxCol[o] = 120;
        paxCol[o + 1] = 200;
        paxCol[o + 2] = 255;
      }
      paxCol[o + 3] = 255;
      k++;
    }
    nPax = k;
  }

  function fillHighwayCars(): void {
    const cars = game.highwayCars;
    const n = cars.length;
    hwPos = growF64(hwPos, n * 3);
    hwMat = growF32(hwMat, n * 12);
    hwCol = growU8(hwCol, n * 4);
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      hwPos[i * 3] = toLon(c.x);
      hwPos[i * 3 + 1] = toLat(c.y);
      hwPos[i * 3 + 2] = 0;
      const co = Math.cos(c.h),
        si = Math.sin(c.h);
      const o = i * 12;
      hwMat[o] = CAR_L * co;
      hwMat[o + 1] = CAR_L * si;
      hwMat[o + 2] = 0;
      hwMat[o + 3] = -CAR_W * si;
      hwMat[o + 4] = CAR_W * co;
      hwMat[o + 5] = 0;
      hwMat[o + 6] = 0;
      hwMat[o + 7] = 0;
      hwMat[o + 8] = CAR_H;
      hwMat[o + 9] = hwMat[o + 10] = hwMat[o + 11] = 0;
      const col = CAR_COLORS[hashIdx(i + 7919) % CAR_COLORS.length];
      hwCol[i * 4] = col[0];
      hwCol[i * 4 + 1] = col[1];
      hwCol[i * 4 + 2] = col[2];
      hwCol[i * 4 + 3] = 255;
    }
    nHw = n;
  }

  // ------------------------------------------------------------------ colour logic
  function roadColor(cr: CityRender, e: number, out: number[]): number[] {
    const G = cr.city.G;
    if (overlayKind === 'congestion') {
      let f = 1;
      if (G.arcAllowed(e * 2)) f = Math.min(f, G.congestion(e * 2));
      if (G.arcAllowed(e * 2 + 1)) f = Math.min(f, G.congestion(e * 2 + 1));
      return ramp(GREEN_RED, (1 - f) / 0.93, out, 235);
    }
    if (overlayKind === 'safety') {
      const over = G.eSpeed[e] - (SAFE_SPEED[G.eCls[e]] ?? 50);
      const t = cr.accEdges.has(e) ? 1 : clamp01(over / 30) * 0.85;
      return ramp(GREEN_RED, t, out, 230);
    }
    const roadsMode = mode === 'roads';
    const alpha = roadsMode ? 230 : 40;
    if (G.eBus[e]) {
      out[0] = 230; out[1] = 50; out[2] = 60; out[3] = roadsMode ? 240 : 90;
      return out;
    }
    if (roadsMode && G.edgeIsModified(e)) {
      out[0] = 190; out[1] = 90; out[2] = 255; out[3] = 245;
      return out;
    }
    const cls = G.eCls[e];
    if (cls <= 1 || cls === 8 || cls === 9) { out[0] = 255; out[1] = 110; out[2] = 40; }
    else if (cls <= 3 || cls === 10 || cls === 11) { out[0] = 255; out[1] = 185; out[2] = 30; }
    else if (cls === 4 || cls === 12) { out[0] = 175; out[1] = 215; out[2] = 70; }
    else if (cls === 7) { out[0] = 120; out[1] = 200; out[2] = 255; }
    else { out[0] = 60; out[1] = 135; out[2] = 245; }
    out[3] = alpha;
    return out;
  }

  function junctionColor(cr: CityRender, j: number, out: number[]): number[] {
    const G = cr.city.G;
    const ctrl = G.jCtrl[j];
    if (overlayKind === 'safety') {
      if (cr.accJunctions.has(j)) return ramp(GREEN_RED, 1, out, 255);
      let r = (CTRL_RISK[ctrl] ?? 0.5) * (1 + G.jLoad[j] / 25);
      if (ctrl === 1 && G.jMainRank[j] >= 7) r *= 2.5;
      return ramp(GREEN_RED, clamp01(r / 1.6), out, 245);
    }
    const c = CTRL_COLORS[ctrl] ?? CTRL_COLORS[0];
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = 245;
    return out;
  }

  // ------------------------------------------------------------------ layers
  function buildLayers(): Layer[] {
    const zoom = map.getZoom();
    const L: Layer[] = [];
    const roadsVisible = mode === 'roads' || overlayKind === 'congestion' || overlayKind === 'safety' || zoom >= 13;
    const roadsPickable = mode === 'roads';
    const roadsStrong = mode === 'roads' || overlayKind === 'congestion' || overlayKind === 'safety';
    const common = { beforeId } as { beforeId?: string };

    // demand overlay
    if (overlayKind === 'demand' && zoneData.length) {
      L.push(
        new ScatterplotLayer<{ z: Zone; t: number }>({
          ...common,
          id: 'zones',
          data: zoneData,
          getPosition: (d) => [toLon(d.z.x), toLat(d.z.y), 0],
          getRadius: 245,
          radiusUnits: 'meters',
          getFillColor: (d, { target }) => ramp(HEAT, d.t, target as number[], 40 + 130 * d.t) as RGBA,
          stroked: false,
          parameters: { depthWriteEnabled: false },
        }),
      );
    }

    // roads + junctions per city
    for (const cr of cityRenders.values()) {
      const ci = cr.city.index;
      const G = cr.city.G;
      if (roadsVisible) {
        L.push(
          new PathLayer<RoadDatum>({
            ...common,
            id: `roads-${ci}`,
            data: cr.roads,
            positionFormat: 'XY',
            getPath: (d) => d.path,
            getColor: (d, { target }) => roadColor(cr, d.e, target as number[]) as RGBA,
            getWidth: (d) => (roadsStrong ? Math.max(3, G.lanesDir(d.e) * (G.eOneway[d.e] ? 1 : 2) * 3) : 4),
            widthUnits: 'meters',
            widthMinPixels: roadsStrong ? 1.5 : 0.8,
            widthMaxPixels: 40,
            capRounded: true,
            jointRounded: true,
            pickable: roadsPickable,
            autoHighlight: roadsPickable,
            highlightColor: [0, 230, 255, 255],
            parameters: { depthWriteEnabled: false },
            updateTriggers: {
              getColor: [colorVersion, overlayKind, mode],
              getWidth: [editVersion, roadsStrong],
            },
          }),
        );
      }
      if (mode === 'roads' && zoom >= 15.5 && cr.chevrons.length) {
        L.push(
          new PathLayer<Float64Array>({
            ...common,
            id: `oneway-${ci}`,
            data: cr.chevrons,
            positionFormat: 'XY',
            getPath: (d) => d,
            getColor: [20, 30, 50, 230],
            getWidth: 0.9,
            widthUnits: 'meters',
            widthMinPixels: 1.4,
            capRounded: true,
            jointRounded: true,
            parameters: { depthWriteEnabled: false },
          }),
        );
      }
      if ((mode === 'roads' || overlayKind === 'safety') && zoom >= 14.5 && cr.junctions.length) {
        const js = cr.junctions;
        const jp = cr.junctionPos;
        L.push(
          new ScatterplotLayer<unknown>({
            ...common,
            id: `junctions-${ci}`,
            data: { length: js.length },
            getPosition: (_d: unknown, { index }) => [jp[index * 3], jp[index * 3 + 1], 0],
            getFillColor: (_d: unknown, { index, target }) => junctionColor(cr, js[index], target as number[]) as RGBA,
            getRadius: (_d: unknown, { index }) => (G.jCtrl[js[index]] === 5 ? 7 : 4.5),
            radiusUnits: 'meters',
            radiusMinPixels: 3,
            radiusMaxPixels: 14,
            stroked: true,
            getLineColor: [15, 20, 35, 230],
            lineWidthUnits: 'pixels',
            getLineWidth: 1.5,
            pickable: mode === 'roads',
            autoHighlight: mode === 'roads',
            highlightColor: [0, 230, 255, 255],
            updateTriggers: { getFillColor: [colorVersion, overlayKind], getRadius: editVersion },
          }),
        );
      }
    }

    // highways
    if (game.highways.length) {
      L.push(
        new PathLayer<HighwayLink>({
          ...common,
          id: 'highways',
          data: game.highways,
          positionFormat: 'XY',
          getPath: (h) => highwayPath(h),
          getColor: (h, { target }) =>
            (h.closedUntil > game.time ? [200, 20, 20, 255] : ramp(GREEN_RED, h.congestion, target as number[], 220)) as RGBA,
          getWidth: (h) => 6 + h.settings.lanes * 3,
          widthUnits: 'meters',
          widthMinPixels: 2.5,
          capRounded: true,
          jointRounded: true,
          pickable: mode !== 'build',
          autoHighlight: true,
          highlightColor: [255, 255, 255, 200],
          parameters: { depthWriteEnabled: false },
          updateTriggers: { getColor: colorVersion, getWidth: colorVersion, getPath: editVersion },
        }),
      );
    }

    // selected line glow (under the lines)
    if (selection && selection.kind === 'line') {
      const id = selection.lineId;
      const ld = lineData.find((l) => l.line.id === id);
      if (ld) {
        L.push(
          new PathLayer<LineDatum>({
            ...common,
            id: 'sel-line',
            data: [ld],
            positionFormat: ld.dim === 3 ? 'XYZ' : 'XY',
            getPath: (d) => d.path,
            getColor: [255, 255, 255, 230],
            getWidth: ld.width * 2.6 + 4,
            widthUnits: 'meters',
            widthMinPixels: 8,
            capRounded: true,
            jointRounded: true,
            parameters: { depthWriteEnabled: false },
          }),
        );
      }
    }

    // transit lines
    const flat = lineData.filter((l) => l.dim === 2);
    const air = lineData.filter((l) => l.dim === 3);
    const linePickable = mode === 'view';
    const dimOthers = mode === 'build' || mode === 'roads';
    if (flat.length) {
      L.push(
        new PathLayer<LineDatum>({
          ...common,
          id: 'lines',
          data: flat,
          positionFormat: 'XY',
          getPath: (d) => d.path,
          getColor: (d) => (dimOthers ? [d.color[0], d.color[1], d.color[2], Math.min(d.color[3], 120)] : d.color),
          getWidth: (d) => d.width,
          widthUnits: 'meters',
          widthMinPixels: 3,
          widthMaxPixels: 22,
          capRounded: true,
          jointRounded: true,
          pickable: linePickable,
          autoHighlight: linePickable,
          highlightColor: [255, 255, 255, 120],
          parameters: { depthWriteEnabled: false },
          updateTriggers: { getColor: [dimOthers, colorVersion] },
        }),
      );
    }
    if (air.length) {
      L.push(
        new PathLayer<LineDatum>({
          ...common,
          id: 'lines-air',
          data: air,
          positionFormat: 'XYZ',
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: 2,
          widthUnits: 'pixels',
          widthMinPixels: 1.5,
          pickable: linePickable,
          autoHighlight: linePickable,
          highlightColor: [255, 255, 255, 160],
        }),
      );
    }

    // draft line
    if (draft) {
      const dr = draft;
      L.push(
        new PathLayer<Float64Array>({
          ...common,
          id: 'draft-dashes',
          data: dr.dashes,
          positionFormat: 'XY',
          getPath: (d) => d,
          getColor: dr.color,
          getWidth: 6,
          widthUnits: 'meters',
          widthMinPixels: 3,
          capRounded: true,
          parameters: { depthWriteEnabled: false },
        }),
        new ScatterplotLayer<Stop>({
          ...common,
          id: 'draft-stops',
          data: dr.stops,
          getPosition: (s) => [toLon(s.x), toLat(s.y), 1],
          getRadius: (s) => MODE_STOP_RADIUS[s.d.mode] * 1.6,
          radiusUnits: 'meters',
          radiusMinPixels: 7,
          getFillColor: [255, 255, 255, 255],
          stroked: true,
          getLineColor: dr.color,
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
        }),
      );
    }

    // stops
    if (stopData.length) {
      const stopPickable = mode === 'view' || mode === 'build';
      L.push(
        new ScatterplotLayer<Stop>({
          ...common,
          id: 'stops',
          data: stopData,
          getPosition: (s) => [toLon(s.x), toLat(s.y), 1.5],
          getRadius: (s) => MODE_STOP_RADIUS[s.d.mode] + Math.min(40, Math.sqrt(s.waiting) * 1.6),
          radiusUnits: 'meters',
          radiusMinPixels: 4,
          radiusMaxPixels: 26,
          getFillColor: (s) => {
            const c = MODES[s.d.mode].color;
            const faint = (mode === 'build' && buildMode && s.d.mode !== buildMode) || mode === 'roads';
            return [c[0], c[1], c[2], faint ? 70 : 255];
          },
          stroked: true,
          getLineColor: (s) => {
            const faint = (mode === 'build' && buildMode && s.d.mode !== buildMode) || mode === 'roads';
            return [255, 255, 255, faint ? 80 : 255];
          },
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          pickable: stopPickable,
          autoHighlight: stopPickable,
          highlightColor: [255, 255, 255, 200],
          updateTriggers: { getRadius: colorVersion, getFillColor: [mode, buildMode], getLineColor: [mode, buildMode] },
        }),
      );
      if (zoom >= 15) {
        L.push(
          new TextLayer<Stop>({
            ...common,
            id: 'stop-labels',
            data: stopData,
            getPosition: (s) => [toLon(s.x), toLat(s.y), 4],
            getText: (s) => s.d.name,
            characterSet: 'auto',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            fontWeight: 600,
            getSize: 13,
            getColor: [255, 255, 255, 255],
            outlineWidth: 3,
            outlineColor: [15, 20, 40, 230],
            fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
            getPixelOffset: [0, -18],
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'bottom',
            billboard: true,
            parameters: { depthCompare: 'always', depthWriteEnabled: false },
          }),
        );
      }
    }

    // passengers
    if (nPax > 0 && zoom >= 13) {
      L.push(
        new ScatterplotLayer({
          ...common,
          id: 'passengers',
          data: {
            length: nPax,
            attributes: {
              getPosition: { value: paxPos, size: 3 },
              getFillColor: { value: paxCol, size: 4 },
            },
          },
          getRadius: 0.9,
          radiusUnits: 'meters',
          radiusMinPixels: 1.5,
          radiusMaxPixels: 5,
        } as never),
      );
    }

    // cars & bikes
    if (zoom >= 12) {
      for (const cr of cityRenders.values()) {
        const ci = cr.city.index;
        if (cr.nCar > 0) {
          L.push(
            new SimpleMeshLayer({
              ...common,
              id: `cars-${ci}`,
              coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
              coordinateOrigin: cr.origin,
              mesh: carMesh,
              data: {
                length: cr.nCar,
                attributes: {
                  getPosition: { value: cr.carPos, size: 3 },
                  instanceModelMatrix: { value: cr.carMat, size: 12 },
                  getColor: { value: cr.carCol, size: 4 },
                },
              },
              material: { ambient: 0.45, diffuse: 0.65, shininess: 40, specularColor: [80, 80, 80] },
            } as never),
          );
        }
        if (cr.nBike > 0) {
          L.push(
            new ScatterplotLayer({
              ...common,
              id: `bikes-${ci}`,
              coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
              coordinateOrigin: cr.origin,
              data: { length: cr.nBike, attributes: { getPosition: { value: cr.bikePos, size: 3 } } },
              getRadius: 0.8,
              radiusUnits: 'meters',
              radiusMinPixels: 1.2,
              radiusMaxPixels: 4,
              getFillColor: [16, 150, 125, 255],
            } as never),
          );
        }
      }
    }

    // highway cars
    if (nHw > 0) {
      L.push(
        new SimpleMeshLayer({
          ...common,
          id: 'highway-cars',
          mesh: carMesh,
          data: {
            length: nHw,
            attributes: {
              getPosition: { value: hwPos, size: 3 },
              instanceModelMatrix: { value: hwMat, size: 12 },
              getColor: { value: hwCol, size: 4 },
            },
          },
          sizeScale: zoom < 12 ? Math.min(6, Math.pow(2, 12 - zoom)) : 1,
          material: { ambient: 0.45, diffuse: 0.65, shininess: 40, specularColor: [80, 80, 80] },
        } as never),
      );
    }

    // transit vehicles
    const vs = game.vehicles;
    if (vs.length) {
      const ground = vs.filter((v) => v.line.d.mode !== 'plane');
      const planes = vs.length === ground.length ? [] : vs.filter((v) => v.line.d.mode === 'plane');
      const vScale = Math.max(1, Math.min(8, Math.pow(2, 15.5 - zoom)));
      const vPick = mode === 'view';
      if (ground.length) {
        L.push(
          new SimpleMeshLayer<Vehicle>({
            ...common,
            id: 'vehicles',
            data: ground,
            mesh: boxMesh as never,
            getPosition: (v) => [toLon(v.x), toLat(v.y), v.z || 0],
            getOrientation: (v) => [0, (v.h * 180) / Math.PI, 0],
            getScale: (v) => v.line.def.dims,
            getColor: (v) => [v.line.d.color[0], v.line.d.color[1], v.line.d.color[2], 255],
            sizeScale: vScale,
            pickable: vPick,
            autoHighlight: vPick,
            highlightColor: [255, 255, 255, 140],
            material: { ambient: 0.5, diffuse: 0.6, shininess: 60, specularColor: [90, 90, 90] },
            updateTriggers: { getPosition: frameNo, getOrientation: frameNo, getColor: colorVersion, getScale: colorVersion },
          }),
        );
      }
      if (planes.length) {
        L.push(
          new SimpleMeshLayer<Vehicle>({
            ...common,
            id: 'planes',
            data: planes,
            mesh: airMesh as never,
            getPosition: (v) => [toLon(v.x), toLat(v.y), v.z || 0],
            getOrientation: (v) => [0, (v.h * 180) / Math.PI, 0],
            getColor: (v) => [v.line.d.color[0], v.line.d.color[1], v.line.d.color[2], 255],
            sizeScale: Math.max(1, Math.min(20, Math.pow(2, 14 - zoom))),
            pickable: vPick,
            autoHighlight: vPick,
            highlightColor: [255, 255, 255, 140],
            material: { ambient: 0.5, diffuse: 0.6, shininess: 60, specularColor: [90, 90, 90] },
            updateTriggers: { getPosition: frameNo, getOrientation: frameNo, getColor: colorVersion },
          }),
        );
      }
    }

    // accidents
    const acc = game.allAccidents();
    if (acc.length) {
      const pulse = 1 + 0.35 * Math.sin(performance.now() / 180);
      L.push(
        new ScatterplotLayer<Accident>({
          ...common,
          id: 'accidents-ring',
          data: acc,
          getPosition: (a) => [toLon(a.x), toLat(a.y), 2],
          getRadius: 22,
          radiusScale: pulse,
          radiusUnits: 'meters',
          radiusMinPixels: 9,
          filled: true,
          getFillColor: [230, 30, 30, 70],
          stroked: true,
          getLineColor: [255, 40, 40, 255],
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
        }),
        new TextLayer<Accident>({
          ...common,
          id: 'accidents-icon',
          data: acc,
          getPosition: (a) => [toLon(a.x), toLat(a.y), 3],
          getText: () => '!',
          getSize: 16,
          fontWeight: 900,
          getColor: [255, 255, 255, 255],
          outlineWidth: 4,
          outlineColor: [200, 0, 0, 255],
          fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
        }),
      );
    }

    // selection highlight
    const selLayer = selectionLayer(common);
    if (selLayer) L.push(selLayer);
    return L;
  }

  function selectionLayer(common: { beforeId?: string }): Layer | null {
    const sel = selection;
    if (!sel) return null;
    const ring = (id: string, x: number, y: number, z: number, r: number) =>
      new ScatterplotLayer<number>({
        ...common,
        id,
        data: [0],
        getPosition: () => [toLon(x), toLat(y), z],
        getRadius: r,
        radiusUnits: 'meters',
        radiusMinPixels: 10,
        filled: false,
        stroked: true,
        getLineColor: [0, 230, 255, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 3,
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
        updateTriggers: { getPosition: [x, y, z] },
      });
    switch (sel.kind) {
      case 'edge': {
        const c = game.cities[sel.city] ?? game.cities.find((cc) => cc.index === sel.city);
        if (!c) return null;
        const cr = cityRenders.get(c);
        const path = cr?.edgePath[sel.edge];
        if (!path) return null;
        return new PathLayer<Float64Array>({
          ...common,
          id: 'sel-edge',
          data: [path],
          positionFormat: 'XY',
          getPath: (d) => d,
          getColor: [0, 230, 255, 255],
          getWidth: 9,
          widthUnits: 'meters',
          widthMinPixels: 5,
          capRounded: true,
          jointRounded: true,
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
        });
      }
      case 'junction': {
        const c = game.cities[sel.city] ?? game.cities.find((cc) => cc.index === sel.city);
        if (!c || sel.junction < 0 || sel.junction >= c.G.nJ) return null;
        return ring('sel-junction', c.G.jx[sel.junction], c.G.jy[sel.junction], 1, 14);
      }
      case 'stop': {
        const s = game.stops.get(sel.stopId);
        if (!s) return null;
        return ring('sel-stop', s.x, s.y, 2, MODE_STOP_RADIUS[s.d.mode] * 2 + 6);
      }
      case 'vehicle': {
        const v = game.vehicles.find((vv) => vv.id === sel.vehicleId);
        if (!v) return null;
        return ring('sel-vehicle', v.x, v.y, (v.z || 0) + 1, Math.max(12, v.line.def.dims[0] * 0.8));
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ picking
  function pickToInfo(info: PickingInfo | null): PickInfo {
    if (!info || !info.layer) return { kind: 'map' };
    const id = info.layer.id;
    const obj = info.object as unknown;
    if (id.startsWith('roads-')) {
      const ci = Number(id.slice(6));
      return { kind: 'edge', city: ci, edge: (obj as RoadDatum).e };
    }
    if (id.startsWith('junctions-')) {
      const ci = Number(id.slice(10));
      const c = game.cities.find((cc) => cc.index === ci);
      const cr = c && cityRenders.get(c);
      if (cr && info.index >= 0) return { kind: 'junction', city: ci, junction: cr.junctions[info.index] };
    }
    if (id === 'stops' && obj) return { kind: 'stop', stopId: (obj as Stop).d.id };
    if ((id === 'lines' || id === 'lines-air') && obj) return { kind: 'line', lineId: (obj as LineDatum).line.id };
    if ((id === 'vehicles' || id === 'planes') && obj) {
      const v = obj as Vehicle;
      return { kind: 'vehicle', lineId: v.line.id, vehicleId: v.id };
    }
    if (id === 'highways' && obj) return { kind: 'highway', key: (obj as HighwayLink).key };
    return { kind: 'map' };
  }

  function pickAt(x: number, y: number, radius = 6): PickInfo {
    if (!overlay) return { kind: 'map' };
    try {
      return pickToInfo(overlay.pickObject({ x, y, radius }) as PickingInfo | null);
    } catch {
      return { kind: 'map' };
    }
  }

  function emitClick(c: MapClick): void {
    for (const cb of clickCbs) cb(c);
  }

  map.on('click', (e) => {
    if (performance.now() - markerClickAt < 350) return;
    const pick = pickAt(e.point.x, e.point.y, 6);
    const { lng, lat } = e.lngLat;
    emitClick({ x: toX(lng), y: toY(lat), lon: lng, lat, pick });
  });

  let lastHover = 0;
  let hoverPending = false;
  map.on('mousemove', (e) => {
    const now = performance.now();
    if (now - lastHover < 70 || hoverPending || !overlay) return;
    lastHover = now;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      const p = pickAt(e.point.x, e.point.y, 4);
      map.getCanvas().style.cursor = p.kind !== 'map' ? 'pointer' : mode === 'build' ? 'crosshair' : '';
    });
  });
  map.on('zoomend', () => updateMarkers());

  // ------------------------------------------------------------------ lifecycle
  const unsubs: Unsub[] = [];
  unsubs.push(
    game.on('changed', (p) => {
      staticDirty = true;
      if (p.what === 'cities' || p.what === 'all') {
        if (ready) {
          updateMask();
          updateBounds();
        }
        updateMarkers();
      }
    }),
  );

  // if the tile style cannot be fetched (offline / blocked), fall back to a plain background so
  // the game (deck.gl layers) still works
  let styleOk = false;
  map.once('styledata', () => (styleOk = true));
  map.on('error', (ev) => {
    if (styleOk || ready || destroyed) return;
    styleOk = true;
    console.warn('[renderer] kaartstijl niet geladen, terugval op lege kaart', ev.error);
    map.setStyle({
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dfe3e8' } }],
    });
  });

  map.on('load', () => {
    if (destroyed) return;
    setupStyle();
    overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    if (!location.search.includes('nodeck')) map.addControl(overlay as unknown as maplibregl.IControl);
    updateBounds();
    ready = true;
    staticDirty = true;
  });
  createMarkers();

  function frame(): void {
    if (!ready || !overlay || destroyed) return;
    frameNo++;
    const now = performance.now();
    if (staticDirty) rebuildStatic();
    if (now - lastSlow > 1000) {
      lastSlow = now;
      colorVersion++;
      for (const cr of cityRenders.values()) cr.refreshAccidents();
      updateMarkers();
    }
    const zoom = map.getZoom();
    if (zoom >= 12) for (const cr of cityRenders.values()) cr.fillTraffic();
    fillPassengers();
    fillHighwayCars();
    overlay.setProps({ layers: buildLayers() });
  }

  const renderer: IRenderer = {
    setMode(m: MapMode, bm?: ModeId) {
      mode = m;
      buildMode = m === 'build' ? (bm ?? null) : null;
      map.getCanvas().style.cursor = m === 'build' ? 'crosshair' : '';
      colorVersion++;
    },
    setSelection(sel: PickInfo | null) {
      selection = sel;
    },
    setDraftLine(stopIds: number[], m: ModeId | null) {
      draft = stopIds.length ? buildDraft(stopIds, m) : null;
    },
    setOverlay(o: Overlay) {
      overlayKind = o;
      colorVersion++;
    },
    onClick(cb) {
      clickCbs.add(cb);
      return () => clickCbs.delete(cb);
    },
    flyToCity(id: string) {
      const def = CITY_BY_ID.get(id);
      if (!def) return;
      map.flyTo({ center: [def.lon, def.lat], zoom: 14, pitch: Math.max(45, map.getPitch()), bearing: map.getBearing(), duration: 2600, essential: true });
    },
    flyTo(x: number, y: number, zoom?: number) {
      map.flyTo({ center: [toLon(x), toLat(y)], zoom: zoom ?? Math.max(map.getZoom(), 15), pitch: map.getPitch(), duration: 1600, essential: true });
    },
    refresh() {
      staticDirty = true;
    },
    frame,
    destroy() {
      destroyed = true;
      for (const u of unsubs) u();
      for (const mk of markers.values()) mk.m.remove();
      markers.clear();
      clickCbs.clear();
      try {
        if (overlay) map.removeControl(overlay as unknown as maplibregl.IControl);
      } catch {
        /* ignore */
      }
      overlay = null;
      map.remove();
    },
  };
  // expose for debugging / tests
  Object.defineProperty(renderer, 'map', { value: map });
  Object.defineProperty(renderer, 'overlay', { get: () => overlay });
  return renderer;
}
