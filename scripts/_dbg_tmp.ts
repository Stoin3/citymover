import { readFileSync } from 'node:fs';
import { createGameFromData } from '../src/game/game.ts';
import type { CityData } from '../src/osm/parse.ts';
const data = JSON.parse(readFileSync(new URL('../public/data/delft.json', import.meta.url), 'utf8')) as CityData;
const g = createGameFromData(null, [data], 'delft');
const c = g.cities[0];
const T = c.traffic;
const za = c.zones[0], zb = c.zones[30];
const t = c.router.buildNow(zb.anchors[0], 1, 0)!;
const p = c.router.path(za.anchors[0], t)!;
let L = 0; for (const a of p) L += c.G.eLen[a >> 1];
console.log('path arcs', p.length, 'len', L.toFixed(0));
c.spawnTraffic(p, true);
const i = T.count - 1;
let time = 0, steps = 0;
while (T.alive[i] && steps < 100000) { c.tickTraffic(3, 0, () => {}, false); time += 3; steps++; if (steps % 20 === 0) console.log(time, T.arcIdx[i], T.s[i].toFixed(1), T.wait[i].toFixed(2)); }
console.log('took', time, 's, expected', (L / 4.4).toFixed(0));
