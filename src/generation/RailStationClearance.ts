import type { CityGenerator, Building, ParkingLot } from './CityGenerator';
import { RailNetworkPlan, RailStationKind } from './RailPlanning';

export interface RailStationClearanceStats {
  buildingsRemoved: number;
  parkingLotsRemoved: number;
}

/**
 * RailPlanningは道路完成後に駅を実道路へスナップするため、駅の最終位置はCityGenerator生成時点では確定していない。
 * 人口生成前に最終駅位置の周囲を駅施設用空地として確保し、見えない建物へAgentが割り当てられないようPOIも無効化する。
 */
export function reserveRailStationClearance(city: CityGenerator, rail: RailNetworkPlan): RailStationClearanceStats {
  if (rail.stations.length === 0) return { buildingsRemoved: 0, parkingLotsRemoved: 0 };

  const removedBuildingIds = new Set<number>();
  for (const b of city.buildings) {
    if (intersectsAnyStation(b.x, b.z, Math.hypot(b.width, b.depth) * 0.42, rail)) removedBuildingIds.add(b.id);
  }

  for (const id of removedBuildingIds) city.poi.disableBuildingPOIs(id);

  if (removedBuildingIds.size > 0) {
    const oldCount = city.buildings.length;
    const remap = new Int32Array(oldCount); remap.fill(-1);
    const kept: Building[] = [];
    for (const b of city.buildings) {
      if (removedBuildingIds.has(b.id)) continue;
      const oldId = b.id, newId = kept.length;
      remap[oldId] = newId; b.id = newId; kept.push(b);
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
    if (intersectsAnyStation(lot.x, lot.z, radius, rail)) {
      parkingLotsRemoved++;
      const p = city.poi.get(lot.poiId);
      p.capacity = 0; p.occupancy = 0; p.stock = 0; p.maxStock = 0;
      continue;
    }
    lot.id = keptLots.length;
    city.lotByPOI.set(lot.poiId, lot.id);
    keptLots.push(lot);
  }
  city.parkingLots.splice(0, city.parkingLots.length, ...keptLots);

  return { buildingsRemoved: removedBuildingIds.size, parkingLotsRemoved };
}

function intersectsAnyStation(x: number, z: number, objectRadius: number, rail: RailNetworkPlan): boolean {
  for (const station of rail.stations) {
    const clearance = station.kind === RailStationKind.Central ? 48
      : station.kind === RailStationKind.SubCenter ? 43
        : station.kind === RailStationKind.Terminal ? 38 : 34;
    const dx = x - station.x, dz = z - station.z;
    if (dx * dx + dz * dz <= (clearance + Math.min(22, objectRadius)) ** 2) return true;
  }
  return false;
}
