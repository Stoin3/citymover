// Line builder, line details, lines overview and stop panels.
import type { MapClick, PickInfo } from '../game/api';
import { MODES, MODE_LIST, ModeId, TIME_BLOCKS, blockAt } from '../config';
import type { Line, Stop } from '../sim/transit';
import type { GameUI } from './gameUI';
import { Panel, section, kv, hint } from './panel';
import { h, eur, eurCents, int, km, pct, rgb, rgbToHex, hexToRgb, modeChip, colorDot, dec1 } from './dom';
import { toast, confirmDialog } from './overlays';

const BUILD_HINT: Record<ModeId, string> = {
  bus: 'Klik op de kaart langs een weg om haltes te plaatsen. Bussen rijden mee met het autoverkeer.',
  tram: 'Trams rijden over eigen sporen langs de weg. Sporen kosten geld per kilometer.',
  metro: 'De metro rijdt ondergronds in vrijwel rechte lijnen: snel en groot, maar tunnels zijn duur.',
  train: 'Plaats stations op bestaand spoor. Treinen kunnen ook tussen steden rijden.',
  coach: 'Snelbussen rijden via snelwegen tussen steden. Zet in elke stad minstens één halte.',
  plane: 'Plaats luchthavens bij vliegvelden in verschillende steden.',
};

function lineStopsUsed(ui: GameUI, stopId: number): Line[] {
  const out: Line[] = [];
  for (const l of ui.game.lines.values()) if (l.d.stops.includes(stopId)) out.push(l);
  return out;
}

// =====================================================================
export class LineBuilderPanel extends Panel {
  key: string;
  cls = 'cm-panel-builder';
  mode: ModeId;
  stops: number[];
  editLineId: number | null;
  private created = new Set<number>();
  private committed = false;
  private errEl: HTMLElement | null = null;

  constructor(ui: GameUI, mode: ModeId, editLineId: number | null = null, initial: number[] = []) {
    super(ui);
    this.mode = mode;
    this.editLineId = editLineId;
    const line = editLineId !== null ? ui.game.lines.get(editLineId) : undefined;
    this.stops = line ? line.d.stops.slice() : initial.slice();
    this.key = `builder:${mode}:${editLineId ?? 'new'}`;
  }

  title(): Node {
    const m = MODES[this.mode];
    const line = this.editLineId !== null ? this.game.lines.get(this.editLineId) : undefined;
    return h('span', { class: 'cm-title-row' }, h('span', { class: 'cm-title-ico', style: `background:${rgb(m.color)}` }, m.icon), line ? `${line.d.name} bewerken` : `Nieuwe ${m.name.toLowerCase()}lijn`);
  }

  onOpen(): void {
    this.renderer.setMode('build', this.mode);
    this.syncDraft();
  }

  onClose(): void {
    if (!this.committed) this.cleanupStops(new Set());
    this.renderer.setDraftLine([], null);
  }

  /** remove stops placed during this draft that ended up unused */
  private cleanupStops(keep: Set<number>): void {
    for (const id of this.created) {
      if (keep.has(id) || !this.game.stops.has(id)) continue;
      if (lineStopsUsed(this.ui, id).length === 0) this.game.removeStop(id);
    }
    this.created.clear();
  }

  private syncDraft(): void {
    this.renderer.setDraftLine(this.stops.slice(), this.mode);
  }

  private changed(): void {
    this.syncDraft();
    this.rebuild();
  }

  handleClick(c: MapClick): void {
    const g = this.game;
    if (c.pick.kind === 'stop') {
      const s = g.stops.get(c.pick.stopId);
      if (s && s.d.mode === this.mode) {
        this.addId(s.d.id);
        return;
      }
    }
    const before = g.stops.size;
    const r = g.addStop(this.mode, c.x, c.y);
    if (typeof r === 'string') {
      toast(r, 'warn');
      return;
    }
    if (g.stops.size > before) this.created.add(r.d.id);
    this.addId(r.d.id);
  }

  private addId(id: number): void {
    if (this.stops[this.stops.length - 1] === id) {
      toast('Deze halte is al de laatste halte van de lijn.', 'info');
      return;
    }
    this.stops.push(id);
    this.changed();
  }

  build(body: HTMLElement): void {
    const g = this.game;
    const m = MODES[this.mode];
    body.append(hint(BUILD_HINT[this.mode] + ' Klik op een bestaande halte om die opnieuw te gebruiken.', 'info'));

    const list = h('ol', { class: 'cm-stoplist cm-stoplist-edit', style: `--c:${rgb(m.color)}` });
    this.stops.forEach((id, i) => {
      const s = g.stops.get(id);
      const name = s ? s.d.name : `Halte ${id}`;
      const move = (d: number) => {
        const j = i + d;
        if (j < 0 || j >= this.stops.length) return;
        [this.stops[i], this.stops[j]] = [this.stops[j], this.stops[i]];
        this.changed();
      };
      list.append(
        h(
          'li',
          null,
          h('span', { class: 'cm-stop-bullet' }),
          h('button', { class: 'cm-linkbtn cm-stop-name', title: 'Toon op kaart', onclick: () => s && this.renderer.flyTo(s.x, s.y, 16) }, name),
          this.created.has(id) ? h('span', { class: 'cm-tag cm-tag-small' }, 'nieuw') : null,
          h(
            'span',
            { class: 'cm-stop-actions' },
            h('button', { class: 'cm-iconbtn cm-iconbtn-s', title: 'Omhoog', 'aria-label': 'Omhoog', disabled: i === 0, onclick: () => move(-1) }, '↑'),
            h('button', { class: 'cm-iconbtn cm-iconbtn-s', title: 'Omlaag', 'aria-label': 'Omlaag', disabled: i === this.stops.length - 1, onclick: () => move(1) }, '↓'),
            h('button', { class: 'cm-iconbtn cm-iconbtn-s cm-danger', title: 'Uit lijn verwijderen', 'aria-label': 'Verwijderen', onclick: () => { this.stops.splice(i, 1); this.changed(); } }, '✕'),
          ),
        ),
      );
    });
    body.append(
      section(
        `Haltes (${this.stops.length})`,
        this.stops.length ? list : h('div', { class: 'cm-empty' }, '👆 Klik op de kaart om de eerste halte te plaatsen.'),
        this.stops.length === 1 ? h('div', { class: 'cm-muted cm-small' }, 'Nog minimaal één halte nodig.') : null,
        this.stops.length >= 2
          ? h('div', { class: 'cm-row' }, h('button', { class: 'cm-btn cm-btn-small', title: 'Volgorde van alle haltes omdraaien', onclick: () => { this.stops.reverse(); this.changed(); } }, '⇅ Omdraaien'))
          : null,
      ),
    );

    const cost = this.text(() => eur(this.stops.length ? g.lineCostEstimate(this.mode, this.stops) : 0), 'cm-big-num');
    const after = this.text(() => {
      const c = this.stops.length ? g.lineCostEstimate(this.mode, this.stops) : 0;
      return `Saldo daarna: ${eur(g.money - c)}`;
    }, 'cm-muted cm-small');
    this.bind(() => {
      const c = this.stops.length ? g.lineCostEstimate(this.mode, this.stops) : 0;
      after.classList.toggle('cm-neg', g.money - c < 0);
    });
    body.append(
      section(
        'Geschatte kosten',
        h('div', { class: 'cm-cost-box' }, cost, after),
        h('div', { class: 'cm-muted cm-small' }, `Nieuwe halte: ${eur(m.stopCost)}${m.infraPerKm ? ` · infrastructuur: ${eur(m.infraPerKm)}/km` : ''} · voertuig: ${eur(m.vehiclePrice)} (apart te kopen)`),
      ),
    );

    this.errEl = h('div', { class: 'cm-error', role: 'alert' });
    const okLabel = this.editLineId !== null ? '✓ Wijzigingen opslaan' : '✓ Lijn aanleggen';
    body.append(
      this.errEl,
      h(
        'div',
        { class: 'cm-row cm-row-stretch cm-sticky-actions' },
        h('button', { class: 'cm-btn', onclick: () => this.ui.closePanel(this) }, 'Annuleren'),
        h('button', { class: 'cm-btn cm-btn-primary', disabled: this.stops.length < 2, title: this.stops.length < 2 ? 'Plaats minimaal 2 haltes' : okLabel, onclick: () => this.commit() }, okLabel),
      ),
    );
  }

  private commit(): void {
    const g = this.game;
    const showErr = (e: string) => {
      if (this.errEl) this.errEl.textContent = e;
      toast(e, 'bad');
    };
    if (this.stops.length < 2) return showErr('Een lijn heeft minimaal 2 haltes nodig.');
    let lineId: number;
    if (this.editLineId !== null) {
      const err = g.setLineStops(this.editLineId, this.stops.slice());
      if (err) return showErr(err);
      lineId = this.editLineId;
      toast('Lijn aangepast.', 'good');
    } else {
      const l = g.createLine(this.mode);
      if (typeof l === 'string') return showErr(l);
      const err = g.setLineStops(l.d.id, this.stops.slice());
      if (err) {
        g.deleteLine(l.d.id);
        return showErr(err);
      }
      lineId = l.d.id;
      const line = g.lines.get(lineId);
      toast(`${line?.d.name ?? 'Lijn'} aangelegd! Koop nu voertuigen om de lijn te laten rijden.`, 'good');
    }
    this.committed = true;
    this.cleanupStops(new Set(this.stops));
    this.ui.openLine(lineId);
  }
}

// =====================================================================
export class LinePanel extends Panel {
  key: string;
  lineId: number;
  constructor(ui: GameUI, lineId: number) {
    super(ui);
    this.lineId = lineId;
    this.key = `line:${lineId}`;
  }
  get line(): Line | undefined {
    return this.game.lines.get(this.lineId);
  }
  isValid(): boolean {
    return this.game.lines.has(this.lineId);
  }
  selection(): PickInfo {
    return { kind: 'line', lineId: this.lineId };
  }
  title(): Node {
    const l = this.line!;
    return h('span', { class: 'cm-title-row' }, h('span', { class: 'cm-title-ico', style: `background:${rgb(l.d.color)}` }, l.def.icon), l.d.name);
  }

  build(body: HTMLElement): void {
    const g = this.game;
    const l = this.line;
    if (!l) return;
    const d = l.d;
    const m = MODES[d.mode];

    // --- name + colour
    const name = h('input', { class: 'cm-input', value: d.name, maxLength: 40, 'aria-label': 'Naam van de lijn' });
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (v) g.updateLine(d.id, { name: v });
      this.dirty = true;
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    const color = h('input', { type: 'color', class: 'cm-color', value: rgbToHex(d.color), title: 'Lijnkleur', 'aria-label': 'Lijnkleur' });
    color.addEventListener('change', () => {
      g.updateLine(d.id, { color: hexToRgb(color.value) });
      this.dirty = true;
    });
    body.append(h('div', { class: 'cm-row cm-name-row' }, name, color));

    // --- status
    const status = h('div', { class: 'cm-hint' });
    this.bind(() => {
      const ln = this.line;
      if (!ln) return;
      let txt: string, kind: string;
      const need = safeNeeded(ln);
      if (!ln.valid) {
        kind = ln.pendingCorridor ? 'info' : 'bad';
        txt = ln.pendingCorridor ? '⏳ Route tussen de steden wordt geladen…' : `⛔ ${ln.error || 'Deze lijn heeft geen geldige route.'}`;
      } else if (ln.d.fleet === 0) {
        kind = 'warn';
        txt = '⚠️ Geen voertuigen — koop voertuigen zodat de lijn gaat rijden.';
      } else if (ln.shortage > 0 || ln.d.fleet < need) {
        kind = 'warn';
        txt = `⚠️ Te weinig voertuigen voor de dienstregeling: ${need} nodig, ${ln.d.fleet} in bezit.`;
      } else {
        kind = 'good';
        txt = `✅ In dienst — ${ln.active} ${ln.active === 1 ? 'voertuig' : 'voertuigen'} onderweg.`;
      }
      status.className = `cm-hint cm-hint-${kind}`;
      if (status.textContent !== txt) status.textContent = txt;
    });
    body.append(status);

    // --- route
    const stopsList = h('ol', { class: 'cm-stoplist', style: `--c:${rgb(d.color)}` });
    for (const id of d.stops) {
      const s = g.stops.get(id);
      stopsList.append(
        h(
          'li',
          null,
          h('span', { class: 'cm-stop-bullet' }),
          h('button', { class: 'cm-linkbtn cm-stop-name', title: 'Open halte', onclick: () => s && this.ui.openStop(id) }, s?.d.name ?? `Halte ${id}`),
          s ? this.text(() => (s.waiting > 0 ? `${int(s.waiting)} wachtend` : ''), 'cm-muted cm-small') : null,
        ),
      );
    }
    const tripMin = () => l.dirs[0].segTime.reduce((a, b) => a + b, 0) / 60;
    body.append(
      section(
        'Route',
        h('div', { class: 'cm-kv-grid' }, kv('Vervoer', modeChip(d.mode)), kv('Haltes', String(d.stops.length)), kv('Lengte', this.text(() => km(l.dirs[0].length))), kv('Rijtijd', this.text(() => (l.valid ? `${Math.round(tripMin())} min` : '—')), 'Enkele reis, inclusief stops')),
        h('details', { class: 'cm-details' }, h('summary', null, 'Haltes tonen'), stopsList),
        h('div', { class: 'cm-row' }, h('button', { class: 'cm-btn cm-btn-small', title: 'Haltes toevoegen, verwijderen of verplaatsen', onclick: () => this.ui.startBuilder(d.mode, d.id) }, '✏️ Route bewerken')),
      ),
    );

    // --- fares
    const fareBase = h('input', { type: 'number', class: 'cm-input cm-input-num', min: 0, max: 100, step: 0.05, value: d.fareBase.toFixed(2), 'aria-label': 'Basistarief' });
    const fareKm = h('input', { type: 'number', class: 'cm-input cm-input-num', min: 0, max: 5, step: 0.01, value: d.fareKm.toFixed(2), 'aria-label': 'Kilometertarief' });
    const applyFare = () => {
      const b = Math.max(0, Math.min(100, Number(fareBase.value) || 0));
      const k = Math.max(0, Math.min(5, Number(fareKm.value) || 0));
      g.updateLine(d.id, { fareBase: b, fareKm: k });
    };
    fareBase.addEventListener('change', applyFare);
    fareKm.addEventListener('change', applyFare);
    this.syncValue(fareBase, () => (this.line?.d.fareBase ?? 0).toFixed(2));
    this.syncValue(fareKm, () => (this.line?.d.fareKm ?? 0).toFixed(2));
    const exKm = m.intercity ? 40 : 4;
    const example = this.text(() => `Voorbeeld: een rit van ${exKm} km kost ${eurCents(l.fareFor(exKm))}.`, 'cm-small cm-muted', 'div');
    const def = h('button', { class: 'cm-linkbtn cm-small', onclick: () => { g.updateLine(d.id, { fareBase: m.defaultFareBase, fareKm: m.defaultFareKm }); this.rebuild(); } }, 'standaard herstellen');
    body.append(
      section(
        'Ticketprijs',
        h(
          'div',
          { class: 'cm-fare-grid' },
          h('label', null, 'Basistarief', h('div', { class: 'cm-input-unit' }, h('span', null, '€'), fareBase)),
          h('label', null, 'Kilometertarief', h('div', { class: 'cm-input-unit' }, h('span', null, '€'), fareKm, h('span', null, '/km'))),
        ),
        example,
        h('div', { class: 'cm-small cm-hint-inline' }, '💡 Hogere prijs = minder reizigers. ', def),
      ),
    );

    // --- timetable
    const tt = h('div', { class: 'cm-timetable' });
    const step = d.mode === 'plane' ? 0.5 : 1;
    TIME_BLOCKS.forEach((b, i) => {
      const inp = h('input', { type: 'number', class: 'cm-input cm-input-num', min: 0, max: 60, step, value: String(d.freq[i] ?? 0), 'aria-label': `Voertuigen per uur ${b.name}` });
      inp.addEventListener('change', () => {
        const ln = this.line;
        if (!ln) return;
        const f = ln.d.freq.slice();
        f[i] = Math.max(0, Math.min(60, Math.round((Number(inp.value) || 0) / step) * step));
        g.updateLine(d.id, { freq: f });
      });
      this.syncValue(inp, () => String(this.line?.d.freq[i] ?? 0));
      const headway = this.text(() => {
        const f = this.line?.d.freq[i] ?? 0;
        return f > 0 ? `elke ${dec1(60 / f)} min` : 'geen dienst';
      }, 'cm-muted cm-small');
      const peak = b.id === 'amPeak' || b.id === 'pmPeak';
      const row = h(
        'div',
        { class: `cm-tt-row ${peak ? 'cm-tt-peak' : ''}` },
        h('div', null, h('b', null, b.name), h('div', { class: 'cm-muted cm-small' }, `${String(b.from).padStart(2, '0')}:00–${String(b.to).padStart(2, '0')}:00`)),
        inp,
        headway,
      );
      this.bind(() => row.classList.toggle('cm-tt-now', blockAt(g.hour()) === i));
      tt.append(row);
    });
    body.append(
      section(
        'Dienstregeling',
        h('div', { class: 'cm-small cm-muted' }, 'Hoeveel voertuigen per uur (per richting) rijden er op welk moment? 0 = geen dienst.'),
        h('div', { class: 'cm-tt-head cm-small cm-muted' }, h('span', null, 'Dagdeel'), h('span', null, 'voertuigen per uur'), h('span', null, 'interval')),
        tt,
      ),
    );

    // --- fleet
    const need = this.text(() => String(safeNeeded(this.line!)));
    const buy = (n: number) => {
      const e = g.buyVehicles(d.id, n);
      if (e) toast(e, 'bad');
    };
    const sell = (n: number) => {
      const e = g.sellVehicles(d.id, n);
      if (e) toast(e, 'bad');
    };
    const shortBtn = h('button', { class: 'cm-btn cm-btn-small cm-btn-primary', onclick: () => { const ln = this.line!; buy(Math.max(1, safeNeeded(ln) - ln.d.fleet)); } });
    this.bind(() => {
      const ln = this.line!;
      const s = safeNeeded(ln) - ln.d.fleet;
      shortBtn.hidden = s <= 0;
      shortBtn.textContent = `+ ${s} (tekort) · ${eur(s * m.vehiclePrice)}`;
    });
    body.append(
      section(
        'Voertuigen',
        h(
          'div',
          { class: 'cm-fleet' },
          h('div', { class: 'cm-fleet-stat' }, this.text(() => String(this.line?.d.fleet ?? 0), 'cm-big-num'), h('span', null, 'in bezit')),
          h('div', { class: 'cm-fleet-stat' }, this.text(() => String(this.line?.active ?? 0), 'cm-big-num'), h('span', null, 'onderweg')),
          h('div', { class: 'cm-fleet-stat' }, h('span', { class: 'cm-big-num' }, need), h('span', null, 'nodig in spits')),
        ),
        h(
          'div',
          { class: 'cm-row cm-row-wrap' },
          h('button', { class: 'cm-btn cm-btn-small', title: `Koop 1 ${m.name.toLowerCase()} voor ${eur(m.vehiclePrice)}`, onclick: () => buy(1) }, `+1 kopen · ${eur(m.vehiclePrice)}`),
          shortBtn,
          h('button', { class: 'cm-btn cm-btn-small', title: 'Verkoop 1 voertuig', onclick: () => sell(1) }, '−1 verkopen'),
        ),
        h('div', { class: 'cm-small cm-muted' }, `Capaciteit ${m.capacity} reizigers · ${eur(m.opCostHour)} per uur in dienst + ${eurCents(m.opCostKm)}/km`),
      ),
    );

    // --- stats
    const row = (label: string, today: () => string, yest: () => string, cls?: () => string) => {
      const t = this.text(today, '', 'td');
      const y = this.text(yest, 'cm-muted', 'td');
      if (cls) this.bind(() => { t.className = cls(); });
      return h('tr', null, h('th', null, label), t, y);
    };
    const crowdFill = h('div', { class: 'cm-bar-fill' });
    this.bind(() => {
      const c = this.line?.crowding ?? 0;
      crowdFill.style.width = `${Math.min(100, c * 100)}%`;
      crowdFill.dataset.level = c > 0.95 ? 'bad' : c > 0.75 ? 'warn' : 'good';
    });
    const ln = () => this.line!;
    body.append(
      section(
        'Resultaten',
        h(
          'table',
          { class: 'cm-table' },
          h('thead', null, h('tr', null, h('th'), h('th', null, 'Vandaag'), h('th', null, 'Gisteren'))),
          h(
            'tbody',
            null,
            row('Reizigers', () => int(ln().paxToday), () => int(ln().paxYesterday)),
            row('Opbrengst', () => eur(ln().revenueToday), () => eur(ln().revenueYesterday)),
            row('Kosten', () => eur(ln().costToday), () => eur(ln().costYesterday)),
            row('Resultaat', () => eur(ln().revenueToday - ln().costToday), () => eur(ln().revenueYesterday - ln().costYesterday), () => (ln().revenueToday - ln().costToday < 0 ? 'cm-neg' : 'cm-pos')),
          ),
        ),
        h('div', { class: 'cm-kv' }, h('span', { class: 'cm-kv-k' }, 'Bezetting'), this.text(() => pct(ln().crowding), 'cm-kv-v')),
        h('div', { class: 'cm-bar', title: 'Gemiddelde bezetting van de voertuigen. Boven 95% blijven reizigers staan.' }, crowdFill),
      ),
    );

    body.append(
      h(
        'div',
        { class: 'cm-row cm-row-end cm-danger-zone' },
        h(
          'button',
          {
            class: 'cm-btn cm-btn-danger cm-btn-small',
            onclick: async () => {
              const ok = await confirmDialog(`${d.name} verwijderen?`, 'De lijn wordt opgeheven. Voertuigen worden verkocht; haltes blijven staan.', 'Verwijderen', true);
              if (ok) {
                g.deleteLine(d.id);
                this.ui.closePanel(this);
                toast(`${d.name} is opgeheven.`, 'info');
              }
            },
          },
          '🗑 Lijn verwijderen',
        ),
      ),
    );
  }
}

function safeNeeded(l: Line): number {
  try {
    const n = l.vehiclesNeeded();
    return isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// =====================================================================
export class LinesListPanel extends Panel {
  key = 'lines';
  title(): string {
    return '🗺️ Lijnen';
  }
  build(body: HTMLElement): void {
    const g = this.game;
    const lines = [...g.lines.values()];
    if (!lines.length) {
      body.append(h('div', { class: 'cm-empty' }, 'Je hebt nog geen lijnen. Kies links een vervoerswijze (bijvoorbeeld 🚌 Bus) en klik haltes op de kaart.'));
      const b = h('button', { class: 'cm-btn cm-btn-primary', onclick: () => this.ui.startBuilder('bus') }, '🚌 Eerste buslijn aanleggen');
      body.append(h('div', { class: 'cm-row cm-row-center' }, b));
      return;
    }
    const totals = this.text(() => {
      let pax = 0,
        profit = 0;
      for (const l of g.lines.values()) {
        pax += l.paxToday;
        profit += l.revenueToday - l.costToday;
      }
      return `${lines.length} lijnen · ${int(pax)} reizigers vandaag · resultaat ${eur(profit)}`;
    }, 'cm-muted cm-small', 'div');
    body.append(totals);
    for (const m of MODE_LIST) {
      const ls = lines.filter((l) => l.d.mode === m.id).sort((a, b) => a.d.name.localeCompare(b.d.name, 'nl', { numeric: true }));
      if (!ls.length) continue;
      const list = h('div', { class: 'cm-linelist' });
      for (const l of ls) {
        const profit = this.text(() => eur(l.revenueToday - l.costToday), 'cm-ll-profit');
        this.bind(() => profit.classList.toggle('cm-neg', l.revenueToday - l.costToday < 0));
        const warn = this.text(() => (!l.valid ? '⛔' : l.d.fleet === 0 || l.shortage > 0 ? '⚠️' : ''), 'cm-ll-warn');
        list.append(
          h(
            'button',
            { class: 'cm-ll-row', title: `Open ${l.d.name}`, onclick: () => this.ui.openLine(l.d.id) },
            colorDot(l.d.color),
            h('span', { class: 'cm-ll-name' }, l.d.name),
            warn,
            this.text(() => `${int(l.paxToday)} 🧍`, 'cm-ll-pax'),
            profit,
          ),
        );
      }
      body.append(section(`${m.icon} ${m.name} (${ls.length})`, list));
    }
  }
  onChanged(what: string): void {
    if (what === 'lines' || what === 'all') this.dirty = true;
  }
}

// =====================================================================
export class StopPanel extends Panel {
  key: string;
  stopId: number;
  constructor(ui: GameUI, stopId: number) {
    super(ui);
    this.stopId = stopId;
    this.key = `stop:${stopId}`;
  }
  get stop(): Stop | undefined {
    return this.game.stops.get(this.stopId);
  }
  isValid(): boolean {
    return this.game.stops.has(this.stopId);
  }
  selection(): PickInfo {
    return { kind: 'stop', stopId: this.stopId };
  }
  title(): Node {
    const s = this.stop!;
    return h('span', { class: 'cm-title-row' }, h('span', { class: 'cm-title-ico', style: `background:${rgb(MODES[s.d.mode].color)}` }, MODES[s.d.mode].icon), s.d.name);
  }
  build(body: HTMLElement): void {
    const g = this.game;
    const s = this.stop;
    if (!s) return;
    const name = h('input', { class: 'cm-input', value: s.d.name, maxLength: 48, 'aria-label': 'Naam van de halte' });
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (v) g.renameStop(s.d.id, v);
      this.dirty = true;
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    const city = g.cityById(s.d.city);
    body.append(
      h('div', { class: 'cm-row cm-name-row' }, name),
      h(
        'div',
        { class: 'cm-kv-grid' },
        kv('Type', modeChip(s.d.mode, s.d.mode === 'train' ? 'Station' : s.d.mode === 'plane' ? 'Luchthaven' : `${MODES[s.d.mode].name}halte`)),
        kv('Stad', city?.def.name ?? s.d.city),
        kv('Wachtend', this.text(() => int(this.stop?.waiting ?? 0))),
        kv('Ingestapt vandaag', this.text(() => int(this.stop?.boardedToday ?? 0))),
      ),
    );
    const lines = lineStopsUsed(this.ui, s.d.id);
    const list = h('div', { class: 'cm-linelist' });
    for (const l of lines)
      list.append(h('button', { class: 'cm-ll-row', onclick: () => this.ui.openLine(l.d.id) }, colorDot(l.d.color), h('span', { class: 'cm-ll-name' }, l.d.name), this.text(() => `${int(l.paxToday)} 🧍`, 'cm-ll-pax')));
    body.append(section(`Lijnen via deze halte (${lines.length})`, lines.length ? list : h('div', { class: 'cm-empty' }, 'Nog geen lijn stopt hier.')));
    body.append(
      h(
        'div',
        { class: 'cm-row cm-row-wrap' },
        g.modeUnlocked(s.d.mode) ? h('button', { class: 'cm-btn cm-btn-small', onclick: () => this.ui.startBuilder(s.d.mode, null, [s.d.id]) }, '➕ Nieuwe lijn vanaf hier') : null,
        h('button', { class: 'cm-btn cm-btn-small', onclick: () => this.renderer.flyTo(s.x, s.y, 16) }, '🎯 Centreren'),
        h(
          'button',
          {
            class: 'cm-btn cm-btn-small cm-btn-danger',
            onclick: async () => {
              const msg = lines.length ? `Deze halte wordt ook uit ${lines.length} ${lines.length === 1 ? 'lijn' : 'lijnen'} verwijderd.` : 'De halte wordt gesloopt.';
              if (!(await confirmDialog(`${s.d.name} verwijderen?`, msg, 'Verwijderen', true))) return;
              const e = g.removeStop(s.d.id);
              if (e) toast(e, 'bad');
              else this.ui.closePanel(this);
            },
          },
          '🗑 Halte verwijderen',
        ),
      ),
    );
  }
  onChanged(what: string): void {
    if (what !== 'roads' && what !== 'highways') this.dirty = true;
  }
}
