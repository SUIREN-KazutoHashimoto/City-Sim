import type { CityGenerator, Building, ParkingLot } from './CityGenerator';
import type { UrbanBlock } from './BlockParcelLayout';
import { RailNetworkPlan, RailStationKind } from './RailPlanning';
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
 * Reserve whole urban blocks around stations and rail curves before population is assigned.
 *
 * Rail alignment is finalized only after the road network exists, while buildings/facilities have
 * already been generated. We therefore remove generated development from affected blocks here,
 * disable/remap the corresponding POIs, and convert station-adjacent blocks into civic parks. This
 * keeps long platforms and curve envelopes free of buildings without leaving invisible occupied POIs.
 */
export function reserveRailStationClearance(city: CityGenerator, rail: RailNetworkPlan): RailStationClearanceStats {
  if (rail.stations.length === 0) {
    return { buildingsRemoved: 0, parkingLotsRemoved: 0, stationParkBlocks: 0, curveBlocksCleared: 0, parksAdded: 0 };
  }

  const stationBlocks = new Set<number>();
  const curveBlocks = new Set<number>();
  const curvePoints = collectRailCurveIntersections(rail);

  for (const block of city.blocks) {
    if (rail.stations.some((station) => blockWithinRadius(block, station, stationBlockRadius(station.kind)))) {
      stationBlocks.add(block.id);
    }
    if (curvePoints.some((point) => blockWithinRadius(block, point, 18))) curveBlocks.add(block.id);
  }

  const clearedBlocks = new Set<number>([...stationBlocks, ...curveBlocks]);
  const removedBuildingIds = new Set<number>();
  for (const b of city.buildings) {
    if (buildingInsideAnyBlock(b, city.blocks, clearedBlocks) || intersectsAnyStation(b.x, b.z, Math.hypot(b.width, b.depth) * 0.42, rail)) {
      removedBuildingIds.add(b.id);
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
    const radius = Math.hypot(lot.width, lot.depth) * 0.32;
    if (pointInsideAnyBlock(lot.x, lot.z, city.blocks, clearedBlocks) || intersectsAnyStation(lot.x, lot.z, radius, rail)) {
      parkingLotsRemoved++;
      city.poi.disable(lot.poiId);
      continue;
    }
    lot.id = keptLots.length;
    city.lotByPOI.set(lot.poiId, lot.id);
    keptLots.push(lot);
  }
  city.parkingLots.splice(0, city.parkingLots.length, ...keptLots);

  let parksAdded = 0;
  for (const blockId of stationBlocks) {
    const block = city.blocks.find((candidate) => candidate.id === blockId);
    if (!block) continue;
    const alreadyPark = city.parks.some((park) => Math.abs(park.x - block.x) < 0.5 && Math.abs(park.z - block.z) < 0.5);
    if (alreadyPark) continue;
    const area = Math.max(1, block.width * block.depth);
    const capacity = Math.max(120, Math.round(area / 12));
    const poiId = city.poi.add({
      category: POICategory.Leisure,
      x: block.x,
      z: block.z,
      priceTier: 0.05,
      capacity,
      buildingId: -1,
    });
    city.parks.push({
      id: city.parks.length,
      x: block.x,
      z: block.z,
      width: block.width,
      depth: block.depth,
      kind: 'civic',
      capacity,
      poiId,
    });
    parksAdded++;
  }

  return {
    buildingsRemoved: removedBuildingIds.size,
    parkingLotsRemoved,
    stationParkBlocks: stationBlocks.size,
    curveBlocksCleared: curveBlocks.size,
    parksAdded,
  };
}

function stationBlockRadius(kind: RailStationKind): number {
  return kind === RailStationKind.Central ? 125
    : kind === RailStationKind.SubCenter ? 112
      : kind === RailStationKind.Terminal ? 104 : 96;
}

function intersectsAnyStation(x: number, z: number, objectRadius: number, rail: RailNetworkPlan): boolean {
  for (const station of rail.stations) {
    const clearance = station.kind === RailStationKind.Central ? 142
      : station.kind === RailStationKind.SubCenter ? 134
        : station.kind === RailStationKind.Terminal ? 128 : 122;
    const dx = x - station.x, dz = z - station.z;
    if (dx * dx + dz * dz <= (clearance + Math.min(24, objectRadius)) ** 2) return true;
  }
  return false;
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
      if (turn < Math.PI / 36) continue; // ignore tiny numerical bends below 5 degrees
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

function buildingInsideAnyBlock(building: Building, blocks: UrbanBlock[], ids: Set<number>): boolean {
  return pointInsideAnyBlock(building.x, building.z, blocks, ids);
}
