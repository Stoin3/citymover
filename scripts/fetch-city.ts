// Pre-download a city from OpenStreetMap into public/data/<id>.json so the game
// does not need the Overpass API at runtime for that city.
//
//   node scripts/fetch-city.ts delft            (via Overpass API)
//   node scripts/fetch-city.ts delft --osmapi   (via OSM API 0.6, small cities only)
//
// Data © OpenStreetMap contributors, ODbL.
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseOsm, overpassQuery } from '../src/osm/parse.ts';
import { CITY_BY_ID } from '../src/data/cities.ts';

const id = process.argv[2];
const useOsmApi = process.argv.includes('--osmapi');
const radiusArg = process.argv.find((a) => a.startsWith('--radius='));
const city = CITY_BY_ID.get(id || '');
if (!city) {
  console.error('Unknown city. Options: ' + [...CITY_BY_ID.keys()].join(', '));
  process.exit(1);
}
const radius = radiusArg ? parseFloat(radiusArg.split('=')[1]) : city.radius;
const center: [number, number] = [city.lon, city.lat];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function viaOverpass(): Promise<any[]> {
  const q = overpassQuery(center, radius);
  for (const ep of ENDPOINTS) {
    try {
      console.log('Overpass:', ep);
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      return j.elements;
    } catch (e) {
      console.warn('  failed:', (e as Error).message);
    }
  }
  throw new Error('All Overpass endpoints failed');
}

async function viaOsmApi(): Promise<any[]> {
  const kmLat = 110.574;
  const kmLon = 111.32 * Math.cos((center[1] * Math.PI) / 180);
  const s = center[1] - radius / kmLat,
    n = center[1] + radius / kmLat;
  const w = center[0] - radius / kmLon,
    e = center[0] + radius / kmLon;
  const stepLon = 0.014,
    stepLat = 0.009;
  const els = new Map<string, any>();
  for (let lat = s; lat < n; lat += stepLat) {
    for (let lon = w; lon < e; lon += stepLon) {
      const bb = [lon, lat, Math.min(lon + stepLon, e), Math.min(lat + stepLat, n)].map((x) => x.toFixed(5)).join(',');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch('https://api.openstreetmap.org/api/0.6/map.json?bbox=' + bb, { headers: { 'User-Agent': 'citymover-fetch/0.1' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const j = await res.json();
          for (const el of j.elements) els.set(el.type + el.id, el);
          console.log('tile', bb, j.elements.length);
          break;
        } catch (err) {
          console.warn('  retry', bb, (err as Error).message);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }
  }
  return [...els.values()];
}

const elements = useOsmApi ? await viaOsmApi() : await viaOverpass();
const data = parseOsm(elements, city.id, center, radius);
mkdirSync('public/data', { recursive: true });
writeFileSync(`public/data/${city.id}.json`, JSON.stringify(data));
console.log(`Wrote public/data/${city.id}.json: ${data.nodes.length / 2} nodes, ${data.ways.length} roads, ${data.rails.length} rails, ${data.pois.length / 3} pois`);
