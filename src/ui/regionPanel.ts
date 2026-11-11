// Cities & region: unlocked cities, cities to unlock, highways.
import type { PickInfo } from '../game/api';
import { CITY_BY_ID, CityDef, distanceKm, neighbours } from '../data/cities';
import { FEATURES, maxCities } from '../config';
import type { CitySim, CityStats } from '../sim/city';
import type { GameUI } from './gameUI';
import { Panel, section, kv, hint, lockBadge } from './panel';
import { h, eur, int, pct } from './dom';
import { toast } from './overlays';

export const SPLIT_COLORS = { walk: '#9aa4b8', bike: '#52b788', car: '#ef8354', pt: '#4cc9f0' };

/** stacked modal split bar walk/bike/car/OV */
export function modalSplit(stats: () => CityStats, p: Panel): HTMLElement {
  const segs = (['walk', 'bike', 'car', 'pt'] as const).map((k) => h('div', { class: 'cm-split-seg', style: `background:${SPLIT_COLORS[k]}` }));
  const legendVals = (['walk', 'bike', 'car', 'pt'] as const).map(() => h('b'));
  const names = { walk: 'Lopen', bike: 'Fiets', car: 'Auto', pt: 'OV' };
  p.bind(() => {
    const s = stats();
    const tot = s.walk + s.bike + s.car + s.pt;
    (['walk', 'bike', 'car', 'pt'] as const).forEach((k, i) => {
      const f = tot ? s[k] / tot : 0.25;
      segs[i].style.flexGrow = String(Math.max(0.0001, f));
      segs[i].title = `${names[k]}: ${tot ? pct(f) : '—'}`;
      legendVals[i].textContent = tot ? pct(f) : '—';
    });
  });
  return h(
    'div',
    { class: 'cm-split' },
    h('div', { class: 'cm-split-bar', role: 'img', 'aria-label': 'Verdeling vervoerswijzen' }, segs),
    h('div', { class: 'cm-split-legend' }, (['walk', 'bike', 'car', 'pt'] as const).map((k, i) => h('span', null, h('i', { style: `background:${SPLIT_COLORS[k]}` }), names[k], ' ', legendVals[i]))),
  );
}

export class RegionPanel extends Panel {
  key = 'region';
  focus: { city?: string; highway?: string } = {};
  constructor(ui: GameUI, focus: { city?: string; highway?: string } = {}) {
    super(ui);
    this.focus = focus;
  }
  title(): string {
    return '🏙️ Steden & regio';
  }
  selection(): PickInfo | null {
    if (this.focus.highway) return { kind: 'highway', key: this.focus.highway };
    if (this.focus.city) return { kind: 'city', cityId: this.focus.city };
    return null;
  }
  setFocus(f: { city?: string; highway?: string }): void {
    this.focus = f;
    this.rebuild();
    this.scrollToFocus();
  }
  onOpen(): void {
    this.scrollToFocus();
  }
  private scrollToFocus(): void {
    const el = this.body.querySelector('.cm-focus') as HTMLElement | null;
    if (el) setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  }
  onChanged(what: string): void {
    if (what === 'cities' || what === 'highways' || what === 'all') this.dirty = true;
  }

  build(body: HTMLElement): void {
    const g = this.game;
    const unlocked = new Set(g.cities.map((c) => c.def.id));

    // ---- unlocked cities
    const cityCard = (c: CitySim) => {
      const st = () => c.stats;
      return h(
        'div',
        { class: `cm-card ${this.focus.city === c.def.id ? 'cm-focus' : ''}` },
        h('div', { class: 'cm-card-head' }, h('b', null, c.def.name), c.def.id === g.startCity ? h('span', { class: 'cm-tag' }, 'thuisstad') : null, h('button', { class: 'cm-btn cm-btn-small', title: `Vlieg naar ${c.def.name}`, onclick: () => this.renderer.flyToCity(c.def.id) }, '✈ Vlieg naar')),
        h(
          'div',
          { class: 'cm-kv-grid cm-kv-grid-3' },
          kv('Inwoners', int(c.def.population)),
          kv('Ritten vandaag', this.text(() => int(st().trips))),
          kv('Met OV', this.text(() => int(st().pt))),
          kv('Reputatie', this.text(() => `${Math.round(c.reputation)}/100`)),
          kv('Ongelukken', this.text(() => int(st().accidents))),
          kv('Gisteren OV', this.text(() => int(c.statsYesterday.pt))),
        ),
        modalSplit(st, this),
      );
    };
    body.append(section(`Jouw steden (${g.cities.length}/${maxCities(g.level)})`, ...g.cities.map(cityCard)));

    // ---- cities to unlock
    const candidates = new Map<string, number>();
    for (const c of g.cities)
      for (const n of neighbours(c.def.id)) {
        if (unlocked.has(n)) continue;
        const def = CITY_BY_ID.get(n);
        if (!def) continue;
        const d = distanceKm(c.def, def);
        candidates.set(n, Math.min(candidates.get(n) ?? Infinity, d));
      }
    if (this.focus.city && !unlocked.has(this.focus.city) && !candidates.has(this.focus.city)) candidates.set(this.focus.city, NaN);
    const regionLvl = FEATURES.find((f) => f.id === 'region')?.level ?? 4;
    const cands = [...candidates.entries()].sort((a, b) => (a[0] === this.focus.city ? -1 : b[0] === this.focus.city ? 1 : (a[1] || 999) - (b[1] || 999)));
    const unlockCard = (id: string, dist: number) => {
      const def = CITY_BY_ID.get(id) as CityDef;
      const st = g.canUnlockCity(id);
      const loading = this.ui.cityLoadStatus.get(id);
      const btn = h('button', { class: 'cm-btn cm-btn-primary cm-btn-small', disabled: !st.ok || loading !== undefined, onclick: () => this.unlock(id, btn) }, loading !== undefined ? 'Laden…' : `Ontgrendelen · ${eur(st.cost)}`);
      const statusEl = this.text(() => {
        const s = this.ui.cityLoadStatus.get(id);
        return s ? `⏳ ${s}` : '';
      }, 'cm-small cm-info', 'div');
      return h(
        'div',
        { class: `cm-card cm-card-locked ${this.focus.city === id ? 'cm-focus' : ''}` },
        h('div', { class: 'cm-card-head' }, h('b', null, `🔒 ${def.name}`), h('span', { class: 'cm-muted cm-small' }, `${int(def.population)} inw.${isFinite(dist) ? ` · ${Math.round(dist)} km` : ''}`), h('button', { class: 'cm-iconbtn cm-iconbtn-s', title: `Bekijk ${def.name} op de kaart`, 'aria-label': 'Bekijk op kaart', onclick: () => this.renderer.flyToCity(id) }, '👁')),
        st.ok ? null : h('div', { class: 'cm-small cm-muted' }, st.reason),
        statusEl,
        h('div', { class: 'cm-row' }, btn),
      );
    };
    body.append(
      section(
        'Steden ontgrendelen',
        g.level < regionLvl ? hint(`Vanaf level ${regionLvl} kun je een aangrenzende stad ontgrendelen en verbinden met snelbus, trein of vliegtuig.`, 'info') : null,
        cands.length ? h('div', { class: 'cm-cards' }, cands.map(([id, d]) => unlockCard(id, d))) : h('div', { class: 'cm-empty' }, 'Geen aangrenzende steden meer.'),
      ),
    );

    // ---- highways
    const hwOk = g.hasFeature('highway');
    const hwLvl = FEATURES.find((f) => f.id === 'highway')?.level ?? 4;
    const rows = g.highways.map((hw) => {
      const a = CITY_BY_ID.get(hw.a)?.name ?? hw.a;
      const b = CITY_BY_ID.get(hw.b)?.name ?? hw.b;
      const speed = h('select', { class: 'cm-input cm-input-s', disabled: !hwOk, 'aria-label': `Snelheid ${a}–${b}` }, [100, 120, 130].map((v) => h('option', { value: String(v), selected: hw.settings.speed === v }, `${v} km/u`)));
      speed.addEventListener('change', () => this.setHw(hw.key, { speed: Number(speed.value) }));
      const lanes = h('select', { class: 'cm-input cm-input-s', disabled: !hwOk, 'aria-label': `Rijstroken ${a}–${b}` }, [2, 3, 4, 5].map((v) => h('option', { value: String(v), selected: hw.settings.lanes === v }, `${v}×`)));
      lanes.addEventListener('change', () => this.setHw(hw.key, { lanes: Number(lanes.value) }));
      const fill = h('div', { class: 'cm-bar-fill' });
      this.bind(() => {
        fill.style.width = `${Math.max(2, hw.congestion * 100)}%`;
        fill.dataset.level = hw.congestion < 0.3 ? 'good' : hw.congestion < 0.65 ? 'warn' : 'bad';
      });
      return h(
        'div',
        { class: `cm-card cm-hw ${this.focus.highway === hw.key ? 'cm-focus' : ''}` },
        h('div', { class: 'cm-card-head' }, h('b', null, `🛣️ ${a} – ${b}`), this.text(() => (hw.closedUntil > g.time ? '⛔ afgesloten (ongeluk)' : `${int(hw.carsPerHour)} auto’s/u`), 'cm-small cm-muted')),
        h('div', { class: 'cm-row cm-row-wrap' }, h('label', { class: 'cm-small' }, 'Snelheid ', speed), h('label', { class: 'cm-small' }, 'Rijstroken per richting ', lanes)),
        h('div', { class: 'cm-bar', title: 'Drukte op de snelweg' }, fill),
      );
    });
    body.append(
      section(
        'Snelwegen',
        hwOk ? h('div', { class: 'cm-small cm-muted' }, 'Hogere snelheid en meer rijstroken maken de auto aantrekkelijker — goed voor snelbussen, maar minder reizigers voor je trein.') : h('div', { class: 'cm-row' }, lockBadge(hwLvl), h('span', { class: 'cm-small cm-muted' }, 'Snelwegen instellen')),
        rows.length ? rows : h('div', { class: 'cm-empty' }, 'Nog geen snelwegen: ontgrendel een tweede stad.'),
      ),
    );
  }

  private setHw(key: string, patch: { speed?: number; lanes?: number }): void {
    const e = this.game.setHighway(key, patch);
    if (e) toast(e, 'bad');
    else toast('Snelweg aangepast.', 'good', { ms: 2500 });
    this.dirty = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  private async unlock(id: string, btn: HTMLButtonElement): Promise<void> {
    const name = CITY_BY_ID.get(id)?.name ?? id;
    btn.disabled = true;
    btn.textContent = 'Laden…';
    if (!this.ui.cityLoadStatus.has(id)) this.ui.cityLoadStatus.set(id, 'Kaartgegevens ophalen…');
    try {
      const e = await this.game.unlockCity(id);
      if (e) toast(e, 'bad');
      else {
        toast(`${name} ontgrendeld! 🎉`, 'good');
        this.renderer.flyToCity(id);
        this.focus = { city: id };
      }
    } catch (ex) {
      toast(`Laden van ${name} mislukt: ${ex instanceof Error ? ex.message : String(ex)}`, 'bad');
    } finally {
      this.ui.cityLoadStatus.delete(id);
      this.dirty = true;
    }
  }
}
