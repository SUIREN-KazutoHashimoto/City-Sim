import { BuildingArchetype, CityGenerator, RoofType, type Building } from './CityGenerator';
import { DistrictType, type PlanningSample } from './CityPlanning';
import { latestCityForestSpaces, type ForestSpace } from './CityDiversityTuning';
import { baselinePlanningSample } from './UrbanFootprintBaseline';
import { supplyChainForPoi, type ProductionSiteRecord } from './RuralIndustryAndDepotTuning';
import { RoadClass, RoadNetwork } from '../traffic/RoadNetwork';
import { POICategory } from '../world/POI';

export interface FarmEstateRecord {
  id: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  blocksWide: number;
  blocksDeep: number;
  accessX: number;
  accessZ: number;
  heading: number;
  roadNode: number;
  officeBuildingId: number;
  warehouseBuildingId: number;
}

type AnyCity = Record<string, any>;
type AnyRoadNetwork = RoadNetwork & Record<string, any>;
type AnyMethod = (...args: any[]) => any;
type AccessSide = 'west' | 'east' | 'north' | 'south';

interface FarmEstatePlan {
  x: number;
  z: number;
  width: number;
  depth: number;
  blocksWide: number;
  blocksDeep: number;
  blockSize: number;
  accessSide: AccessSide;
  accessX: number;
  accessZ: number;
  heading: number;
  score: number;
}

const plannedByNetwork = new WeakMap<RoadNetwork, FarmEstatePlan[]>();
const estatesByNetwork = new WeakMap<RoadNetwork, FarmEstateRecord[]>();

function clamp(value: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, value)); }
function mod(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function farFromCenters(city: AnyCity, x: number, z: number): number {
  let best = Math.hypot(x - city.planning.cbd.x, z - city.planning.cbd.z);
  for (const c of city.planning.subCenters) best = Math.min(best, Math.hypot(x - c.x, z - c.z));
  return best / Math.max(1, city.sizeMeters);
}

function majorLine(index: number, arterialEvery: number, arterialOffset: number, collectorEvery: number, collectorOffset: number): boolean {
  return mod(index - arterialOffset, arterialEvery) === 0 || mod(index - collectorOffset, collectorEvery) === 0;
}

function planFarmEstates(city: AnyCity): FarmEstatePlan[] {
  const bs = city.cfg.blockSize as number;
  const cols = Math.floor(city.sizeMeters / bs);
  const options = city.planning.options;
  const arterialEvery = Math.max(4, Math.round(options.arterialSpacing / bs));
  const collectorEvery = Math.max(2, Math.round(options.collectorSpacing / bs));
  const arterialOffsetX = mod(Math.round(city.planning.cbd.x / bs), arterialEvery);
  const arterialOffsetZ = mod(Math.round(city.planning.cbd.z / bs), arterialEvery);
  const collectorOffsetX = mod(Math.round(city.planning.cbd.x / bs), collectorEvery);
  const collectorOffsetZ = mod(Math.round(city.planning.cbd.z / bs), collectorEvery);
  const isMajorX = (i: number): boolean => majorLine(i, arterialEvery, arterialOffsetX, collectorEvery, collectorOffsetX);
  const isMajorZ = (i: number): boolean => majorLine(i, arterialEvery, arterialOffsetZ, collectorEvery, collectorOffsetZ);

  const target = clamp(Math.round(cols * cols * Math.max(0.08, city.cfg.urbanRatioTarget) / 180), 8, 32);
  const shapes: Array<[number, number]> = [[3, 2], [2, 3], [3, 3], [4, 2], [2, 4]];
  const candidates: FarmEstatePlan[] = [];

  for (let j = 2; j < cols - 2; j++) for (let i = 2; i < cols - 2; i++) {
    const shape = shapes[Math.floor(hash01(Math.imul(i + 7, 811) ^ Math.imul(j + 11, 1237) ^ city.cfg.seed) * shapes.length) % shapes.length];
    const [w, d] = shape;
    if (i + w >= cols - 1 || j + d >= cols - 1) continue;

    let internalMajor = false;
    for (let x = i + 1; x < i + w; x++) if (isMajorX(x)) internalMajor = true;
    for (let z = j + 1; z < j + d; z++) if (isMajorZ(z)) internalMajor = true;
    if (internalMajor) continue;

    const boundaries: AccessSide[] = [];
    if (isMajorX(i)) boundaries.push('west');
    if (isMajorX(i + w)) boundaries.push('east');
    if (isMajorZ(j)) boundaries.push('north');
    if (isMajorZ(j + d)) boundaries.push('south');
    if (boundaries.length === 0) continue;

    const x = (i + w * 0.5) * bs, z = (j + d * 0.5) * bs;
    const p = baselinePlanningSample(city.planning, x, z) as PlanningSample;
    const far = farFromCenters(city, x, z);
    if (far < 0.19 || p.centerInfluence > 0.30) continue;
    if (p.district === DistrictType.CBD || p.district === DistrictType.Commercial || p.district === DistrictType.Park) continue;

    const accessSide = boundaries[Math.floor(hash01(i * 4099 + j * 8191 + city.cfg.seed) * boundaries.length) % boundaries.length];
    let accessX = x, accessZ = z, heading = 0;
    if (accessSide === 'west') { accessX = i * bs; accessZ = z; heading = Math.PI * 0.5; }
    else if (accessSide === 'east') { accessX = (i + w) * bs; accessZ = z; heading = Math.PI * 0.5; }
    else if (accessSide === 'north') { accessX = x; accessZ = j * bs; heading = 0; }
    else { accessX = x; accessZ = (j + d) * bs; heading = 0; }

    const score = p.centerInfluence * 1.8 + p.density * 0.45 - far * 1.2 + hash01(i * 1619 + j * 3571 + city.cfg.seed) * 0.16;
    candidates.push({
      x, z, width: w * bs - 10, depth: d * bs - 10,
      blocksWide: w, blocksDeep: d, blockSize: bs,
      accessSide, accessX, accessZ, heading, score,
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  const selected: FarmEstatePlan[] = [];
  for (const candidate of candidates) {
    if (selected.length >= target) break;
    const margin = bs * 1.25;
    const overlap = selected.some((other) =>
      Math.abs(other.x - candidate.x) < (other.width + candidate.width) * 0.5 + margin
      && Math.abs(other.z - candidate.z) < (other.depth + candidate.depth) * 0.5 + margin);
    if (!overlap) selected.push(candidate);
  }
  return selected;
}

function edgeInsideEstate(plan: FarmEstatePlan, ax: number, az: number, bx: number, bz: number): boolean {
  const margin = plan.blockSize * 0.24;
  const minX = plan.x - plan.width * 0.5 + margin, maxX = plan.x + plan.width * 0.5 - margin;
  const minZ = plan.z - plan.depth * 0.5 + margin, maxZ = plan.z + plan.depth * 0.5 - margin;
  const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
  return mx > minX && mx < maxX && mz > minZ && mz < maxZ;
}

const roadProto = RoadNetwork.prototype as unknown as Record<string, any>;
if (!roadProto.__citySimFarmEstateRoadGuardV077) {
  const previousConnect = roadProto.connect as AnyMethod;
  roadProto.connect = function connectAroundFarmEstates(this: AnyRoadNetwork, a: number, b: number, roadClass: RoadClass, lanes = 1): void {
    const plans = plannedByNetwork.get(this as RoadNetwork);
    if (plans && roadClass !== RoadClass.Highway && roadClass !== RoadClass.Path) {
      const na = this.nodes[a], nb = this.nodes[b];
      if (na && nb && plans.some((plan) => edgeInsideEstate(plan, na.x, na.z, nb.x, nb.z))) return;
    }
    previousConnect.call(this, a, b, roadClass, lanes);
  };
  roadProto.__citySimFarmEstateRoadGuardV077 = true;
}

function insidePlan(plan: FarmEstatePlan, x: number, z: number, margin = 0): boolean {
  return Math.abs(x - plan.x) <= plan.width * 0.5 + margin && Math.abs(z - plan.z) <= plan.depth * 0.5 + margin;
}

function intersectsPlan(plan: FarmEstatePlan, x: number, z: number, width: number, depth: number): boolean {
  return Math.abs(x - plan.x) * 2 < width + plan.width && Math.abs(z - plan.z) * 2 < depth + plan.depth;
}

function hasBlockingBuilding(city: AnyCity, plan: FarmEstatePlan): boolean {
  for (const building of city.buildings as Array<Building & Record<string, any>>) {
    if (building.infrastructureLabel === 'farm') continue;
    if (insidePlan(plan, building.x, building.z, 18)) return true;
  }
  return false;
}

function inwardVector(side: AccessSide): { x: number; z: number; alongX: number; alongZ: number } {
  if (side === 'west') return { x: 1, z: 0, alongX: 0, alongZ: 1 };
  if (side === 'east') return { x: -1, z: 0, alongX: 0, alongZ: 1 };
  if (side === 'north') return { x: 0, z: 1, alongX: 1, alongZ: 0 };
  return { x: 0, z: -1, alongX: 1, alongZ: 0 };
}

function configureBuilding(
  city: AnyCity,
  building: Building & Record<string, any>,
  x: number,
  z: number,
  width: number,
  depth: number,
  floors: number,
  heading: number,
  archetype: BuildingArchetype,
  label: string,
): number {
  city.poi.disableBuildingPOIs(building.id);
  Object.assign(building, {
    x, z, width, depth, floors, rotation: heading, archetype,
    roofType: archetype === BuildingArchetype.Warehouse ? RoofType.Mechanical : RoofType.Flat,
    category: POICategory.Work, district: DistrictType.Industrial,
    urbanity: 0.10, landValue: 0.12, developmentIntensity: 0.14,
    coverageRatio: 0.52, floorAreaRatio: floors * 0.52,
    grossFloorArea: width * depth * floors * 0.82, siteArea: width * depth * 1.35,
    intendedUse: 'office', infrastructureLabel: label, heightTier: 'low-rise',
  });
  return city.poi.add({
    category: POICategory.Work, x, z, priceTier: 0.28,
    capacity: Math.max(8, Math.round(width * depth * floors / 70)), buildingId: building.id,
  });
}

function addFarmOffice(city: AnyCity, x: number, z: number, heading: number, sequence: number): { buildingId: number; workPoiId: number } {
  const id = city.buildings.length;
  const width = 22, depth = 16, floors = 2;
  const building = {
    id, x, z, width, depth, floors, category: POICategory.Work,
    archetype: BuildingArchetype.SmallOffice, roofType: RoofType.Flat,
    palette: sequence % 4, styleSeed: (city.cfg.seed ^ Math.imul(sequence + 77, 2654435761)) >>> 0,
    rotation: heading, urbanity: 0.12, district: DistrictType.Industrial, landValue: 0.14,
    frontage: 'south', developmentIntensity: 0.16, coverageRatio: 0.58, floorAreaRatio: 1.16,
    grossFloorArea: width * depth * floors * 0.86, siteArea: width * depth * 1.35, parcelCount: 1,
    heightTier: 'low-rise', intendedUse: 'office', infrastructureLabel: 'farm-office',
  } as Building & Record<string, any>;
  city.buildings.push(building);
  const workPoiId = city.poi.add({ category: POICategory.Work, x, z, priceTier: 0.30, capacity: 14, buildingId: id });
  return { buildingId: id, workPoiId };
}

function clearFarmForests(plans: readonly FarmEstatePlan[]): void {
  const forests = latestCityForestSpaces() as ForestSpace[];
  for (let i = forests.length - 1; i >= 0; i--) {
    const forest = forests[i];
    if (plans.some((plan) => intersectsPlan(plan, forest.x, forest.z, forest.width, forest.depth))) forests.splice(i, 1);
  }
}

function clearFarmParks(city: AnyCity, plans: readonly FarmEstatePlan[]): void {
  const retained = [] as any[];
  for (const park of city.parks as any[]) {
    if (plans.some((plan) => intersectsPlan(plan, park.x, park.z, park.width, park.depth))) city.poi.disable(park.poiId);
    else retained.push(park);
  }
  city.parks.length = 0;
  retained.forEach((park, index) => { park.id = index; city.parks.push(park); });
}

function repurposeFarmAsRawFactory(city: AnyCity, site: ProductionSiteRecord & Record<string, any>): void {
  site.kind = 'raw-factory';
  site.inputStage = -1; site.outputStage = 0; site.inputCapacity = 0;
  site.outputCapacity = Math.max(2200, site.outputCapacity); site.processRate = 6.0;
  const building = city.buildings[site.buildingId] as Building & Record<string, any> | undefined;
  if (building) {
    building.archetype = BuildingArchetype.Factory;
    building.infrastructureLabel = 'raw-factory';
    site.width = building.width; site.depth = building.depth;
  }
}

function materializeFarmEstates(city: AnyCity, plans: FarmEstatePlan[]): void {
  const supply = supplyChainForPoi(city.poi);
  if (!supply) return;
  const oldFarms = supply.sites.filter((site) => site.kind === 'farm') as Array<ProductionSiteRecord & Record<string, any>>;
  const usable = plans.filter((plan) => !hasBlockingBuilding(city, plan));
  const count = Math.min(oldFarms.length, usable.length);
  const activePlans = usable.slice(0, count);
  const estates: FarmEstateRecord[] = [];

  for (let i = 0; i < count; i++) {
    const site = oldFarms[i], plan = activePlans[i];
    const warehouse = city.buildings[site.buildingId] as Building & Record<string, any> | undefined;
    if (!warehouse) { repurposeFarmAsRawFactory(city, site); continue; }
    const inward = inwardVector(plan.accessSide);
    const wx = plan.accessX + inward.x * 30 + inward.alongX * 20;
    const wz = plan.accessZ + inward.z * 30 + inward.alongZ * 20;
    const ox = plan.accessX + inward.x * 24 - inward.alongX * 20;
    const oz = plan.accessZ + inward.z * 24 - inward.alongZ * 20;
    const warehousePoi = configureBuilding(city, warehouse, wx, wz, 38, 24, 1, plan.heading, BuildingArchetype.Warehouse, 'farm-warehouse');
    const office = addFarmOffice(city, ox, oz, plan.heading, i);
    const roadNode = city.net.nearestNode(plan.accessX, plan.accessZ);

    site.x = wx; site.z = wz; site.width = 38; site.depth = 24;
    site.fieldX = plan.x; site.fieldZ = plan.z; site.fieldWidth = plan.width; site.fieldDepth = plan.depth;
    site.heading = plan.heading; site.roadNode = roadNode;
    site.outputCapacity = Math.max(4200, Math.round(plan.width * plan.depth / 8));
    site.outputStock = Math.min(site.outputCapacity, Math.max(site.outputStock, site.outputCapacity * 0.22));
    site.processRate = Math.max(10, plan.blocksWide * plan.blocksDeep * 1.7);
    site.officeBuildingId = office.buildingId;
    site.warehouseBuildingId = warehouse.id;
    site.workPoiIds = [office.workPoiId, warehousePoi];
    site.blocksWide = plan.blocksWide; site.blocksDeep = plan.blocksDeep;

    estates.push({
      id: estates.length, x: plan.x, z: plan.z, width: plan.width, depth: plan.depth,
      blocksWide: plan.blocksWide, blocksDeep: plan.blocksDeep,
      accessX: plan.accessX, accessZ: plan.accessZ, heading: plan.heading, roadNode,
      officeBuildingId: office.buildingId, warehouseBuildingId: warehouse.id,
    });
  }

  for (let i = count; i < oldFarms.length; i++) repurposeFarmAsRawFactory(city, oldFarms[i]);
  clearFarmForests(activePlans);
  clearFarmParks(city, activePlans);
  estatesByNetwork.set(city.net, estates);
  console.info('[City-Sim] farm estates', {
    estates: estates.length,
    farmBlocks: estates.reduce((sum, estate) => sum + estate.blocksWide * estate.blocksDeep, 0),
    convertedLegacyFarms: Math.max(0, oldFarms.length - count),
  });
}

export function farmEstatesForNetwork(net: RoadNetwork): readonly FarmEstateRecord[] {
  return estatesByNetwork.get(net) ?? [];
}

const cityProto = CityGenerator.prototype as unknown as Record<string, any>;
if (!cityProto.__citySimAgriculturalEstatesV077) {
  const previousGenerate = cityProto.generate as AnyMethod;
  cityProto.generate = function generateWithAgriculturalEstates(this: AnyCity): void {
    const plans = planFarmEstates(this);
    plannedByNetwork.set(this.net, plans);
    previousGenerate.call(this);
    materializeFarmEstates(this, plans);
  };
  cityProto.__citySimAgriculturalEstatesV077 = true;
}
