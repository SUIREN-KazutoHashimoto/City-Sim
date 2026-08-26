import { BuildingArchetype, CityGenerator, RoofType, type Building, type ParkingLot } from './CityGenerator';
import { CityPlanning, DistrictType, type PlanningSample } from './CityPlanning';
import { RoadClass, RoadNetwork, roadWidth } from '../traffic/RoadNetwork';
import { POICategory, type POIRegistry } from '../world/POI';
import { baselinePlanningSample } from './UrbanFootprintBaseline';

export type FleetDepotKind = 'taxi' | 'bus' | 'freight';
export type ProductionKind = 'farm' | 'raw-factory' | 'processor' | 'assembler';

export interface FleetDepotRecord {
  kind: FleetDepotKind;
  buildingId: number;
  x: number;
  z: number;
  roadNode: number;
  parkingLotId: number;
  parkingPoiId: number;
  slotX: Float32Array;
  slotZ: Float32Array;
}

export interface ProductionSiteRecord {
  id: number;
  kind: ProductionKind;
  buildingId: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  heading: number;
  roadNode: number;
  inputStage: -1 | 0 | 1;
  outputStage: 0 | 1 | 2;
  inputStock: number;
  outputStock: number;
  reservedInput: number;
  inputCapacity: number;
  outputCapacity: number;
  processRate: number;
}

export interface SupplyChainRuntime {
  sites: ProductionSiteRecord[];
  retailerPoiIds: number[];
  gateNodes: number[];
  exportedUnits: number;
}

interface CityRuntime {
  depots: Record<FleetDepotKind, FleetDepotRecord>;
  supply: SupplyChainRuntime;
}

type AnyCity = any;
type AnyRoadNetwork = any;
type ConnectMethod = (this: AnyRoadNetwork, a: number, b: number, roadClass: RoadClass, lanes?: number) => void;
type GenerateMethod = (this: AnyCity) => void;

const runtimeByNetwork = new WeakMap<RoadNetwork, CityRuntime>();
const runtimeByPoi = new WeakMap<POIRegistry, CityRuntime>();
const planningByNetwork = new WeakMap<RoadNetwork, CityPlanning>();

const PARK_BUILDING_RATIO = 1 / 160;
const MID_RISE_ROAD_SKIP = 0.07;
const LOW_RISE_ROAD_SKIP = 0.24;
const INDUSTRIAL_ROAD_SKIP = 0.12;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function hash2(a: number, b: number, seed: number): number {
  return hash01(Math.imul(a + 0x51ed, 73856093) ^ Math.imul(b + 0xb05, 19349663) ^ seed);
}

function surfaceRoadRank(cls: RoadClass): number {
  if (cls === RoadClass.Arterial) return 0;
  if (cls === RoadClass.Collector) return 1;
  if (cls === RoadClass.Local) return 2;
  return 9;
}

function localRoadSkipShare(plan: PlanningSample): number {
  if (plan.district === DistrictType.CBD || plan.district === DistrictType.Commercial) return 0;
  if (plan.density >= 0.72 || plan.centerInfluence >= 0.58) return 0;
  if (plan.district === DistrictType.Industrial || plan.district === DistrictType.Logistics) return INDUSTRIAL_ROAD_SKIP;
  if (plan.density >= 0.50 || plan.district === DistrictType.MixedUse || plan.district === DistrictType.ResidentialHigh) return MID_RISE_ROAD_SKIP;
  return LOW_RISE_ROAD_SKIP;
}

const planningProto = CityPlanning.prototype as unknown as Record<string, any>;
if (!planningProto.__citySimReducedParkSpreadV076) {
  const previousSample = planningProto.sample as (this: CityPlanning, x: number, z: number) => PlanningSample;
  planningProto.sample = function sampleWithReducedParkSpread(this: CityPlanning, x: number, z: number): PlanningSample {
    const tuned = previousSample.call(this, x, z);
    if (tuned.district !== DistrictType.Park) return tuned;
    const baseline = baselinePlanningSample(this, x, z);
    if (baseline.district === DistrictType.Park) return tuned;
    const gx = Math.floor(x / 420), gz = Math.floor(z / 420);
    const keep = hash2(gx, gz, Math.round(this.sizeMeters) ^ 0x7601) < 0.34;
    if (keep) return tuned;
    return { ...tuned, district: baseline.district, density: baseline.density };
  };
  planningProto.__citySimReducedParkSpreadV076 = true;
}

const roadProto = RoadNetwork.prototype as unknown as Record<string, any>;
if (!roadProto.__citySimTieredRoadDiversityV076) {
  const previousConnect = roadProto.connect as ConnectMethod;
  roadProto.connect = function connectWithTieredDiversity(
    this: AnyRoadNetwork,
    a: number,
    b: number,
    roadClass: RoadClass,
    lanes = 1,
  ): void {
    const tuning = this.__citySimGridDiversity as { blockSize: number; seed: number } | undefined;
    const planning = planningByNetwork.get(this as RoadNetwork);
    if (!tuning || !planning || roadClass !== RoadClass.Local) {
      previousConnect.call(this, a, b, roadClass, lanes);
      return;
    }

    const na = this.nodes[a], nb = this.nodes[b];
    const mxWorld = (na.x + nb.x) * 0.5, mzWorld = (na.z + nb.z) * 0.5;
    const plan = planning.sample(mxWorld, mzWorld);
    const skipShare = localRoadSkipShare(plan);
    if (skipShare > 0) {
      const len = Math.hypot(nb.x - na.x, nb.z - na.z);
      if (len <= tuning.blockSize * 2.25) {
        const mx = Math.round(mxWorld / tuning.blockSize), mz = Math.round(mzWorld / tuning.blockSize);
        const axisSalt = Math.abs(nb.x - na.x) >= Math.abs(nb.z - na.z) ? 0x31 : 0x73;
        const preserve = ((mx + mz + axisSalt) % 4 + 4) % 4 === 0;
        if (!preserve && hash2(mx + axisSalt, mz - axisSalt, tuning.seed ^ 0x7600) < skipShare) return;
      }
    }

    // CityDiversityTuning's older uniform 14% filter is inside previousConnect. Temporarily hide
    // its marker so this density-aware policy is the only local-road diversity rule applied.
    const saved = this.__citySimGridDiversity;
    delete this.__citySimGridDiversity;
    try { previousConnect.call(this, a, b, roadClass, lanes); }
    finally { this.__citySimGridDiversity = saved; }
  };
  roadProto.__citySimTieredRoadDiversityV076 = true;
}

function trimParksToBuildingRatio(city: AnyCity): void {
  const parks = city.parks as Array<{ id: number; poiId: number; x: number; z: number; width: number; depth: number; kind: string }>;
  if (parks.length === 0) return;
  const target = Math.max(3, Math.round(city.buildings.length * PARK_BUILDING_RATIO));
  if (parks.length <= target) return;

  const ranked = parks.map((park, index) => {
    const plan = city.planning.sample(park.x, park.z) as PlanningSample;
    const kindBias = park.kind === 'city' ? 0.80 : park.kind === 'civic' ? 0.45 : 0;
    const areaBias = Math.min(0.65, Math.sqrt(Math.max(1, park.width * park.depth)) / 480);
    const score = kindBias + areaBias + plan.centerInfluence * 0.28 + hash01(index * 701 + city.cfg.seed) * 0.08;
    return { park, score };
  }).sort((a, b) => b.score - a.score);

  const keep = new Set(ranked.slice(0, target).map((x) => x.park));
  for (const park of parks) if (!keep.has(park)) city.poi.disable(park.poiId);
  const retained = parks.filter((park) => keep.has(park));
  parks.length = 0;
  for (let i = 0; i < retained.length; i++) {
    retained[i].id = i;
    parks.push(retained[i]);
  }
}

function usableSurfaceEdges(city: AnyCity, nodeId: number): Array<{ from: number; to: number; lanes: number; roadClass: RoadClass }> {
  const node = city.net.nodes[nodeId];
  if (!node) return [];
  return node.edges
    .map((eid: number) => city.net.edges[eid])
    .filter((e: any) => e && e.roadClass !== RoadClass.Highway && e.roadClass !== RoadClass.Path)
    .sort((a: any, b: any) => surfaceRoadRank(a.roadClass) - surfaceRoadRank(b.roadClass) || b.length - a.length);
}

function sitePose(city: AnyCity, nodeId: number, lateral: number, longitudinal: number, salt: number): { x: number; z: number; heading: number } | null {
  const edges = usableSurfaceEdges(city, nodeId);
  if (edges.length === 0) return null;
  const edge = edges[0], a = city.net.nodes[edge.from], b = city.net.nodes[edge.to];
  const origin = city.net.nodes[nodeId];
  const other = edge.from === nodeId ? b : a;
  let dx = other.x - origin.x, dz = other.z - origin.z;
  const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
  const side = hash01(nodeId * 811 + salt) < 0.5 ? -1 : 1;
  const px = dz * side, pz = -dx * side;
  const roadHalf = roadWidth(Math.max(1, edge.lanes)) * 0.5;
  return {
    x: clamp(origin.x + px * (roadHalf + lateral) + dx * longitudinal, 35, city.sizeMeters - 35),
    z: clamp(origin.z + pz * (roadHalf + lateral) + dz * longitudinal, 35, city.sizeMeters - 35),
    heading: Math.atan2(dz, dx),
  };
}

function clearOfExistingBuildings(city: AnyCity, x: number, z: number, radius: number): boolean {
  const r2 = radius * radius;
  for (const b of city.buildings as Building[]) {
    const dx = b.x - x, dz = b.z - z;
    if (dx * dx + dz * dz < r2) return false;
  }
  return true;
}

function pushBuilding(
  city: AnyCity,
  x: number,
  z: number,
  width: number,
  depth: number,
  floors: number,
  heading: number,
  archetype: BuildingArchetype,
  district: DistrictType,
  styleSalt: number,
  label: string,
): number {
  const id = city.buildings.length;
  const siteArea = width * depth * 1.38;
  const building = {
    id, x, z, width, depth, floors,
    category: POICategory.Work,
    archetype,
    roofType: archetype === BuildingArchetype.Factory || archetype === BuildingArchetype.Warehouse ? RoofType.Mechanical : RoofType.Flat,
    palette: Math.abs(styleSalt) % 4,
    styleSeed: (city.cfg.seed ^ Math.imul(styleSalt + 1, 2654435761)) >>> 0,
    rotation: heading,
    urbanity: 0.14,
    district,
    landValue: 0.18,
    frontage: 'south',
    developmentIntensity: 0.20,
    coverageRatio: 0.55,
    floorAreaRatio: floors * 0.55,
    grossFloorArea: width * depth * floors * 0.82,
    siteArea,
    parcelCount: 1,
    heightTier: 'low-rise',
    intendedUse: 'office',
    infrastructureLabel: label,
  } as Building & Record<string, any>;
  city.buildings.push(building);
  city.poi.add({ category: POICategory.Work, x, z, priceTier: 0.32, capacity: Math.max(12, Math.round(width * depth * floors / 55)), buildingId: id });
  return id;
}

function chooseDepotNode(city: AnyCity, kind: FleetDepotKind, used: Set<number>): number {
  const cbd = city.planning.cbd;
  const logistics = city.planning.logisticsCenter;
  const candidates: Array<{ id: number; score: number }> = [];
  for (const node of city.net.nodes) {
    if (used.has(node.id) || usableSurfaceEdges(city, node.id).length === 0) continue;
    const testPose = sitePose(city, node.id, kind === 'freight' ? 34 : 29, 0, 0x760 + kind.length);
    if (!testPose || !clearOfExistingBuildings(city, testPose.x, testPose.z, kind === 'freight' ? 62 : 52)) continue;
    const plan = city.planning.sample(node.x, node.z) as PlanningSample;
    const cbdD = Math.hypot(node.x - cbd.x, node.z - cbd.z) / Math.max(1, city.sizeMeters);
    let score: number;
    if (kind === 'freight') {
      const d = Math.hypot(node.x - logistics.x, node.z - logistics.z) / Math.max(1, city.sizeMeters);
      score = d + plan.centerInfluence * 0.55;
    } else {
      const target = kind === 'taxi' ? 0.17 : 0.23;
      score = Math.abs(cbdD - target) + Math.abs(plan.urbanScore - city.urbanThreshold) * 0.18 + plan.centerInfluence * (kind === 'bus' ? 0.10 : 0.03);
    }
    score += hash01(node.id * 1223 + city.cfg.seed) * 0.025;
    candidates.push({ id: node.id, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.id ?? city.net.nearestNode(cbd.x, cbd.z);
}

function addDepot(city: AnyCity, kind: FleetDepotKind, usedNodes: Set<number>): FleetDepotRecord {
  const nodeId = chooseDepotNode(city, kind, usedNodes);
  usedNodes.add(nodeId);
  const pose = sitePose(city, nodeId, kind === 'freight' ? 34 : 29, 0, 0x760 + kind.length)
    ?? { x: city.net.nodes[nodeId].x, z: city.net.nodes[nodeId].z, heading: 0 };
  const width = kind === 'freight' ? 48 : kind === 'bus' ? 42 : 34;
  const depth = kind === 'freight' ? 28 : 24;
  const buildingId = pushBuilding(
    city, pose.x, pose.z, width, depth, 2, pose.heading,
    kind === 'taxi' ? BuildingArchetype.SmallOffice : BuildingArchetype.Warehouse,
    kind === 'freight' ? DistrictType.Logistics : DistrictType.Industrial,
    900 + kind.length * 17,
    `${kind}-depot`,
  );

  const dx = Math.cos(pose.heading), dz = Math.sin(pose.heading);
  const lotX = clamp(pose.x + dx * (width * 0.72 + 34), 35, city.sizeMeters - 35);
  const lotZ = clamp(pose.z + dz * (width * 0.72 + 34), 35, city.sizeMeters - 35);
  (city as any).addParkingRect(lotX, lotZ, kind === 'freight' ? 82 : kind === 'bus' ? 76 : 64, kind === 'freight' ? 48 : 42);
  const lot = city.parkingLots[city.parkingLots.length - 1] as ParkingLot;
  // Fleet depots own these spaces; prevent resident cars from reserving them as public parking.
  city.poi.disable(lot.poiId);
  return {
    kind, buildingId, x: lot.x, z: lot.z, roadNode: nodeId,
    parkingLotId: lot.id, parkingPoiId: lot.poiId, slotX: lot.slotX, slotZ: lot.slotZ,
  };
}

function farFromCenters(city: AnyCity, x: number, z: number): number {
  const cbd = city.planning.cbd;
  let best = Math.hypot(x - cbd.x, z - cbd.z);
  for (const c of city.planning.subCenters) best = Math.min(best, Math.hypot(x - c.x, z - c.z));
  return best / Math.max(1, city.sizeMeters);
}

function collectRuralCandidates(city: AnyCity): number[] {
  const candidates: Array<{ id: number; rank: number }> = [];
  for (const node of city.net.nodes) {
    const edges = usableSurfaceEdges(city, node.id);
    if (edges.length === 0) continue;
    const plan = city.planning.sample(node.x, node.z) as PlanningSample;
    const far = farFromCenters(city, node.x, node.z);
    if (far < 0.18 || plan.centerInfluence > 0.34) continue;
    const roadBonus = edges[0].roadClass === RoadClass.Arterial ? -0.10 : edges[0].roadClass === RoadClass.Collector ? -0.04 : 0;
    const rank = plan.centerInfluence * 0.55 - far * 0.70 + roadBonus + hash01(node.id * 4099 + city.cfg.seed) * 0.22;
    candidates.push({ id: node.id, rank });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates.map((x) => x.id);
}

function addProductionSite(
  city: AnyCity,
  kind: ProductionKind,
  nodeId: number,
  sequence: number,
): ProductionSiteRecord | null {
  const farm = kind === 'farm';
  const pose = sitePose(city, nodeId, farm ? 58 : 40, ((sequence % 3) - 1) * 24, 0x901 + sequence * 13);
  if (!pose) return null;
  const clearance = farm ? 72 : 50;
  if (!clearOfExistingBuildings(city, pose.x, pose.z, clearance)) return null;

  const width = farm ? 24 : 44 + (sequence % 3) * 4;
  const depth = farm ? 16 : 28 + (sequence % 2) * 4;
  const floors = farm ? 1 : kind === 'assembler' ? 3 : 2;
  const district = farm ? DistrictType.ResidentialLow : DistrictType.Industrial;
  const buildingId = pushBuilding(
    city, pose.x, pose.z, width, depth, floors, pose.heading,
    farm ? BuildingArchetype.Warehouse : BuildingArchetype.Factory,
    district,
    2000 + sequence,
    kind,
  );

  const inputStage: -1 | 0 | 1 = kind === 'processor' ? 0 : kind === 'assembler' ? 1 : -1;
  const outputStage: 0 | 1 | 2 = kind === 'processor' ? 1 : kind === 'assembler' ? 2 : 0;
  const inputCapacity = inputStage < 0 ? 0 : kind === 'assembler' ? 1800 : 2200;
  const outputCapacity = farm ? 1800 : kind === 'raw-factory' ? 2200 : 1800;
  const processRate = farm ? 4.8 : kind === 'raw-factory' ? 6.0 : kind === 'processor' ? 7.2 : 6.4;
  return {
    id: -1, kind, buildingId, x: pose.x, z: pose.z,
    width: farm ? 96 : width, depth: farm ? 72 : depth, heading: pose.heading, roadNode: nodeId,
    inputStage, outputStage, inputStock: 0, outputStock: farm ? outputCapacity * 0.35 : kind === 'raw-factory' ? outputCapacity * 0.25 : 0,
    reservedInput: 0, inputCapacity, outputCapacity, processRate,
  };
}

function buildRuralIndustry(city: AnyCity, depots: Record<FleetDepotKind, FleetDepotRecord>): SupplyChainRuntime {
  const baseBuildingCount = Math.max(1, city.buildings.length - 3);
  const farmTarget = clamp(Math.round(baseBuildingCount / 50), 18, 90);
  const factoryTarget = clamp(Math.round(baseBuildingCount / 35), 24, 120);
  const candidates = collectRuralCandidates(city);
  const sites: ProductionSiteRecord[] = [];
  const usedNodes = new Set<number>(Object.values(depots).map((d) => d.roadNode));

  let cursor = 0;
  const nextCandidate = (): number => {
    while (cursor < candidates.length) {
      const node = candidates[cursor++];
      if (usedNodes.has(node)) continue;
      if ([...usedNodes].some((u) => {
        const a = city.net.nodes[u], b = city.net.nodes[node];
        return a && b && (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 170 * 170;
      })) continue;
      usedNodes.add(node);
      return node;
    }
    return -1;
  };

  for (let i = 0; i < farmTarget; i++) {
    const node = nextCandidate(); if (node < 0) break;
    const site = addProductionSite(city, 'farm', node, i);
    if (site) { site.id = sites.length; sites.push(site); }
  }

  for (let i = 0; i < factoryTarget; i++) {
    const node = nextCandidate(); if (node < 0) break;
    const r = i / Math.max(1, factoryTarget);
    const kind: ProductionKind = r < 0.22 ? 'raw-factory' : r < 0.62 ? 'processor' : 'assembler';
    const site = addProductionSite(city, kind, node, farmTarget + i);
    if (site) { site.id = sites.length; sites.push(site); }
  }

  const retailerPoiIds = city.poi.all()
    .filter((p: any) => p.capacity > 0 && p.maxStock > 0 && (p.category === POICategory.Retail || p.category === POICategory.Food))
    .map((p: any) => p.id);
  return { sites, retailerPoiIds, gateNodes: [...city.gateNodes], exportedUnits: 0 };
}

export function fleetDepotForNetwork(net: RoadNetwork, kind: FleetDepotKind): FleetDepotRecord | null {
  return runtimeByNetwork.get(net)?.depots[kind] ?? null;
}

export function supplyChainForPoi(poi: POIRegistry): SupplyChainRuntime | null {
  return runtimeByPoi.get(poi)?.supply ?? null;
}

export function productionSitesForNetwork(net: RoadNetwork): readonly ProductionSiteRecord[] {
  return runtimeByNetwork.get(net)?.supply.sites ?? [];
}

const cityProto = CityGenerator.prototype as unknown as Record<string, any>;
if (!cityProto.__citySimRuralIndustryAndDepotsV076) {
  const previousGenerate = cityProto.generate as GenerateMethod;
  cityProto.generate = function generateWithRuralIndustryAndDepots(this: AnyCity): void {
    planningByNetwork.set(this.net, this.planning);
    previousGenerate.call(this);
    trimParksToBuildingRatio(this);

    const usedNodes = new Set<number>();
    const depots = {
      taxi: addDepot(this, 'taxi', usedNodes),
      bus: addDepot(this, 'bus', usedNodes),
      freight: addDepot(this, 'freight', usedNodes),
    };
    const supply = buildRuralIndustry(this, depots);
    const runtime: CityRuntime = { depots, supply };
    runtimeByNetwork.set(this.net, runtime);
    runtimeByPoi.set(this.poi, runtime);
    console.info('[City-Sim] rural industry', {
      parks: this.parks.length,
      parkPerBuildings: this.parks.length / Math.max(1, this.buildings.length),
      farms: supply.sites.filter((s) => s.kind === 'farm').length,
      factories: supply.sites.filter((s) => s.kind !== 'farm').length,
      retailers: supply.retailerPoiIds.length,
    });
  };
  cityProto.__citySimRuralIndustryAndDepotsV076 = true;
}
