// Finance, statistics and settings panels.
import type { Ledger, Overlay } from '../game/api';
import { HOURLY_DEMAND, TIME_BLOCKS } from '../config';
import type { GameUI } from './gameUI';
import { Panel, section, kv } from './panel';
import { modalSplit } from './regionPanel';
import { h, eur, int, clear, lineLabel } from './dom';

export function ledgerResult(l: Ledger): number {
  return l.fares + l.subsidy - l.operations - l.construction - l.vehicles - l.accidents;
}

// =====================================================================
export class FinancePanel extends Panel {
  key = 'finance';
  title(): string {
    return '📊 Financiën';
  }
  build(body: HTMLElement): void {
    const g = this.game;
    const money = this.text(() => eur(g.money), 'cm-big-num');
    this.bind(() => money.classList.toggle('cm-neg', g.money < 0));
    body.append(h('div', { class: 'cm-cost-box' }, h('span', { class: 'cm-muted cm-small' }, 'Saldo'), money));
    const rows: [string, (l: Ledger) => number, string][] = [
      ['Kaartverkoop', (l) => l.fares, 'Opbrengst van verkochte kaartjes'],
      ['Subsidie gemeente', (l) => l.subsidy, 'Bijdrage van de gemeente voor goed openbaar vervoer (hangt af van je reputatie)'],
      ['Exploitatie', (l) => -l.operations, 'Personeel, energie en onderhoud van voertuigen in dienst'],
      ['Bouw', (l) => -l.construction, 'Haltes, sporen, tunnels en aanpassingen aan wegen'],
      ['Voertuigen', (l) => -l.vehicles, 'Aankoop min verkoop van voertuigen'],
      ['Ongelukken', (l) => -l.accidents, 'Schade en boetes door verkeersongelukken'],
    ];
    const cell = (fn: () => number, cls = '') => {
      const td = this.text(() => eur(fn()), cls, 'td');
      this.bind(() => td.classList.toggle('cm-neg', fn() < 0));
      return td;
    };
    body.append(
      section(
        'Inkomsten & uitgaven',
        h(
          'table',
          { class: 'cm-table cm-table-fin' },
          h('thead', null, h('tr', null, h('th'), h('th', null, 'Vandaag'), h('th', null, 'Gisteren'))),
          h(
            'tbody',
            null,
            rows.map(([label, f, tip]) => h('tr', { title: tip }, h('th', null, label), cell(() => f(g.ledgerToday)), cell(() => f(g.ledgerYesterday), 'cm-muted'))),
          ),
          h('tfoot', null, h('tr', null, h('th', null, 'Resultaat'), cell(() => ledgerResult(g.ledgerToday), 'cm-pos'), cell(() => ledgerResult(g.ledgerYesterday), 'cm-pos'))),
        ),
      ),
    );
    // per line
    const tbody = h('tbody');
    const lineTable = h('table', { class: 'cm-table' }, h('thead', null, h('tr', null, h('th', null, 'Lijn'), h('th', null, 'Opbrengst'), h('th', null, 'Kosten'), h('th', null, 'Resultaat'))), tbody);
    let sig = '';
    this.bind(() => {
      const ls = [...g.lines.values()].sort((a, b) => b.revenueToday - b.costToday - (a.revenueToday - a.costToday));
      const s = ls.map((l) => `${l.d.id}:${Math.round(l.revenueToday)}:${Math.round(l.costToday)}:${l.d.name}`).join('|');
      if (s === sig) return;
      sig = s;
      clear(tbody);
      for (const l of ls) {
        const p = l.revenueToday - l.costToday;
        tbody.append(
          h(
            'tr',
            { class: 'cm-clickable', onclick: () => this.ui.openLine(l.d.id), title: `Open ${lineLabel(l.d)}` },
            h('th', null, h('span', { class: 'cm-dot', style: `background:rgb(${l.d.color})` }), ' ', lineLabel(l.d)),
            h('td', null, eur(l.revenueToday)),
            h('td', null, eur(l.costToday)),
            h('td', { class: p < 0 ? 'cm-neg' : 'cm-pos' }, eur(p)),
          ),
        );
      }
      if (!ls.length) tbody.append(h('tr', null, h('td', { colSpan: 4, class: 'cm-muted' }, 'Nog geen lijnen.')));
    });
    body.append(section('Per lijn (vandaag)', lineTable));
  }
}

// =====================================================================
export class StatsPanel extends Panel {
  key = 'stats';
  cityIdx = 0;
  title(): string {
    return '📈 Statistieken';
  }
  build(body: HTMLElement): void {
    const g = this.game;
    if (this.cityIdx >= g.cities.length) this.cityIdx = 0;
    if (g.cities.length > 1) {
      const sel = h('select', { class: 'cm-input', 'aria-label': 'Stad' }, g.cities.map((c, i) => h('option', { value: String(i), selected: i === this.cityIdx }, c.def.name)));
      sel.addEventListener('change', () => {
        this.cityIdx = Number(sel.value);
        sel.blur();
        this.rebuild();
      });
      body.append(sel);
    }
    const city = () => g.cities[this.cityIdx];
    const chart = h('div', { class: 'cm-chart' });
    let sig = '';
    this.bind(() => {
      const c = city();
      if (!c) return;
      const hr = Math.floor(g.hour());
      const s = c.hourly.map((v) => Math.round(v)).join(',') + '|' + hr;
      if (s === sig) return;
      sig = s;
      clear(chart);
      chart.append(hourlyChart(c.hourly, hr));
    });
    body.append(
      section(
        'OV-reizen per uur (vandaag)',
        chart,
        h('div', { class: 'cm-chart-legend cm-small' }, h('span', null, h('i', { class: 'cm-lg-peak' }), 'Spits'), h('span', null, h('i', { class: 'cm-lg-off' }), 'Dal / nacht'), h('span', null, h('i', { class: 'cm-lg-demand' }), 'Typisch reispatroon')),
        h('div', { class: 'cm-small cm-muted' }, 'In de ochtendspits (7–9 uur) en avondspits (16–19 uur) wil iedereen tegelijk reizen. Zet dan extra voertuigen in via de dienstregeling van je lijnen.'),
      ),
    );
    body.append(section('Vervoerswijzen vandaag', modalSplit(() => city().stats, this)), section('Vervoerswijzen gisteren', modalSplit(() => city().statsYesterday, this)));
    body.append(
      section(
        'Totalen',
        h(
          'div',
          { class: 'cm-kv-grid' },
          kv('Ritten vandaag', this.text(() => int(city().stats.trips))),
          kv('Met jouw OV', this.text(() => int(city().stats.pt))),
          kv('Aangekomen', this.text(() => int(city().stats.delivered))),
          kv('OV niet mogelijk', this.text(() => int(city().stats.ptFailed)), 'Mensen die OV wilden nemen maar geen geschikte verbinding vonden'),
          kv('Ongelukken', this.text(() => int(city().stats.accidents))),
          kv('Totaal vervoerd', this.text(() => int(g.totalDelivered)), 'Alle reizigers sinds het begin van het spel'),
        ),
      ),
    );
  }
}

function hourlyChart(hourly: number[], nowHour: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 340,
    H = 150,
    padL = 30,
    padB = 20,
    padT = 8;
  const max = Math.max(1, ...hourly);
  const nice = niceMax(max);
  const bw = (W - padL - 4) / 24;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / nice);
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'cm-chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Staafdiagram OV-reizen per uur');
  const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  // peak bands
  for (const b of TIME_BLOCKS) {
    if (b.id !== 'amPeak' && b.id !== 'pmPeak') continue;
    el('rect', { x: padL + b.from * bw, y: padT, width: (b.to - b.from) * bw, height: H - padT - padB, class: 'cm-ch-band' });
  }
  // grid
  for (const f of [0, 0.5, 1]) {
    const v = nice * f;
    el('line', { x1: padL, x2: W - 4, y1: y(v), y2: y(v), class: 'cm-ch-grid' });
    el('text', { x: padL - 4, y: y(v) + 3, class: 'cm-ch-ylab', 'text-anchor': 'end' }, int(v));
  }
  const isPeak = (hr: number) => TIME_BLOCKS.some((b) => (b.id === 'amPeak' || b.id === 'pmPeak') && hr >= b.from && hr < b.to);
  for (let i = 0; i < 24; i++) {
    const v = hourly[i] || 0;
    const top = y(v);
    const hgt = Math.max(0, H - padB - top);
    const x = padL + i * bw + 1;
    const w = bw - 2;
    const r = Math.min(3, w / 2, hgt);
    const path = hgt > 0 ? `M${x} ${H - padB} V${top + r} Q${x} ${top} ${x + r} ${top} H${x + w - r} Q${x + w} ${top} ${x + w} ${top + r} V${H - padB} Z` : '';
    const bar = el('path', { d: path, class: `cm-ch-bar ${isPeak(i) ? 'cm-ch-peak' : ''} ${i === nowHour ? 'cm-ch-now' : ''} ${i > nowHour ? 'cm-ch-future' : ''}` });
    void bar;
    const hit = el('rect', { x: padL + i * bw, y: padT, width: bw, height: H - padT - padB, class: 'cm-ch-hit' });
    const t = document.createElementNS(ns, 'title');
    t.textContent = `${String(i).padStart(2, '0')}:00–${String(i + 1).padStart(2, '0')}:00 — ${int(v)} reizen${isPeak(i) ? ' (spits)' : ''}`;
    hit.appendChild(t);
  }
  // typical demand profile, scaled to today's total
  // scale so that the profile matches the hours played so far today
  let seen = 0,
    expect = 0;
  for (let i = 0; i <= nowHour && i < 24; i++) {
    seen += hourly[i] || 0;
    expect += HOURLY_DEMAND[i];
  }
  const dMax = Math.max(...HOURLY_DEMAND);
  const scale = seen > 0 && expect > 0 ? seen / expect : (nice * 0.8) / dMax;
  const pts = HOURLY_DEMAND.map((d, i) => `${padL + (i + 0.5) * bw},${y(Math.min(nice, d * scale))}`).join(' ');
  el('polyline', { points: pts, class: 'cm-ch-demand' });
  for (let i = 0; i <= 24; i += 3) el('text', { x: padL + i * bw, y: H - 5, class: 'cm-ch-xlab', 'text-anchor': 'middle' }, `${i}`);
  el('line', { x1: padL, x2: W - 4, y1: H - padB, y2: H - padB, class: 'cm-ch-axis' });
  return svg;
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

// =====================================================================
export const OVERLAYS: { id: Overlay; name: string; desc: string }[] = [
  { id: 'none', name: 'Geen', desc: 'Gewone kaart' },
  { id: 'congestion', name: 'Congestie', desc: 'Drukte op wegen: groen = vrij, rood = file' },
  { id: 'safety', name: 'Veiligheid', desc: 'Gevaarlijke wegen en kruispunten, recente ongelukken' },
  { id: 'demand', name: 'Vraag', desc: 'Waar wonen en werken mensen — goede plekken voor haltes' },
];

export class SettingsPanel extends Panel {
  key = 'settings';
  title(): string {
    return '⚙️ Instellingen';
  }
  build(body: HTMLElement): void {
    const g = this.game;
    const val = h('b', null, int(g.maxEntities));
    const range = h('input', { type: 'range', class: 'cm-range', min: 2000, max: 40000, step: 1000, value: String(g.maxEntities), 'aria-label': 'Maximaal aantal voertuigen en fietsers' });
    range.addEventListener('input', () => {
      val.textContent = int(Number(range.value));
      this.ui.setMaxEntities(Number(range.value));
    });
    body.append(
      section(
        'Prestaties',
        h('label', { class: 'cm-kv' }, h('span', { class: 'cm-kv-k' }, 'Max. auto’s en fietsers per stad'), val),
        range,
        h('div', { class: 'cm-range-labels cm-small cm-muted' }, h('span', null, '2.000 · snel'), h('span', null, '40.000 · druk')),
        h('div', { class: 'cm-small cm-muted' }, 'Minder verkeer op de kaart maakt het spel sneller op tragere computers. De simulatie zelf blijft kloppen.'),
      ),
    );
    const ov = h('div', { class: 'cm-radio-list', role: 'radiogroup', 'aria-label': 'Kaartlaag' });
    for (const o of OVERLAYS) {
      const inp = h('input', { type: 'radio', name: 'cm-overlay', value: o.id, checked: this.ui.overlay === o.id });
      inp.addEventListener('change', () => this.ui.setOverlay(o.id));
      ov.append(h('label', { class: 'cm-radio' }, inp, h('span', null, h('b', null, o.name), h('span', { class: 'cm-small cm-muted' }, o.desc))));
    }
    body.append(section('Kaartlaag', ov));
    body.append(
      section(
        'Sneltoetsen',
        h(
          'div',
          { class: 'cm-keys' },
          [
            ['Spatie', 'Pauze / hervatten'],
            ['1 – 4', 'Snelheid 1×, 3×, 10×, 30×'],
            ['Esc', 'Paneel sluiten / bouwen annuleren'],
            ['B', 'Buslijn aanleggen'],
            ['R', 'Wegen bewerken'],
            ['V', 'Bekijken'],
          ].map(([k, d]) => h('div', null, h('kbd', null, k), h('span', null, d))),
        ),
        h('div', { class: 'cm-row' }, h('button', { class: 'cm-btn cm-btn-small', onclick: () => this.ui.showHelp() }, '❓ Uitleg opnieuw tonen')),
      ),
    );
    body.append(section('Opslaan', h('div', { class: 'cm-small cm-muted' }, this.ui.backend.isCloud() ? 'Je spel wordt elke minuut en aan het einde van elke speldag in de cloud opgeslagen.' : 'Je spel wordt elke minuut en aan het einde van elke speldag lokaal in deze browser opgeslagen.'), h('div', { class: 'cm-row' }, h('button', { class: 'cm-btn cm-btn-small', onclick: () => this.ui.save(true) }, '💾 Nu opslaan'))));
    body.append(h('div', { class: 'cm-small cm-muted cm-center' }, 'Kaartgegevens © OpenStreetMap-bijdragers (ODbL)'));
  }
}
