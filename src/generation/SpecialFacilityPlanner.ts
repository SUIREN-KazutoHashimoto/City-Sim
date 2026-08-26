import { clamp, makeRng } from '../core/math';
import { POICategory, POIRegistry } from '../world/POI';
import { DistrictType, PlanningSample } from './CityPlanning';
import type { FrontageSide, UrbanBlock } from './BlockParcelLayout';

export enum FacilityType {
  School = 0,
  Hospital = 1,
  University = 2,
  CityHall = 3,
  PoliceStation = 4,
  FireStation = 5,
  Mall = 6,
  Supermarket = 7,
  Hotel = 8,
  GasStation = 9,
  Stadium = 10,
}

export const FACILITY_LABEL: Record<FacilityType, string> = {
  [FacilityType.School]: '学校',
  [FacilityType.Hospital]: '病院',
  [FacilityType.University]: '大学',
  [FacilityType.CityHall]: '市役所',
  [FacilityType.PoliceStation]: '警察署',
  [FacilityType.FireStation]: '消防署',
  [FacilityType.Mall]: 'ショッピングモール',
  [FacilityType.Supermarket]: 'スーパーマーケット',
  [FacilityType.Hotel]: 'ホテル',
  [FacilityType.GasStation]: 'ガソリンスタンド',
  [FacilityType.Stadium]: 'スタジアム',
};

export type ParkKind = 'neighborhood' | 'city' | 'civic';

export interface ParkSpace {
  id: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  kind: ParkKind;
  capacity: number;
  poiId: number;
}

export interface FacilityRecord {
  id: number;
  type: FacilityType;
  buildingId: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  floors: number;
  siteArea: number;
  capacity: number;
  frontage: FrontageSide;
  district: DistrictType;
}

interface FacilityBuilding {
  id: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  floors: number;
  category: POICategory;
  district: DistrictType;
  landValue: number;
  siteArea: number;
  frontage: FrontageSide;
}

interface FacilityCity {
  sizeMeters: number;
  buildings: FacilityBuilding[];
  blocks: UrbanBlock[];
  poi: POIRegistry;
  planning: { cbd: { x: number; z: number }; sample(x: number, z: number): PlanningSample };
}

export interface SpecialFacilityPlan {
  facilities: FacilityRecord[];
  parks: ParkSpace[];
}

interface FacilitySpec {
  type: FacilityType;
  count: number;
  minArea: number;
  minWidth: number;
  minDepth: number;
  spacing: number;
}

export function planSpecialFacilities(city: FacilityCity, seed: number): SpecialFacilityPlan {
  const rng = makeRng(seed ^ 0x63fac17e);
  const areaKm2 = city.sizeMeters * city.sizeMeters / 1_000_000;
  const facilities: FacilityRecord[] = [];
  const parks = buildParks(city);
  const used = new Set<number>();

  const count = (perKm2: number, lo: number, hi: number): number => clamp(Math.round(areaKm2 / perKm2), lo, hi);
  const specs: FacilitySpec[] = [
    { type: FacilityType.CityHall, count: 1, minArea: 700, minWidth: 18, minDepth: 16, spacing: 0 },
    { type: FacilityType.Stadium, count: areaKm2 >= 30 ? 1 : 0, minArea: 1300, minWidth: 25, minDepth: 22, spacing: 0 },
    { type: FacilityType.University, count: count(55, 1, 3), minArea: 1000, minWidth: 22, minDepth: 20, spacing: 3500 },
    { type: FacilityType.Hospital, count: count(22, 1, 8), minArea: 800, minWidth: 20, minDepth: 18, spacing: 2200 },
    { type: FacilityType.FireStation, count: count(25, 1, 8), minArea: 430, minWidth: 15, minDepth: 14, spacing: 1800 },
    { type: FacilityType.PoliceStation, count: count(30, 1, 7), minArea: 430, minWidth: 15, minDepth: 14, spacing: 1800 },
    { type: FacilityType.Mall, count: count(35, 1, 5), minArea: 1050, minWidth: 24, minDepth: 22, spacing: 2600 },
    { type: FacilityType.School, count: count(7, 4, 24), minArea: 620, minWidth: 18, minDepth: 16, spacing: 1050 },
    { type: FacilityType.Hotel, count: count(20, 1, 10), minArea: 420, minWidth: 14, minDepth: 14, spacing: 900 },
    { type: FacilityType.Supermarket, count: count(10, 2, 16), minArea: 500, minWidth: 16, minDepth: 15, spacing: 700 },
    { type: FacilityType.GasStation, count: count(12, 2, 16), minArea: 360, minWidth: 14, minDepth: 12, spacing: 850 },
  ];

  for (const spec of specs) {
    if (spec.count <= 0) continue;
    const candidates = city.buildings
      .filter((b) => !used.has(b.id) && b.siteArea >= spec.minArea && b.width >= spec.minWidth && b.depth >= spec.minDepth)
      .map((b) => ({ b, score: facilityScore(city, b, spec.type) + rng() * 0.16 }))
      .sort((a, b) => b.score - a.score);

    let placed = 0;
    for (const candidate of candidates) {
      if (placed >= spec.count) break;
      const b = candidate.b;
      if (used.has(b.id)) continue;
      if (spec.spacing > 0 && facilities.some((f) => f.type === spec.type && distSq(f.x, f.z, b.x, b.z) < spec.spacing * spec.spacing)) continue;
      used.add(b.id);
      const record = convertBuilding(city.poi, b, spec.type, facilities.length);
      facilities.push(record); placed++;
    }
  }

  return { facilities, parks };
}

function buildParks(city: FacilityCity): ParkSpace[] {
  const parks: ParkSpace[] = [];
  for (const block of city.blocks) {
    const p = city.planning.sample(block.x, block.z);
    if (p.district !== DistrictType.Park) continue;
    const area = block.width * block.depth;
    const kind: ParkKind = area >= 45_000 ? 'city' : p.centerInfluence > 0.35 ? 'civic' : 'neighborhood';
    const capacity = Math.max(80, Math.round(area / (kind === 'city' ? 9 : 14)));
    const poiId = city.poi.add({ category: POICategory.Leisure, x: block.x, z: block.z, priceTier: 0.08, capacity, buildingId: -1 });
    parks.push({ id: parks.length, x: block.x, z: block.z, width: block.width, depth: block.depth, kind, capacity, poiId });
  }
  return parks;
}

function facilityScore(city: FacilityCity, b: FacilityBuilding, type: FacilityType): number {
  const p = city.planning.sample(b.x, b.z);
  const cbdD = Math.hypot(b.x - city.planning.cbd.x, b.z - city.planning.cbd.z) / Math.max(1, city.sizeMeters);
  const size = clamp(Math.sqrt(Math.max(1, b.siteArea)) / 70, 0, 1.4);
  const d = b.district;
  let district = 0;
  switch (type) {
    case FacilityType.CityHall:
      district = d === DistrictType.Civic ? 1.5 : d === DistrictType.CBD ? 1.25 : d === DistrictType.Commercial ? 0.8 : 0.2;
      return district + size * 0.35 + b.landValue * 0.45 - cbdD * 2.4;
    case FacilityType.Stadium:
      district = d === DistrictType.Civic ? 1.2 : d === DistrictType.Commercial ? 0.8 : d === DistrictType.ResidentialLow ? 0.65 : 0.2;
      return district + size * 0.9 - b.landValue * 0.15;
    case FacilityType.University:
      district = d === DistrictType.Civic ? 1.25 : d === DistrictType.MixedUse ? 0.9 : d === DistrictType.ResidentialHigh ? 0.8 : d === DistrictType.Commercial ? 0.65 : 0.1;
      return district + size * 0.7 + p.centerInfluence * 0.3;
    case FacilityType.Hospital:
      district = d === DistrictType.Civic ? 1.15 : d === DistrictType.ResidentialHigh ? 1 : d === DistrictType.MixedUse ? 0.9 : d === DistrictType.Commercial ? 0.7 : 0.2;
      return district + size * 0.55 + p.centerInfluence * 0.28;
    case FacilityType.School:
      district = d === DistrictType.ResidentialHigh ? 1.2 : d === DistrictType.ResidentialLow ? 1.1 : d === DistrictType.MixedUse ? 0.78 : d === DistrictType.Civic ? 0.75 : 0.15;
      return district + size * 0.35 - b.landValue * 0.12;
    case FacilityType.PoliceStation:
      district = d === DistrictType.Civic ? 1.2 : d === DistrictType.MixedUse ? 0.82 : d === DistrictType.Commercial ? 0.78 : d === DistrictType.ResidentialHigh ? 0.7 : 0.25;
      return district + p.centerInfluence * 0.24 + size * 0.2;
    case FacilityType.FireStation:
      district = d === DistrictType.Civic ? 1.15 : d === DistrictType.ResidentialHigh ? 0.9 : d === DistrictType.Industrial ? 0.86 : d === DistrictType.ResidentialLow ? 0.75 : 0.25;
      return district + size * 0.24;
    case FacilityType.Mall:
      district = d === DistrictType.Commercial ? 1.3 : d === DistrictType.MixedUse ? 1.0 : d === DistrictType.CBD ? 0.85 : 0.15;
      return district + size * 0.82 + b.landValue * 0.2;
    case FacilityType.Supermarket:
      district = d === DistrictType.ResidentialHigh ? 1.1 : d === DistrictType.ResidentialLow ? 1.05 : d === DistrictType.MixedUse ? 0.95 : d === DistrictType.Commercial ? 0.85 : 0.25;
      return district + size * 0.35;
    case FacilityType.Hotel:
      district = d === DistrictType.CBD ? 1.25 : d === DistrictType.Commercial ? 1.15 : d === DistrictType.MixedUse ? 0.82 : 0.2;
      return district + b.landValue * 0.55 + p.centerInfluence * 0.3;
    case FacilityType.GasStation:
      district = d === DistrictType.Logistics ? 1.15 : d === DistrictType.Industrial ? 1.05 : d === DistrictType.ResidentialLow ? 0.8 : d === DistrictType.Commercial ? 0.65 : 0.2;
      return district + size * 0.28 - b.landValue * 0.18;
  }
}

function convertBuilding(poi: POIRegistry, b: FacilityBuilding, type: FacilityType, id: number): FacilityRecord {
  poi.disableBuildingPOIs(b.id);
  const area = Math.max(1, b.siteArea);
  b.floors = normalizedFacilityFloors(type, b.floors, area);
  const add = (category: POICategory, capacity: number, priceTier: number, stock = 0): number => poi.add({
    category, x: b.x, z: b.z, priceTier, capacity: Math.max(1, Math.round(capacity)), buildingId: b.id,
    stock, maxStock: stock,
  });

  let primary = POICategory.Work, capacity = Math.max(30, area * 0.15);
  switch (type) {
    case FacilityType.School:
      primary = POICategory.Education; capacity = Math.max(450, area * 0.62); add(primary, capacity, 0.12); add(POICategory.Work, Math.max(45, capacity * 0.10), 0.35); break;
    case FacilityType.Hospital:
      primary = POICategory.Health; capacity = Math.max(320, area * 0.42); add(primary, capacity, 0.45); add(POICategory.Work, Math.max(90, capacity * 0.34), 0.55); break;
    case FacilityType.University:
      primary = POICategory.Education; capacity = Math.max(1800, area * 1.15); add(primary, capacity, 0.28); add(POICategory.Work, Math.max(180, capacity * 0.12), 0.55); add(POICategory.Food, Math.max(90, capacity * 0.05), 0.45, 220); break;
    case FacilityType.CityHall:
      primary = POICategory.Work; capacity = Math.max(260, area * 0.26); add(primary, capacity, 0.40); break;
    case FacilityType.PoliceStation:
      primary = POICategory.Work; capacity = Math.max(75, area * 0.15); add(primary, capacity, 0.38); break;
    case FacilityType.FireStation:
      primary = POICategory.Work; capacity = Math.max(60, area * 0.13); add(primary, capacity, 0.34); break;
    case FacilityType.Mall:
      primary = POICategory.Retail; capacity = Math.max(650, area * 0.58); add(primary, capacity, 0.58, Math.max(1000, Math.round(area * 1.6))); add(POICategory.Food, Math.max(180, capacity * 0.26), 0.55, 600); add(POICategory.Work, Math.max(120, capacity * 0.22), 0.52); break;
    case FacilityType.Supermarket:
      primary = POICategory.Retail; capacity = Math.max(180, area * 0.28); add(primary, capacity, 0.40, Math.max(600, Math.round(area * 1.1))); add(POICategory.Work, Math.max(35, capacity * 0.18), 0.42); break;
    case FacilityType.Hotel:
      primary = POICategory.Leisure; capacity = Math.max(180, area * 0.24); add(primary, capacity, 0.72); add(POICategory.Work, Math.max(50, capacity * 0.28), 0.55); add(POICategory.Food, Math.max(45, capacity * 0.20), 0.65, 180); break;
    case FacilityType.GasStation:
      primary = POICategory.Retail; capacity = Math.max(35, area * 0.08); add(primary, capacity, 0.48, 180); add(POICategory.Work, Math.max(8, capacity * 0.18), 0.42); break;
    case FacilityType.Stadium:
      primary = POICategory.Leisure; capacity = Math.max(3500, area * 3.2); add(primary, capacity, 0.62); add(POICategory.Work, Math.max(160, capacity * 0.045), 0.50); add(POICategory.Food, Math.max(220, capacity * 0.07), 0.58, 900); break;
  }
  b.category = primary;
  return { id, type, buildingId: b.id, x: b.x, z: b.z, width: b.width, depth: b.depth, floors: b.floors, siteArea: b.siteArea, capacity: Math.round(capacity), frontage: b.frontage, district: b.district };
}

function normalizedFacilityFloors(type: FacilityType, current: number, siteArea: number): number {
  const large = siteArea >= 2200;
  switch (type) {
    case FacilityType.School: return clamp(Math.round(current * 0.32 + (large ? 4 : 3)), 3, 5);
    case FacilityType.Hospital: return clamp(Math.round(current * 0.45 + (large ? 7 : 5)), 6, 12);
    case FacilityType.University: return clamp(Math.round(current * 0.32 + (large ? 5 : 4)), 4, 8);
    case FacilityType.CityHall: return clamp(Math.round(current * 0.55 + 4), 5, 14);
    case FacilityType.PoliceStation: return clamp(Math.round(current * 0.20 + 2), 2, 4);
    case FacilityType.FireStation: return clamp(Math.round(current * 0.16 + 2), 2, 4);
    case FacilityType.Mall: return clamp(Math.round(current * 0.25 + 3), 2, 6);
    case FacilityType.Supermarket: return clamp(Math.round(current * 0.12 + 1), 1, 3);
    case FacilityType.Hotel: return clamp(Math.round(current * 0.78 + 4), 6, 22);
    case FacilityType.GasStation: return clamp(Math.round(current * 0.06 + 1), 1, 2);
    case FacilityType.Stadium: return clamp(Math.round(current * 0.16 + 3), 2, 5);
  }
}

function distSq(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz;
}
