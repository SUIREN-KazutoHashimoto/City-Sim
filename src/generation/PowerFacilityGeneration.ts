import { getLoadedPowerConfig } from '../config/CityConfigLoader';
import { fleetDepotForNetwork, supplyChainForPoi } from './RuralIndustryAndDepotTuning';
import { BuildingArchetype, CityGenerator, RoofType, type Building } from './CityGenerator';
import { DistrictType } from './CityPlanning';
import { POICategory } from '../world/POI';
import type { PowerConfig } from '../power/PowerTypes';

export type PlannedPowerFacilityKind = 'generation' | 'substation' | 'external';
export type PlannedPowerFacilityRole = 'thermal' | 'solar' | 'substation' | 'external';

export interface PlannedPowerFacilityBuilding {
  key: string;
  kind: PlannedPowerFacilityKind;
  role: PlannedPowerFacilityRole;
  label: string;
  buildingId: number;
  workPoiId: number;
  x: number;
  z: number;
  roadNodeId: number;
  district: DistrictType;
}

type AnyCity = CityGenerator & Record<string, unknown>;
type AnyMethod = (...args: any[]) => any;
type BuildingMeta = Building & Record<string, unknown>;

const plansByCity = new WeakMap<CityGenerator, PlannedPowerFacilityBuilding[]>();

function hasActiveWorkPoi(city: CityGenerator, buildingId: number): boolean {
  return city.poi.poisInBuilding(buildingId)
    .some((poi) => poi.category === POICategory.Work && poi.capacity > 0);
}

function reservedBuildings(city: CityGenerator): Set<number> {
  const used = new Set<number>();
  for (const facility of city.facilities) used.add(facility.buildingId);

  const chain = supplyChainForPoi(city.poi);
  if (chain) for (const site of chain.sites) used.add(site.buildingId);

  for (const kind of ['taxi', 'bus', 'freight'] as const) {
    const depot = fleetDepotForNetwork(city.net, kind);
    if (depot) used.add(depot.buildingId);
  }

  for (const building of city.buildings) {
    const meta = building as BuildingMeta;
    if (typeof meta.infrastructureLabel === 'string') used.add(building.id);
  }
  return used;
}

function industrialArchetype(building: Building): boolean {
  return building.archetype === BuildingArchetype.Factory || building.archetype === BuildingArchetype.Warehouse;
}

function candidateScore(
  city: CityGenerator,
  building: Building,
  targetX: number,
  targetZ: number,
  role: PlannedPowerFacilityRole,
): number {
  const distance = Math.hypot(building.x - targetX, building.z - targetZ) / Math.max(1, city.sizeMeters);
  const area = Math.max(1, building.siteArea);
  let districtPenalty = 0;
  let archetypePenalty = 0;
  let sizePenalty = 0;
  let floorPenalty = 0;

  if (role === 'thermal' || role === 'solar') {
    const industrial = building.district === DistrictType.Industrial || building.district === DistrictType.Logistics;
    districtPenalty = industrial ? 0 : role === 'thermal' ? 1.25 : 0.75;
    archetypePenalty = industrialArchetype(building) ? 0 : 0.45;
    const desiredArea = role === 'thermal' ? 1350 : 850;
    sizePenalty = Math.max(0, desiredArea - area) / desiredArea * 0.55;
    sizePenalty -= Math.min(0.18, Math.sqrt(area) / 400);
    floorPenalty = Math.max(0, building.floors - 4) * 0.08;
  } else if (role === 'external') {
    const edgeDistrict = building.district === DistrictType.Logistics || building.district === DistrictType.Industrial;
    districtPenalty = edgeDistrict ? 0 : 0.48;
    archetypePenalty = industrialArchetype(building) || building.archetype === BuildingArchetype.SmallOffice ? 0 : 0.18;
    sizePenalty = Math.max(0, 260 - area) / 800;
    floorPenalty = Math.max(0, building.floors - 4) * 0.07;
  } else {
    const logicalDistrict = city.planning.sample(targetX, targetZ).district;
    districtPenalty = building.district === logicalDistrict ? 0 : 0.12;
    archetypePenalty = building.floors <= 4 ? 0 : 0.22;
    sizePenalty = area < 100 ? 0.12 : area > 2600 ? Math.min(0.22, (area - 2600) / 10000) : 0;
    floorPenalty = Math.max(0, building.floors - 4) * 0.12;
  }

  return distance * (role === 'substation' ? 5.4 : role === 'external' ? 4.6 : 3.4)
    + districtPenalty + archetypePenalty + sizePenalty + floorPenalty;
}

function chooseBuilding(
  city: CityGenerator,
  used: Set<number>,
  targetX: number,
  targetZ: number,
  role: PlannedPowerFacilityRole,
): Building | null {
  const available = city.buildings
    .filter((building) => !used.has(building.id))
    .filter((building) => building.district !== DistrictType.Park);
  if (!available.length) return null;

  const work = available.filter((building) => hasActiveWorkPoi(city, building.id));
  const candidates = work.length ? work : available;
  candidates.sort((a, b) => candidateScore(city, a, targetX, targetZ, role) - candidateScore(city, b, targetX, targetZ, role));
  return candidates[0] ?? null;
}

function frontageRoadNode(city: CityGenerator, building: Building): number {
  const margin = 2;
  let x = building.x;
  let z = building.z;
  if (building.frontage === 'north') z -= building.depth * 0.5 + margin;
  else if (building.frontage === 'south') z += building.depth * 0.5 + margin;
  else if (building.frontage === 'west') x -= building.width * 0.5 + margin;
  else x += building.width * 0.5 + margin;
  return city.net.nearestNode(x, z);
}

function normalizeBuildingMass(building: Building, role: PlannedPowerFacilityRole): void {
  if (role === 'thermal') {
    building.archetype = BuildingArchetype.Factory;
    building.roofType = RoofType.Mechanical;
    building.floors = Math.max(1, Math.min(3, building.floors));
  } else if (role === 'solar') {
    building.archetype = BuildingArchetype.Warehouse;
    building.roofType = RoofType.Flat;
    building.floors = 1;
  } else if (role === 'substation') {
    building.archetype = building.siteArea > 900 ? BuildingArchetype.Warehouse : BuildingArchetype.SmallOffice;
    building.roofType = RoofType.Mechanical;
    building.floors = Math.max(1, Math.min(2, building.floors));
  } else {
    building.archetype = building.siteArea > 1000 ? BuildingArchetype.Warehouse : BuildingArchetype.SmallOffice;
    building.roofType = RoofType.Mechanical;
    building.floors = Math.max(1, Math.min(2, building.floors));
  }
  const floorplateFactor = building.archetype === BuildingArchetype.Warehouse || building.archetype === BuildingArchetype.Factory ? 0.96 : 0.88;
  building.grossFloorArea = building.width * building.depth * building.floors * floorplateFactor;
  building.floorAreaRatio = building.grossFloorArea / Math.max(1, building.siteArea);
}

function convertBuilding(
  city: CityGenerator,
  building: Building,
  key: string,
  kind: PlannedPowerFacilityKind,
  role: PlannedPowerFacilityRole,
  label: string,
  capacity: number,
): PlannedPowerFacilityBuilding {
  city.poi.disableBuildingPOIs(building.id);
  building.category = POICategory.Work;
  normalizeBuildingMass(building, role);

  const meta = building as BuildingMeta;
  meta.infrastructureLabel = label;
  meta.powerFacilityKey = key;
  meta.powerFacilityKind = kind;
  meta.powerFacilityRole = role;

  const workPoiId = city.poi.add({
    category: POICategory.Work,
    x: building.x,
    z: building.z,
    priceTier: kind === 'generation' ? 0.48 : 0.42,
    capacity: Math.max(1, Math.floor(capacity)),
    buildingId: building.id,
  });

  return {
    key,
    kind,
    role,
    label,
    buildingId: building.id,
    workPoiId,
    x: building.x,
    z: building.z,
    roadNodeId: frontageRoadNode(city, building),
    district: building.district,
  };
}

function generationRosterTarget(cfg: PowerConfig, role: 'thermal' | 'solar', maxMw: number): number {
  const per100 = role === 'thermal' ? cfg.thermalPlantStaffPer100Mw : cfg.solarPlantStaffPer100Mw;
  const minimum = role === 'thermal' ? 8 : 2;
  return Math.max(minimum, Math.ceil(maxMw / 100 * per100));
}

function generationTarget(
  city: CityGenerator,
  role: 'thermal' | 'solar',
  index: number,
  count: number,
): { x: number; z: number } {
  const anchor = index % 2
    ? (role === 'thermal' ? city.planning.logisticsCenter : city.planning.industrialCenter)
    : (role === 'thermal' ? city.planning.industrialCenter : city.planning.logisticsCenter);
  const angle = index / Math.max(1, count) * Math.PI * 2 + (role === 'thermal' ? 0.45 : 1.2);
  const radius = role === 'thermal'
    ? Math.max(160, city.sizeMeters * (0.012 + (index % 3) * 0.004))
    : Math.max(280, city.sizeMeters * (0.025 + (index % 4) * 0.006));
  return {
    x: Math.max(0, Math.min(city.sizeMeters, anchor.x + Math.cos(angle) * radius)),
    z: Math.max(0, Math.min(city.sizeMeters, anchor.z + Math.sin(angle) * radius)),
  };
}

function substationTargets(city: CityGenerator, cfg: PowerConfig): Array<{ x: number; z: number }> {
  if (!city.net.nodes.length) return [];
  const spacing = Math.max(300, cfg.substationSpacingMeters);
  const minD2 = (spacing * 0.48) ** 2;
  const candidates = city.net.nodes.filter((node) => {
    const plan = city.planning.sample(node.x, node.z);
    return plan.district !== DistrictType.Park
      && (plan.urbanScore >= city.urbanThreshold * 0.82 || plan.district === DistrictType.Industrial || plan.district === DistrictType.Logistics || plan.district === DistrictType.Civic);
  });
  const pool = candidates.length ? candidates : city.net.nodes;
  const result: Array<{ x: number; z: number }> = [];

  const addNearest = (x: number, z: number): void => {
    if (result.length >= 256) return;
    let best = -1;
    let distance = Infinity;
    for (const node of pool) {
      const d = (node.x - x) ** 2 + (node.z - z) ** 2;
      if (d < distance) { distance = d; best = node.id; }
    }
    if (best < 0) return;
    const node = city.net.nodes[best];
    if (result.some((entry) => (entry.x - node.x) ** 2 + (entry.z - node.z) ** 2 < minD2)) return;
    result.push({ x: node.x, z: node.z });
  };

  for (let z = spacing * 0.5; z < city.sizeMeters && result.length < 256; z += spacing) {
    for (let x = spacing * 0.5; x < city.sizeMeters && result.length < 256; x += spacing) addNearest(x, z);
  }
  addNearest(city.planning.industrialCenter.x, city.planning.industrialCenter.z);
  addNearest(city.planning.logisticsCenter.x, city.planning.logisticsCenter.z);
  addNearest(city.planning.cbd.x, city.planning.cbd.z);
  if (!result.length) addNearest(city.sizeMeters * 0.5, city.sizeMeters * 0.5);
  return result;
}

function planPowerFacilityBuildings(city: CityGenerator): void {
  const cfg = getLoadedPowerConfig();
  if (!cfg.enabled) { plansByCity.set(city, []); return; }

  const used = reservedBuildings(city);
  const plans: PlannedPowerFacilityBuilding[] = [];
  const reserve = (
    key: string,
    kind: PlannedPowerFacilityKind,
    role: PlannedPowerFacilityRole,
    label: string,
    targetX: number,
    targetZ: number,
    capacity: number,
  ): void => {
    const building = chooseBuilding(city, used, targetX, targetZ, role);
    if (!building) return;
    used.add(building.id);
    plans.push(convertBuilding(city, building, key, kind, role, label, capacity));
  };

  const thermalCount = Math.max(0, Math.floor(cfg.thermalPlantCount));
  for (let i = 0; i < thermalCount; i++) {
    const target = generationTarget(city, 'thermal', i, thermalCount);
    reserve(
      `generation:thermal-${i}`,
      'generation',
      'thermal',
      `火力発電所 thermal-${i}`,
      target.x,
      target.z,
      generationRosterTarget(cfg, 'thermal', cfg.thermalPlantCapacityMw),
    );
  }

  const solarCount = Math.max(0, Math.floor(cfg.solarPlantCount));
  for (let i = 0; i < solarCount; i++) {
    const target = generationTarget(city, 'solar', i, solarCount);
    reserve(
      `generation:solar-${i}`,
      'generation',
      'solar',
      `太陽光発電所 solar-${i}`,
      target.x,
      target.z,
      generationRosterTarget(cfg, 'solar', cfg.solarPlantCapacityMw),
    );
  }

  const gates = city.gateNodes.filter((node) => node >= 0 && node < city.net.nodes.length);
  const externalCount = Math.min(Math.max(0, Math.floor(cfg.externalConnectionCount)), gates.length);
  for (let i = 0; i < externalCount; i++) {
    const node = city.net.nodes[gates[Math.floor(i * gates.length / externalCount)]];
    reserve(`external:external-${i}`, 'external', 'external', `外部受電所 external-${i}`, node.x, node.z, 6);
  }

  const substations = substationTargets(city, cfg);
  for (let i = 0; i < substations.length; i++) {
    const target = substations[i];
    reserve(`substation:substation-${i}`, 'substation', 'substation', `変電所 substation-${i}`, target.x, target.z, 4);
  }

  plansByCity.set(city, plans);
  console.info('[City-Sim] power facilities generated as Building records', {
    generation: plans.filter((plan) => plan.kind === 'generation').length,
    substations: plans.filter((plan) => plan.kind === 'substation').length,
    external: plans.filter((plan) => plan.kind === 'external').length,
  });
}

export function plannedPowerFacilityBuildings(city: CityGenerator): readonly PlannedPowerFacilityBuilding[] {
  return plansByCity.get(city) ?? [];
}

export function plannedPowerFacilityByKey(city: CityGenerator, key: string): PlannedPowerFacilityBuilding | null {
  return plansByCity.get(city)?.find((plan) => plan.key === key) ?? null;
}

const proto = CityGenerator.prototype as unknown as Record<string, any>;
if (!proto.__citySimPowerFacilityGenerationV1026) {
  const previousGenerate = proto.generate as AnyMethod;
  proto.generate = function generateWithPowerFacilities(this: AnyCity): void {
    previousGenerate.call(this);
    planPowerFacilityBuildings(this);
  };
  proto.__citySimPowerFacilityGenerationV1026 = true;
}
