import { World } from '../world/World';
import { POICategory } from '../world/POI';
import { productionSitesForNetwork } from '../generation/RuralIndustryAndDepotTuning';
import { UniversalInspector } from './UniversalInspector';

type AnyWorld = any;
type AnyInspector = any;
type AnyMethod = (...args: any[]) => any;

interface RosterRuntime { assigned: Int32Array; count: number; }
const rosterByWorld = new WeakMap<object, RosterRuntime>();

function rebuild(world: AnyWorld): RosterRuntime {
  const assigned = new Int32Array(world.city.poi.size);
  for (let agent = 0; agent < world.store.count; agent++) {
    const work = world.store.workPOI[agent];
    if (work >= 0 && work < assigned.length) assigned[work]++;
  }
  const rt = { assigned, count: world.store.count };
  rosterByWorld.set(world as object, rt);
  return rt;
}

function runtime(world: AnyWorld): RosterRuntime {
  const current = rosterByWorld.get(world as object);
  return current && current.count === world.store.count && current.assigned.length === world.city.poi.size ? current : rebuild(world);
}

function siteForBuilding(world: AnyWorld, buildingId: number): any | null {
  return productionSitesForNetwork(world.city.net).find((site: any) =>
    site.buildingId === buildingId || site.officeBuildingId === buildingId || site.warehouseBuildingId === buildingId) ?? null;
}

function assignedForPois(world: AnyWorld, ids: readonly number[]): number {
  const rt = runtime(world); let total = 0;
  for (const id of ids) if (id >= 0 && id < rt.assigned.length) total += rt.assigned[id];
  return total;
}

function assignedForBuilding(world: AnyWorld, buildingId: number): number {
  const site = siteForBuilding(world, buildingId);
  if (site && Array.isArray(site.workPoiIds)) return assignedForPois(world, site.workPoiIds);
  const ids = world.city.poi.poisInBuilding(buildingId)
    .filter((p: any) => p.category === POICategory.Work && p.capacity > 0)
    .map((p: any) => p.id);
  return assignedForPois(world, ids);
}

function injectRoster(text: string, assigned: number): string {
  return text.replace(/出勤\s+(\d+)\/(\d+)\s+\/\s+((?:生産|稼働)効率)/,
    (_all, present, capacity, label) => `出勤 ${present} / 在籍 ${assigned} / 定員 ${capacity} / ${label}`);
}

const worldProto = World.prototype as unknown as Record<string, any>;
if (!worldProto.__citySimWorkplaceRosterV081) {
  const previousPopulate = worldProto.populate as AnyMethod;
  worldProto.populate = function populateWithWorkplaceRoster(this: AnyWorld, ...args: any[]): void {
    previousPopulate.apply(this, args);
    rebuild(this);
  };
  worldProto.__citySimWorkplaceRosterV081 = true;
}

const inspectorProto = UniversalInspector.prototype as unknown as Record<string, any>;
if (!inspectorProto.__citySimWorkplaceRosterInspectorV081) {
  const previousDescribeAgent = inspectorProto.describeAgent as AnyMethod;
  inspectorProto.describeAgent = function describeAgentWithRoster(this: AnyInspector, agent: number): string {
    const text = previousDescribeAgent.call(this, agent) as string;
    const workPoi = this.world.store.workPOI[agent];
    if (!text || workPoi < 0) return text;
    const poi = this.world.city.poi.get(workPoi);
    if (!poi) return text;
    const site = siteForBuilding(this.world, poi.buildingId);
    const assigned = site && Array.isArray(site.workPoiIds)
      ? assignedForPois(this.world, site.workPoiIds)
      : assignedForPois(this.world, [workPoi]);
    return injectRoster(text, assigned);
  };

  const previousDescribeBuilding = inspectorProto.describeBuilding as AnyMethod;
  inspectorProto.describeBuilding = function describeBuildingWithRoster(this: AnyInspector, buildingId: number): string {
    const text = previousDescribeBuilding.call(this, buildingId) as string;
    return text ? injectRoster(text, assignedForBuilding(this.world, buildingId)) : text;
  };
  inspectorProto.__citySimWorkplaceRosterInspectorV081 = true;
}
