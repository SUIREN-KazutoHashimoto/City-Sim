import { BuildingArchetype, RoofType, type Building } from '../generation/CityGenerator';
import { DistrictType } from '../generation/CityPlanning';
import { fleetDepotForNetwork, supplyChainForPoi } from '../generation/RuralIndustryAndDepotTuning';
import { POICategory } from '../world/POI';
import type { PowerSystem } from './PowerSystem';
import { GenerationType } from './PowerTypes';

export type PowerFacilityBuildingKind = 'generation' | 'substation' | 'external';

export interface PowerFacilityBuildingBinding {
  key: string;
  kind: PowerFacilityBuildingKind;
  label: string;
  buildingId: number;
  workPoiId: number;
}

type BuildingMeta = Building & Record<string, unknown>;
type CandidateRole = 'thermal' | 'solar' | 'substation' | 'external';

const bindingsBySystem = new WeakMap<PowerSystem, Map<string, PowerFacilityBuildingBinding>>();
const bindingsByBuilding = new WeakMap<PowerSystem, Map<number, PowerFacilityBuildingBinding>>();

export function generationRosterTarget(system: PowerSystem, type: GenerationType, maxOutputKw: number): number {
  const maxOutputMw = Math.max(0, maxOutputKw / 1000);
  const per100 = type === GenerationType.Thermal
    ? system.config.thermalPlantStaffPer100Mw
    : system.config.solarPlantStaffPer100Mw;
  const minimum = type === GenerationType.Thermal ? 8 : 2;
  return Math.max(minimum, Math.ceil(maxOutputMw / 100 * per100));
}

function hasActiveWorkPoi(system: PowerSystem, buildingId: number): boolean {
  return system.city.poi.poisInBuilding(buildingId)
    .some((poi) => poi.category === POICategory.Work && poi.capacity > 0);
}

function reservedBuildings(system: PowerSystem): Set<number> {
  const used = new Set<number>();
  for (const facility of system.city.facilities) used.add(facility.buildingId);

  const chain = supplyChainForPoi(system.city.poi);
  if (chain) for (const site of chain.sites) used.add(site.buildingId);

  for (const kind of ['taxi', 'bus', 'freight'] as const) {
    const depot = fleetDepotForNetwork(system.city.net, kind);
    if (depot) used.add(depot.buildingId);
  }

  for (const building of system.city.buildings) {
    const meta = building as BuildingMeta;
    if (typeof meta.infrastructureLabel === 'string') used.add(building.id);
  }
  return used;
}

function industrialArchetype(building: Building): boolean {
  return building.archetype === BuildingArchetype.Factory || building.archetype === BuildingArchetype.Warehouse;
}

function candidateScore(
  system: PowerSystem,
  building: Building,
  targetX: number,
  targetZ: number,
  role: CandidateRole,
): number {
  const distance = Math.hypot(building.x - targetX, building.z - targetZ) / Math.max(1, system.city.sizeMeters);
  const area = Math.max(1, building.siteArea);
  let districtPenalty = 0;
  let archetypePenalty = 0;
  let sizePenalty = 0;

  if (role === 'thermal' || role === 'solar') {
    const industrial = building.district === DistrictType.Industrial || building.district === DistrictType.Logistics;
    districtPenalty = industrial ? 0 : 0.85;
    archetypePenalty = industrialArchetype(building) ? 0 : 0.34;
    const desiredArea = role === 'thermal' ? 1350 : 850;
    sizePenalty = Math.max(0, desiredArea - area) / desiredArea * 0.42;
    // Large industrial parcels are preferable, but location still dominates.
    sizePenalty -= Math.min(0.18, Math.sqrt(area) / 400);
  } else if (role === 'external') {
    const edgeDistrict = building.district === DistrictType.Logistics || building.district === DistrictType.Industrial;
    districtPenalty = edgeDistrict ? 0 : 0.38;
    archetypePenalty = industrialArchetype(building) || building.archetype === BuildingArchetype.SmallOffice ? 0 : 0.16;
    sizePenalty = Math.max(0, 280 - area) / 900;
  } else {
    const logicalDistrict = system.city.planning.sample(targetX, targetZ).district;
    districtPenalty = building.district === logicalDistrict ? 0 : 0.10;
    archetypePenalty = building.floors <= 4 ? 0 : 0.15;
    // A substation should use a modest road-fronting site rather than a tower or very large plant parcel.
    sizePenalty = area < 120 ? 0.12 : area > 2600 ? Math.min(0.18, (area - 2600) / 12000) : 0;
  }

  return distance * (role === 'substation' ? 5.2 : role === 'external' ? 4.4 : 3.2)
    + districtPenalty + archetypePenalty + sizePenalty;
}

function chooseBuilding(
  system: PowerSystem,
  used: Set<number>,
  targetX: number,
  targetZ: number,
  role: CandidateRole,
): Building | null {
  const candidates = system.city.buildings
    .filter((building) => !used.has(building.id))
    .filter((building) => hasActiveWorkPoi(system, building.id));
  if (!candidates.length) return null;
  candidates.sort((a, b) => candidateScore(system, a, targetX, targetZ, role) - candidateScore(system, b, targetX, targetZ, role));
  return candidates[0] ?? null;
}

function frontageRoadNode(system: PowerSystem, building: Building, fallback: number): number {
  const margin = 7;
  let x = building.x;
  let z = building.z;
  if (building.frontage === 'north') z -= building.depth * 0.5 + margin;
  else if (building.frontage === 'south') z += building.depth * 0.5 + margin;
  else if (building.frontage === 'west') x -= building.width * 0.5 + margin;
  else x += building.width * 0.5 + margin;
  const node = system.city.net.nearestNode(x, z);
  return node >= 0 ? node : fallback;
}

function convertBuilding(
  system: PowerSystem,
  building: Building,
  key: string,
  kind: PowerFacilityBuildingKind,
  label: string,
  capacity: number,
  role: CandidateRole,
): PowerFacilityBuildingBinding {
  const poi = system.city.poi;
  poi.disableBuildingPOIs(building.id);
  building.category = POICategory.Work;

  if (role === 'thermal') {
    building.archetype = BuildingArchetype.Factory;
    building.roofType = RoofType.Mechanical;
  } else if (role === 'solar') {
    building.archetype = BuildingArchetype.Warehouse;
    building.roofType = RoofType.Flat;
  } else if (role === 'substation') {
    building.archetype = building.siteArea > 900 ? BuildingArchetype.Warehouse : BuildingArchetype.SmallOffice;
    building.roofType = RoofType.Mechanical;
  } else {
    building.archetype = building.siteArea > 1000 ? BuildingArchetype.Warehouse : BuildingArchetype.SmallOffice;
    building.roofType = RoofType.Mechanical;
  }

  const meta = building as BuildingMeta;
  meta.infrastructureLabel = label;
  meta.powerFacilityKey = key;
  meta.powerFacilityKind = kind;

  const workPoiId = poi.add({
    category: POICategory.Work,
    x: building.x,
    z: building.z,
    priceTier: kind === 'generation' ? 0.48 : 0.42,
    capacity: Math.max(1, Math.floor(capacity)),
    buildingId: building.id,
  });

  return { key, kind, label, buildingId: building.id, workPoiId };
}

function remember(system: PowerSystem, binding: PowerFacilityBuildingBinding): void {
  let byKey = bindingsBySystem.get(system);
  if (!byKey) { byKey = new Map(); bindingsBySystem.set(system, byKey); }
  let byBuilding = bindingsByBuilding.get(system);
  if (!byBuilding) { byBuilding = new Map(); bindingsByBuilding.set(system, byBuilding); }
  byKey.set(binding.key, binding);
  byBuilding.set(binding.buildingId, binding);
}

export function bindPowerFacilitiesToBuildings(system: PowerSystem): void {
  if (bindingsBySystem.has(system)) return;
  bindingsBySystem.set(system, new Map());
  bindingsByBuilding.set(system, new Map());

  const used = reservedBuildings(system);

  for (const facility of system.generationFacilities) {
    const role: CandidateRole = facility.type === GenerationType.Thermal ? 'thermal' : 'solar';
    const building = chooseBuilding(system, used, facility.x, facility.z, role);
    if (!building) continue;
    used.add(building.id);
    const label = facility.type === GenerationType.Thermal
      ? `火力発電所 ${facility.id}`
      : `太陽光発電所 ${facility.id}`;
    const binding = convertBuilding(
      system,
      building,
      `generation:${facility.id}`,
      'generation',
      label,
      generationRosterTarget(system, facility.type, facility.maxOutputKw),
      role,
    );
    facility.x = building.x;
    facility.z = building.z;
    facility.roadNodeId = frontageRoadNode(system, building, facility.roadNodeId);
    remember(system, binding);
  }

  for (const connection of system.externalConnections) {
    const building = chooseBuilding(system, used, connection.x, connection.z, 'external');
    if (!building) continue;
    used.add(building.id);
    const binding = convertBuilding(
      system,
      building,
      `external:${connection.id}`,
      'external',
      `外部受電所 ${connection.id}`,
      6,
      'external',
    );
    connection.x = building.x;
    connection.z = building.z;
    connection.roadNodeId = frontageRoadNode(system, building, connection.roadNodeId);
    remember(system, binding);
  }

  for (const substation of system.substations) {
    const building = chooseBuilding(system, used, substation.x, substation.z, 'substation');
    if (!building) continue;
    used.add(building.id);
    const binding = convertBuilding(
      system,
      building,
      `substation:${substation.id}`,
      'substation',
      `変電所 ${substation.id}`,
      4,
      'substation',
    );
    substation.x = building.x;
    substation.z = building.z;
    substation.roadNodeId = frontageRoadNode(system, building, substation.roadNodeId);
    substation.district = building.district;
    remember(system, binding);
  }

  // All source/substation road-node changes must be reflected before the first simulation tick.
  system.rebuildTopology();
}

export function powerFacilityBuildingBinding(system: PowerSystem, key: string): PowerFacilityBuildingBinding | null {
  return bindingsBySystem.get(system)?.get(key) ?? null;
}

export function powerFacilityForBuilding(system: PowerSystem, buildingId: number): PowerFacilityBuildingBinding | null {
  return bindingsByBuilding.get(system)?.get(buildingId) ?? null;
}

export function powerFacilityBindings(system: PowerSystem): readonly PowerFacilityBuildingBinding[] {
  return [...(bindingsBySystem.get(system)?.values() ?? [])];
}
