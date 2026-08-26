import { BuildingArchetype, RoofType } from './CityGenerator';
import type { CityGenerator, Building, ParkingLot } from './CityGenerator';
import type { UrbanBlock } from './BlockParcelLayout';
import { RailNetworkPlan, RailStationKind } from './RailPlanning';
import { setRailStationOpenSpaces } from './RailPlanningEnhancements';
import { POICategory } from '../world/POI';

export interface RailStationClearanceStats {
  buildingsRemoved: number;
  parkingLotsRemoved: number;
  stationParkBlocks: number;
  curveBlocksCleared: number;
  parksAdded: number;
}

interface PointXZ { x: number; z: number; }

/**
 * Clear only the real railway/station envelope. The previous whole-block clearing produced oversized
 * green voids around stations; safe buildings in station-adjacent blocks are now retained and major
 * station frontage is converted to low-rise food/retail/leisure uses.
 */
export function reserveRailStationClearance(city: CityGenerator, rail: RailNetworkPlan): RailStationClearanceStats {
  if (rail.stations.length === 0) {
    return { buildingsRemoved: 0, parkingLotsRemoved: 0, stationParkBlocks: 0, curveBlocksCleared: 0, parksAdded: 0 };
  }

  setRailStationOpenSpaces(city.parks);
  rail.alignToRoadNetwork(city.net);

  const stationBlocks = new Set<number>();
  const majorCommercialBlocks = new Set<number>();
  const curveBlocks = new Set<number>();
  const curvePoints = collectRailCurveIntersections(rail);

  for (const block of city.blocks) {
    for (const station of rail.stations) {
      if (!blockWithinRadius(block, station, stationBlockRadius(station.kind))) continue;
      stationBlocks.add(block.id);
      if (station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter) majorCommercialBlocks.add(block.id);
    }
    if (curvePoints.some((point) => blockWithinRadius(block, point, 18))) curveBlocks.add(block.id);
  }

  const facilityBuildingIds = new Set(city.facilities.map((facility) => facility.buildingId));
  const removedBuildingIds = new Set<number>();
  for (const building of city.buildings) {
    const objectRadius = Math.min(22, Math.hypot(building.width, building.depth) * 0.38);
    if (intersectsRailEnvelope(building.x, building.z, objectRadius, rail)) {
      removedBuildingIds.add(building.id);
      continue;
    }
    if (majorCommercialBlocks.size > 0
      && pointInsideAnyBlock(building.x, building.z, city.blocks, majorCommercialBlocks)
      && !facilityBuildingIds.has(building.id)) {
      restyleStationCommercial(city, building);
    }
  }

  for (const id of removedBuildingIds) city.poi.disableBuildingPOIs(id);

  if (removedBuildingIds.size > 0) {
    const oldCount = city.buildings.length;
    const remap = new Int32Array(oldCount); remap.fill(-1);
    const kept: Building[] = [];
    for (const b of city.buildings) {
      if (removedBuildingIds.has(b.id)) continue;
      const oldId = b.id, newId = kept.length;
      remap[oldId] = newId;
      b.id = newId;
      kept.push(b);
    }
    city.buildings.splice(0, city.buildings.length, ...kept);

    for (const p of city.poi.all()) {
      if (p.buildingId < 0 || p.buildingId >= remap.length) continue;
      const mapped = remap[p.buildingId];
      p.buildingId = mapped >= 0 ? mapped : -1;
    }

    const keptFacilities = city.facilities.filter((f) => f.buildingId >= 0 && f.buildingId < remap.length && remap[f.buildingId] >= 0);
    for (let i = 0; i < keptFacilities.length; i++) {
      keptFacilities[i].buildingId = remap[keptFacilities[i].buildingId];
      keptFacilities[i].id = i;
    }
    city.facilities.splice(0, city.facilities.length, ...keptFacilities);
  }

  const keptLots: ParkingLot[] = [];
  let parkingLotsRemoved = 0;
  city.lotByPOI.clear();
  for (const lot of city.parkingLots) {
    const radius = Math.min(16, Math.hypot(lot.width, lot.depth) * 0.32);
    if (intersectsRailEnvelope(lot.x, lot.z, radius, rail)) {
      parkingLotsRemoved++;
      city.poi.disable(lot.poiId);
      continue;
    }
    lot.id = keptLots.length;
    city.lotByPOI.set(lot.poiId, lot.id);
    keptLots.push(lot);
  }
  city.parkingLots.splice(0, city.parkingLots.length, ...keptLots);

  return {
    buildingsRemoved: removedBuildingIds.size,
    parkingLotsRemoved,
    stationParkBlocks: stationBlocks.size,
    curveBlocksCleared: curveBlocks.size,
    parksAdded: 0,
  };
}

function restyleStationCommercial(city: CityGenerator, building: Building): void {
  city.poi.disableBuildingPOIs(building.id);

  const variant = Math.abs((building.styleSeed | 0) + building.id * 17) % 3;
  const floors = 2 + variant;
  building.width = Math.max(12, Math.min(34, building.width));
  building.depth = Math.max(12, Math.min(30, building.depth));
  building.floors = floors;
  building.archetype = variant === 2 ? BuildingArchetype.MixedUse : BuildingArchetype.SmallShop;
  building.roofType = RoofType.Flat;
  building.category = variant === 0 ? POICategory.Retail : POICategory.Food;
  building.developmentIntensity = Math.min(0.62, Math.max(0.42, building.developmentIntensity));
  building.siteArea = Math.max(building.width * building.depth * 1.18, building.siteArea * 0.42);
  building.grossFloorArea = building.width * building.depth * floors * 0.86;
  building.coverageRatio = Math.min(0.82, building.width * building.depth / Math.max(1, building.siteArea));
  building.floorAreaRatio = building.grossFloorArea / Math.max(1, building.siteArea);

  const baseCapacity = Math.max(35, Math.round(building.width * building.depth * 0.18));
  city.poi.add({
    category: POICategory.Food,
    x: building.x,
    z: building.z,
    priceTier: 0.34 + variant * 0.09,
    capacity: baseCapacity,
    buildingId: building.id,
  });
  city.poi.add({
    category: POICategory.Retail,
    x: building.x,
    z: building.z,
    priceTier: 0.28 + variant * 0.08,
    capacity: Math.max(28, Math.round(baseCapacity * 0.82)),
    buildingId: building.id,
    stock: 140,
    maxStock: 140,
  });
  if ((building.id & 1) === 0) {
    city.poi.add({
      category: POICategory.Leisure,
      x: building.x,
      z: building.z,
      priceTier: 0.42 + variant * 0.08,
      capacity: Math.max(24, Math.round(baseCapacity * 0.58)),
      buildingId: building.id,
    });
  }
}

function stationBlockRadius(kind: RailStationKind): number {
  return kind === RailStationKind.Central ? 125
    : kind === RailStationKind.SubCenter ? 112
      : kind === RailStationKind.Terminal ? 104 : 96;
}

function intersectsRailEnvelope(x: number, z: number, objectRadius: number, rail: RailNetworkPlan): boolean {
  const clearance = 18 + Math.min(18, Math.max(0, objectRadius));
  const limit2 = clearance * clearance;
  for (const line of rail.lines) {
    for (let i = 1; i < line.path.length; i++) {
      if (pointSegmentDistanceSquared(x, z, line.path[i - 1], line.path[i]) <= limit2) return true;
    }
  }
  return false;
}

function pointSegmentDistanceSquared(x: number, z: number, a: PointXZ, b: PointXZ): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 0.01) return (x - a.x) ** 2 + (z - a.z) ** 2;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
  const qx = a.x + dx * t, qz = a.z + dz * t;
  return (x - qx) ** 2 + (z - qz) ** 2;
}

function collectRailCurveIntersections(rail: RailNetworkPlan): PointXZ[] {
  const result: PointXZ[] = [];
  for (const line of rail.lines) {
    const path = line.path;
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[i - 1], p = path[i], b = path[i + 1];
      const ax = p.x - a.x, az = p.z - a.z, bx = b.x - p.x, bz = b.z - p.z;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la < 1 || lb < 1) continue;
      const dot = Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb)));
      const turn = Math.acos(dot);
      if (turn < Math.PI / 36) continue;
      if (!result.some((q) => (q.x - p.x) ** 2 + (q.z - p.z) ** 2 < 4)) result.push({ x: p.x, z: p.z });
    }
  }
  return result;
}

function blockWithinRadius(block: UrbanBlock, point: PointXZ, radius: number): boolean {
  const dx = Math.max(0, Math.abs(point.x - block.x) - block.width * 0.5);
  const dz = Math.max(0, Math.abs(point.z - block.z) - block.depth * 0.5);
  return dx * dx + dz * dz <= radius * radius;
}

function pointInsideBlock(x: number, z: number, block: UrbanBlock): boolean {
  return Math.abs(x - block.x) <= block.width * 0.5 + 0.01 && Math.abs(z - block.z) <= block.depth * 0.5 + 0.01;
}

function pointInsideAnyBlock(x: number, z: number, blocks: UrbanBlock[], ids: Set<number>): boolean {
  for (const block of blocks) if (ids.has(block.id) && pointInsideBlock(x, z, block)) return true;
  return false;
}
