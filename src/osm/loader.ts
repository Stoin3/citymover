// Loads city data: IndexedDB cache -> prebaked /data/<id>.json -> Overpass API.
import { CityData, parseOsm, overpassQuery, corridorQuery } from './parse';
import { CityDef } from '../data/cities';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const DB_NAME = 'citymover';
const STORE = 'osm';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as T) ?? null);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(key: string, val: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function overpass(query: string, onStatus: (s: string) => void): Promise<any[]> {
  let lastErr: unknown = null;
  for (const ep of ENDPOINTS) {
    try {
      onStatus(`OpenStreetMap-data ophalen via ${new URL(ep).host}…`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 150_000);
      const res = await fetch(ep, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      onStatus('Data verwerken…');
      const j = await res.json();
      if (!j.elements) throw new Error('Leeg antwoord');
      return j.elements;
    } catch (e) {
      lastErr = e;
      console.warn('Overpass failed', ep, e);
    }
  }
  throw new Error('Kon OpenStreetMap niet bereiken: ' + String(lastErr));
}

export async function loadCityData(def: CityDef, onStatus: (s: string) => void): Promise<CityData> {
  const key = 'city:' + def.id + ':v1';
  onStatus('Cache controleren…');
  const cached = await idbGet<CityData>(key);
  if (cached) return cached;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${def.id}.json`);
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      onStatus('Meegeleverde kaartdata laden…');
      const d = (await res.json()) as CityData;
      await idbPut(key, d);
      return d;
    }
  } catch {
    /* not prebaked */
  }
  const center: [number, number] = [def.lon, def.lat];
  const els = await overpass(overpassQuery(center, def.radius), onStatus);
  const data = parseOsm(els, def.id, center, def.radius);
  await idbPut(key, data);
  return data;
}

export interface CorridorData {
  nodes: number[];
  ways: { n: number[]; c: number; o: number; s: number; l: number; nm?: string }[];
}

export async function loadCorridor(kind: 'rail' | 'road', a: CityDef, b: CityDef): Promise<CorridorData | null> {
  const [x, y] = [a.id, b.id].sort();
  const key = `corr:${kind}:${x}:${y}:v1`;
  const cached = await idbGet<CorridorData>(key);
  if (cached) return cached;
  try {
    const els = await overpass(corridorQuery([a.lon, a.lat], [b.lon, b.lat], kind), () => {});
    const parsed = parseOsm(els, key, [(a.lon + b.lon) / 2, (a.lat + b.lat) / 2], 10000);
    const data: CorridorData =
      kind === 'rail'
        ? { nodes: parsed.nodes, ways: parsed.rails.map((r) => ({ n: r.n, c: 0, o: 0, s: 0, l: 1 })) }
        : { nodes: parsed.nodes, ways: parsed.ways };
    await idbPut(key, data);
    return data;
  } catch (e) {
    console.warn('corridor failed', e);
    return null;
  }
}
