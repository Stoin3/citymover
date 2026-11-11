// Converts raw OpenStreetMap JSON (Overpass API or OSM API 0.6 "map.json")
// into the compact CityData format used by the game.
// This file has no imports so it can also be run directly by Node (scripts/).

export interface CityWay {
  n: number[]; // node indices
  c: number; // highway class (see HIGHWAY_CLASSES)
  o: number; // oneway: 1 forward, -1 backward, 0 both
  s: number; // maxspeed km/h (0 = unknown)
  l: number; // lanes total (0 = unknown)
  nm?: string; // name
  r?: number; // roundabout
}

export interface CityRail {
  n: number[];
  t: number; // 0 rail, 1 subway, 2 light_rail, 3 tram
}

export interface CityStation {
  nm: string;
  lon: number;
  lat: number;
  t: number; // 0 train, 1 metro, 2 tram stop
}

export interface CityData {
  v: number;
  id: string;
  center: [number, number];
  radius: number; // km
  nodes: number[]; // flat lon,lat
  sig: number[]; // node indices with traffic_signals
  ways: CityWay[];
  rails: CityRail[];
  pois: number[]; // flat lon,lat,kind  (1 jobs, 2 shop, 3 education, 4 leisure)
  land: number[]; // flat lon,lat,area(m2),kind (0 residential, 1 commercial, 2 industrial)
  stations: CityStation[];
}

export const HIGHWAY_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
];

const RAIL_TYPES = ['rail', 'subway', 'light_rail', 'tram'];

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  center?: { lat: number; lon: number };
}

function parseSpeed(v: string | undefined): number {
  if (!v) return 0;
  if (v === 'NL:urban' || v === 'BE:urban' || v === 'DE:urban') return 50;
  if (v === 'NL:rural' || v === 'BE:rural' || v === 'DE:rural') return 80;
  if (v === 'NL:zone30' || v === 'DE:zone30') return 30;
  if (v === 'walk') return 15;
  const m = /^(\d+)\s*(mph)?/.exec(v);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return m[2] ? Math.round(n * 1.609) : n;
}

function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function parseOsm(
  elements: OsmElement[],
  id: string,
  center: [number, number],
  radiusKm: number,
): CityData {
  const nodeCoord = new Map<number, [number, number]>();
  const signalIds = new Set<number>();
  const pois: number[] = [];
  const land: number[] = [];
  const stations: CityStation[] = [];
  const kmLat = 110.574;
  const kmLon = 111.32 * Math.cos((center[1] * Math.PI) / 180);
  const inside = (lon: number, lat: number) => {
    const dx = (lon - center[0]) * kmLon;
    const dy = (lat - center[1]) * kmLat;
    return dx * dx + dy * dy <= radiusKm * radiusKm * 1.05;
  };

  for (const e of elements) {
    if (e.type !== 'node' || e.lat === undefined || e.lon === undefined) continue;
    nodeCoord.set(e.id, [e.lon, e.lat]);
    const t = e.tags;
    if (!t) continue;
    if (t.highway === 'traffic_signals') signalIds.add(e.id);
    if (!inside(e.lon, e.lat)) continue;
    if (t.railway === 'station' || t.public_transport === 'station') {
      if (t.name) {
        const metro = t.station === 'subway' || t.subway === 'yes';
        stations.push({ nm: t.name, lon: r6(e.lon), lat: r6(e.lat), t: metro ? 1 : 0 });
      }
    }
    let kind = 0;
    if (t.shop) kind = 2;
    else if (t.office || t.craft) kind = 1;
    else if (t.amenity) {
      if (['school', 'university', 'college', 'kindergarten'].includes(t.amenity)) kind = 3;
      else if (['bench', 'waste_basket', 'bicycle_parking', 'parking', 'post_box', 'recycling', 'vending_machine', 'telephone', 'parking_entrance', 'charging_station', 'drinking_water'].includes(t.amenity)) kind = 0;
      else kind = 1;
    } else if (t.tourism || t.leisure) kind = 4;
    if (kind) pois.push(r6(e.lon), r6(e.lat), kind);
  }

  const nodeIndex = new Map<number, number>();
  const nodes: number[] = [];
  const idx = (osmId: number): number => {
    let i = nodeIndex.get(osmId);
    if (i !== undefined) return i;
    const c = nodeCoord.get(osmId);
    if (!c) return -1;
    i = nodes.length / 2;
    nodes.push(r6(c[0]), r6(c[1]));
    nodeIndex.set(osmId, i);
    return i;
  };

  const ways: CityWay[] = [];
  const rails: CityRail[] = [];
  for (const e of elements) {
    if (e.type !== 'way') continue;
    const t = e.tags || {};
    const hw = t.highway;
    const cls = hw ? HIGHWAY_CLASSES.indexOf(hw) : -1;
    if (cls >= 0 && e.nodes && e.nodes.length > 1) {
      if (t.access === 'no' || t.access === 'private' || t.area === 'yes') continue;
      const n: number[] = [];
      for (const id of e.nodes) {
        const i = idx(id);
        if (i >= 0 && n[n.length - 1] !== i) n.push(i);
      }
      if (n.length < 2) continue;
      let o = 0;
      if (t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true') o = 1;
      else if (t.oneway === '-1' || t.oneway === 'reverse') o = -1;
      else if (t.junction === 'roundabout' || cls === 0 || cls === 8) o = t.oneway === 'no' ? 0 : 1;
      const w: CityWay = { n, c: cls, o, s: parseSpeed(t.maxspeed), l: parseInt(t.lanes || '0', 10) || 0 };
      if (t.name) w.nm = t.name;
      if (t.junction === 'roundabout') w.r = 1;
      ways.push(w);
      continue;
    }
    const rt = t.railway ? RAIL_TYPES.indexOf(t.railway) : -1;
    if (rt >= 0 && e.nodes && e.nodes.length > 1) {
      if (t.service === 'yard' || t.service === 'siding' || t.usage === 'industrial') continue;
      const n: number[] = [];
      for (const id of e.nodes) {
        const i = idx(id);
        if (i >= 0 && n[n.length - 1] !== i) n.push(i);
      }
      if (n.length >= 2) rails.push({ n, t: rt });
      continue;
    }
    const lu = t.landuse;
    const lk = lu === 'residential' ? 0 : lu === 'commercial' || lu === 'retail' ? 1 : lu === 'industrial' ? 2 : -1;
    if (lk >= 0) {
      let minlat = 90,
        minlon = 180,
        maxlat = -90,
        maxlon = -180;
      if (e.bounds) {
        ({ minlat, minlon, maxlat, maxlon } = e.bounds);
      } else if (e.nodes) {
        for (const id of e.nodes) {
          const c = nodeCoord.get(id);
          if (!c) continue;
          minlon = Math.min(minlon, c[0]);
          maxlon = Math.max(maxlon, c[0]);
          minlat = Math.min(minlat, c[1]);
          maxlat = Math.max(maxlat, c[1]);
        }
      }
      if (maxlat < minlat) continue;
      const area = (maxlat - minlat) * kmLat * 1000 * (maxlon - minlon) * kmLon * 1000 * 0.6;
      const clon = (minlon + maxlon) / 2,
        clat = (minlat + maxlat) / 2;
      if (inside(clon, clat)) land.push(r6(clon), r6(clat), Math.round(area), lk);
    }
  }

  const sig: number[] = [];
  for (const id of signalIds) {
    const i = nodeIndex.get(id);
    if (i !== undefined) sig.push(i);
  }

  return { v: 1, id, center, radius: radiusKm, nodes, sig, ways, rails, pois, land, stations };
}

export function overpassQuery(center: [number, number], radiusKm: number): string {
  const kmLat = 110.574;
  const kmLon = 111.32 * Math.cos((center[1] * Math.PI) / 180);
  const s = (center[1] - radiusKm / kmLat).toFixed(5);
  const n = (center[1] + radiusKm / kmLat).toFixed(5);
  const w = (center[0] - radiusKm / kmLon).toFixed(5);
  const e = (center[0] + radiusKm / kmLon).toFixed(5);
  const bb = `${s},${w},${n},${e}`;
  const hw = HIGHWAY_CLASSES.join('|');
  return `[out:json][timeout:120][maxsize:268435456];
(
  way["highway"~"^(${hw})$"](${bb});
  way["railway"~"^(rail|subway|light_rail|tram)$"](${bb});
);
out body;
>;
out skel qt;
(
  node["highway"="traffic_signals"](${bb});
  node["railway"="station"](${bb});
  node["shop"](${bb});
  node["office"](${bb});
  node["amenity"](${bb});
  node["tourism"](${bb});
  node["leisure"](${bb});
);
out body qt;
way["landuse"~"^(residential|commercial|retail|industrial)$"](${bb});
out tags bb qt;`;
}

export function corridorQuery(a: [number, number], b: [number, number], kind: 'rail' | 'road'): string {
  const pad = 0.04;
  const s = (Math.min(a[1], b[1]) - pad).toFixed(5);
  const n = (Math.max(a[1], b[1]) + pad).toFixed(5);
  const w = (Math.min(a[0], b[0]) - pad).toFixed(5);
  const e = (Math.max(a[0], b[0]) + pad).toFixed(5);
  const bb = `${s},${w},${n},${e}`;
  const filter =
    kind === 'rail'
      ? `way["railway"="rail"]["usage"~"^(main|branch)$"](${bb});way["railway"="rail"]["highspeed"="yes"](${bb});`
      : `way["highway"~"^(motorway|trunk|motorway_link|trunk_link)$"](${bb});`;
  return `[out:json][timeout:120];(${filter});out body;>;out skel qt;`;
}
