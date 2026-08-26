import type { CityGenerator } from '../generation/CityGenerator';
import type { RailNetworkPlan } from '../generation/RailPlanning';
import type { RoadNetwork } from '../traffic/RoadNetwork';
import type { POIRegistry } from '../world/POI';
import type { PowerSystem } from './PowerSystem';

export interface PowerQualityAccessor {
  operationalFactorForBuilding(buildingId: number): number;
  operationalFactorForInfrastructure(id: string): number;
}

const byPoi = new WeakMap<object, PowerSystem>();
const byRoad = new WeakMap<object, PowerSystem>();
const byRail = new WeakMap<object, PowerSystem>();
const qualityBySystem = new WeakMap<PowerSystem, PowerQualityAccessor>();

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function registerPowerSystem(city: CityGenerator, system: PowerSystem): void {
  byPoi.set(city.poi as object, system);
  byRoad.set(city.net as object, system);
  byRail.set(city.planning.rail as object, system);
}

export function registerPowerQualityAccessor(system: PowerSystem, accessor: PowerQualityAccessor): void {
  qualityBySystem.set(system, accessor);
}

export function powerSystemForPoi(poi: POIRegistry): PowerSystem | null {
  return byPoi.get(poi as object) ?? null;
}

export function powerSystemForRoad(net: RoadNetwork): PowerSystem | null {
  return byRoad.get(net as object) ?? null;
}

export function powerSystemForRail(rail: RailNetworkPlan): PowerSystem | null {
  return byRail.get(rail as object) ?? null;
}

export function powerOperationalFactorForBuilding(poi: POIRegistry, buildingId: number): number {
  const system = powerSystemForPoi(poi);
  return system ? powerOperationalFactorForBuildingSystem(system, buildingId) : 1;
}

export function powerOperationalFactorForBuildingSystem(system: PowerSystem, buildingId: number): number {
  const quality = qualityBySystem.get(system);
  if (quality) return clamp01(quality.operationalFactorForBuilding(buildingId));
  return clamp01(system.buildingConnections.get(buildingId)?.supplyRatio ?? 1);
}

export function powerOperationalFactorForInfrastructure(system: PowerSystem, id: string): number {
  const quality = qualityBySystem.get(system);
  if (quality) return clamp01(quality.operationalFactorForInfrastructure(id));
  return clamp01(system.infrastructureLoads.find((load) => load.id === id)?.supplyRatio ?? 1);
}

export function powerCommercialCapacityFactor(poi: POIRegistry, buildingId: number): number {
  if (buildingId < 0) return 1;
  const factor = powerOperationalFactorForBuilding(poi, buildingId);
  if (factor < 0.04) return 0;
  return clamp01(0.12 + factor * 0.88);
}

export function powerAverageBuildingFactorNear(net: RoadNetwork, x: number, z: number, radius: number): number {
  const system = powerSystemForRoad(net);
  if (!system) return 1;
  const r2 = radius * radius;
  let weighted = 0, weight = 0;
  for (const building of system.city.buildings) {
    const dx = building.x - x, dz = building.z - z;
    if (dx * dx + dz * dz > r2) continue;
    const areaWeight = Math.max(1, building.grossFloorArea || building.width * building.depth * Math.max(1, building.floors));
    weighted += powerOperationalFactorForBuildingSystem(system, building.id) * areaWeight;
    weight += areaWeight;
  }
  return weight > 0 ? clamp01(weighted / weight) : 1;
}

export function powerAverageStreetLightFactorNear(net: RoadNetwork, x: number, z: number, radius: number): number {
  const system = powerSystemForRoad(net);
  if (!system) return 1;
  const r2 = radius * radius;
  let sum = 0, count = 0;
  for (const load of system.infrastructureLoads) {
    if (load.kind !== 'street-light') continue;
    const node = net.nodes[load.roadNodeId];
    if (!node) continue;
    const dx = node.x - x, dz = node.z - z;
    if (dx * dx + dz * dz > r2) continue;
    sum += powerOperationalFactorForInfrastructure(system, load.id);
    count++;
  }
  return count > 0 ? clamp01(sum / count) : 1;
}

export function powerRailTractionFactor(rail: RailNetworkPlan): number {
  const system = powerSystemForRail(rail);
  if (!system) return 1;
  let sum = 0, count = 0;
  for (const line of rail.lines) {
    sum += powerOperationalFactorForInfrastructure(system, `rail-traction-${line.id}`);
    count++;
  }
  return count > 0 ? clamp01(sum / count) : 1;
}

export function powerRailStationFactor(rail: RailNetworkPlan): number {
  const system = powerSystemForRail(rail);
  if (!system) return 1;
  let sum = 0, count = 0;
  for (const station of rail.stations) {
    sum += powerOperationalFactorForInfrastructure(system, `rail-station-${station.id}`);
    count++;
  }
  return count > 0 ? clamp01(sum / count) : 1;
}
