import { BuildingArchetype, CityGenerator, type DevelopmentSite } from './CityGenerator';
import { BlockParcelLayout, type FrontageSide, type UrbanBlock } from './BlockParcelLayout';
import { CityPlanning, DistrictType, type PlanningSample } from './CityPlanning';
import { FacilityType, type FacilityRecord } from './SpecialFacilityPlanner';
import { RoadClass, RoadNetwork, roadWidth } from '../traffic/RoadNetwork';
import { POICategory } from '../world/POI';

export type BuildingHeightTier = 'super-high-rise' | 'high-rise' | 'mid-rise' | 'low-rise';
export type PlannedBuildingUse = 'residential' | 'restaurant' | 'commercial' | 'hotel' | 'office';

export interface ForestSpace {
  id: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  density: number;
  source: 'rural' | 'vacant-lot';
}

type AnyCity = Record<string, any>;
type AnyPlanning = Record<string, any>;
type AnyRoadNetwork = Record<string, any>;
type SitePlan = { site: DevelopmentSite; plan: PlanningSample; disposition: 'building' | 'parking' | 'empty' };
type TieredSite = { site: DevelopmentSite; plan: PlanningSample; tier: BuildingHeightTier; use: PlannedBuildingUse };

type DiversityRuntime = {
  blockSize: number;
  seed: number;
  forestSpaces: ForestSpace[];
};

const diversityByCity = new WeakMap<object, DiversityRuntime>();
let latestForestSpaces: ForestSpace[] = [];

const SUPER_SHARE = 0.03;
const HIGH_SHARE = 0.07;
const MID_SHARE = 0.30;
const PARK_CELL_SIZE = 420;
const LOCAL_ROAD_SKIP_SHARE = 0.14;

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

function roadRank(cls: RoadClass): number {
  if (cls === RoadClass.Highway) return 0;
  if (cls === RoadClass.Arterial) return 1;
  if (cls === RoadClass.Collector) return 2;
  if (cls === RoadClass.Local) return 3;
  return 4;
}

function tierUse(tier: BuildingHeightTier, plan: PlanningSample, r: number): PlannedBuildingUse {
  if (plan.district === DistrictType.Industrial || plan.district === DistrictType.Logistics) return 'office';
  if (tier === 'super-high-rise') return r < 0.55 ? 'commercial' : 'hotel';
  if (tier === 'high-rise') {
    if (r < 0.32) return 'hotel';
    if (r < 0.62) return 'commercial';
    if (r < 0.84) return 'office';
    return 'residential';
  }
  if (tier === 'mid-rise') {
    if (r < 0.40) return 'residential';
    if (r < 0.58) return 'restaurant';
    if (r < 0.74) return 'commercial';
    if (r < 0.88) return 'hotel';
    return 'office';
  }
  if (r < 0.55) return 'residential';
  if (r < 0.75) return 'commercial';
  if (r < 0.90) return 'restaurant';
  return 'office';
}

function categoryForUse(use: PlannedBuildingUse): POICategory {
  if (use === 'residential') return POICategory.Home;
  if (use === 'restaurant') return POICategory.Food;
  if (use === 'commercial') return POICategory.Retail;
  if (use === 'hotel') return POICategory.Leisure;
  return POICategory.Work;
}

function archetypeForTier(city: AnyCity, tier: BuildingHeightTier, use: PlannedBuildingUse, plan: PlanningSample): BuildingArchetype {
  const r = city.rng() as number;
  if (plan.district === DistrictType.Industrial) return r < 0.62 ? BuildingArchetype.Factory : BuildingArchetype.OfficeSlab;
  if (plan.district === DistrictType.Logistics) return r < 0.78 ? BuildingArchetype.Warehouse : BuildingArchetype.Factory;
  if (tier === 'super-high-rise') return BuildingArchetype.MixedUse;
  if (tier === 'high-rise') {
    if (use === 'residential') return BuildingArchetype.ResidentialTower;
    if (use === 'office') return BuildingArchetype.OfficeTower;
    return BuildingArchetype.MixedUse;
  }
  if (tier === 'mid-rise') {
    if (use === 'residential') return BuildingArchetype.MidRiseApartment;
    if (use === 'office') return BuildingArchetype.OfficeSlab;
    if (use === 'hotel') return BuildingArchetype.MixedUse;
    return BuildingArchetype.CommercialBlock;
  }
  if (use === 'residential') return r < 0.60 ? BuildingArchetype.DetachedHouse : r < 0.82 ? BuildingArchetype.TownHouse : BuildingArchetype.LowRiseApartment;
  if (use === 'office') return BuildingArchetype.SmallOffice;
  if (use === 'restaurant') return BuildingArchetype.SmallShop;
  return r < 0.55 ? BuildingArchetype.SmallShop : BuildingArchetype.RetailBox;
}

function floorCountForTier(city: AnyCity, tier: BuildingHeightTier, plan: PlanningSample): number {
  const r = city.rng() as number;
  if (plan.district === DistrictType.Logistics) return 1 + Math.floor(r * 2);
  if (plan.district === DistrictType.Industrial) return 2 + Math.floor(r * 3);
  if (tier === 'super-high-rise') return 32 + Math.floor(r * 24);
  if (tier === 'high-rise') return 16 + Math.floor(r * 16);
  if (tier === 'mid-rise') return 5 + Math.floor(r * 11);
  return 1 + Math.floor(r * 4);
}

function strongestFrontage(block: UrbanBlock): { side: FrontageSide; roadClass: RoadClass; lanes: number } | null {
  let best: { side: FrontageSide; roadClass: RoadClass; lanes: number; score: number } | null = null;
  for (const frontage of block.frontages) {
    const score = roadRank(frontage.roadClass) * 10 - frontage.coverage;
    if (!best || score < best.score) best = { side: frontage.side, roadClass: frontage.roadClass, lanes: frontage.lanes, score };
  }
  return best;
}

function wholeBlockSite(city: AnyCity, block: UrbanBlock, parcelIds: number[]): DevelopmentSite | null {
  const frontage = strongestFrontage(block);
  if (!frontage) return null;
  const bySide = new Map<FrontageSide, { lanes: number }>();
  for (const f of block.frontages) bySide.set(f.side, f);
  const inset = (side: FrontageSide): number => {
    const f = bySide.get(side);
    return f ? roadWidth(Math.max(1, f.lanes)) / 2 + 3 : 2.5;
  };
  const west = inset('west'), east = inset('east'), north = inset('north'), south = inset('south');
  const width = block.width - west - east, depth = block.depth - north - south;
  if (width < 24 || depth < 24) return null;
  const x = block.x + (west - east) * 0.5;
  const z = block.z + (north - south) * 0.5;
  return {
    id: city.nextSite++,
    blockId: block.id,
    parcelIds,
    x,
    z,
    width,
    depth,
    frontage: frontage.side,
    roadClass: frontage.roadClass,
    roadLanes: frontage.lanes,
    intensity: city.developmentIntensity(city.planning.sample(x, z)),
  } as DevelopmentSite;
}

function superBlockScore(city: AnyCity, block: UrbanBlock): number {
  const p = city.planning.sample(block.x, block.z) as PlanningSample;
  if (p.district === DistrictType.Park || p.district === DistrictType.Industrial || p.district === DistrictType.Logistics) return -Infinity;
  const frontage = strongestFrontage(block);
  if (!frontage) return -Infinity;
  const access = frontage.roadClass === RoadClass.Arterial ? 0.18 : frontage.roadClass === RoadClass.Collector ? 0.10 : 0;
  return p.landValue * 0.42 + p.density * 0.28 + p.centerInfluence * 0.20 + p.transitInfluence * 0.10 + access;
}

function selectSuperBlocks(city: AnyCity, plans: SitePlan[]): Set<number> {
  const buildCountByBlock = new Map<number, number>();
  for (const item of plans) if (item.disposition === 'building') buildCountByBlock.set(item.site.blockId, (buildCountByBlock.get(item.site.blockId) ?? 0) + 1);
  const candidates = city.blocks
    .map((block: UrbanBlock) => ({ block, score: superBlockScore(city, block) + hash01(block.id * 4099 + city.cfg.seed) * 0.035 }))
    .filter((x: { score: number }) => Number.isFinite(x.score))
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

  let total = plans.reduce((sum, item) => sum + (item.disposition === 'building' ? 1 : 0), 0);
  let superCount = 0;
  let bestDiff = Math.abs(SUPER_SHARE);
  const selected = new Set<number>();
  for (const candidate of candidates) {
    const k = buildCountByBlock.get(candidate.block.id) ?? 0;
    const nextTotal = total - k + 1;
    if (nextTotal <= 0) continue;
    const nextSuper = superCount + 1;
    const nextRatio = nextSuper / nextTotal;
    const nextDiff = Math.abs(nextRatio - SUPER_SHARE);
    if (nextDiff > bestDiff && superCount > 0 && superCount / Math.max(1, total) >= SUPER_SHARE) break;
    selected.add(candidate.block.id);
    total = nextTotal;
    superCount = nextSuper;
    bestDiff = nextDiff;
  }
  return selected;
}

function heightSuitability(item: SitePlan, seed: number): number {
  const p = item.plan;
  const districtPenalty = p.district === DistrictType.Industrial || p.district === DistrictType.Logistics ? 0.55 : 0;
  return item.site.intensity * 0.50 + p.landValue * 0.24 + p.centerInfluence * 0.14 + p.transitInfluence * 0.12
    - districtPenalty + hash01(item.site.id * 1619 + seed) * 0.06;
}

function appendForest(city: AnyCity, x: number, z: number, width: number, depth: number, density: number, source: ForestSpace['source']): void {
  const runtime = diversityByCity.get(city);
  if (!runtime || width < 10 || depth < 10) return;
  runtime.forestSpaces.push({ id: runtime.forestSpaces.length, x, z, width, depth, density, source });
}

function buildTieredSites(city: AnyCity, rawSites: DevelopmentSite[]): TieredSite[] {
  const blockParking = new Set<number>();
  const plans: SitePlan[] = rawSites.map((site) => {
    const plan = city.planning.sample(site.x, site.z) as PlanningSample;
    if (plan.urbanScore < city.urbanThreshold) return { site, plan, disposition: 'empty' as const };
    if (plan.district === DistrictType.Park && city.rng() > 0.10) return { site, plan, disposition: 'empty' as const };
    const parkingChance = city.parkingChance(plan.district) * (1 - site.intensity * 0.55);
    if (!blockParking.has(site.blockId) && plan.district !== DistrictType.CBD && plan.district !== DistrictType.Park && city.rng() < parkingChance) {
      blockParking.add(site.blockId);
      return { site, plan, disposition: 'parking' as const };
    }
    if (city.rng() < city.emptyChance(plan.district) * (1 - site.intensity * 0.50)) return { site, plan, disposition: 'empty' as const };
    return { site, plan, disposition: 'building' as const };
  });

  const selectedSuper = selectSuperBlocks(city, plans);
  const parcelsByBlock = new Map<number, number[]>();
  for (const parcel of city.parcels) {
    let ids = parcelsByBlock.get(parcel.blockId);
    if (!ids) { ids = []; parcelsByBlock.set(parcel.blockId, ids); }
    ids.push(parcel.id);
  }

  const superSites: TieredSite[] = [];
  for (const blockId of selectedSuper) {
    const block = city.blocks[blockId] as UrbanBlock | undefined;
    if (!block) continue;
    const site = wholeBlockSite(city, block, parcelsByBlock.get(blockId) ?? []);
    if (!site) { selectedSuper.delete(blockId); continue; }
    const plan = city.planning.sample(site.x, site.z) as PlanningSample;
    const use = tierUse('super-high-rise', plan, city.rng());
    superSites.push({ site, plan, tier: 'super-high-rise', use });
  }

  const normalBuild: SitePlan[] = [];
  for (const item of plans) {
    if (selectedSuper.has(item.site.blockId)) continue;
    if (item.disposition === 'parking') {
      const mx = Math.max(2, Math.min(6, item.site.width * 0.08));
      const mz = Math.max(2, Math.min(6, item.site.depth * 0.08));
      city.addParkingRect(item.site.x, item.site.z, Math.max(8, item.site.width - mx * 2), Math.max(8, item.site.depth - mz * 2));
      continue;
    }
    if (item.disposition === 'empty') {
      if (item.plan.district !== DistrictType.Park && item.plan.centerInfluence < 0.34) {
        appendForest(city, item.site.x, item.site.z, Math.max(10, item.site.width - 6), Math.max(10, item.site.depth - 6), 0.76, 'vacant-lot');
      }
      continue;
    }
    normalBuild.push(item);
  }

  const total = superSites.length + normalBuild.length;
  const highTarget = Math.min(normalBuild.length, Math.round(total * HIGH_SHARE));
  const midTarget = Math.min(Math.max(0, normalBuild.length - highTarget), Math.round(total * MID_SHARE));
  normalBuild.sort((a, b) => heightSuitability(b, city.cfg.seed) - heightSuitability(a, city.cfg.seed));

  const result = [...superSites];
  for (let i = 0; i < normalBuild.length; i++) {
    const item = normalBuild[i];
    const tier: BuildingHeightTier = i < highTarget ? 'high-rise' : i < highTarget + midTarget ? 'mid-rise' : 'low-rise';
    const use = tierUse(tier, item.plan, city.rng());
    result.push({ site: item.site, plan: item.plan, tier, use });
  }
  return result;
}

function convertPlannedHotels(city: AnyCity): void {
  const used = new Set<number>((city.facilities as FacilityRecord[]).map((f) => f.buildingId));
  for (const building of city.buildings as Array<Record<string, any>>) {
    if (building.intendedUse !== 'hotel' || used.has(building.id)) continue;
    city.poi.disableBuildingPOIs(building.id);
    const area = Math.max(1, building.siteArea as number);
    const floors = Math.max(5, building.floors as number);
    const guestCapacity = Math.max(120, Math.round(area * 0.13 + floors * 16));
    city.poi.add({ category: POICategory.Leisure, x: building.x, z: building.z, priceTier: 0.72, capacity: guestCapacity, buildingId: building.id });
    city.poi.add({ category: POICategory.Work, x: building.x, z: building.z, priceTier: 0.55, capacity: Math.max(40, Math.round(guestCapacity * 0.24)), buildingId: building.id });
    city.poi.add({ category: POICategory.Food, x: building.x, z: building.z, priceTier: 0.65, capacity: Math.max(36, Math.round(guestCapacity * 0.18)), buildingId: building.id, stock: 180, maxStock: 180 });
    building.category = POICategory.Leisure;
    city.facilities.push({
      id: city.facilities.length,
      type: FacilityType.Hotel,
      buildingId: building.id,
      x: building.x,
      z: building.z,
      width: building.width,
      depth: building.depth,
      floors,
      siteArea: area,
      capacity: guestCapacity,
      frontage: building.frontage,
      district: building.district,
    } as FacilityRecord);
    used.add(building.id);
  }
}

function addRuralForests(city: AnyCity): void {
  const runtime = diversityByCity.get(city);
  if (!runtime) return;
  const bs = runtime.blockSize;
  const cols = Math.floor(city.sizeMeters / bs);
  for (let j = 0; j < cols; j++) for (let i = 0; i < cols; i++) {
    const x = (i + 0.5) * bs, z = (j + 0.5) * bs;
    const p = city.planning.sample(x, z) as PlanningSample;
    if (p.urbanScore >= city.urbanThreshold) continue;
    if (p.district === DistrictType.Industrial || p.district === DistrictType.Logistics) continue;
    const inset = Math.max(7, bs * 0.07);
    appendForest(city, x, z, Math.max(12, bs - inset * 2), Math.max(12, bs - inset * 2), 0.82 + hash2(i, j, runtime.seed) * 0.18, 'rural');
  }
  latestForestSpaces = runtime.forestSpaces;
}

export function latestCityForestSpaces(): readonly ForestSpace[] {
  return latestForestSpaces;
}

const planningProto = CityPlanning.prototype as unknown as Record<string, any>;
if (!planningProto.__citySimParkPriorityV068) {
  const previousSample = planningProto.sample as (this: AnyPlanning, x: number, z: number) => PlanningSample;
  planningProto.sample = function sampleWithParkPriority(this: AnyPlanning, x: number, z: number): PlanningSample {
    const base = previousSample.call(this, x, z);
    if (base.district === DistrictType.Industrial || base.district === DistrictType.Logistics || base.transitInfluence > 0.75) return base;
    const gx = Math.floor(x / PARK_CELL_SIZE), gz = Math.floor(z / PARK_CELL_SIZE);
    const seed = Math.round(this.sizeMeters) ^ 0x68c17e;
    const roll = hash2(gx, gz, seed);
    const scale = Math.max(0.25, this.options.parkRatio / 0.055);
    const chance = base.centerInfluence < 0.24 ? 0.18 * scale : base.centerInfluence >= 0.58 ? 0.065 * scale : 0.025 * scale;
    if (roll >= Math.min(0.34, chance)) return base;
    return {
      ...base,
      district: DistrictType.Park,
      urbanScore: Math.max(base.urbanScore, base.centerInfluence < 0.24 ? 0.46 : 0.54),
      density: Math.min(base.density, 0.10),
    };
  };
  planningProto.__citySimParkPriorityV068 = true;
}

const roadProto = RoadNetwork.prototype as unknown as Record<string, any>;
if (!roadProto.__citySimLocalRoadDiversityV068) {
  const previousConnect = roadProto.connect as (this: AnyRoadNetwork, a: number, b: number, roadClass: RoadClass, lanes?: number) => void;
  roadProto.connect = function connectWithLocalVariation(this: AnyRoadNetwork, a: number, b: number, roadClass: RoadClass, lanes = 1): void {
    const tuning = this.__citySimGridDiversity as { blockSize: number; seed: number } | undefined;
    if (tuning && roadClass === RoadClass.Local) {
      const na = this.nodes[a], nb = this.nodes[b];
      const len = Math.hypot(nb.x - na.x, nb.z - na.z);
      if (len <= tuning.blockSize * 2.25) {
        const mx = Math.round(((na.x + nb.x) * 0.5) / tuning.blockSize);
        const mz = Math.round(((na.z + nb.z) * 0.5) / tuning.blockSize);
        const axisSalt = Math.abs(nb.x - na.x) >= Math.abs(nb.z - na.z) ? 0x31 : 0x73;
        const roll = hash2(mx + axisSalt, mz - axisSalt, tuning.seed);
        const preserve = ((mx + mz + axisSalt) % 5 + 5) % 5 === 0;
        if (!preserve && roll < LOCAL_ROAD_SKIP_SHARE) return;
      }
    }
    previousConnect.call(this, a, b, roadClass, lanes);
  };
  roadProto.__citySimLocalRoadDiversityV068 = true;
}

const cityProto = CityGenerator.prototype as unknown as Record<string, any>;
if (!cityProto.__citySimDiverseGenerationV068) {
  const previousGenerate = cityProto.generate as (this: AnyCity) => void;
  const previousBuildGates = cityProto.buildGates as (this: AnyCity, nodeGrid: number[][], cols: number, bs: number, size: number) => void;
  const previousPlaceDevelopmentBuilding = cityProto.placeDevelopmentBuilding as (this: AnyCity, site: DevelopmentSite, plan: PlanningSample) => void;
  const previousPickCategory = cityProto.pickCategory as (this: AnyCity, plan: PlanningSample, frontage: RoadClass) => POICategory;
  const previousPickArchetype = cityProto.pickArchetype as (this: AnyCity, category: POICategory, plan: PlanningSample, floors: number, width: number, depth: number) => BuildingArchetype;
  const previousBaseFloors = cityProto.baseFloorsForPlan as (this: AnyCity, plan: PlanningSample) => number;
  const previousFloorsForDevelopment = cityProto.floorsForDevelopment as (this: AnyCity, ...args: any[]) => number;

  cityProto.pickCategory = function pickCategoryByTier(this: AnyCity, plan: PlanningSample, frontage: RoadClass): POICategory {
    const use = this.__citySimActiveBuildingUse as PlannedBuildingUse | undefined;
    return use ? categoryForUse(use) : previousPickCategory.call(this, plan, frontage);
  };

  cityProto.pickArchetype = function pickArchetypeByTier(
    this: AnyCity,
    category: POICategory,
    plan: PlanningSample,
    floors: number,
    width: number,
    depth: number,
  ): BuildingArchetype {
    const tier = this.__citySimActiveHeightTier as BuildingHeightTier | undefined;
    const use = this.__citySimActiveBuildingUse as PlannedBuildingUse | undefined;
    return tier && use ? archetypeForTier(this, tier, use, plan) : previousPickArchetype.call(this, category, plan, floors, width, depth);
  };

  cityProto.baseFloorsForPlan = function baseFloorsByTier(this: AnyCity, plan: PlanningSample): number {
    const tier = this.__citySimActiveHeightTier as BuildingHeightTier | undefined;
    return tier ? floorCountForTier(this, tier, plan) : previousBaseFloors.call(this, plan);
  };

  cityProto.floorsForDevelopment = function floorsByTier(this: AnyCity, ...args: any[]): number {
    const tier = this.__citySimActiveHeightTier as BuildingHeightTier | undefined;
    const plan = args[0] as PlanningSample;
    return tier ? floorCountForTier(this, tier, plan) : previousFloorsForDevelopment.apply(this, args);
  };

  cityProto.buildGates = function buildGatesWithFacilityProtection(this: AnyCity, nodeGrid: number[][], cols: number, bs: number, size: number): void {
    previousBuildGates.call(this, nodeGrid, cols, bs, size);
    const restore = new Map<number, number>();
    for (const building of this.buildings as Array<Record<string, any>>) {
      if (building.heightTier !== 'super-high-rise' && building.heightTier !== 'high-rise') continue;
      restore.set(building.id, building.siteArea as number);
      building.siteArea = 0;
    }
    this.__citySimFacilitySiteAreaRestore = restore;
  };

  cityProto.generateBlocksAndParcels = function generateDiverseBlocksAndParcels(this: AnyCity, bs: number, cols: number): void {
    const layout = new BlockParcelLayout(this.net, bs, cols);
    const extracted = layout.extractBlocks((x: number, z: number) => this.urbanization(x, z) >= this.urbanThreshold);
    this.blocks.push(...extracted);
    const rawSites: DevelopmentSite[] = [];
    for (const block of this.blocks as UrbanBlock[]) {
      const centerPlan = this.planning.sample(block.x, block.z) as PlanningSample;
      const parcels = layout.subdivide(block, this.parcelFrontage(centerPlan.district), this.parcelDepth(centerPlan.district), this.rng, () => this.nextParcel++);
      this.parcels.push(...parcels);
      rawSites.push(...this.consolidateParcels(parcels));
    }

    const tiered = buildTieredSites(this, rawSites);
    this.developmentSites.push(...tiered.map((item) => item.site));
    for (const item of tiered) {
      this.__citySimActiveHeightTier = item.tier;
      this.__citySimActiveBuildingUse = item.use;
      const before = this.buildings.length;
      previousPlaceDevelopmentBuilding.call(this, item.site, item.plan);
      if (this.buildings.length > before) {
        const building = this.buildings[this.buildings.length - 1] as Record<string, any>;
        building.heightTier = item.tier;
        building.intendedUse = item.use;
        building.blockId = item.site.blockId;
      }
      this.__citySimActiveHeightTier = undefined;
      this.__citySimActiveBuildingUse = undefined;
    }
  };

  cityProto.generate = function generateWithDiversity(this: AnyCity): void {
    const runtime: DiversityRuntime = { blockSize: this.cfg.blockSize, seed: this.cfg.seed, forestSpaces: [] };
    diversityByCity.set(this, runtime);
    this.net.__citySimGridDiversity = { blockSize: runtime.blockSize, seed: runtime.seed };
    try {
      previousGenerate.call(this);
    } finally {
      delete this.net.__citySimGridDiversity;
      const restore = this.__citySimFacilitySiteAreaRestore as Map<number, number> | undefined;
      if (restore) {
        for (const [buildingId, siteArea] of restore) {
          const building = this.buildings[buildingId] as Record<string, any> | undefined;
          if (building) building.siteArea = siteArea;
        }
      }
      this.__citySimFacilitySiteAreaRestore = undefined;
    }
    addRuralForests(this);
    convertPlannedHotels(this);
    latestForestSpaces = runtime.forestSpaces;
    const tierCounts = { superHighRise: 0, highRise: 0, midRise: 0, lowRise: 0 };
    for (const building of this.buildings as Array<Record<string, any>>) {
      if (building.heightTier === 'super-high-rise') tierCounts.superHighRise++;
      else if (building.heightTier === 'high-rise') tierCounts.highRise++;
      else if (building.heightTier === 'mid-rise') tierCounts.midRise++;
      else if (building.heightTier === 'low-rise') tierCounts.lowRise++;
    }
    console.info('[City-Sim] building height distribution', { total: this.buildings.length, ...tierCounts, forests: runtime.forestSpaces.length });
  };

  cityProto.__citySimDiverseGenerationV068 = true;
}
