// Real cities. Coordinates are city centres (lon, lat).
// radius = playable area loaded from OpenStreetMap (km).

export interface CityDef {
  id: string;
  name: string;
  country: 'NL' | 'BE' | 'DE';
  lon: number;
  lat: number;
  population: number;
  radius: number;
  airport?: { name: string; lon: number; lat: number };
  starter?: boolean;
}

export const CITIES: CityDef[] = [
  { id: 'amsterdam', name: 'Amsterdam', country: 'NL', lon: 4.8952, lat: 52.3702, population: 931000, radius: 3.5, starter: true, airport: { name: 'Schiphol', lon: 4.7683, lat: 52.3105 } },
  { id: 'rotterdam', name: 'Rotterdam', country: 'NL', lon: 4.4777, lat: 51.9225, population: 655000, radius: 3.5, starter: true, airport: { name: 'Rotterdam The Hague Airport', lon: 4.4372, lat: 51.9569 } },
  { id: 'denhaag', name: 'Den Haag', country: 'NL', lon: 4.3113, lat: 52.0799, population: 552000, radius: 3.2, starter: true },
  { id: 'utrecht', name: 'Utrecht', country: 'NL', lon: 5.1214, lat: 52.0907, population: 361000, radius: 3, starter: true },
  { id: 'eindhoven', name: 'Eindhoven', country: 'NL', lon: 5.4697, lat: 51.4416, population: 238000, radius: 3, starter: true, airport: { name: 'Eindhoven Airport', lon: 5.3745, lat: 51.4501 } },
  { id: 'groningen', name: 'Groningen', country: 'NL', lon: 6.5665, lat: 53.2194, population: 234000, radius: 2.8, starter: true, airport: { name: 'Groningen Airport Eelde', lon: 6.5794, lat: 53.1197 } },
  { id: 'tilburg', name: 'Tilburg', country: 'NL', lon: 5.0913, lat: 51.5555, population: 222000, radius: 2.8 },
  { id: 'almere', name: 'Almere', country: 'NL', lon: 5.2147, lat: 52.3708, population: 218000, radius: 2.8 },
  { id: 'breda', name: 'Breda', country: 'NL', lon: 4.7760, lat: 51.5890, population: 184000, radius: 2.6 },
  { id: 'nijmegen', name: 'Nijmegen', country: 'NL', lon: 5.8528, lat: 51.8426, population: 179000, radius: 2.6 },
  { id: 'arnhem', name: 'Arnhem', country: 'NL', lon: 5.9110, lat: 51.9851, population: 164000, radius: 2.6 },
  { id: 'apeldoorn', name: 'Apeldoorn', country: 'NL', lon: 5.9699, lat: 52.2112, population: 165000, radius: 2.6 },
  { id: 'haarlem', name: 'Haarlem', country: 'NL', lon: 4.6368, lat: 52.3808, population: 162000, radius: 2.5, starter: true },
  { id: 'enschede', name: 'Enschede', country: 'NL', lon: 6.8937, lat: 52.2215, population: 160000, radius: 2.5 },
  { id: 'amersfoort', name: 'Amersfoort', country: 'NL', lon: 5.3878, lat: 52.1561, population: 158000, radius: 2.5 },
  { id: 'zaandam', name: 'Zaandam', country: 'NL', lon: 4.8292, lat: 52.4420, population: 157000, radius: 2.3 },
  { id: 'denbosch', name: "'s-Hertogenbosch", country: 'NL', lon: 5.3037, lat: 51.6978, population: 157000, radius: 2.5 },
  { id: 'zwolle', name: 'Zwolle', country: 'NL', lon: 6.0830, lat: 52.5168, population: 130000, radius: 2.4 },
  { id: 'leeuwarden', name: 'Leeuwarden', country: 'NL', lon: 5.7999, lat: 53.2012, population: 125000, radius: 2.3 },
  { id: 'leiden', name: 'Leiden', country: 'NL', lon: 4.4970, lat: 52.1601, population: 125000, radius: 2.3, starter: true },
  { id: 'maastricht', name: 'Maastricht', country: 'NL', lon: 5.6910, lat: 50.8514, population: 121000, radius: 2.4, airport: { name: 'Maastricht Aachen Airport', lon: 5.7701, lat: 50.9117 } },
  { id: 'dordrecht', name: 'Dordrecht', country: 'NL', lon: 4.6901, lat: 51.8133, population: 120000, radius: 2.3 },
  { id: 'alkmaar', name: 'Alkmaar', country: 'NL', lon: 4.7485, lat: 52.6324, population: 110000, radius: 2.2 },
  { id: 'delft', name: 'Delft', country: 'NL', lon: 4.3571, lat: 52.0116, population: 104000, radius: 2.2, starter: true },
  { id: 'venlo', name: 'Venlo', country: 'NL', lon: 6.1724, lat: 51.3704, population: 102000, radius: 2.2 },
  { id: 'deventer', name: 'Deventer', country: 'NL', lon: 6.1639, lat: 52.2550, population: 101000, radius: 2.2 },
  { id: 'hilversum', name: 'Hilversum', country: 'NL', lon: 5.1669, lat: 52.2292, population: 92000, radius: 2.2 },
  { id: 'gouda', name: 'Gouda', country: 'NL', lon: 4.7105, lat: 52.0115, population: 74000, radius: 2 },
  { id: 'antwerpen', name: 'Antwerpen', country: 'BE', lon: 4.4025, lat: 51.2194, population: 530000, radius: 3.2 },
  { id: 'gent', name: 'Gent', country: 'BE', lon: 3.7174, lat: 51.0543, population: 265000, radius: 2.8 },
  { id: 'brussel', name: 'Brussel', country: 'BE', lon: 4.3517, lat: 50.8503, population: 1220000, radius: 3.5, airport: { name: 'Brussels Airport', lon: 4.4844, lat: 50.9014 } },
  { id: 'hasselt', name: 'Hasselt', country: 'BE', lon: 5.3378, lat: 50.9307, population: 79000, radius: 2.2 },
  { id: 'luik', name: 'Luik', country: 'BE', lon: 5.5797, lat: 50.6326, population: 197000, radius: 2.6, airport: { name: 'Liège Airport', lon: 5.4432, lat: 50.6374 } },
  { id: 'aken', name: 'Aken', country: 'DE', lon: 6.0839, lat: 50.7753, population: 249000, radius: 2.6 },
  { id: 'keulen', name: 'Keulen', country: 'DE', lon: 6.9603, lat: 50.9375, population: 1080000, radius: 3.5, airport: { name: 'Köln/Bonn', lon: 7.1427, lat: 50.8659 } },
  { id: 'dusseldorf', name: 'Düsseldorf', country: 'DE', lon: 6.7735, lat: 51.2277, population: 620000, radius: 3.2, airport: { name: 'Düsseldorf Airport', lon: 6.7668, lat: 51.2895 } },
  { id: 'duisburg', name: 'Duisburg', country: 'DE', lon: 6.7623, lat: 51.4344, population: 498000, radius: 3 },
  { id: 'munster', name: 'Münster', country: 'DE', lon: 7.6261, lat: 51.9607, population: 317000, radius: 2.8, airport: { name: 'Münster/Osnabrück', lon: 7.6847, lat: 52.1346 } },
];

export const CITY_BY_ID = new Map(CITIES.map((c) => [c.id, c]));

export function distanceKm(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180,
    lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Adjacency: cities closer than 48 km are neighbours; every city gets at least its 2 nearest.
const ADJ = new Map<string, Set<string>>();
for (const c of CITIES) ADJ.set(c.id, new Set());
for (const a of CITIES) {
  const sorted = CITIES.filter((b) => b !== a)
    .map((b) => ({ b, d: distanceKm(a, b) }))
    .sort((x, y) => x.d - y.d);
  sorted.forEach(({ b, d }, i) => {
    if (d < 48 || i < 2) {
      ADJ.get(a.id)!.add(b.id);
      ADJ.get(b.id)!.add(a.id);
    }
  });
}

export function neighbours(id: string): string[] {
  return [...(ADJ.get(id) || [])];
}
