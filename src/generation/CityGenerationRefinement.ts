import { CityGenerator, type Building } from './CityGenerator';
import { RailStationKind } from './RailPlanning';
import { DistrictType } from './CityPlanning';
import { roadWidth, type RoadNetwork } from '../traffic/RoadNetwork';
import { supplyChainForPoi } from './RuralIndustryAndDepotTuning';
import { farmEstatesForNetwork } from './AgriculturalEstateTuning';

type AnyCity = any;
type AnyBuilding = Building & Record<string, any>;
type AnyMethod = (...args: any[]) => any;
type ZoneTier = 'high' | 'mid' | 'low';

interface Rect { x: number; z: number; width: number; depth: number; }

function stationRadius(kind: RailStationKind): number {
  return kind === RailStationKind.Central || kind === RailStationKind.SubCenter ? 78 : 56;
}

function conflictsStation(city: AnyCity, building: AnyBuilding): boolean {
  if (building.width <= 0 || building.depth <= 0) return false;
  const halfDiag = Math.hypot(building.width, building.depth) * 0.5;
  for (const station of city.planning.rail.stations) {
    const sx = Number.isFinite(station.x) ? station.x : station.plannedX;
    const sz = Number.isFinite(station.z) ? station.z : station.plannedZ;
    if (Math.hypot(building.x - sx, building.z - sz) < stationRadius(station.kind) + halfDiag) return true;
  }
  return false;
}

function retireBuilding(city: AnyCity, buildingId: number, hidden: Set<number>): void {
  if (hidden.has(buildingId)) return;
  const building = city.buildings[buildingId] as AnyBuilding | undefined;
  if (!building) return;
  hidden.add(buildingId);
  city.poi.disableBuildingPOIs(buildingId);
  building.__stationClearance = true;
  building.width = 0;
  building.depth = 0;
  building.floors = 0;
  building.siteArea = 0;
  building.grossFloorArea = 0;
  building.coverageRatio = 0;
  building.floorAreaRatio = 0;
}

function enforceStationClearance(city: AnyCity): void {
  const hidden = new Set<number>();
  for (const building of city.buildings as AnyBuilding[]) {
    if (conflictsStation(city, building)) retireBuilding(city, building.id, hidden);
  }
  if (hidden.size === 0) return;

  const keptFacilities = city.facilities.filter((facility: any) => !hidden.has(facility.buildingId));
  city.facilities.length = 0;
  keptFacilities.forEach((facility: any, index: number) => { facility.id = index; city.facilities.push(facility); });

  const chain = supplyChainForPoi(city.poi);
  if (chain) {
    const keptSites = [] as any[];
    for (const site of chain.sites as any[]) {
      const ids = [site.buildingId, site.officeBuildingId, site.warehouseBuildingId]
        .filter((id) => Number.isInteger(id) && id >= 0) as number[];
      if (ids.some((id) => hidden.has(id))) {
        for (const id of ids) retireBuilding(city, id, hidden);
        continue;
      }
      keptSites.push(site);
    }
    chain.sites.length = 0;
    keptSites.forEach((site, index) => { site.id = index; chain.sites.push(site); });
  }

  const estates = farmEstatesForNetwork(city.net) as any[];
  if (Array.isArray(estates) && estates.length) {
    const kept = estates.filter((estate) => !hidden.has(estate.officeBuildingId) && !hidden.has(estate.warehouseBuildingId));
    estates.length = 0;
    kept.forEach((estate, index) => { estate.id = index; estates.push(estate); });
  }
}

function roadCrossesInterior(net: RoadNetwork, rect: Rect, inset: number): boolean {
  const minX = rect.x - rect.width * 0.5 + inset;
  const maxX = rect.x + rect.width * 0.5 - inset;
  const minZ = rect.z - rect.depth * 0.5 + inset;
  const maxZ = rect.z + rect.depth * 0.5 - inset;
  if (minX >= maxX || minZ >= maxZ) return true;
  const seen = new Set<string>();
  for (const edge of net.edges) {
    const key = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = net.nodes[edge.from], b = net.nodes[edge.to];
    if (!a || !b) continue;
    const half = roadWidth(Math.max(1, edge.lanes)) * 0.5 + 2;
    const ex0 = Math.min(a.x, b.x) - half, ex1 = Math.max(a.x, b.x) + half;
    const ez0 = Math.min(a.z, b.z) - half, ez1 = Math.max(a.z, b.z) + half;
    if (ex1 > minX && ex0 < maxX && ez1 > minZ && ez0 < maxZ) return true;
  }
  return false;
}

function buildingCrossesField(city: AnyCity, rect: Rect, ignored: Set<number>): boolean {
  for (const b of city.buildings as AnyBuilding[]) {
    if (ignored.has(b.id) || b.width <= 0 || b.depth <= 0) continue;
    const bx0 = b.x - b.width * 0.5 - 4, bx1 = b.x + b.width * 0.5 + 4;
    const bz0 = b.z - b.depth * 0.5 - 4, bz1 = b.z + b.depth * 0.5 + 4;
    const rx0 = rect.x - rect.width * 0.5, rx1 = rect.x + rect.width * 0.5;
    const rz0 = rect.z - rect.depth * 0.5, rz1 = rect.z + rect.depth * 0.5;
    if (bx1 > rx0 && bx0 < rx1 && bz1 > rz0 && bz0 < rz1) return true;
  }
  return false;
}

function overlapsFarm(rect: Rect, accepted: readonly Rect[]): boolean {
  return accepted.some((other) =>
    Math.abs(other.x - rect.x) * 2 < other.width + rect.width + 24
    && Math.abs(other.z - rect.z) * 2 < other.depth + rect.depth + 24);
}

function expandFarmFields(city: AnyCity): void {
  const chain = supplyChainForPoi(city.poi);
  if (!chain) return;
  const estates = farmEstatesForNetwork(city.net) as any[];
  const estateByWarehouse = new Map<number, any>();
  for (const estate of estates) estateByWarehouse.set(estate.warehouseBuildingId, estate);
  const accepted: Rect[] = [];
  const bs = Math.max(60, Number(city.cfg.blockSize) || 100);

  for (const site of chain.sites as any[]) {
    if (site.kind !== 'farm') continue;
    const estate = estateByWarehouse.get(site.warehouseBuildingId ?? site.buildingId);
    let rect: Rect = {
      x: site.fieldX ?? estate?.x ?? site.x,
      z: site.fieldZ ?? estate?.z ?? site.z,
      width: site.fieldWidth ?? estate?.width ?? site.width,
      depth: site.fieldDepth ?? estate?.depth ?? site.depth,
    };
    const ignored = new Set<number>([site.buildingId, site.officeBuildingId, site.warehouseBuildingId]
      .filter((id) => Number.isInteger(id) && id >= 0));

    const accessDx = estate ? estate.accessX - rect.x : 0;
    const accessDz = estate ? estate.accessZ - rect.z : 0;
    const horizontalAccess = Math.abs(accessDx) >= Math.abs(accessDz);
    const attempts: Rect[] = [];
    for (const extra of [bs * 2.0, bs * 1.5, bs]) {
      if (horizontalAccess) {
        const away = accessDx <= 0 ? 1 : -1;
        attempts.push({ x: rect.x + away * extra * 0.5, z: rect.z, width: rect.width + extra, depth: rect.depth });
      } else {
        const away = accessDz <= 0 ? 1 : -1;
        attempts.push({ x: rect.x, z: rect.z + away * extra * 0.5, width: rect.width, depth: rect.depth + extra });
      }
    }
    for (const crossExtra of [bs, bs * 0.5]) {
      attempts.push(horizontalAccess
        ? { x: rect.x, z: rect.z, width: rect.width, depth: rect.depth + crossExtra }
        : { x: rect.x, z: rect.z, width: rect.width + crossExtra, depth: rect.depth });
    }

    for (const candidate of attempts) {
      if (candidate.x - candidate.width * 0.5 < 20 || candidate.x + candidate.width * 0.5 > city.sizeMeters - 20) continue;
      if (candidate.z - candidate.depth * 0.5 < 20 || candidate.z + candidate.depth * 0.5 > city.sizeMeters - 20) continue;
      if (roadCrossesInterior(city.net, candidate, 18)) continue;
      if (buildingCrossesField(city, candidate, ignored)) continue;
      if (overlapsFarm(candidate, accepted)) continue;
      rect = candidate;
      break;
    }

    accepted.push(rect);
    site.fieldX = rect.x; site.fieldZ = rect.z; site.fieldWidth = rect.width; site.fieldDepth = rect.depth;
    const area = Math.max(1, rect.width * rect.depth);
    site.fieldArea = area;
    site.outputCapacity = Math.max(6_000, Math.round(area / 3.2));
    site.outputStock = Math.min(site.outputCapacity, Math.max(site.outputStock, site.outputCapacity * 0.20));
    // Absolute production is determined only by cultivated area. WorkplaceProductivityTuning later
    // multiplies this base rate by present workers / staffing capacity.
    site.processRate = Math.max(6, area / 7_000);
    site.blocksWide = Math.max(1, Math.round(rect.width / bs));
    site.blocksDeep = Math.max(1, Math.round(rect.depth / bs));
    if (estate) {
      estate.x = rect.x; estate.z = rect.z; estate.width = rect.width; estate.depth = rect.depth;
      estate.blocksWide = site.blocksWide; estate.blocksDeep = site.blocksDeep;
    }
  }
}

function tierRank(tier: string | undefined): number {
  if (tier === 'super-high-rise' || tier === 'high-rise') return 3;
  if (tier === 'mid-rise') return 2;
  return 1;
}

function tierName(rank: number): ZoneTier { return rank >= 3 ? 'high' : rank === 2 ? 'mid' : 'low'; }

function trimParksByHeightZone(city: AnyCity): void {
  const blockRanks = new Map<number, number>();
  for (const building of city.buildings as AnyBuilding[]) {
    if (building.width <= 0 || !Number.isInteger(building.blockId)) continue;
    const rank = tierRank(building.heightTier);
    blockRanks.set(building.blockId, Math.max(blockRanks.get(building.blockId) ?? 0, rank));
  }

  const classifiedBlocks: Array<{ x: number; z: number; tier: ZoneTier }> = [];
  const counts: Record<ZoneTier, number> = { high: 0, mid: 0, low: 0 };
  for (const block of city.blocks as any[]) {
    const plan = city.planning.sample(block.x, block.z);
    if (plan.district === DistrictType.Park) continue;
    let rank = blockRanks.get(block.id) ?? 0;
    if (rank === 0) rank = plan.density >= 0.68 ? 3 : plan.density >= 0.38 ? 2 : 1;
    const tier = tierName(rank);
    counts[tier]++;
    classifiedBlocks.push({ x: block.x, z: block.z, tier });
  }

  const quota: Record<ZoneTier, number> = {
    high: Math.max(0, Math.round(counts.high * 0.02)),
    mid: Math.max(0, Math.round(counts.mid * 0.01)),
    low: Math.max(0, Math.round(counts.low * 0.05)),
  };
  const groups: Record<ZoneTier, any[]> = { high: [], mid: [], low: [] };
  for (const park of city.parks as any[]) {
    let bestTier: ZoneTier = 'low', best = Infinity;
    for (const block of classifiedBlocks) {
      const d2 = (block.x - park.x) ** 2 + (block.z - park.z) ** 2;
      if (d2 < best) { best = d2; bestTier = block.tier; }
    }
    groups[bestTier].push(park);
  }

  const keep = new Set<any>();
  for (const tier of ['high', 'mid', 'low'] as const) {
    groups[tier].sort((a, b) => {
      const ak = a.kind === 'city' ? 2 : a.kind === 'civic' ? 1 : 0;
      const bk = b.kind === 'city' ? 2 : b.kind === 'civic' ? 1 : 0;
      return bk - ak || b.width * b.depth - a.width * a.depth;
    });
    for (const park of groups[tier].slice(0, Math.min(groups[tier].length, quota[tier]))) keep.add(park);
  }

  const retained = [] as any[];
  for (const park of city.parks as any[]) {
    if (keep.has(park)) retained.push(park);
    else city.poi.disable(park.poiId);
  }
  city.parks.length = 0;
  retained.forEach((park, index) => { park.id = index; city.parks.push(park); });
  console.info('[City-Sim] tiered park quotas', { blocks: counts, quota, parks: city.parks.length });
}

const proto = CityGenerator.prototype as unknown as Record<string, any>;
if (!proto.__citySimGenerationRefinementV081) {
  const previousGenerate = proto.generate as AnyMethod;
  proto.generate = function generateWithRefinedLandUse(this: AnyCity): void {
    previousGenerate.call(this);
    enforceStationClearance(this);
    expandFarmFields(this);
    trimParksByHeightZone(this);
  };
  proto.__citySimGenerationRefinementV081 = true;
}
