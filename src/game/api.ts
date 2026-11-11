// SHARED CONTRACT between game core (src/game/game.ts), renderer (src/render/*),
// UI (src/ui/*, src/main.ts) and saving (src/save/*).
// Do not change signatures without updating all consumers.
import type { ModeId } from '../config';
import type { CitySim, Accident, RoadEdits } from '../sim/city';
import type { Line, LineData, Stop, StopData, Vehicle } from '../sim/transit';
import type { PassengerPool } from '../sim/agents';
import type { TransitNet } from '../sim/network';

export interface HighwaySettings {
  speed: number; // 100 | 120 | 130 km/h
  lanes: number; // lanes per direction 2..5
}

export interface HighwayLink {
  key: string; // "cityA|cityB" (ids sorted alphabetically)
  a: string;
  b: string;
  settings: HighwaySettings;
  pts: number[]; // polyline x,y (global metres, see src/geo.ts); straight until OSM corridor loaded
  congestion: number; // 0 (free) .. 1 (jam)
  carsPerHour: number;
  closedUntil: number; // game minutes, accident closure
}

/** Intercity car moving along a highway polyline (visual + congestion). */
export interface HighwayCar {
  link: HighwayLink;
  s: number; // distance along pts
  dir: 1 | -1;
  speed: number; // m/s
  x: number;
  y: number;
  h: number;
}

export interface Ledger {
  fares: number;
  subsidy: number;
  operations: number; // positive number = cost
  construction: number; // positive number = cost
  vehicles: number; // positive number = cost (purchases minus sales)
  accidents: number; // positive number = cost
}

export interface SaveData {
  v: 1;
  money: number;
  xp: number;
  time: number; // game minutes since start (day = floor(time/1440))
  startCity: string;
  cities: string[]; // unlocked city ids in unlock order
  stops: StopData[];
  lines: LineData[];
  edits: Record<string, RoadEdits>; // per city id
  highways: Record<string, HighwaySettings>;
  reputation: Record<string, number>;
  nextId: number;
  totalDelivered: number;
}

export type ToastKind = 'info' | 'good' | 'warn' | 'bad';

export interface GameEventMap {
  toast: { msg: string; kind: ToastKind };
  levelup: { level: number; unlocked: string[] }; // unlocked = human readable names
  /** structural change (lines/stops/roads/cities) -> renderer rebuilds static layers, UI refreshes */
  changed: { what: 'lines' | 'stops' | 'roads' | 'cities' | 'highways' | 'all' };
  accident: Accident;
  day: { day: number; ledger: Ledger };
  cityLoading: { id: string; status: string | null }; // status null = done
}

export type Unsub = () => void;

export interface IGame {
  // ---- state (read-only for consumers) ----
  readonly money: number;
  readonly xp: number;
  readonly level: number;
  readonly time: number; // game minutes since start
  speed: number; // 0 = pause, 1 = 1 game-minute per real second, 3, 10, 30
  readonly cities: CitySim[]; // loaded+unlocked cities (index = CitySim.index)
  readonly startCity: string;
  readonly stops: Map<number, Stop>;
  readonly lines: Map<number, Line>;
  readonly vehicles: Vehicle[]; // all active transit vehicles
  readonly passengers: PassengerPool; // global transit passengers (state/x/y)
  readonly highways: HighwayLink[];
  readonly highwayCars: HighwayCar[];
  readonly net: TransitNet;
  readonly ledgerToday: Ledger;
  readonly ledgerYesterday: Ledger;
  readonly totalDelivered: number;
  maxEntities: number; // cap on cars+bikes per city (UI setting)

  // ---- queries ----
  hour(): number; // 0..24 fractional
  day(): number;
  hasFeature(featureId: string): boolean; // see FEATURES in config.ts
  modeUnlocked(mode: ModeId): boolean;
  cityById(id: string): CitySim | undefined;
  cityAt(x: number, y: number): CitySim | undefined;
  allAccidents(): Accident[];
  /** can the player unlock this (adjacent, level, money) */
  canUnlockCity(id: string): { ok: boolean; reason: string; cost: number };
  /** cost estimate in € for a line with these stops (new stops + track) */
  lineCostEstimate(mode: ModeId, stopIds: number[]): number;

  // ---- actions (return error string in Dutch, or null on success) ----
  unlockCity(id: string): Promise<string | null>;
  /** place a stop of a mode near (x,y) (global metres). Snaps to road/rail/station/airport. */
  addStop(mode: ModeId, x: number, y: number): Stop | string;
  removeStop(id: number): string | null;
  renameStop(id: number, name: string): void;
  /** create a line (empty) - not charged until setLineStops succeeds */
  createLine(mode: ModeId): Line | string;
  setLineStops(lineId: number, stopIds: number[]): string | null;
  updateLine(lineId: number, patch: Partial<Pick<LineData, 'name' | 'color' | 'fareBase' | 'fareKm' | 'freq'>>): void;
  deleteLine(lineId: number): void;
  buyVehicles(lineId: number, n: number): string | null;
  sellVehicles(lineId: number, n: number): string | null;

  setEdgeSpeed(cityIndex: number, edge: number, kmh: number): string | null;
  setEdgeOneway(cityIndex: number, edge: number, oneway: -1 | 0 | 1): string | null;
  setEdgeLanes(cityIndex: number, edge: number, lanes: number): string | null;
  setEdgeBusLane(cityIndex: number, edge: number, on: boolean): string | null;
  setJunctionControl(cityIndex: number, junction: number, ctrl: number): string | null;
  setHighway(key: string, patch: Partial<HighwaySettings>): string | null;

  // ---- loop / persistence ----
  tick(realDtSec: number): void;
  serialize(): SaveData;
  on<K extends keyof GameEventMap>(ev: K, cb: (p: GameEventMap[K]) => void): Unsub;
}

// ---------------------------------------------------------------------------
// Game construction (implemented in src/game/game.ts):
//   export async function createGame(save: SaveData | null, startCityId: string,
//       onStatus: (s: string) => void): Promise<IGame>
// When save is given, startCityId is ignored and all cities in save.cities are loaded.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RENDERER CONTRACT (implemented in src/render/renderer.ts):
//   export function createRenderer(container: HTMLElement, game: IGame): IRenderer
// ---------------------------------------------------------------------------
export type PickInfo =
  | { kind: 'edge'; city: number; edge: number }
  | { kind: 'junction'; city: number; junction: number }
  | { kind: 'stop'; stopId: number }
  | { kind: 'line'; lineId: number }
  | { kind: 'vehicle'; lineId: number; vehicleId: number }
  | { kind: 'city'; cityId: string } // locked/unlocked city marker
  | { kind: 'highway'; key: string }
  | { kind: 'map' };

export interface MapClick {
  x: number; // global metres
  y: number;
  lon: number;
  lat: number;
  pick: PickInfo;
}

/** view: inspect stops/lines/vehicles; roads: edges+junctions pickable; build: placing stops for a line */
export type MapMode = 'view' | 'roads' | 'build';
export type Overlay = 'none' | 'congestion' | 'safety' | 'demand';

export interface IRenderer {
  setMode(mode: MapMode, buildMode?: ModeId): void;
  setSelection(sel: PickInfo | null): void;
  /** preview polyline/stops while the player is drawing a line */
  setDraftLine(stopIds: number[], mode: ModeId | null): void;
  setOverlay(o: Overlay): void;
  onClick(cb: (c: MapClick) => void): Unsub;
  flyToCity(id: string): void;
  flyTo(x: number, y: number, zoom?: number): void;
  /** rebuild static layers (lines, stops, roads). Also auto-called on game 'changed'. */
  refresh(): void;
  /** called every animation frame by main.ts after game.tick() */
  frame(): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// SAVE CONTRACT (implemented in src/save/supabase.ts):
//   export const saveBackend: SaveBackend
// Uses Supabase when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set,
// otherwise falls back to localStorage (user = "lokaal").
// ---------------------------------------------------------------------------
export interface SaveUser {
  id: string;
  email: string;
}
export interface SaveBackend {
  isCloud(): boolean;
  getUser(): Promise<SaveUser | null>;
  signUp(email: string, password: string): Promise<string | null>; // error or null
  signIn(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
  load(): Promise<SaveData | null>;
  save(data: SaveData): Promise<string | null>;
  onAuthChange(cb: (u: SaveUser | null) => void): Unsub;
}
