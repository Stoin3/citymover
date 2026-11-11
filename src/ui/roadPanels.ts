// Road (edge) and junction editing panels.
import type { PickInfo } from '../game/api';
import { CLASS_NAMES, SAFE_SPEED, FEATURES, ROAD_EDIT_COST, CONTROL_NAMES, CONTROL_FEATURE, CONTROL_COST } from '../config';
import type { CitySim } from '../sim/city';
import type { GameUI } from './gameUI';
import { Panel, section, kv, hint, lockBadge } from './panel';
import { h, eur, km, int, dec1 } from './dom';
import { toast } from './overlays';

const SPEED_OPTIONS = [15, 30, 50, 60, 70, 80, 100, 120, 130];

function featureLevel(id: string): number {
  return FEATURES.find((f) => f.id === id)?.level ?? 1;
}

/** congestion 0..1 (0 = free flow) for an edge, worst direction */
export function edgeCongestion(city: CitySim, e: number): number {
  const G = city.G;
  let worst = 0;
  for (const a of [e * 2, e * 2 + 1]) {
    if (!G.arcAllowed(a)) continue;
    const f = G.congestion(a); // 1 = free, 0.07 = jam
    worst = Math.max(worst, (1 - f) / 0.93);
  }
  return Math.max(0, Math.min(1, worst));
}

function congestionBar(p: Panel, fn: () => number, labels = ['Vrij', 'Druk', 'File']): HTMLElement {
  const fill = h('div', { class: 'cm-bar-fill' });
  const txt = p.text(() => {
    const c = fn();
    return `${Math.round(c * 100)}% · ${c < 0.3 ? labels[0] : c < 0.65 ? labels[1] : labels[2]}`;
  }, 'cm-kv-v');
  p.bind(() => {
    const c = fn();
    fill.style.width = `${Math.max(2, c * 100)}%`;
    fill.dataset.level = c < 0.3 ? 'good' : c < 0.65 ? 'warn' : 'bad';
  });
  return h('div', null, h('div', { class: 'cm-kv' }, h('span', { class: 'cm-kv-k' }, 'Drukte nu'), txt), h('div', { class: 'cm-bar' }, fill));
}

// =====================================================================
export class RoadPanel extends Panel {
  key: string;
  city: number;
  edge: number;
  private errEl!: HTMLElement;
  constructor(ui: GameUI, city: number, edge: number) {
    super(ui);
    this.city = city;
    this.edge = edge;
    this.key = `edge:${city}:${edge}`;
  }
  get sim(): CitySim | undefined {
    return this.game.cities[this.city];
  }
  isValid(): boolean {
    const c = this.sim;
    return !!c && this.edge >= 0 && this.edge < c.G.nE;
  }
  selection(): PickInfo {
    return { kind: 'edge', city: this.city, edge: this.edge };
  }
  title(): string {
    return `🛣️ ${this.sim!.G.eName[this.edge] || 'Naamloze weg'}`;
  }
  onChanged(what: string): void {
    if (what === 'roads' || what === 'all') this.dirty = true;
  }

  private act(fn: () => string | null, okMsg: string): void {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const e = fn();
    if (e) {
      this.errEl.textContent = e;
      toast(e, 'bad');
    } else {
      toast(okMsg, 'good', { ms: 2500 });
      this.rebuild();
    }
  }

  build(body: HTMLElement): void {
    const g = this.game;
    const c = this.sim!;
    const G = c.G;
    const e = this.edge;
    const cls = G.eCls[e];
    const safe = SAFE_SPEED[cls] ?? 50;
    const acc = c.accidents.filter((a) => a.e === e).length;

    body.append(
      h(
        'div',
        { class: 'cm-kv-grid' },
        kv('Wegtype', CLASS_NAMES[cls] ?? 'Weg'),
        kv('Lengte', km(G.eLen[e])),
        kv('Stad', c.def.name),
        kv('Ongelukken', String(acc), 'Ongelukken op deze weg (recent)'),
      ),
      congestionBar(this, () => edgeCongestion(c, e)),
    );
    this.errEl = h('div', { class: 'cm-error', role: 'alert' });
    body.append(this.errEl);

    // ---- speed
    const speedOk = g.hasFeature('speed');
    const cur = G.eSpeed[e];
    const opts = SPEED_OPTIONS.includes(cur) ? SPEED_OPTIONS : [...SPEED_OPTIONS, cur].sort((a, b) => a - b);
    const sel = h('select', { class: 'cm-input', disabled: !speedOk, 'aria-label': 'Maximumsnelheid' }, opts.map((v) => h('option', { value: String(v), selected: v === cur }, `${v} km/u`)));
    const warn = h('div', { class: 'cm-hint cm-hint-warn' });
    const showWarn = (v: number) => {
      warn.hidden = v <= safe;
      warn.textContent = `⚠️ Hogere snelheid = meer ongelukken. Veilige snelheid voor een ${(CLASS_NAMES[cls] ?? 'weg').toLowerCase()}: ${safe} km/u.`;
    };
    showWarn(cur);
    sel.addEventListener('input', () => showWarn(Number(sel.value)));
    sel.addEventListener('change', () => this.act(() => g.setEdgeSpeed(this.city, e, Number(sel.value)), `Maximumsnelheid ${sel.value} km/u ingesteld.`));
    body.append(
      section(
        'Maximumsnelheid',
        h('div', { class: 'cm-row' }, sel, speedOk ? h('span', { class: 'cm-cost' }, eur(ROAD_EDIT_COST.speed)) : lockBadge(featureLevel('speed'))),
        warn,
        G.eSpeedOsm[e] !== cur ? h('div', { class: 'cm-small cm-muted' }, `Oorspronkelijk (OpenStreetMap): ${G.eSpeedOsm[e]} km/u`) : null,
      ),
    );

    // ---- direction
    const onewayOk = g.hasFeature('oneway');
    const o = G.eOneway[e];
    const dirBtn = (v: -1 | 0 | 1, label: string, title: string) =>
      h('button', { class: `cm-seg-btn ${o === v ? 'cm-on' : ''}`, disabled: !onewayOk || o === v, title, 'aria-pressed': String(o === v), onclick: () => this.act(() => g.setEdgeOneway(this.city, e, v), `Rijrichting aangepast: ${label}.`) }, label);
    body.append(
      section(
        'Richting',
        h('div', { class: 'cm-seg' }, dirBtn(0, '⇄ Tweerichting', 'Verkeer in beide richtingen'), dirBtn(1, '→ Eenrichting', 'Alleen in de richting van de pijlen op de kaart'), dirBtn(-1, '← Eenrichting', 'Alleen tegen de tekenrichting in')),
        h('div', { class: 'cm-small cm-muted' }, 'Eenrichtingsverkeer geeft alle rijstroken aan één richting (meer doorstroming), maar auto’s en bussen moeten omrijden. Let op: een lijn kan onbereikbaar worden.'),
        onewayOk ? h('div', { class: 'cm-small' }, 'Kosten: ', h('span', { class: 'cm-cost' }, eur(ROAD_EDIT_COST.oneway))) : lockBadge(featureLevel('oneway')),
      ),
    );

    // ---- lanes
    const lanesOk = g.hasFeature('lanes');
    const lanes = G.eLanes[e];
    const laneBtns = h('div', { class: 'cm-seg cm-seg-num' });
    for (let n = 1; n <= 6; n++)
      laneBtns.append(h('button', { class: `cm-seg-btn ${n === lanes ? 'cm-on' : ''}`, disabled: !lanesOk || n === lanes, title: `${n} rijstro${n === 1 ? 'ok' : 'ken'} totaal`, onclick: () => this.act(() => g.setEdgeLanes(this.city, e, n), `${n} rijstroken ingesteld.`) }, String(n)));
    body.append(
      section(
        'Rijstroken',
        laneBtns,
        h('div', { class: 'cm-small cm-muted' }, `Totaal ${lanes} · per richting ${G.lanesDir(e)}${G.eBus[e] ? ' (waarvan 1 busbaan)' : ''}. Meer rijstroken = minder file, maar meer autoverkeer.`),
        lanesOk ? h('div', { class: 'cm-small' }, 'Kosten: ', h('span', { class: 'cm-cost' }, `${eur(ROAD_EDIT_COST.lanes)} per wijziging`)) : lockBadge(featureLevel('lanes')),
      ),
    );

    // ---- bus lane
    const busOk = g.hasFeature('buslane');
    const bus = !!G.eBus[e];
    const sw = h('input', { type: 'checkbox', class: 'cm-switch-input', checked: bus, disabled: !busOk, 'aria-label': 'Busbaan' });
    sw.addEventListener('change', () => this.act(() => g.setEdgeBusLane(this.city, e, sw.checked), sw.checked ? 'Busbaan aangelegd.' : 'Busbaan verwijderd.'));
    body.append(
      section(
        'Busbaan',
        h('label', { class: 'cm-switch' }, sw, h('span', { class: 'cm-switch-track' }), h('span', null, bus ? 'Busbaan aanwezig' : 'Geen busbaan')),
        h('div', { class: 'cm-small cm-muted' }, 'Bussen rijden over de busbaan langs de file. Auto’s houden één rijstrook per richting minder over.'),
        busOk && G.lanesDir(e) < 2 && !bus ? hint('Deze weg heeft maar 1 rijstrook per richting: met een busbaan blijft er weinig ruimte over voor auto’s.', 'warn') : null,
        busOk ? h('div', { class: 'cm-small' }, 'Kosten: ', h('span', { class: 'cm-cost' }, eur(ROAD_EDIT_COST.buslane))) : lockBadge(featureLevel('buslane')),
      ),
    );
  }
}

// =====================================================================
const CTRL_ICON = ['⚠️', '↘️', '🔶', '🛑', '🚦', '🔄'];
const CTRL_DESC = [
  'Geen regeling: snel maar zeer gevaarlijk bij druk verkeer.',
  'Voorrang van rechts: standaard in woonwijken. Iedereen remt af — redelijk veilig, wat trager.',
  'Voorrangsweg: de hoofdweg rijdt door, zijstraten wachten. Goed voor doorgaande routes.',
  'Stopborden: zijstraten stoppen volledig. Veiliger, maar meer wachttijd voor de zijstraten.',
  'Verkeerslichten: veilig maar meer wachttijd voor iedereen. Geschikt voor drukke kruispunten.',
  'Rotonde: veilig én vlot doorstromend — het beste compromis, maar duur om aan te leggen.',
];

export class JunctionPanel extends Panel {
  key: string;
  city: number;
  junction: number;
  constructor(ui: GameUI, city: number, junction: number) {
    super(ui);
    this.city = city;
    this.junction = junction;
    this.key = `junction:${city}:${junction}`;
  }
  get sim(): CitySim | undefined {
    return this.game.cities[this.city];
  }
  isValid(): boolean {
    const c = this.sim;
    return !!c && this.junction >= 0 && this.junction < c.G.nJ;
  }
  selection(): PickInfo {
    return { kind: 'junction', city: this.city, junction: this.junction };
  }
  title(): string {
    return `✳️ ${this.sim!.junctionName(this.junction)}`;
  }
  onChanged(what: string): void {
    if (what === 'roads' || what === 'all') this.dirty = true;
  }
  build(body: HTMLElement): void {
    const g = this.game;
    const c = this.sim!;
    const G = c.G;
    const j = this.junction;
    const cur = G.jCtrl[j];
    const acc = c.accidents.filter((a) => a.j === j).length;
    const loadFill = h('div', { class: 'cm-bar-fill' });
    this.bind(() => {
      const l = G.jLoad[j] || 0;
      loadFill.style.width = `${Math.min(100, (l / 60) * 100)}%`;
      loadFill.dataset.level = l < 20 ? 'good' : l < 40 ? 'warn' : 'bad';
    });
    body.append(
      h(
        'div',
        { class: 'cm-kv-grid' },
        kv('Aantal wegen', String(G.jDeg[j])),
        kv('Regeling nu', `${CTRL_ICON[cur] ?? ''} ${CONTROL_NAMES[cur] ?? '—'}`),
        kv('Stad', c.def.name),
        kv('Ongelukken', String(acc)),
      ),
      h('div', { class: 'cm-kv' }, h('span', { class: 'cm-kv-k' }, 'Verkeer nu'), this.text(() => `${dec1(G.jLoad[j] || 0)} voertuigen/min`, 'cm-kv-v')),
      h('div', { class: 'cm-bar' }, loadFill),
    );
    if (G.jDeg[j] < 3) body.append(hint('Hier komen minder dan 3 wegen samen: een kruispuntregeling heeft weinig effect.', 'info'));
    if (cur === 0 && (G.jLoad[j] || 0) > 10) body.append(hint('Druk kruispunt zonder regeling — grote kans op ongelukken!', 'bad'));
    const err = h('div', { class: 'cm-error', role: 'alert' });
    const list = h('div', { class: 'cm-ctrl-list' });
    CONTROL_NAMES.forEach((name, i) => {
      const feat = CONTROL_FEATURE[i];
      const ok = g.hasFeature(feat);
      const isCur = i === cur;
      list.append(
        h(
          'button',
          {
            class: `cm-ctrl ${isCur ? 'cm-on' : ''} ${ok ? '' : 'cm-locked'}`,
            disabled: !ok || isCur,
            title: CTRL_DESC[i],
            'aria-pressed': String(isCur),
            onclick: () => {
              const e = g.setJunctionControl(this.city, j, i);
              if (e) {
                err.textContent = e;
                toast(e, 'bad');
              } else {
                toast(`${name} ingesteld.`, 'good', { ms: 2500 });
                this.rebuild();
              }
            },
          },
          h('span', { class: 'cm-ctrl-ico' }, CTRL_ICON[i]),
          h('span', { class: 'cm-ctrl-text' }, h('b', null, name), h('span', { class: 'cm-small cm-muted' }, CTRL_DESC[i].split(': ')[1] ?? CTRL_DESC[i])),
          h('span', { class: 'cm-ctrl-side' }, isCur ? h('span', { class: 'cm-tag cm-tag-good' }, 'huidig') : ok ? h('span', { class: 'cm-cost' }, CONTROL_COST[i] ? eur(CONTROL_COST[i]) : 'gratis') : lockBadge(featureLevel(feat))),
        ),
      );
    });
    body.append(err, section('Kruispuntregeling', list));
    body.append(h('div', { class: 'cm-small cm-muted' }, `Tip: ongelukken kosten geld en reputatie. ${int(acc)} ongeluk(ken) hier recent.`));
  }
}
