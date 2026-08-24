import type { CityGenerator, Building, ParkingLot } from './CityGenerator';
import type { UrbanBlock } from './BlockParcelLayout';
import { RailNetworkPlan, RailStationKind } from './RailPlanning';
import { POICategory } from '../world/POI';

export interface StationForecourtSpace {
  id: number;
  stationId: number;
  blockId: number;
  kind: 'plaza' | 'park';
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface RailStationClearanceStats {
  buildingsRemoved: number;
  parkingLotsRemoved: number;
  stationParkBlocks: number;
  curveBlocksCleared: number;
  parksAdded: number;
  plazasAdded: number;
  forecourts: StationForecourtSpace[];
}

interface PointXZ { x: number; z: number; }

/**
 * Reserve compact station forecourts and rail-curve envelopes before population is assigned.
 *
 * A station-adjacent urban block is split into quarters. The quarter nearest the station becomes a
 * paved plaza and the quarter directly behind it becomes a small civic park. We intentionally do
 * not turn the whole surrounding block/radius into parkland: the remaining quarters stay available
 * for ordinary development unless they intersect the minimum station safety envelope.
 */
export function reserveRailStationClearance(city: CityGenerator, rail: RailNetworkPlan): RailStationClearanceStats {
  if (rail.stations.length === 0) {
    return { buildingsRemoved: 0, parkingLotsRemoved: 0, stationParkBlocks: 0, curveBlocksCleared: 0, parksAdded: 0, plazasAdded: 0, forecourts: [] };
  }

  const curveBlocks = new Set<number>();
  const curvePoints = collectRailCurveIntersections(rail);
  for (const block of city.blocks) {
    if (curvePoints.some((point) => blockWithinRadius(block, point, 18))) curveBlocks.add(block.id);
  }

  const forecourts = buildStationForecourts(city.blocks, rail);
  const stationBlocks = new Set(forecourts.map((space) => space.blockId));

  const removedBuildingIds = new Set<number>();
  for (const b of city.buildings) {
    if (
      buildingInsideAnyBlock(b, city.blocks, curveBlocks)
      || objectInsideAnyForecourt(b.x, b.z, Math.min(12, Math.hypot(b.width, b.depth) * 0.22), forecourts)
      || intersectsAnyStationCore(b.x, b.z, Math.hypot(b.width, b.depth) * 0.35, rail)
    ) {
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
    const radius = Math.min(10, Math.hypot(lot.width, lot.depth) * 0.20);
    if (
      pointInsideAnyBlock(lot.x, lot.z, city.blocks, curveBlocks)
      || objectInsideAnyForecourt(lot.x, lot.z, radius, forecourts)
      || intersectsAnyStationCore(lot.x, lot.z, radius, rail)
    ) {
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
  let plazasAdded = 0;
  for (const space of forecourts) {
    const alreadySpace = city.parks.some((park) => Math.abs(park.x - space.x) < 0.75 && Math.abs(park.z - space.z) < 0.75);
    if (alreadySpace) continue;
    const area = Math.max(1, space.width * space.depth);
    const capacity = space.kind === 'plaza' ? Math.max(70, Math.round(area / 18)) : Math.max(90, Math.round(area / 13));
    const poiId = city.poi.add({
      category: POICategory.Leisure,
      x: space.x,
      z: space.z,
      priceTier: space.kind === 'plaza' ? 0.02 : 0.05,
      capacity,
      buildingId: -1,
    });
    const record = {
      id: city.parks.length,
      x: space.x,
      z: space.z,
      width: space.width,
      depth: space.depth,
      kind: 'civic' as const,
      capacity,
      poiId,
      stationSurface: space.kind,
      stationRelated: true,
      stationId: space.stationId,
    };
    city.parks.push(record as (typeof city.parks)[number]);
    if (space.kind === 'plaza') plazasAdded++;
    else parksAdded++;
  }

  return {
    buildingsRemoved: removedBuildingIds.size,
    parkingLotsRemoved,
    stationParkBlocks: stationBlocks.size,
    curveBlocksCleared: curveBlocks.size,
    parksAdded,
    plazasAdded,
    forecourts,
  };
}

function buildStationForecourts(blocks: UrbanBlock[], rail: RailNetworkPlan): StationForecourtSpace[] {
  const spaces: StationForecourtSpace[] = [];
  let nextId = 0;
  for (let stationIndex = 0; stationIndex < rail.stations.length; stationIndex++) {
    const station = rail.stations[stationIndex];
    const stationId = station.id ?? stationIndex;
    const selected = selectFrontageBlocks(blocks, station, stationBlockRadius(station.kind));
    for (const block of selected) {
      const pair = splitFrontageBlock(block, station, stationId, nextId);
      for (const candidate of pair) {
        if (spaces.some((space) => Math.hypot(space.x - candidate.x, space.z - candidate.z) < 2.0)) continue;
        spaces.push(candidate);
        nextId++;
      }
    }
  }
  for (let i = 0; i < spaces.length; i++) spaces[i].id = i;
  return spaces;
}

function selectFrontageBlocks(blocks: UrbanBlock[], station: PointXZ, radius: number): UrbanBlock[] {
  const candidates = blocks
    .filter((block) => blockWithinRadius(block, station, radius))
    .sort((a, b) => blockCenterDistSq(a, station) - blockCenterDistSq(b, station));
  if (candidates.length <= 1) return candidates;

  const first = candidates[0];
  const fx = first.x - station.x, fz = first.z - station.z;
  let second: UrbanBlock | undefined;
  let secondScore = Infinity;
  for (let i = 1; i < Math.min(candidates.length, 10); i++) {
    const c = candidates[i], cx = c.x - station.x, cz = c.z - station.z;
    const dot = fx * cx + fz * cz;
    if (dot >= 0) continue;
    const score = blockCenterDistSq(c, station);
    if (score < secondScore) { second = c; secondScore = score; }
  }
  return second ? [first, second] : [first, candidates[1]];
}

function splitFrontageBlock(block: UrbanBlock, station: PointXZ, stationId: number, idBase: number): StationForecourtSpace[] {
  const dx = station.x - block.x, dz = station.z - block.z;
  const sx = dx === 0 ? 1 : Math.sign(dx);
  const sz = dz === 0 ? 1 : Math.sign(dz);
  const width = Math.max(12, block.width * 0.5 - 5);
  const depth = Math.max(12, block.depth * 0.5 - 5);
  let plazaX: number, plazaZ: number, parkX: number, parkZ: number;

  if (Math.abs(dx) >= Math.abs(dz)) {
    plazaX = block.x + sx * block.width * 0.25;
    plazaZ = block.z + sz * block.depth * 0.25;
    parkX = block.x - sx * block.width * 0.25;
    parkZ = plazaZ;
  } else {
    plazaX = block.x + sx * block.width * 0.25;
    plazaZ = block.z + sz * block.depth * 0.25;
    parkX = plazaX;
    parkZ = block.z - sz * block.depth * 0.25;
  }

  return [
    { id: idBase, stationId, blockId: block.id, kind: 'plaza', x: plazaX, z: plazaZ, width, depth },
    { id: idBase + 1, stationId, blockId: block.id, kind: 'park', x: parkX, z: parkZ, width, depth },
  ];
}

function stationBlockRadius(kind: RailStationKind): number {
  return kind === RailStationKind.Central ? 82
    : kind === RailStationKind.SubCenter ? 76
      : kind === RailStationKind.Terminal ? 72 : 68;
}

function intersectsAnyStationCore(x: number, z: number, objectRadius: number, rail: RailNetworkPlan): boolean {
  for (const station of rail.stations) {
    const clearance = station.kind === RailStationKind.Central ? 38
      : station.kind === RailStationKind.SubCenter ? 34
        : station.kind === RailStationKind.Terminal ? 31 : 28;
    const dx = x - station.x, dz = z - station.z;
    if (dx * dx + dz * dz <= (clearance + Math.min(14, objectRadius)) ** 2) return true;
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

function blockCenterDistSq(block: UrbanBlock, point: PointXZ): number {
  return (block.x - point.x) ** 2 + (block.z - point.z) ** 2;
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

function objectInsideAnyForecourt(x: number, z: number, radius: number, spaces: StationForecourtSpace[]): boolean {
  for (const space of spaces) {
    if (Math.abs(x - space.x) <= space.width * 0.5 + radius && Math.abs(z - space.z) <= space.depth * 0.5 + radius) return true;
  }
  return false;
}
