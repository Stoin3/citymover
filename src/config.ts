// Central game balance & definitions.

export type ModeId = 'bus' | 'tram' | 'metro' | 'train' | 'coach' | 'plane';

export interface ModeDef {
  id: ModeId;
  name: string;
  icon: string;
  color: [number, number, number];
  unlockLevel: number;
  capacity: number;
  cruiseKmh: number; // top speed of vehicle
  vehiclePrice: number;
  opCostHour: number; // per active vehicle per hour
  opCostKm: number;
  stopCost: number;
  infraPerKm: number; // track / tunnel cost per km of route
  dwell: number; // base dwell seconds per stop
  routing: 'road' | 'tram' | 'straight' | 'rail' | 'highway' | 'air';
  defaultFareBase: number;
  defaultFareKm: number;
  dims: [number, number, number]; // length, width, height (m)
  z: number; // render altitude
  stopRadius: number; // walking catchment (m)
  minStopSpacing: number; // m
  intercity: boolean; // may connect stops in different cities
}

export const MODES: Record<ModeId, ModeDef> = {
  bus: {
    id: 'bus', name: 'Bus', icon: '🚌', color: [230, 57, 70], unlockLevel: 1, capacity: 90, cruiseKmh: 70,
    vehiclePrice: 120_000, opCostHour: 18, opCostKm: 0.25, stopCost: 4_000, infraPerKm: 0, dwell: 12,
    routing: 'road', defaultFareBase: 1.1, defaultFareKm: 0.18, dims: [12, 2.55, 3.2], z: 0, stopRadius: 600,
    minStopSpacing: 150, intercity: false,
  },
  tram: {
    id: 'tram', name: 'Tram', icon: '🚋', color: [255, 183, 3], unlockLevel: 3, capacity: 220, cruiseKmh: 60,
    vehiclePrice: 900_000, opCostHour: 40, opCostKm: 0.6, stopCost: 30_000, infraPerKm: 600_000, dwell: 15,
    routing: 'tram', defaultFareBase: 1.1, defaultFareKm: 0.18, dims: [30, 2.4, 3.4], z: 0, stopRadius: 700,
    minStopSpacing: 250, intercity: false,
  },
  metro: {
    id: 'metro', name: 'Metro', icon: '🚇', color: [58, 134, 255], unlockLevel: 5, capacity: 900, cruiseKmh: 80,
    vehiclePrice: 4_000_000, opCostHour: 120, opCostKm: 1.8, stopCost: 1_500_000, infraPerKm: 5_000_000, dwell: 20,
    routing: 'straight', defaultFareBase: 1.1, defaultFareKm: 0.18, dims: [70, 2.9, 3.6], z: 0, stopRadius: 900,
    minStopSpacing: 500, intercity: false,
  },
  train: {
    id: 'train', name: 'Trein', icon: '🚆', color: [255, 214, 10], unlockLevel: 6, capacity: 700, cruiseKmh: 140,
    vehiclePrice: 7_000_000, opCostHour: 160, opCostKm: 2.5, stopCost: 1_000_000, infraPerKm: 0, dwell: 45,
    routing: 'rail', defaultFareBase: 2.6, defaultFareKm: 0.17, dims: [110, 2.9, 4.2], z: 0, stopRadius: 1200,
    minStopSpacing: 1000, intercity: true,
  },
  coach: {
    id: 'coach', name: 'Snelbus', icon: '🚍', color: [112, 224, 0], unlockLevel: 4, capacity: 65, cruiseKmh: 100,
    vehiclePrice: 280_000, opCostHour: 26, opCostKm: 0.35, stopCost: 15_000, infraPerKm: 0, dwell: 30,
    routing: 'highway', defaultFareBase: 2.5, defaultFareKm: 0.12, dims: [14, 2.55, 3.6], z: 0, stopRadius: 800,
    minStopSpacing: 1000, intercity: true,
  },
  plane: {
    id: 'plane', name: 'Vliegtuig', icon: '✈️', color: [224, 224, 255], unlockLevel: 10, capacity: 180, cruiseKmh: 750,
    vehiclePrice: 45_000_000, opCostHour: 1800, opCostKm: 4, stopCost: 15_000_000, infraPerKm: 0, dwell: 900,
    routing: 'air', defaultFareBase: 45, defaultFareKm: 0.09, dims: [38, 34, 12], z: 0, stopRadius: 0,
    minStopSpacing: 50_000, intercity: true,
  },
};

export const MODE_LIST: ModeDef[] = Object.values(MODES);

// Time blocks for timetables (game hours)
export const TIME_BLOCKS = [
  { id: 'night', name: 'Nacht', from: 0, to: 6 },
  { id: 'amPeak', name: 'Ochtendspits', from: 6, to: 9 },
  { id: 'day', name: 'Dal', from: 9, to: 16 },
  { id: 'pmPeak', name: 'Avondspits', from: 16, to: 19 },
  { id: 'evening', name: 'Avond', from: 19, to: 24 },
] as const;

export function blockAt(hour: number): number {
  for (let i = 0; i < TIME_BLOCKS.length; i++) if (hour >= TIME_BLOCKS[i].from && hour < TIME_BLOCKS[i].to) return i;
  return 0;
}

// Fraction of daily trips starting in each hour (Dutch weekday profile)
export const HOURLY_DEMAND = [
  0.004, 0.002, 0.002, 0.002, 0.004, 0.012, 0.035, 0.085, 0.095, 0.055, 0.042, 0.045, 0.05, 0.048, 0.047, 0.055,
  0.075, 0.09, 0.08, 0.05, 0.035, 0.028, 0.017, 0.008,
];

export interface FeatureDef {
  id: string;
  name: string;
  level: number;
  desc: string;
}

export const FEATURES: FeatureDef[] = [
  { id: 'speed', name: 'Maximumsnelheid', level: 1, desc: 'Pas de maximumsnelheid van wegen aan.' },
  { id: 'oneway', name: 'Eenrichtingsverkeer', level: 1, desc: 'Maak wegen eenrichting (of juist weer tweerichting).' },
  { id: 'priority', name: 'Voorrangsregels', level: 1, desc: 'Voorrang van rechts, voorrangsweg of stopborden.' },
  { id: 'buslane', name: 'Busbanen', level: 2, desc: 'Reserveer een rijstrook voor bussen.' },
  { id: 'lanes', name: 'Rijstroken', level: 2, desc: 'Wijzig het aantal rijstroken op bestaande wegen.' },
  { id: 'signals', name: 'Verkeerslichten', level: 2, desc: 'Plaats verkeerslichten op kruispunten.' },
  { id: 'roundabout', name: 'Rotondes', level: 3, desc: 'Zet een kruispunt om naar een rotonde-regeling.' },
  { id: 'region', name: 'Tweede stad', level: 4, desc: 'Ontgrendel een aangrenzende stad.' },
  { id: 'highway', name: 'Snelwegen', level: 4, desc: 'Stel snelwegen tussen steden in (snelheid, rijstroken).' },
];

export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(1000 * Math.pow(level - 1, 1.8));
}

export function levelFromXp(xp: number): number {
  let l = 1;
  while (xp >= xpForLevel(l + 1)) l++;
  return l;
}

export function maxCities(level: number): number {
  if (level < 4) return 1;
  return 2 + Math.floor((level - 4) / 2);
}

export function cityUnlockCost(population: number): number {
  return Math.round((400_000 * Math.sqrt(population / 150_000)) / 10_000) * 10_000;
}

export const START_MONEY = 1_500_000;

// Simulation scale: number of simulated trips per resident per day.
export const TRIPS_PER_RESIDENT = 2.3;

// Behaviour (logit) parameters, utilities in "minutes".
export const VALUE_OF_TIME = 0.2; // € per minute (12 €/h)
export const BETA = 0.075; // logit scale per minute
export const CAR_COST_KM = 0.22;
export const PARKING_CENTER = 4.0;
export const MAX_WAIT_MIN = 40;
// Transit generalized-cost weights (minutes of in-vehicle time per minute)
export const PT_WALK_WEIGHT = 1.5;
export const PT_WAIT_WEIGHT = 1.5;
export const PT_TRANSFER_PENALTY = 5;
export const PT_ASC = -2; // alternative-specific constant for transit (minutes)

// Road safety
export const SAFE_SPEED: number[] = [120, 100, 70, 60, 50, 50, 30, 15, 80, 70, 60, 50, 50];
export const DEFAULT_SPEED: number[] = [100, 80, 50, 50, 50, 50, 30, 15, 70, 60, 50, 50, 50];
export const DEFAULT_LANES: number[] = [2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
export const CLASS_RANK: number[] = [10, 9, 8, 7, 6, 4, 3, 1, 5, 5, 5, 4, 4];
export const CLASS_NAMES = [
  'Snelweg', 'Autoweg', 'Hoofdweg', 'Secundaire weg', 'Wijkontsluitingsweg', 'Overige weg', 'Woonstraat', 'Woonerf',
  'Oprit snelweg', 'Oprit autoweg', 'Afslag hoofdweg', 'Afslag', 'Afslag',
];

export const CONTROL_NAMES = ['Geen regeling', 'Voorrang van rechts', 'Voorrangsweg', 'Stopborden', 'Verkeerslichten', 'Rotonde'];
export const CONTROL_FEATURE = ['priority', 'priority', 'priority', 'priority', 'signals', 'roundabout'];
export const CONTROL_COST = [0, 0, 2_000, 1_500, 60_000, 250_000];
export const ROAD_EDIT_COST = { speed: 500, oneway: 2_000, buslane: 15_000, lanes: 40_000 };

// Economy (game core)
export const ACCIDENT_CLAIM = 1_500; // damage claims paid per road accident in your cities
export const BUS_ACCIDENT_REPAIR = 20_000; // extra when one of your vehicles is involved
// Daily municipal subsidy per city = population/1000 * SUBSIDY_PER_1000 * service * safety + delivered * SUBSIDY_PER_PAX
//   service = min(1, delivered / (population/1000 * SUBSIDY_FULL_PAX_PER_1000))
//   safety  = 1 - min(0.8, accidents * 0.03)
export const SUBSIDY_PER_1000 = 600;
export const SUBSIDY_FULL_PAX_PER_1000 = 30;
export const SUBSIDY_PER_PAX = 0.3; // daily subsidy per delivered passenger
export const VEHICLE_RESALE = 0.5; // fraction of the price refunded when selling vehicles
