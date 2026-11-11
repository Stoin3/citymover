import { readFileSync } from 'node:fs';
import { createGameFromData } from '../src/game/game.ts';
import type { CityData } from '../src/osm/parse.ts';
const data = JSON.parse(readFileSync(new URL('../public/data/delft.json', import.meta.url), 'utf8')) as CityData;
const g = createGameFromData(null, [data], 'delft');
g.speed = 30;
while (g.time < 16.5 * 60) g.tick(1 / 60);
for (const sp of [1, 10]) {
  g.speed = sp;
  const ts: number[] = [];
  for (let i = 0; i < (sp === 1 ? 3600 : 1200); i++) {
    const t = performance.now(); const m0 = Math.floor(g.time);
    g.tick(1 / 60);
    const d = performance.now() - t;
    if (d > 6) console.log('spike', sp, d.toFixed(1), 'ms at', (g.time / 60 % 24).toFixed(3), 'minute crossed', Math.floor(g.time) !== m0, 'trees queued', g.cities[0].router.pendingBuilds);
  }
}
