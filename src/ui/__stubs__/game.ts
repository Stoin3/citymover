// DEV-ONLY fake IGame for the UI harness (ui-harness.html). Not used by the real game.
import type { IGame, GameEventMap, HighwayLink, Ledger, SaveData, Unsub } from '../../game/api';
import { MODES, ModeId, levelFromXp, FEATURES, HOURLY_DEMAND, CONTROL_COST, ROAD_EDIT_COST, cityUnlockCost, maxCities } from '../../config';
import { CITY_BY_ID, neighbours } from '../../data/cities';
import type { CitySim, CityStats, Accident } from '../../sim/city';
import { Line, Stop, newLineData } from '../../sim/transit';
import { PassengerPool } from '../../sim/agents';
import type { TransitNet } from '../../sim/network';

const STREETS_H = ['Oude Delft', 'Voorstraat', 'Wijnhaven', 'Phoenixstraat', 'Westvest', 'Zuidwal', 'Kampveldweg', 'Papsouwselaan', 'Schoemakerstraat', 'Mekelweg', 'Julianalaan', 'Kruisstraat'];
const STREETS_V = ['Molslaan', 'Hippolytusbuurt', 'Choorstraat', 'Brabantse Turfmarkt', 'Oostsingel', 'Rotterdamseweg', 'Krakeelpolderweg', 'Van Foreestweg', 'Kanaalweg', 'Delflandplein', 'Sint Sebastiaansbrug', 'Hof van Delftlaan'];

export const GRID_N = 12;
export const GRID_SP = 260;

export class FakeGraph {
  nJ: number;
  nE: number;
  jx: Float64Array;
  jy: Float64Array;
  jDeg: Uint8Array;
  jCtrl: Uint8Array;
  jCtrlOsm: Uint8Array;
  jLoad: Float32Array;
  eA: Int32Array;
  eB: Int32Array;
  eLen: Float32Array;
  eCls: Uint8Array;
  eOneway: Int8Array;
  eOnewayOsm: Int8Array;
  eSpeed: Uint8Array;
  eSpeedOsm: Uint8Array;
  eLanes: Uint8Array;
  eLanesOsm: Uint8Array;
  eBus: Uint8Array;
  eName: string[] = [];
  arcLoad: Float32Array;
  constructor(cx: number, cy: number) {
    const N = GRID_N;
    this.nJ = N * N;
    this.jx = new Float64Array(this.nJ);
    this.jy = new Float64Array(this.nJ);
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const j = r * N + c;
        this.jx[j] = cx + (c - (N - 1) / 2) * GRID_SP + Math.sin(r * 1.7) * 30;
        this.jy[j] = cy + (r - (N - 1) / 2) * GRID_SP + Math.cos(c * 1.3) * 30;
      }
    const A: number[] = [],
      B: number[] = [],
      names: string[] = [],
      cls: number[] = [];
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const j = r * N + c;
        if (c + 1 < N) {
          A.push(j);
          B.push(j + 1);
          names.push(STREETS_H[r % STREETS_H.length]);
          cls.push(r === 5 ? 2 : r % 3 === 0 ? 4 : 6);
        }
        if (r + 1 < N) {
          A.push(j);
          B.push(j + N);
          names.push(STREETS_V[c % STREETS_V.length]);
          cls.push(c === 6 ? 3 : c % 4 === 0 ? 4 : 6);
        }
      }
    this.nE = A.length;
    this.eA = Int32Array.from(A);
    this.eB = Int32Array.from(B);
    this.eName = names;
    this.eCls = Uint8Array.from(cls);
    this.eLen = new Float32Array(this.nE).map((_, e) => Math.hypot(this.jx[A[e]] - this.jx[B[e]], this.jy[A[e]] - this.jy[B[e]]));
    this.eSpeed = Uint8Array.from(cls.map((k) => (k <= 2 ? 50 : k === 3 ? 50 : k === 4 ? 50 : 30)));
    this.eSpeedOsm = this.eSpeed.slice();
    this.eLanes = Uint8Array.from(cls.map((k) => (k <= 3 ? 4 : 2)));
    this.eLanesOsm = this.eLanes.slice();
    this.eOneway = new Int8Array(this.nE);
    this.eOnewayOsm = this.eOneway.slice();
    this.eBus = new Uint8Array(this.nE);
    this.arcLoad = new Float32Array(this.nE * 2).map(() => Math.random() * 6);
    this.jDeg = new Uint8Array(this.nJ);
    for (let e = 0; e < this.nE; e++) {
      this.jDeg[A[e]]++;
      this.jDeg[B[e]]++;
    }
    this.jCtrl = new Uint8Array(this.nJ).map((_, j) => (this.jDeg[j] >= 4 ? 1 : 0));
    this.jCtrl[5 * N + 6] = 4;
    this.jCtrlOsm = this.jCtrl.slice();
    this.jLoad = new Float32Array(this.nJ).map(() => Math.random() * 40);
  }
  arcAllowed(a: number): boolean {
    const o = this.eOneway[a >> 1];
    return o === 0 || (o === 1 && (a & 1) === 0) || (o === -1 && (a & 1) === 1);
  }
  lanesDir(e: number): number {
    const l = this.eLanes[e];
    return this.eOneway[e] !== 0 ? l : Math.max(1, Math.floor(l / 2));
  }
  congestion(a: number): number {
    const e = a >> 1;
    const cap = (Math.max(1, this.lanesDir(e) - (this.eBus[e] ? 1 : 0)) * this.eLen[e]) / 7.5;
    const dens = (this.arcLoad[a] * 6) / Math.max(1, cap);
    return Math.max(0.07, 1 - 0.9 * Math.min(1, dens));
  }
  nearestJunction(x: number, y: number): number {
    let best = -1,
      bd = Infinity;
    for (let j = 0; j < this.nJ; j++) {
      const d = Math.hypot(this.jx[j] - x, this.jy[j] - y);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    return best;
  }
}

function emptyStats(): CityStats {
  return { trips: 0, walk: 0, bike: 0, car: 0, pt: 0, ptFailed: 0, accidents: 0, delivered: 0 };
}

export interface FakeCity {
  def: ReturnType<typeof CITY_BY_ID.get> & object;
  index: number;
  G: FakeGraph;
  cx: number;
  cy: number;
  radius: number;
  reputation: number;
  stats: CityStats;
  statsYesterday: CityStats;
  hourly: number[];
  accidents: Accident[];
  junctionName(j: number): string;
  contains(x: number, y: number): boolean;
}

function makeCity(id: string, index: number, cx: number, cy: number): FakeCity {
  const def = CITY_BY_ID.get(id)!;
  const G = new FakeGraph(cx, cy);
  return {
    def,
    index,
    G,
    cx,
    cy,
    radius: (GRID_N / 2) * GRID_SP,
    reputation: 62,
    stats: emptyStats(),
    statsYesterday: { trips: 31000, walk: 7400, bike: 13100, car: 9200, pt: 1300, ptFailed: 420, accidents: 3, delivered: 1240 },
    hourly: new Array(24).fill(0),
    accidents: [],
    junctionName(j: number) {
      const N = GRID_N;
      const r = Math.floor(j / N),
        c = j % N;
      return `${STREETS_H[r % STREETS_H.length]} / ${STREETS_V[c % STREETS_V.length]}`;
    },
    contains(x: number, y: number) {
      return Math.hypot(x - cx, y - cy) < this.radius * 1.2;
    },
  };
}

const emptyLedger = (): Ledger => ({ fares: 0, subsidy: 0, operations: 0, construction: 0, vehicles: 0, accidents: 0 });

export class FakeGame implements IGame {
  money = 1_500_000;
  xp = 900;
  get level(): number {
    return levelFromXp(this.xp);
  }
  time = 1440 * 2 + 7 * 60 + 42;
  speed = 1;
  cities: CitySim[] = [];
  startCity = 'delft';
  stops = new Map<number, Stop>();
  lines = new Map<number, Line>();
  vehicles = [];
  passengers = new PassengerPool(16);
  highways: HighwayLink[] = [];
  highwayCars = [];
  net = {} as TransitNet;
  ledgerToday: Ledger = emptyLedger();
  ledgerYesterday: Ledger = { fares: 18450, subsidy: 9200, operations: 14100, construction: 64000, vehicles: 240000, accidents: 1500 };
  totalDelivered = 5230;
  maxEntities = 12000;
  private nextId = 1;
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  private minuteAcc = 0;

  constructor() {
    const c = makeCity('delft', 0, 0, 0);
    this.cities.push(c as unknown as CitySim);
    // seed stats for today so far
    for (let h = 0; h < 8; h++) c.hourly[h] = Math.round(HOURLY_DEMAND[h] * 4200 * (0.8 + Math.random() * 0.4));
    Object.assign(c.stats, { trips: 9400, walk: 2200, bike: 3900, car: 2700, pt: 600, ptFailed: 140, accidents: 1, delivered: 412 });
    Object.assign(this.ledgerToday, { fares: 4210, subsidy: 2100, operations: 3900, construction: 12000, vehicles: 0, accidents: 0 });
    // two lines
    const G = c.G;
    const mk = (mode: ModeId, name: string, js: number[], color?: [number, number, number]) => {
      const ids = js.map((j, i) => this.mkStop(mode, G.jx[j] + 20, G.jy[j] + 20, `${name.split(' ')[0]} ${['Station', 'Markt', 'Prinsenhof', 'TU Campus', 'Ziekenhuis', 'Hof van Delft', 'Tanthof', 'Voorhof'][(i + js[0]) % 8]}`).d.id);
      const d = newLineData(this.nextId++, mode, name, color ?? MODES[mode].color);
      d.stops = ids;
      d.fleet = mode === 'bus' ? 6 : 3;
      const l = new Line(d);
      this.routeLine(l);
      l.paxToday = 380 + Math.round(Math.random() * 200);
      l.revenueToday = l.paxToday * 1.62;
      l.costToday = 520;
      l.paxYesterday = 1430;
      l.revenueYesterday = 2310;
      l.costYesterday = 1890;
      l.crowding = 0.68;
      this.lines.set(d.id, l);
      return l;
    };
    mk('bus', 'Bus 1', [GRID_N * 2 + 1, GRID_N * 2 + 4, GRID_N * 5 + 4, GRID_N * 5 + 8, GRID_N * 9 + 8, GRID_N * 9 + 10]);
    const l2 = mk('bus', 'Bus 2', [GRID_N * 10 + 2, GRID_N * 7 + 2, GRID_N * 7 + 6, GRID_N * 3 + 6, GRID_N * 3 + 10], [0, 180, 216]);
    l2.d.fleet = 3;
    l2.shortage = 2;
    l2.revenueToday = 310;
    l2.costToday = 640;
    l2.crowding = 0.97;
    this.highways.push({ key: 'delft|denhaag', a: 'delft', b: 'denhaag', settings: { speed: 100, lanes: 3 }, pts: [], congestion: 0.55, carsPerHour: 4200, closedUntil: 0 });
    this.highways.push({ key: 'delft|rotterdam', a: 'delft', b: 'rotterdam', settings: { speed: 130, lanes: 3 }, pts: [], congestion: 0.82, carsPerHour: 6100, closedUntil: 0 });
  }

  private mkStop(mode: ModeId, x: number, y: number, name?: string): Stop {
    const id = this.nextId++;
    const s = new Stop({ id, name: name ?? `Halte ${id}`, x, y, city: 'delft', mode });
    s.waiting = Math.round(Math.random() * 30);
    s.boardedToday = Math.round(Math.random() * 300);
    this.stops.set(id, s);
    return s;
  }

  private routeLine(l: Line): void {
    const ss = l.d.stops.map((id) => this.stops.get(id)!).filter(Boolean);
    let len = 0;
    for (let i = 1; i < ss.length; i++) len += Math.abs(ss[i].x - ss[i - 1].x) + Math.abs(ss[i].y - ss[i - 1].y);
    for (const dir of l.dirs) {
      dir.length = len;
      dir.stops = ss;
      dir.segTime = new Float64Array(Math.max(0, ss.length - 1)).fill(len / Math.max(1, ss.length - 1) / (l.def.cruiseKmh / 3.6 * 0.5) + l.def.dwell);
    }
    l.valid = ss.length >= 2;
    l.error = l.valid ? '' : 'Een lijn heeft minimaal 2 haltes nodig.';
  }

  hour(): number {
    return (this.time % 1440) / 60;
  }
  day(): number {
    return Math.floor(this.time / 1440);
  }
  hasFeature(id: string): boolean {
    const f = FEATURES.find((x) => x.id === id);
    return !!f && this.level >= f.level;
  }
  modeUnlocked(mode: ModeId): boolean {
    return this.level >= MODES[mode].unlockLevel;
  }
  cityById(id: string): CitySim | undefined {
    return this.cities.find((c) => c.def.id === id);
  }
  cityAt(x: number, y: number): CitySim | undefined {
    return this.cities.find((c) => c.contains(x, y));
  }
  allAccidents(): Accident[] {
    return this.cities.flatMap((c) => c.accidents);
  }
  canUnlockCity(id: string): { ok: boolean; reason: string; cost: number } {
    const def = CITY_BY_ID.get(id);
    const cost = def ? cityUnlockCost(def.population) : 0;
    if (!this.cities.some((c) => neighbours(c.def.id).includes(id))) return { ok: false, reason: 'Niet aangrenzend aan je steden.', cost };
    if (this.level < 4) return { ok: false, reason: 'Beschikbaar vanaf level 4.', cost };
    if (this.cities.length >= maxCities(this.level)) return { ok: false, reason: 'Je hebt het maximale aantal steden voor je level.', cost };
    if (this.money < cost) return { ok: false, reason: 'Niet genoeg geld.', cost };
    return { ok: true, reason: '', cost };
  }
  lineCostEstimate(mode: ModeId, stopIds: number[]): number {
    const m = MODES[mode];
    let len = 0;
    for (let i = 1; i < stopIds.length; i++) {
      const a = this.stops.get(stopIds[i - 1]),
        b = this.stops.get(stopIds[i]);
      if (a && b) len += Math.hypot(a.x - b.x, a.y - b.y);
    }
    return (len / 1000) * m.infraPerKm;
  }
  async unlockCity(id: string): Promise<string | null> {
    const st = this.canUnlockCity(id);
    if (!st.ok) return st.reason;
    for (const s of ['Kaartgegevens ophalen…', 'Wegennet opbouwen…', 'Inwoners plaatsen…']) {
      this.emit('cityLoading', { id, status: s });
      await new Promise((r) => setTimeout(r, 700));
    }
    this.money -= st.cost;
    const c = makeCity(id, this.cities.length, 30000, 0);
    this.cities.push(c as unknown as CitySim);
    this.emit('cityLoading', { id, status: null });
    this.emit('changed', { what: 'cities' });
    return null;
  }
  addStop(mode: ModeId, x: number, y: number): Stop | string {
    const city = this.cityAt(x, y);
    if (!city) return 'Je kunt alleen haltes plaatsen in een ontgrendelde stad.';
    for (const s of this.stops.values()) if (s.d.mode === mode && Math.hypot(s.x - x, s.y - y) < MODES[mode].minStopSpacing * 0.5) return s;
    const cost = MODES[mode].stopCost;
    if (this.money < cost) return 'Niet genoeg geld voor een nieuwe halte.';
    this.money -= cost;
    this.ledgerToday.construction += cost;
    const G = (city as unknown as FakeCity).G;
    const j = G.nearestJunction(x, y);
    const s = this.mkStop(mode, G.jx[j] + 18, G.jy[j] + 18, `${G.eName[j % G.nE]}`);
    this.emit('changed', { what: 'stops' });
    return s;
  }
  removeStop(id: number): string | null {
    for (const l of this.lines.values()) {
      if (l.d.stops.includes(id)) {
        l.d.stops = l.d.stops.filter((s) => s !== id);
        this.routeLine(l);
      }
    }
    this.stops.delete(id);
    this.emit('changed', { what: 'stops' });
    return null;
  }
  renameStop(id: number, name: string): void {
    const s = this.stops.get(id);
    if (s) s.d.name = name;
    this.emit('changed', { what: 'stops' });
  }
  createLine(mode: ModeId): Line | string {
    const n = [...this.lines.values()].filter((l) => l.d.mode === mode).length + 1;
    const d = newLineData(this.nextId++, mode, `${MODES[mode].name} ${n}`, MODES[mode].color);
    const l = new Line(d);
    this.lines.set(d.id, l);
    return l;
  }
  setLineStops(lineId: number, stopIds: number[]): string | null {
    const l = this.lines.get(lineId);
    if (!l) return 'Lijn bestaat niet.';
    if (stopIds.length < 2) return 'Een lijn heeft minimaal 2 haltes nodig.';
    const cost = this.lineCostEstimate(l.d.mode, stopIds);
    if (cost > this.money) return 'Niet genoeg geld.';
    this.money -= cost;
    l.d.stops = stopIds.slice();
    this.routeLine(l);
    this.emit('changed', { what: 'lines' });
    return null;
  }
  updateLine(lineId: number, patch: Partial<Pick<Line['d'], 'name' | 'color' | 'fareBase' | 'fareKm' | 'freq'>>): void {
    const l = this.lines.get(lineId);
    if (!l) return;
    Object.assign(l.d, patch);
    this.emit('changed', { what: 'lines' });
  }
  deleteLine(lineId: number): void {
    this.lines.delete(lineId);
    this.emit('changed', { what: 'lines' });
  }
  buyVehicles(lineId: number, n: number): string | null {
    const l = this.lines.get(lineId);
    if (!l) return 'Lijn bestaat niet.';
    const cost = n * l.def.vehiclePrice;
    if (cost > this.money) return `Niet genoeg geld: ${n} voertuigen kosten € ${cost.toLocaleString('nl-NL')}.`;
    this.money -= cost;
    this.ledgerToday.vehicles += cost;
    l.d.fleet += n;
    this.emit('changed', { what: 'lines' });
    return null;
  }
  sellVehicles(lineId: number, n: number): string | null {
    const l = this.lines.get(lineId);
    if (!l) return 'Lijn bestaat niet.';
    if (l.d.fleet < n) return 'Geen voertuigen om te verkopen.';
    l.d.fleet -= n;
    this.money += n * l.def.vehiclePrice * 0.5;
    this.emit('changed', { what: 'lines' });
    return null;
  }
  private roadCost(cost: number, fn: () => void, feature: string): string | null {
    if (!this.hasFeature(feature)) return 'Nog niet beschikbaar op jouw level.';
    if (this.money < cost) return 'Niet genoeg geld.';
    this.money -= cost;
    this.ledgerToday.construction += cost;
    fn();
    this.emit('changed', { what: 'roads' });
    return null;
  }
  private G(ci: number): FakeGraph {
    return (this.cities[ci] as unknown as FakeCity).G;
  }
  setEdgeSpeed(ci: number, e: number, kmh: number): string | null {
    return this.roadCost(ROAD_EDIT_COST.speed, () => (this.G(ci).eSpeed[e] = kmh), 'speed');
  }
  setEdgeOneway(ci: number, e: number, o: -1 | 0 | 1): string | null {
    return this.roadCost(ROAD_EDIT_COST.oneway, () => (this.G(ci).eOneway[e] = o), 'oneway');
  }
  setEdgeLanes(ci: number, e: number, lanes: number): string | null {
    return this.roadCost(ROAD_EDIT_COST.lanes, () => (this.G(ci).eLanes[e] = lanes), 'lanes');
  }
  setEdgeBusLane(ci: number, e: number, on: boolean): string | null {
    return this.roadCost(ROAD_EDIT_COST.buslane, () => (this.G(ci).eBus[e] = on ? 1 : 0), 'buslane');
  }
  setJunctionControl(ci: number, j: number, ctrl: number): string | null {
    const feat = ['priority', 'priority', 'priority', 'priority', 'signals', 'roundabout'][ctrl];
    return this.roadCost(CONTROL_COST[ctrl], () => (this.G(ci).jCtrl[j] = ctrl), feat);
  }
  setHighway(key: string, patch: Partial<HighwayLink['settings']>): string | null {
    const hw = this.highways.find((x) => x.key === key);
    if (!hw) return 'Snelweg niet gevonden.';
    if (!this.hasFeature('highway')) return 'Snelwegen zijn beschikbaar vanaf level 4.';
    Object.assign(hw.settings, patch);
    this.emit('changed', { what: 'highways' });
    return null;
  }

  tick(dt: number): void {
    if (this.speed <= 0) return;
    const dm = dt * this.speed;
    const prevDay = this.day();
    this.time += dm;
    this.minuteAcc += dm;
    const hr = Math.floor(this.hour());
    for (const c of this.cities) {
      const v = HOURLY_DEMAND[hr] * 4200 * dm / 60;
      c.hourly[hr] += v;
      c.stats.pt += v;
      c.stats.delivered += v * 0.9;
      c.stats.trips += v * 7;
      c.stats.walk += v * 1.6;
      c.stats.bike += v * 2.8;
      c.stats.car += v * 1.6;
    }
    if (this.minuteAcc > 0.5) {
      const earn = this.minuteAcc * (20 + HOURLY_DEMAND[hr] * 600);
      this.money += earn;
      this.ledgerToday.fares += earn;
      this.xp += this.minuteAcc * 0.8;
      for (const l of this.lines.values()) {
        l.paxToday += this.minuteAcc * HOURLY_DEMAND[hr] * 40;
        l.revenueToday += this.minuteAcc * HOURLY_DEMAND[hr] * 60;
        l.costToday += this.minuteAcc * 1.2;
      }
      this.minuteAcc = 0;
    }
    if (this.day() !== prevDay) {
      this.ledgerYesterday = this.ledgerToday;
      this.ledgerToday = emptyLedger();
      for (const c of this.cities) {
        c.statsYesterday = c.stats;
        c.stats = emptyStats();
        c.hourly.fill(0);
      }
      this.emit('day', { day: prevDay + 1, ledger: this.ledgerYesterday });
    }
  }

  serialize(): SaveData {
    return {
      v: 1, money: this.money, xp: this.xp, time: this.time, startCity: this.startCity, cities: this.cities.map((c) => c.def.id),
      stops: [...this.stops.values()].map((s) => s.d), lines: [...this.lines.values()].map((l) => l.d), edits: {}, highways: {}, reputation: {}, nextId: this.nextId, totalDelivered: this.totalDelivered,
    };
  }

  on<K extends keyof GameEventMap>(ev: K, cb: (p: GameEventMap[K]) => void): Unsub {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(cb as (p: unknown) => void);
    return () => s!.delete(cb as (p: unknown) => void);
  }
  emit<K extends keyof GameEventMap>(ev: K, p: GameEventMap[K]): void {
    this.listeners.get(ev)?.forEach((cb) => cb(p));
  }
}

export async function createFakeGame(_save: SaveData | null, _start: string, onStatus: (s: string) => void): Promise<IGame> {
  for (const s of ['Kaartgegevens laden…', 'Wegennet opbouwen…', 'Woonwijken en kantoren analyseren…']) {
    onStatus(s);
    await new Promise((r) => setTimeout(r, 400));
  }
  return new FakeGame();
}
