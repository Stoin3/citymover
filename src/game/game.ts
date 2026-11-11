// Game core: owns cities, transit network, vehicles, passengers, economy and
// progression. Implements the IGame contract from ./api.ts.
import {
  MODES, MODE_LIST, FEATURES, START_MONEY, MAX_WAIT_MIN, ROAD_EDIT_COST, CONTROL_FEATURE, CONTROL_COST,
  ACCIDENT_CLAIM, BUS_ACCIDENT_REPAIR, SUBSIDY_PER_1000, SUBSIDY_PER_PAX, SUBSIDY_FULL_PAX_PER_1000, VEHICLE_RESALE,
  blockAt, levelFromXp, maxCities, cityUnlockCost, type ModeId,
} from '../config';
import { CITY_BY_ID, neighbours, type CityDef } from '../data/cities';
import type { CityData } from '../osm/parse';
import { loadCityData, loadCorridor, type CorridorData } from '../osm/loader';
import { toX, toY } from '../geo';
import { CitySim, type Accident } from '../sim/city';
import { RoadGraph, type RouteKind } from '../sim/graph';
import { PassengerPool, P_WALK_TO_STOP, P_WAITING, P_RIDING, P_WALK_TO_DEST } from '../sim/agents';
import {
  Line, Stop, buildLineRoute, routePoint, newLineData, type LineData, type StopData, type Vehicle, type RouteContext,
} from '../sim/transit';
import { TransitNet, WALK_SPEED } from '../sim/network';
import { Intercity, HIGHWAY_LANE_COST, HIGHWAY_SPEED_COST, type IntercityHost } from './intercity';
import type {
  IGame, GameEventMap, Ledger, SaveData, ToastKind, Unsub, HighwayLink, HighwayCar, HighwaySettings,
} from './api';

/** Where city / corridor data comes from (injectable for tests). */
export interface DataProvider {
  city(def: CityDef, onStatus: (s: string) => void): Promise<CityData>;
  corridor(kind: 'rail' | 'road', a: CityDef, b: CityDef): Promise<CorridorData | null>;
}

const defaultProvider: DataProvider = { city: loadCityData, corridor: loadCorridor };

const MAX_PASSENGERS = 60_000;
const PATHS_PER_FRAME = 10;

const LINE_PREFIX: Record<ModeId, string> = { bus: '', tram: 'T', metro: 'M', train: 'IC', coach: 'X', plane: 'VL' };
const PALETTE: [number, number, number][] = [
  [230, 57, 70], [29, 120, 200], [42, 157, 143], [244, 162, 97], [131, 56, 236], [255, 0, 110],
  [6, 214, 160], [255, 183, 3], [17, 138, 178], [231, 111, 81], [90, 90, 90], [160, 100, 40],
];

export function emptyLedger(): Ledger {
  return { fares: 0, subsidy: 0, operations: 0, construction: 0, vehicles: 0, accidents: 0 };
}

export function eur(n: number): string {
  return '€' + Math.round(n).toLocaleString('nl-NL');
}

function kindFor(mode: ModeId): RouteKind {
  return mode === 'tram' ? 'tram' : mode === 'train' ? 'rail' : 'bus';
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sampleRow(c: Float64Array, off: number, n: number): number {
  const total = c[off + n - 1];
  if (!(total > 0)) return Math.floor(Math.random() * n);
  const r = Math.random() * total;
  let lo = 0,
    hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[off + mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type AnyListener = (p: unknown) => void;

export class Game implements IGame {
  money = START_MONEY;
  xp = 0;
  time = 6 * 60;
  speed = 1;
  cities: CitySim[] = [];
  startCity = '';
  stops = new Map<number, Stop>();
  lines = new Map<number, Line>();
  vehicles: Vehicle[] = [];
  passengers = new PassengerPool(4096);
  net = new TransitNet();
  ledgerToday: Ledger = emptyLedger();
  ledgerYesterday: Ledger = emptyLedger();
  totalDelivered = 0;
  maxEntities = 12000;
  nextId = 1;
  intercity: Intercity;

  private provider: DataProvider;
  private listeners = new Map<string, Set<AnyListener>>();
  private netDirty = true;
  private lastNetTime = -1e9;
  private lastLevel = 1;
  private vehicleSeq = 0;
  private budget = { n: 0 };
  private tmp = new Float64Array(3);
  private onTransitFns: ((o: number, d: number, ox: number, oy: number, dx: number, dy: number) => boolean)[] = [];
  private onAccidentFn = (a: Accident) => this.cityAccident(a);
  private corridorState = new Map<string, RoadGraph | null | 'pending'>();
  private corridorPromise = new Map<string, Promise<RoadGraph | null>>();
  private trackLen = new Map<number, number>();
  private shortageToast = new Map<number, number>();
  private unlocking = false;

  private ctx: RouteContext = {
    graphFor: (stop, kind) => {
      const c = this.cityById(stop.d.city);
      if (!c) return null;
      return kind === 'rail' ? c.R : c.G;
    },
    corridor: (kind, a, b) => this.corridorFor(kind, a.d.city, b.d.city),
  };

  constructor(provider: DataProvider = defaultProvider) {
    this.provider = provider;
    const self = this;
    const host: IntercityHost = {
      get time() {
        return self.time;
      },
      get cities() {
        return self.cities;
      },
      get net() {
        return self.net;
      },
      toast: (m, k) => this.toast(m, k),
      accident: (a, where) => this.accident(a, where),
      changed: (w) => this.emit('changed', { what: w }),
      corridorGraph: (kind, a, b) => this.corridorGraph(kind, a, b),
      spawnIntercity: (from, to, legs) => this.spawnIntercity(from, to, legs),
    };
    this.intercity = new Intercity(host);
  }

  // ------------------------------------------------------------------ state getters

  get level(): number {
    return levelFromXp(this.xp);
  }
  get highways(): HighwayLink[] {
    return this.intercity.links;
  }
  get highwayCars(): HighwayCar[] {
    return this.intercity.cars;
  }

  // ------------------------------------------------------------------ init / persistence

  init(save: SaveData | null, startCityId: string, data: Map<string, CityData>): void {
    if (save) {
      this.money = save.money;
      this.xp = save.xp;
      this.time = save.time;
      this.nextId = save.nextId;
      this.totalDelivered = save.totalDelivered || 0;
      this.startCity = save.startCity;
      this.intercity.saved = { ...(save.highways || {}) };
      for (const id of save.cities) {
        const def = CITY_BY_ID.get(id);
        const d = data.get(id);
        if (!def || !d) continue;
        const c = this.addCity(def, d);
        c.applyEdits(save.edits?.[id]);
        const rep = save.reputation?.[id];
        if (typeof rep === 'number') c.reputation = rep;
      }
      for (const sd of save.stops) {
        const s = new Stop({ ...sd });
        s.j = this.snapLoadedStop(s);
        this.stops.set(s.d.id, s);
      }
      for (const ld of save.lines) {
        const line = new Line({ ...ld, stops: ld.stops.slice(), freq: ld.freq.slice(), color: [...ld.color] as [number, number, number] });
        this.lines.set(ld.id, line);
        const stops = line.d.stops.map((id) => this.stops.get(id)).filter((s): s is Stop => !!s);
        line.d.stops = stops.map((s) => s.d.id);
        if (stops.length >= 2) {
          buildLineRoute(line, stops, this.ctx);
          for (const dir of line.dirs) dir.nextDispatch = this.time;
          if (line.valid) this.trackLen.set(line.id, line.dirs[0].length);
        }
      }
      for (const s of this.stops.values()) this.nextId = Math.max(this.nextId, s.d.id + 1);
      for (const l of this.lines.values()) this.nextId = Math.max(this.nextId, l.d.id + 1);
    } else {
      const def = CITY_BY_ID.get(startCityId);
      const d = data.get(startCityId);
      if (!def || !d) throw new Error('Onbekende startstad: ' + startCityId);
      this.startCity = startCityId;
      this.addCity(def, d);
    }
    if (!this.cities.length) throw new Error('Geen steden geladen');
    this.lastLevel = this.level;
    this.intercity.syncLinks();
    this.rebuildNet();
  }

  private snapLoadedStop(s: Stop): number {
    const c = this.cityById(s.d.city);
    if (!c) return -1;
    const m = s.d.mode;
    if (m === 'bus' || m === 'tram' || m === 'coach') return c.G.nearestJunction(s.d.x, s.d.y, 60);
    if (m === 'train') return c.R ? c.R.nearestJunction(s.d.x, s.d.y, 120) : -1;
    return -1;
  }

  private addCity(def: CityDef, data: CityData): CitySim {
    const c = new CitySim(def, data, this.cities.length);
    this.cities.push(c);
    this.onTransitFns.push((o, d, ox, oy, dx, dy) => this.spawnLocalTransit(c, o, d, ox, oy, dx, dy));
    return c;
  }

  serialize(): SaveData {
    const edits: SaveData['edits'] = {};
    const reputation: SaveData['reputation'] = {};
    for (const c of this.cities) {
      edits[c.def.id] = c.serializeEdits();
      reputation[c.def.id] = Math.round(c.reputation * 100) / 100;
    }
    const highways: Record<string, HighwaySettings> = { ...this.intercity.saved };
    for (const l of this.intercity.links) highways[l.key] = { ...l.settings };
    return {
      v: 1,
      money: Math.round(this.money),
      xp: this.xp,
      time: this.time,
      startCity: this.startCity,
      cities: this.cities.map((c) => c.def.id),
      stops: [...this.stops.values()].map((s) => ({ ...s.d })),
      lines: [...this.lines.values()].map((l) => ({
        ...l.d,
        stops: l.d.stops.slice(),
        freq: l.d.freq.slice(),
        color: [...l.d.color] as [number, number, number],
      })),
      edits,
      highways,
      reputation,
      nextId: this.nextId,
      totalDelivered: this.totalDelivered,
    };
  }

  // ------------------------------------------------------------------ events

  on<K extends keyof GameEventMap>(ev: K, cb: (p: GameEventMap[K]) => void): Unsub {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    const f = cb as AnyListener;
    s.add(f);
    return () => {
      s!.delete(f);
    };
  }

  emit<K extends keyof GameEventMap>(ev: K, p: GameEventMap[K]): void {
    const s = this.listeners.get(ev);
    if (!s) return;
    for (const cb of [...s]) {
      try {
        cb(p);
      } catch (e) {
        console.error('listener error', ev, e);
      }
    }
  }

  toast(msg: string, kind: ToastKind = 'info'): void {
    this.emit('toast', { msg, kind });
  }

  private spend(amount: number, cat: keyof Ledger): void {
    this.money -= amount;
    this.ledgerToday[cat] += amount;
  }
  private earn(amount: number, cat: 'fares' | 'subsidy'): void {
    this.money += amount;
    this.ledgerToday[cat] += amount;
  }

  // ------------------------------------------------------------------ queries

  hour(): number {
    return (((this.time % 1440) + 1440) % 1440) / 60;
  }
  day(): number {
    return Math.floor(this.time / 1440);
  }
  hasFeature(featureId: string): boolean {
    const f = FEATURES.find((x) => x.id === featureId);
    return !!f && this.level >= f.level;
  }
  modeUnlocked(mode: ModeId): boolean {
    return this.level >= MODES[mode].unlockLevel;
  }
  cityById(id: string): CitySim | undefined {
    return this.cities.find((c) => c.def.id === id);
  }
  cityAt(x: number, y: number): CitySim | undefined {
    let best: CitySim | undefined,
      bd = Infinity;
    for (const c of this.cities) {
      const d = Math.hypot(x - c.cx, y - c.cy);
      if (d <= c.radius * 1.05 && d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }
  allAccidents(): Accident[] {
    const out: Accident[] = [];
    for (const c of this.cities) for (const a of c.accidents) out.push(a);
    for (const a of this.intercity.accidents) out.push(a);
    return out;
  }

  canUnlockCity(id: string): { ok: boolean; reason: string; cost: number } {
    const def = CITY_BY_ID.get(id);
    if (!def) return { ok: false, reason: 'Onbekende stad.', cost: 0 };
    const cost = cityUnlockCost(def.population);
    if (this.cityById(id)) return { ok: false, reason: 'Deze stad is al ontgrendeld.', cost };
    if (!this.cities.some((c) => neighbours(c.def.id).includes(id)))
      return { ok: false, reason: 'Deze stad grenst niet aan een van je steden.', cost };
    const lvl = this.level;
    if (this.cities.length >= maxCities(lvl)) {
      let l = lvl;
      while (maxCities(l) <= this.cities.length && l < 200) l++;
      return { ok: false, reason: `Bereik niveau ${l} om een extra stad te ontgrendelen.`, cost };
    }
    if (this.money < cost) return { ok: false, reason: `Niet genoeg geld (${eur(cost)} nodig).`, cost };
    return { ok: true, reason: '', cost };
  }

  lineCostEstimate(mode: ModeId, stopIds: number[]): number {
    const def = MODES[mode];
    if (!def.infraPerKm) return 0;
    let len = 0;
    let prev: Stop | undefined;
    for (const id of stopIds) {
      const s = this.stops.get(id);
      if (!s) continue;
      if (prev) len += Math.hypot(s.x - prev.x, s.y - prev.y) * (mode === 'tram' ? 1.3 : 1);
      prev = s;
    }
    return Math.round(((len / 1000) * def.infraPerKm) / 1000) * 1000;
  }

  // ------------------------------------------------------------------ cities

  async unlockCity(id: string): Promise<string | null> {
    const chk = this.canUnlockCity(id);
    if (!chk.ok) return chk.reason;
    if (this.unlocking) return 'Er wordt al een stad geladen.';
    const def = CITY_BY_ID.get(id)!;
    this.unlocking = true;
    try {
      this.emit('cityLoading', { id, status: 'Kaart laden…' });
      const data = await this.provider.city(def, (s) => this.emit('cityLoading', { id, status: s }));
      const chk2 = this.canUnlockCity(id);
      if (!chk2.ok) return chk2.reason;
      this.emit('cityLoading', { id, status: 'Stad opbouwen…' });
      this.spend(chk2.cost, 'construction');
      this.addCity(def, data);
      this.intercity.syncLinks();
      this.netDirty = true;
      this.rebuildNet();
      this.emit('changed', { what: 'cities' });
      this.toast(`${def.name} is ontgrendeld!`, 'good');
      return null;
    } catch (e) {
      return 'Kon de kaart niet laden: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      this.unlocking = false;
      this.emit('cityLoading', { id, status: null });
    }
  }

  // ------------------------------------------------------------------ corridors

  private corridorKey(kind: string, a: string, b: string): string {
    return a < b ? `${kind}:${a}:${b}` : `${kind}:${b}:${a}`;
  }

  corridorGraph(kind: 'rail' | 'road', a: CityDef, b: CityDef): Promise<RoadGraph | null> {
    const key = this.corridorKey(kind, a.id, b.id);
    let p = this.corridorPromise.get(key);
    if (!p) {
      p = this.provider
        .corridor(kind, a, b)
        .then((d) => (d && d.nodes.length && d.ways.length ? RoadGraph.build(d.nodes, d.ways, [], kind === 'rail') : null))
        .catch(() => null);
      this.corridorPromise.set(key, p);
    }
    return p;
  }

  private corridorFor(kind: 'rail' | 'road', ida: string, idb: string): RoadGraph | null | 'pending' {
    const key = this.corridorKey(kind, ida, idb);
    const st = this.corridorState.get(key);
    if (st !== undefined) return st;
    const a = CITY_BY_ID.get(ida),
      b = CITY_BY_ID.get(idb);
    if (!a || !b) return null;
    this.corridorState.set(key, 'pending');
    this.corridorGraph(kind, a, b).then((g) => {
      this.corridorState.set(key, g);
      let any = false;
      for (const line of this.lines.values()) {
        if (!line.pendingCorridor) continue;
        this.rebuildLine(line);
        any = true;
      }
      if (any) {
        this.netDirty = true;
        this.emit('changed', { what: 'lines' });
      }
    });
    return 'pending';
  }

  // ------------------------------------------------------------------ stops

  addStop(mode: ModeId, x: number, y: number): Stop | string {
    const def = MODES[mode];
    if (!def) return 'Onbekend vervoermiddel.';
    if (!this.modeUnlocked(mode)) return `${def.name} wordt ontgrendeld op niveau ${def.unlockLevel}.`;
    let city: CitySim | undefined;
    let sx = x,
      sy = y,
      j = -1,
      name = '';
    if (mode === 'plane') {
      let bd = 4000;
      for (const c of this.cities) {
        const ap = c.def.airport;
        if (!ap) continue;
        const ax = toX(ap.lon),
          ay = toY(ap.lat);
        const d = Math.hypot(ax - x, ay - y);
        if (d <= bd) {
          bd = d;
          city = c;
          sx = ax;
          sy = ay;
          name = ap.name;
        }
      }
      if (!city) return 'Een luchthaven kan alleen bij een bestaand vliegveld van een ontgrendelde stad.';
    } else {
      city = this.cityAt(x, y);
      if (!city) return 'Je kunt alleen haltes plaatsen binnen een ontgrendelde stad.';
      const c = city;
      if (mode === 'bus' || mode === 'tram' || mode === 'coach') {
        j = c.G.nearestJunction(x, y, 150, (k) => c.inCore[k] === 1);
        if (j < 0) return 'Plaats de halte op of vlak bij een weg.';
        sx = c.G.jx[j];
        sy = c.G.jy[j];
        name = c.junctionName(j);
      } else if (mode === 'train') {
        if (!c.R) return 'Deze stad heeft geen spoorlijnen.';
        let tx = x,
          ty = y,
          stName = '';
        let bd = 400;
        for (const st of c.data.stations) {
          if (st.t !== 0) continue;
          const stx = toX(st.lon),
            sty = toY(st.lat);
          const d = Math.hypot(stx - x, sty - y);
          if (d <= bd) {
            bd = d;
            tx = stx;
            ty = sty;
            stName = st.nm;
          }
        }
        j = c.R.nearestJunction(tx, ty, 300);
        if (j < 0 && stName) j = c.R.nearestJunction(x, y, 300);
        if (j < 0) return 'Een treinstation moet op of vlak bij het spoor liggen.';
        sx = c.R.jx[j];
        sy = c.R.jy[j];
        if (stName) name = stName;
        else {
          const rj = c.G.nearestJunction(sx, sy, 400);
          name = (rj >= 0 ? c.junctionName(rj) : c.def.name) + ' (station)';
        }
      } else {
        // metro: free placement
        if (!c.contains(x, y, 1.0)) return 'Metrostations moeten binnen de stad liggen.';
        const rj = c.G.nearestJunction(x, y, 400);
        name = rj >= 0 ? c.junctionName(rj) : c.def.name + ' Centrum';
      }
    }
    if (!name || name === 'Kruispunt') name = city.def.name + ' ' + (this.stops.size + 1);
    for (const s of this.stops.values()) {
      if (s.d.mode !== mode) continue;
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < def.minStopSpacing)
        return `Te dicht bij "${s.d.name}" (minimaal ${def.minStopSpacing.toLocaleString('nl-NL')} m tussen ${def.name.toLowerCase()}haltes).`;
    }
    if (this.money < def.stopCost) return `Niet genoeg geld (${eur(def.stopCost)} nodig).`;
    // unique-ish name
    const base = name;
    let n = 2;
    const taken = (nm: string) => {
      for (const s of this.stops.values()) if (s.d.mode === mode && s.d.name === nm) return true;
      return false;
    };
    while (taken(name)) name = `${base} (${n++})`;
    const sd: StopData = { id: this.nextId++, name, x: sx, y: sy, city: city.def.id, mode };
    const stop = new Stop(sd);
    stop.j = j;
    this.stops.set(sd.id, stop);
    this.spend(def.stopCost, 'construction');
    this.emit('changed', { what: 'stops' });
    return stop;
  }

  removeStop(id: number): string | null {
    const s = this.stops.get(id);
    if (!s) return 'Halte bestaat niet.';
    for (const l of this.lines.values())
      if (l.d.stops.includes(id)) return `Halte wordt gebruikt door lijn ${l.d.name}. Haal hem eerst uit de lijn.`;
    this.stops.delete(id);
    this.emit('changed', { what: 'stops' });
    return null;
  }

  renameStop(id: number, name: string): void {
    const s = this.stops.get(id);
    const nm = name.trim().slice(0, 60);
    if (!s || !nm) return;
    s.d.name = nm;
    this.emit('changed', { what: 'stops' });
  }

  // ------------------------------------------------------------------ lines

  createLine(mode: ModeId): Line | string {
    const def = MODES[mode];
    if (!def) return 'Onbekend vervoermiddel.';
    if (!this.modeUnlocked(mode)) return `${def.name} wordt ontgrendeld op niveau ${def.unlockLevel}.`;
    const used = new Set([...this.lines.values()].map((l) => l.d.name));
    let n = 1;
    while (used.has(LINE_PREFIX[mode] + n)) n++;
    const sameMode = [...this.lines.values()].filter((l) => l.d.mode === mode).length;
    const color: [number, number, number] = sameMode === 0 ? [...def.color] as [number, number, number] : [...PALETTE[(this.lines.size + sameMode) % PALETTE.length]] as [number, number, number];
    const d = newLineData(this.nextId++, mode, LINE_PREFIX[mode] + n, color);
    const line = new Line(d);
    this.lines.set(d.id, line);
    this.emit('changed', { what: 'lines' });
    return line;
  }

  setLineStops(lineId: number, stopIds: number[]): string | null {
    const line = this.lines.get(lineId);
    if (!line) return 'Lijn bestaat niet.';
    const def = line.def;
    if (!this.modeUnlocked(def.id)) return `${def.name} wordt ontgrendeld op niveau ${def.unlockLevel}.`;
    const stops: Stop[] = [];
    for (const id of stopIds) {
      const s = this.stops.get(id);
      if (!s) return 'Onbekende halte.';
      if (s.d.mode !== def.id) return `"${s.d.name}" is geen ${def.name.toLowerCase()}halte.`;
      if (stops.length && stops[stops.length - 1] === s) return 'Dezelfde halte staat twee keer achter elkaar.';
      stops.push(s);
    }
    if (stops.length < 2) return 'Een lijn heeft minimaal 2 haltes nodig.';
    const tmp = new Line({ ...line.d, stops: stopIds.slice() });
    buildLineRoute(tmp, stops, this.ctx);
    if (!tmp.valid) return tmp.error || 'Geen geldige route.';
    const newLen = tmp.dirs[0].length;
    const paid = this.trackLen.get(line.id) ?? 0;
    const infra = def.infraPerKm > 0 ? (Math.max(0, newLen - paid) / 1000) * def.infraPerKm : 0;
    if (infra > this.money) return `Niet genoeg geld: ${eur(infra)} nodig voor ${(Math.max(0, newLen - paid) / 1000).toFixed(1)} km baan.`;
    if (infra > 0) this.spend(infra, 'construction');
    const structural = !line.valid || !sameIds(line.d.stops, stopIds);
    if (structural) this.clearLine(line);
    this.applyRoute(line, tmp, !structural);
    line.d.stops = stopIds.slice();
    this.trackLen.set(line.id, newLen);
    if (structural) for (const dir of line.dirs) dir.nextDispatch = this.time;
    this.netDirty = true;
    this.emit('changed', { what: 'lines' });
    return null;
  }

  /** install geometry built on tmp into line; keep=true keeps vehicles and waiting passengers */
  private applyRoute(line: Line, tmp: Line, keep: boolean): void {
    const old = line.dirs;
    for (let d = 0; d < 2; d++) {
      const nd = tmp.dirs[d],
        od = old[d];
      nd.nextDispatch = od.nextDispatch;
      if (keep && od.waiting.length === nd.stops.length) nd.waiting = od.waiting;
      if (keep && od.segTime.length === nd.segTime.length) nd.segTime = od.segTime;
    }
    if (keep) {
      for (const v of line.vehicles) {
        const od = old[v.dir],
          nd = tmp.dirs[v.dir];
        const k = Math.max(1, Math.min(v.nextStop, nd.stopDist.length - 1));
        const a0 = od.stopDist[k - 1] ?? 0,
          a1 = od.stopDist[k] ?? a0;
        const f = a1 > a0 ? Math.max(0, Math.min(1, (v.s - a0) / (a1 - a0))) : 0;
        v.s = nd.stopDist[k - 1] + f * (nd.stopDist[k] - nd.stopDist[k - 1]);
        v.arcIdx = 0;
        v.ptHint = 0;
      }
    }
    line.dirs = tmp.dirs;
    line.valid = tmp.valid;
    line.error = tmp.error;
    line.pendingCorridor = tmp.pendingCorridor;
  }

  /** remove all vehicles and waiting passengers of a line (passengers count as failed) */
  private clearLine(line: Line): void {
    const P = this.passengers;
    for (const v of line.vehicles) {
      for (const p of v.pax) if (P.state[p] === P_RIDING) this.fail(p);
      v.pax.length = 0;
      v.nextStop = -1;
    }
    line.vehicles.length = 0;
    this.purgeVehicles();
    for (const dir of line.dirs)
      for (const q of dir.waiting) {
        for (const p of q) if (P.state[p] === P_WAITING) this.fail(p);
        q.length = 0;
      }
  }

  private purgeVehicles(): void {
    const vs = this.vehicles;
    let w = 0;
    for (let i = 0; i < vs.length; i++) if (vs[i].nextStop >= 0) vs[w++] = vs[i];
    vs.length = w;
  }

  /** re-route a line on its current stops (after road edits / corridor load) */
  private rebuildLine(line: Line): boolean {
    const stops = line.d.stops.map((id) => this.stops.get(id)).filter((s): s is Stop => !!s);
    if (stops.length < 2) return false;
    const tmp = new Line({ ...line.d });
    buildLineRoute(tmp, stops, this.ctx);
    if (!tmp.valid) {
      if (line.valid) {
        this.clearLine(line);
        line.valid = false;
        this.toast(`Lijn ${line.d.name} kan niet meer rijden: ${tmp.error}`, 'bad');
      }
      line.error = tmp.error;
      this.netDirty = true;
      return false;
    }
    const was = line.valid;
    this.applyRoute(line, tmp, was);
    if (!was) {
      for (const dir of line.dirs) dir.nextDispatch = this.time;
      this.toast(`Lijn ${line.d.name} rijdt weer.`, 'good');
    }
    this.trackLen.set(line.id, Math.max(this.trackLen.get(line.id) ?? 0, line.dirs[0].length));
    this.netDirty = true;
    return true;
  }

  updateLine(lineId: number, patch: Partial<Pick<LineData, 'name' | 'color' | 'fareBase' | 'fareKm' | 'freq'>>): void {
    const line = this.lines.get(lineId);
    if (!line) return;
    const d = line.d;
    if (patch.name !== undefined && patch.name.trim()) d.name = patch.name.trim().slice(0, 24);
    if (patch.color) d.color = [...patch.color] as [number, number, number];
    if (patch.fareBase !== undefined && isFinite(patch.fareBase)) {
      d.fareBase = Math.max(0, Math.min(200, patch.fareBase));
      this.netDirty = true;
    }
    if (patch.fareKm !== undefined && isFinite(patch.fareKm)) {
      d.fareKm = Math.max(0, Math.min(5, patch.fareKm));
      this.netDirty = true;
    }
    if (patch.freq) {
      d.freq = d.freq.map((f, i) => {
        const v = patch.freq![i];
        return v === undefined || !isFinite(v) ? f : Math.max(0, Math.min(60, v));
      });
      this.netDirty = true;
    }
    this.emit('changed', { what: 'lines' });
  }

  deleteLine(lineId: number): void {
    const line = this.lines.get(lineId);
    if (!line) return;
    this.clearLine(line);
    if (line.d.fleet > 0) {
      const refund = line.d.fleet * line.def.vehiclePrice * VEHICLE_RESALE;
      this.money += refund;
      this.ledgerToday.vehicles -= refund;
    }
    this.lines.delete(lineId);
    this.trackLen.delete(lineId);
    this.shortageToast.delete(lineId);
    this.netDirty = true;
    this.emit('changed', { what: 'lines' });
  }

  buyVehicles(lineId: number, n: number): string | null {
    const line = this.lines.get(lineId);
    if (!line) return 'Lijn bestaat niet.';
    n = Math.floor(n);
    if (!(n > 0)) return 'Ongeldig aantal.';
    const cost = n * line.def.vehiclePrice;
    if (this.money < cost) return `Niet genoeg geld (${eur(cost)} nodig).`;
    this.spend(cost, 'vehicles');
    line.d.fleet += n;
    this.netDirty = true;
    this.emit('changed', { what: 'lines' });
    return null;
  }

  sellVehicles(lineId: number, n: number): string | null {
    const line = this.lines.get(lineId);
    if (!line) return 'Lijn bestaat niet.';
    n = Math.floor(n);
    if (!(n > 0)) return 'Ongeldig aantal.';
    if (n > line.d.fleet) return 'Zoveel voertuigen heeft deze lijn niet.';
    line.d.fleet -= n;
    const refund = n * line.def.vehiclePrice * VEHICLE_RESALE;
    this.money += refund;
    this.ledgerToday.vehicles -= refund;
    this.netDirty = true;
    this.emit('changed', { what: 'lines' });
    return null;
  }

  // ------------------------------------------------------------------ road edits

  private roadCheck(cityIndex: number, feature: string, cost: number): CitySim | string {
    const c = this.cities[cityIndex];
    if (!c) return 'Onbekende stad.';
    if (!this.hasFeature(feature)) {
      const f = FEATURES.find((x) => x.id === feature);
      return f ? `${f.name} wordt ontgrendeld op niveau ${f.level}.` : 'Niet beschikbaar.';
    }
    if (this.money < cost) return `Niet genoeg geld (${eur(cost)} nodig).`;
    return c;
  }

  private roadsChanged(c: CitySim, structural: boolean, edge = -1): void {
    if (structural) c.G.rebuildAdjacency();
    else {
      // invalidates cached car paths; the strongly connected core is unaffected
      const coreOk = c.coreVersion === c.G.version;
      c.G.version++;
      if (coreOk) c.coreVersion = c.G.version;
    }
    c.ensureCaches();
    if (structural) {
      // re-route bus/coach lines that use this edge, and retry broken ones
      let any = false;
      for (const line of this.lines.values()) {
        const r = line.def.routing;
        if (r !== 'road' && r !== 'highway' && r !== 'tram') continue;
        const inCity = line.d.stops.some((id) => this.stops.get(id)?.d.city === c.def.id);
        if (!inCity) continue;
        let uses = !line.valid;
        if (!uses && r !== 'tram')
          for (const dir of line.dirs) {
            for (let i = 0; i < dir.arcs.length; i++)
              if (dir.arcG[i] === c.G && dir.arcs[i] >> 1 === edge) {
                uses = true;
                break;
              }
            if (uses) break;
          }
        if (uses) {
          this.rebuildLine(line);
          any = true;
        }
      }
      if (any) this.emit('changed', { what: 'lines' });
    }
    this.emit('changed', { what: 'roads' });
  }

  setEdgeSpeed(cityIndex: number, edge: number, kmh: number): string | null {
    const chk = this.roadCheck(cityIndex, 'speed', ROAD_EDIT_COST.speed);
    if (typeof chk === 'string') return chk;
    const G = chk.G;
    if (!(edge >= 0 && edge < G.nE)) return 'Onbekende weg.';
    const v = Math.max(15, Math.min(130, Math.round(kmh / 5) * 5));
    if (G.eSpeed[edge] === v) return null;
    G.eSpeed[edge] = v;
    this.spend(ROAD_EDIT_COST.speed, 'construction');
    this.roadsChanged(chk, false);
    return null;
  }

  setEdgeOneway(cityIndex: number, edge: number, oneway: -1 | 0 | 1): string | null {
    const chk = this.roadCheck(cityIndex, 'oneway', ROAD_EDIT_COST.oneway);
    if (typeof chk === 'string') return chk;
    const G = chk.G;
    if (!(edge >= 0 && edge < G.nE)) return 'Onbekende weg.';
    const o = oneway > 0 ? 1 : oneway < 0 ? -1 : 0;
    if (G.eOneway[edge] === o) return null;
    const oldLanes = G.lanesDir(edge);
    G.eOneway[edge] = o;
    // keep the physical road width: two-way -> one-way keeps total lanes
    if (G.eBus[edge] && G.lanesDir(edge) < 2) G.eBus[edge] = 0;
    void oldLanes;
    this.spend(ROAD_EDIT_COST.oneway, 'construction');
    this.roadsChanged(chk, true, edge);
    return null;
  }

  setEdgeLanes(cityIndex: number, edge: number, lanes: number): string | null {
    const c0 = this.cities[cityIndex];
    if (!c0) return 'Onbekende stad.';
    const G0 = c0.G;
    if (!(edge >= 0 && edge < G0.nE)) return 'Onbekende weg.';
    const l = Math.max(1, Math.min(6, Math.round(lanes)));
    const added = l - G0.eLanes[edge];
    if (added === 0) return null;
    const cost = added > 0 ? added * ROAD_EDIT_COST.lanes : ROAD_EDIT_COST.oneway;
    const chk = this.roadCheck(cityIndex, 'lanes', cost);
    if (typeof chk === 'string') return chk;
    G0.eLanes[edge] = l;
    if (G0.eBus[edge] && G0.lanesDir(edge) < 2) G0.eBus[edge] = 0;
    this.spend(cost, 'construction');
    this.roadsChanged(chk, false);
    return null;
  }

  setEdgeBusLane(cityIndex: number, edge: number, on: boolean): string | null {
    const cost = on ? ROAD_EDIT_COST.buslane : ROAD_EDIT_COST.speed;
    const chk = this.roadCheck(cityIndex, 'buslane', cost);
    if (typeof chk === 'string') return chk;
    const G = chk.G;
    if (!(edge >= 0 && edge < G.nE)) return 'Onbekende weg.';
    if (!!G.eBus[edge] === on) return null;
    if (on && G.lanesDir(edge) < 2) return 'Een busbaan vraagt minstens 2 rijstroken per richting.';
    G.eBus[edge] = on ? 1 : 0;
    this.spend(cost, 'construction');
    this.roadsChanged(chk, false);
    return null;
  }

  setJunctionControl(cityIndex: number, junction: number, ctrl: number): string | null {
    ctrl = Math.round(ctrl);
    if (!(ctrl >= 0 && ctrl <= 5)) return 'Onbekende regeling.';
    const cost = CONTROL_COST[ctrl];
    const chk = this.roadCheck(cityIndex, CONTROL_FEATURE[ctrl], cost);
    if (typeof chk === 'string') return chk;
    const G = chk.G;
    if (!(junction >= 0 && junction < G.nJ)) return 'Onbekend kruispunt.';
    if (G.jCtrl[junction] === ctrl) return null;
    G.jCtrl[junction] = ctrl;
    this.spend(cost, 'construction');
    this.roadsChanged(chk, false);
    return null;
  }

  setHighway(key: string, patch: Partial<HighwaySettings>): string | null {
    if (!this.hasFeature('highway')) {
      const f = FEATURES.find((x) => x.id === 'highway')!;
      return `${f.name} worden ontgrendeld op niveau ${f.level}.`;
    }
    const link = this.intercity.linkByKey(key);
    if (!link) return 'Onbekende snelweg.';
    const s = link.settings;
    const speed = patch.speed !== undefined ? Math.max(80, Math.min(130, Math.round(patch.speed / 10) * 10)) : s.speed;
    const lanes = patch.lanes !== undefined ? Math.max(2, Math.min(5, Math.round(patch.lanes))) : s.lanes;
    const cost = (speed !== s.speed ? HIGHWAY_SPEED_COST : 0) + Math.max(0, lanes - s.lanes) * HIGHWAY_LANE_COST;
    if (speed === s.speed && lanes === s.lanes) return null;
    if (this.money < cost) return `Niet genoeg geld (${eur(cost)} nodig).`;
    s.speed = speed;
    s.lanes = lanes;
    if (cost > 0) this.spend(cost, 'construction');
    this.emit('changed', { what: 'highways' });
    return null;
  }

  // ------------------------------------------------------------------ main loop

  tick(realDtSec: number): void {
    if (!(realDtSec > 0) || !(this.speed > 0)) return;
    const real = Math.min(realDtSec, 0.1);
    const simDt = real * this.speed * 60;
    const n = Math.max(1, Math.ceil(simDt / 3));
    const dt = simDt / n;
    // car/bike path searches per frame, fewer on big road graphs (cost per search ~ graph size)
    let nJ = 0;
    for (const c of this.cities) nJ += c.G.nJ;
    this.budget.n = Math.max(3, Math.min(PATHS_PER_FRAME, Math.round(40000 / Math.max(1, nJ))));
    for (let i = 0; i < n; i++) this.step(dt);
  }

  private step(dt: number): void {
    const prev = this.time;
    this.time += dt / 60;
    const now = this.time;
    const dtMin = dt / 60;
    for (const c of this.cities) {
      c.generateTrips(now, dtMin, this.budget, this.maxEntities, this.onTransitFns[c.index]);
      c.tickTraffic(dt, now, this.onAccidentFn);
    }
    this.dispatch();
    this.moveVehicles(dt);
    this.movePassengers(dt);
    this.intercity.tick(dt);
    if (Math.floor(now) !== Math.floor(prev)) this.minute();
    if (Math.floor(now / 1440) !== Math.floor(prev / 1440)) this.newDay();
  }

  private minute(): void {
    const now = this.time;
    for (const c of this.cities) c.minuteUpdate(now);
    this.giveUp(now);
    // hourly operating cost per active vehicle
    for (const line of this.lines.values()) {
      const n = line.vehicles.length;
      if (!n) continue;
      const c = (n * line.def.opCostHour) / 60;
      this.spend(c, 'operations');
      line.costToday += c;
    }
    const block = blockAt(this.hour());
    if (this.netDirty || block !== this.net.block || now - this.lastNetTime >= 30) this.rebuildNet();
    this.intercity.minute(now);
    this.updateStopWaiting();
    this.checkLevel();
  }

  rebuildNet(): void {
    for (const line of this.lines.values()) {
      if (line.loadSamples > 0) {
        line.crowding = line.loadSum / line.loadSamples;
        line.loadSum = 0;
        line.loadSamples = 0;
      } else line.crowding *= 0.5;
    }
    this.net.build([...this.lines.values()], blockAt(this.hour()));
    for (const c of this.cities) c.updateTransitSkims(this.net);
    this.intercity.updateSkims();
    this.netDirty = false;
    this.lastNetTime = this.time;
  }

  private updateStopWaiting(): void {
    for (const s of this.stops.values()) s.waiting = 0;
    for (const line of this.lines.values())
      for (const dir of line.dirs)
        for (let k = 0; k < dir.stops.length && k < dir.waiting.length; k++) dir.stops[k].waiting += dir.waiting[k].length;
  }

  private checkLevel(): void {
    const L = this.level;
    if (L <= this.lastLevel) return;
    const unlocked: string[] = [];
    for (let l = this.lastLevel + 1; l <= L; l++) {
      for (const m of MODE_LIST) if (m.unlockLevel === l) unlocked.push(m.name);
      for (const f of FEATURES) if (f.level === l) unlocked.push(f.name);
      if (maxCities(l) > maxCities(l - 1)) unlocked.push('Nieuwe stad beschikbaar');
    }
    this.lastLevel = L;
    this.emit('levelup', { level: L, unlocked });
    this.toast(`Niveau ${L} bereikt!${unlocked.length ? ' Nieuw: ' + unlocked.join(', ') : ''}`, 'good');
  }

  private newDay(): void {
    for (const c of this.cities) {
      const s = c.stats;
      const safety = 1 - Math.min(0.8, s.accidents * 0.03);
      const service = Math.min(1, s.delivered / Math.max(1, (c.def.population / 1000) * SUBSIDY_FULL_PAX_PER_1000));
      const sub = (c.def.population / 1000) * SUBSIDY_PER_1000 * service * safety + s.delivered * SUBSIDY_PER_PAX;
      if (sub > 0) this.earn(sub, 'subsidy');
      c.newDay();
    }
    this.ledgerYesterday = this.ledgerToday;
    this.ledgerToday = emptyLedger();
    for (const line of this.lines.values()) {
      line.paxYesterday = line.paxToday;
      line.revenueYesterday = line.revenueToday;
      line.costYesterday = line.costToday;
      line.paxToday = 0;
      line.revenueToday = 0;
      line.costToday = 0;
      line.shortage = 0;
    }
    for (const s of this.stops.values()) s.boardedToday = 0;
    this.emit('day', { day: this.day(), ledger: this.ledgerYesterday });
  }

  // ------------------------------------------------------------------ vehicles

  private dispatch(): void {
    const now = this.time;
    const block = blockAt(this.hour());
    for (const line of this.lines.values()) {
      if (!line.valid || line.d.fleet <= 0) continue;
      const f = line.freqAt(block);
      for (let d = 0; d < 2; d++) {
        const dir = line.dirs[d];
        if (dir.stops.length < 2) continue;
        if (f <= 0) {
          if (dir.nextDispatch < now) dir.nextDispatch = now;
          continue;
        }
        if (now < dir.nextDispatch) continue;
        const hw = 60 / f;
        const base = dir.nextDispatch < now - hw ? now : dir.nextDispatch;
        dir.nextDispatch = base + hw;
        if (line.vehicles.length < line.d.fleet) this.spawnVehicle(line, d);
        else {
          line.shortage++;
          const last = this.shortageToast.get(line.id) ?? -1e9;
          if (now - last > 180) {
            this.shortageToast.set(line.id, now);
            this.toast(`Lijn ${line.d.name}: te weinig voertuigen (${line.d.fleet} in bezit, ±${line.vehiclesNeeded()} nodig).`, 'warn');
          }
        }
      }
    }
  }

  private spawnVehicle(line: Line, d: number): void {
    const dir = line.dirs[d];
    const v: Vehicle = {
      id: ++this.vehicleSeq,
      line,
      dir: d,
      s: 0,
      arcIdx: 0,
      ptHint: 0,
      nextStop: 0,
      dwell: 0,
      delay: 0,
      pax: [],
      x: dir.pts[0],
      y: dir.pts[1],
      z: 0,
      h: 0,
      lastStopTime: this.time,
      speed: 0,
    };
    line.vehicles.push(v);
    this.vehicles.push(v);
    this.arrive(v, 0);
    if (v.nextStop >= 0) this.placeVehicle(v);
  }

  private moveVehicles(dt: number): void {
    const vs = this.vehicles;
    const now = this.time;
    let w = 0;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (v.nextStop >= 0) this.moveVehicle(v, dt, now);
      if (v.nextStop < 0) {
        const lv = v.line.vehicles;
        const k = lv.indexOf(v);
        if (k >= 0) lv.splice(k, 1);
        continue;
      }
      vs[w++] = v;
    }
    vs.length = w;
  }

  private moveVehicle(v: Vehicle, dt: number, now: number): void {
    const line = v.line,
      def = line.def,
      dir = line.dirs[v.dir];
    let rem = dt;
    if (v.dwell > 0) {
      if (v.dwell >= rem) {
        v.dwell -= rem;
        v.speed = 0;
        return;
      }
      rem -= v.dwell;
      v.dwell = 0;
    }
    const arcs = dir.arcs,
      as = dir.arcStart,
      nA = arcs.length;
    const kind = kindFor(def.id);
    const cruise = def.cruiseKmh;
    const straightV = (cruise / 3.6) * 0.82;
    let moved = 0;
    let guard = 0;
    while (rem > 1e-6 && guard++ < 64) {
      while (v.arcIdx < nA - 1 && v.s >= as[v.arcIdx + 1] - 1e-6) v.arcIdx++;
      const target = dir.stopDist[v.nextStop];
      const ai = v.arcIdx;
      const arc = nA ? arcs[ai] : -1;
      const G = nA ? dir.arcG[ai] : null;
      const spd = arc >= 0 && G ? G.arcSpeed(arc, kind, now, cruise) : straightV;
      v.speed = spd;
      const arcEnd = ai + 1 < as.length ? as[ai + 1] : dir.length;
      const end = Math.min(arcEnd, target);
      const ds = spd * rem;
      if (v.s + ds < end - 1e-6) {
        v.s += ds;
        moved += ds;
        rem = 0;
        break;
      }
      const stepLen = Math.max(0, end - v.s);
      moved += stepLen;
      rem -= stepLen / spd;
      v.s = end;
      if (end >= target - 1e-6) {
        this.arrive(v, v.nextStop);
        if (v.nextStop < 0) break;
        if (v.dwell >= rem) {
          v.dwell -= rem;
          rem = 0;
        } else {
          rem -= v.dwell;
          v.dwell = 0;
        }
      } else {
        v.arcIdx = Math.min(nA - 1, ai + 1);
        if (arc >= 0 && G && G.jDeg[G.arcTo(arc)] >= 3) {
          let jd = G.junctionDelay(arc) * (0.3 + Math.random() * 1.4);
          if (def.id === 'tram') jd *= 0.6;
          if (jd >= rem) {
            v.dwell = jd - rem;
            rem = 0;
            v.speed = 0;
          } else rem -= jd;
        }
      }
    }
    if (moved > 0) {
      const c = (moved / 1000) * def.opCostKm;
      this.spend(c, 'operations');
      line.costToday += c;
    }
    if (v.nextStop >= 0) this.placeVehicle(v);
  }

  private placeVehicle(v: Vehicle): void {
    const dir = v.line.dirs[v.dir];
    if (dir.cum.length < 2) return;
    const out = this.tmp;
    v.ptHint = routePoint(dir, v.s, v.ptHint, out);
    const h = out[2];
    const plane = v.line.def.id === 'plane';
    const off = plane ? 0 : 1.8;
    v.x = out[0] + Math.sin(h) * off;
    v.y = out[1] - Math.cos(h) * off;
    v.h = h;
    v.z = plane ? Math.min(3000, Math.min(v.s, dir.length - v.s) * 0.12) : 0;
  }

  /** vehicle reaches stop k of its direction */
  private arrive(v: Vehicle, k: number): void {
    const line = v.line,
      def = line.def,
      dir = line.dirs[v.dir];
    const P = this.passengers;
    const now = this.time;
    const stop = dir.stops[k];
    if (k > 0) {
      const meas = (now - v.lastStopTime) * 60;
      if (meas > 0 && meas < 6 * 3600) dir.segTime[k - 1] = dir.segTime[k - 1] * 0.8 + meas * 0.2;
    }
    v.lastStopTime = now;
    const last = dir.stops.length - 1;
    // alight
    let alight = 0;
    const pax = v.pax;
    let w = 0;
    for (let i = 0; i < pax.length; i++) {
      const p = pax[i];
      const plan = P.plans[p];
      if (P.state[p] !== P_RIDING || !plan) continue;
      if (plan[P.leg[p] * 4 + 3] === k || k >= last) {
        alight++;
        this.alight(p, stop, line);
      } else pax[w++] = p;
    }
    pax.length = w;
    if (k >= last) {
      v.pax.length = 0;
      v.nextStop = -1;
      return;
    }
    // board
    let board = 0;
    const q = dir.waiting[k];
    if (q && q.length) {
      const cap = def.capacity;
      let i = 0;
      while (i < q.length && pax.length < cap) {
        const p = q[i++];
        if (P.state[p] !== P_WAITING) continue;
        const plan = P.plans[p]!;
        const lg = P.leg[p] * 4;
        const ak = plan[lg + 3];
        if (plan[lg] !== line.id || plan[lg + 1] !== v.dir || plan[lg + 2] !== k || ak <= k || ak > last) {
          this.fail(p);
          continue;
        }
        const fare = line.fareFor((dir.stopDist[ak] - dir.stopDist[k]) / 1000);
        this.earn(fare, 'fares');
        line.revenueToday += fare;
        P.state[p] = P_RIDING;
        pax.push(p);
        board++;
      }
      q.splice(0, i);
      stop.boardedToday += board;
    }
    line.loadSum += pax.length / def.capacity;
    line.loadSamples++;
    v.nextStop = k + 1;
    v.dwell = def.dwell + 1.2 * (alight + board);
  }

  // ------------------------------------------------------------------ passengers

  private fail(p: number): void {
    const c = this.cities[this.passengers.city[p]];
    if (c) c.stats.ptFailed++;
    this.passengers.release(p);
  }

  private alight(p: number, stop: Stop, line: Line): void {
    const P = this.passengers;
    P.x[p] = stop.x;
    P.y[p] = stop.y;
    line.paxToday++;
    P.leg[p]++;
    const plan = P.plans[p]!;
    const lg = P.leg[p] * 4;
    if (lg < plan.length) {
      // transfer
      const nl = this.lines.get(plan[lg]);
      const ns = nl && nl.valid ? nl.dirs[plan[lg + 1]]?.stops[plan[lg + 2]] : undefined;
      if (!ns) {
        this.fail(p);
        return;
      }
      P.tx[p] = ns.x;
      P.ty[p] = ns.y;
      P.state[p] = P_WALK_TO_STOP;
      return;
    }
    if (P.intercity[p]) {
      this.xp += 3;
      this.totalDelivered++;
      const oc = this.cities[P.city[p]];
      if (oc) {
        oc.stats.delivered++;
        oc.reputation = Math.min(100, oc.reputation + 0.003);
      }
      const dc = P.destCity[p] >= 0 ? this.cities[P.destCity[p]] : undefined;
      P.release(p);
      if (dc) this.continueLocal(dc, stop.x, stop.y);
      return;
    }
    P.tx[p] = P.dx[p];
    P.ty[p] = P.dy[p];
    P.state[p] = P_WALK_TO_DEST;
  }

  private movePassengers(dt: number): void {
    const P = this.passengers;
    const st = WALK_SPEED * dt;
    const st2 = st * st;
    const state = P.state,
      x = P.x,
      y = P.y,
      tx = P.tx,
      ty = P.ty;
    for (let i = 0, n = P.count; i < n; i++) {
      const s = state[i];
      if (s !== P_WALK_TO_STOP && s !== P_WALK_TO_DEST) continue;
      const dx = tx[i] - x[i],
        dy = ty[i] - y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 <= st2) {
        x[i] = tx[i];
        y[i] = ty[i];
        if (s === P_WALK_TO_STOP) this.reachStop(i);
        else this.finish(i);
      } else {
        const f = st / Math.sqrt(d2);
        x[i] += dx * f;
        y[i] += dy * f;
      }
    }
  }

  private reachStop(i: number): void {
    const P = this.passengers;
    const plan = P.plans[i];
    if (!plan) {
      this.fail(i);
      return;
    }
    const lg = P.leg[i] * 4;
    const line = this.lines.get(plan[lg]);
    const dir = line && line.valid ? line.dirs[plan[lg + 1]] : undefined;
    const k = plan[lg + 2];
    const stop = dir?.stops[k];
    if (!dir || !stop || Math.abs(stop.x - P.tx[i]) > 3 || Math.abs(stop.y - P.ty[i]) > 3 || plan[lg + 3] <= k || plan[lg + 3] >= dir.stops.length) {
      this.fail(i);
      return;
    }
    this.startWaiting(i, dir.waiting[k], stop);
  }

  private startWaiting(i: number, q: number[], stop: Stop): void {
    const P = this.passengers;
    P.state[i] = P_WAITING;
    P.waitStart[i] = this.time;
    P.x[i] = stop.x + (Math.random() - 0.5) * 10;
    P.y[i] = stop.y + (Math.random() - 0.5) * 10;
    q.push(i);
  }

  private finish(i: number): void {
    const P = this.passengers;
    this.xp += 1;
    this.totalDelivered++;
    const c = this.cities[P.city[i]];
    if (c) {
      c.stats.delivered++;
      c.reputation = Math.min(100, c.reputation + 0.003);
    }
    P.release(i);
  }

  private giveUp(now: number): void {
    const P = this.passengers;
    for (const line of this.lines.values())
      for (const dir of line.dirs)
        for (const q of dir.waiting) {
          if (!q.length) continue;
          let i = 0;
          while (i < q.length && now - P.waitStart[q[i]] > MAX_WAIT_MIN) {
            const p = q[i++];
            if (P.state[p] !== P_WAITING) continue;
            const c = this.cities[P.city[p]];
            if (c) c.reputation = Math.max(0, c.reputation - 0.02);
            this.fail(p);
          }
          if (i) q.splice(0, i);
        }
  }

  private spawnLocalTransit(c: CitySim, o: number, d: number, ox: number, oy: number, dx: number, dy: number): boolean {
    const end = c.ptEnd[o * c.Z + d];
    if (end < 0 || c.ptNetVersion !== this.net.version) return false;
    const pred = c.ptPred[o];
    if (!pred) return false;
    const P = this.passengers;
    if (P.active >= MAX_PASSENGERS) return false;
    const legs = this.net.legs(pred, end);
    if (legs.length < 4) return false;
    const line = this.lines.get(legs[0]);
    const stop = line && line.valid ? line.dirs[legs[1]]?.stops[legs[2]] : undefined;
    if (!stop) return false;
    const i = P.alloc();
    P.state[i] = P_WALK_TO_STOP;
    P.x[i] = ox;
    P.y[i] = oy;
    P.tx[i] = stop.x;
    P.ty[i] = stop.y;
    P.dx[i] = dx;
    P.dy[i] = dy;
    P.leg[i] = 0;
    P.t0[i] = this.time;
    P.waitStart[i] = 0;
    P.city[i] = c.index;
    P.destCity[i] = -1;
    P.intercity[i] = 0;
    P.plans[i] = legs;
    return true;
  }

  private spawnIntercity(from: CitySim, to: CitySim, legs: Int32Array): boolean {
    if (legs.length < 4) return false;
    const P = this.passengers;
    if (P.active >= MAX_PASSENGERS) return false;
    const line = this.lines.get(legs[0]);
    const dir = line && line.valid ? line.dirs[legs[1]] : undefined;
    const k = legs[2];
    const stop = dir?.stops[k];
    if (!dir || !stop || legs[3] <= k || legs[3] >= dir.stops.length) return false;
    const i = P.alloc();
    P.tx[i] = stop.x;
    P.ty[i] = stop.y;
    P.dx[i] = to.cx;
    P.dy[i] = to.cy;
    P.leg[i] = 0;
    P.t0[i] = this.time;
    P.city[i] = from.index;
    P.destCity[i] = to.index;
    P.intercity[i] = 1;
    P.plans[i] = legs;
    this.startWaiting(i, dir.waiting[k], stop);
    return true;
  }

  /** an intercity traveller continues with a local trip in the destination city */
  private continueLocal(c: CitySim, x: number, y: number): void {
    if (c.Z < 2) return;
    const o = c.zoneAt(x, y);
    if (o < 0) return;
    const d = sampleRow(c.cumDest[1], o * c.Z, c.Z);
    const zd = c.zones[d];
    if (!zd || !zd.anchors.length) return;
    const dj = zd.anchors[(Math.random() * zd.anchors.length) | 0];
    const dx = c.G.jx[dj] + (Math.random() - 0.5) * 80,
      dy = c.G.jy[dj] + (Math.random() - 0.5) * 80;
    c.stats.trips++;
    const m = c.chooseMode(o, d, Math.hypot(dx - x, dy - y));
    if (m === 0) c.stats.walk++;
    else if (m === 1) c.stats.bike++;
    else if (m === 2) c.stats.car++;
    else {
      c.stats.pt++;
      if (!this.spawnLocalTransit(c, o, d, x, y, dx, dy)) c.stats.ptFailed++;
    }
  }

  // ------------------------------------------------------------------ accidents

  private cityAccident(a: Accident): void {
    const c = this.cities[a.city];
    if (!c) return;
    let where = '';
    if (a.j >= 0) where = c.junctionName(a.j);
    else if (a.e >= 0) where = c.G.eName[a.e] || 'naamloze weg';
    this.accident(a, where ? `${where}, ${c.def.name}` : c.def.name);
  }

  private accident(a: Accident, where: string): void {
    this.spend(ACCIDENT_CLAIM, 'accidents');
    this.emit('accident', a);
    this.toast(`Ongeluk: ${a.cause} (${where}).`, 'bad');
    for (const v of this.vehicles) {
      const r = v.line.def.routing;
      if (r !== 'road' && r !== 'tram' && r !== 'highway') continue;
      if (Math.abs(v.x - a.x) > 40 || Math.abs(v.y - a.y) > 40) continue;
      if (Math.hypot(v.x - a.x, v.y - a.y) > 40) continue;
      this.spend(BUS_ACCIDENT_REPAIR, 'accidents');
      this.toast(`Een voertuig van lijn ${v.line.d.name} is betrokken bij het ongeluk: ${eur(BUS_ACCIDENT_REPAIR)} reparatiekosten.`, 'bad');
      break;
    }
  }
}

// ------------------------------------------------------------------ construction

export async function createGame(
  save: SaveData | null,
  startCityId: string,
  onStatus: (s: string) => void,
  provider: DataProvider = defaultProvider,
): Promise<IGame> {
  const ids = save ? save.cities : [startCityId];
  const data = new Map<string, CityData>();
  for (const id of ids) {
    const def = CITY_BY_ID.get(id);
    if (!def) continue;
    onStatus(`${def.name} laden…`);
    data.set(id, await provider.city(def, onStatus));
  }
  onStatus('Simulatie opbouwen…');
  const g = new Game(provider);
  g.init(save, startCityId, data);
  onStatus('Klaar');
  return g;
}

/** Synchronous construction from already-loaded city data (tests / headless). */
export function createGameFromData(save: SaveData | null, cityData: CityData[], startCityId?: string, provider?: Partial<DataProvider>): Game {
  const map = new Map(cityData.map((d) => [d.id, d] as [string, CityData]));
  const p: DataProvider = {
    city: provider?.city ?? (async (def, s) => map.get(def.id) ?? loadCityData(def, s)),
    corridor: provider?.corridor ?? (async () => null),
  };
  const g = new Game(p);
  g.init(save, startCityId ?? save?.startCity ?? cityData[0].id, map);
  return g;
}
