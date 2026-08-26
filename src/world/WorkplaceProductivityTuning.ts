import { AgentState } from '../agents/AgentStore';
import { supplyChainForPoi, type ProductionSiteRecord } from '../generation/RuralIndustryAndDepotTuning';
import { powerOperationalFactorForBuilding } from '../power/PowerRuntimeRegistry';
import { LogisticsSystem } from '../traffic/LogisticsSystem';
import { POICategory, type POIRegistry } from './POI';
import { World } from './World';

type AnyWorld = any;
type AnyLogistics = any;
type AnyMethod = (...args: any[]) => any;

export interface WorkplaceStaffing {
  present: number;
  capacity: number;
  efficiency: number;
}

interface StaffingRuntime {
  present: Int32Array;
  capacity: Int32Array;
  efficiency: Float32Array;
}

const staffingByPoi = new WeakMap<POIRegistry, StaffingRuntime>();
const baseRateBySite = new WeakMap<object, number>();
const workPoisBySite = new WeakMap<object, number[]>();

function ensureRuntime(poi: POIRegistry): StaffingRuntime {
  let runtime = staffingByPoi.get(poi);
  if (runtime && runtime.present.length === poi.size) return runtime;
  runtime = { present: new Int32Array(poi.size), capacity: new Int32Array(poi.size), efficiency: new Float32Array(poi.size) };
  for (const p of poi.all()) if (p.category === POICategory.Work && p.capacity > 0) runtime.capacity[p.id] = p.capacity;
  staffingByPoi.set(poi, runtime);
  return runtime;
}

function refreshAttendance(world: AnyWorld): void {
  const poi = world.city.poi as POIRegistry;
  const runtime = ensureRuntime(poi);
  runtime.present.fill(0);
  const store = world.store;
  for (let agent = 0; agent < store.count; agent++) {
    const work = store.workPOI[agent];
    if (work < 0 || work >= runtime.present.length) continue;
    if (store.state[agent] !== AgentState.Engaged || store.goalPOI[agent] !== work) continue;
    runtime.present[work]++;
  }
  for (let id = 0; id < runtime.present.length; id++) {
    const cap = runtime.capacity[id];
    if (cap <= 0) { runtime.efficiency[id] = 0; continue; }
    const attendance = Math.max(0, Math.min(1, runtime.present[id] / cap));
    const p = poi.get(id);
    const power = p?.buildingId >= 0 ? powerOperationalFactorForBuilding(poi, p.buildingId) : 1;
    runtime.efficiency[id] = attendance * power;
  }
}

export function workplaceStaffingForPoi(poi: POIRegistry, poiId: number): WorkplaceStaffing {
  const runtime = ensureRuntime(poi);
  if (poiId < 0 || poiId >= runtime.present.length) return { present: 0, capacity: 0, efficiency: 0 };
  return { present: runtime.present[poiId], capacity: runtime.capacity[poiId], efficiency: runtime.efficiency[poiId] };
}

export function aggregateWorkplaceStaffing(poi: POIRegistry, poiIds: readonly number[]): WorkplaceStaffing {
  let present = 0, capacity = 0, effectiveCapacity = 0;
  for (const id of poiIds) {
    const staffing = workplaceStaffingForPoi(poi, id);
    present += staffing.present; capacity += staffing.capacity; effectiveCapacity += staffing.capacity * staffing.efficiency;
  }
  return { present, capacity, efficiency: capacity > 0 ? Math.max(0, Math.min(1, effectiveCapacity / capacity)) : 0 };
}

function workPoiIdsForSite(poi: POIRegistry, site: ProductionSiteRecord & Record<string, any>): number[] {
  const cached = workPoisBySite.get(site as object);
  if (cached) return cached;
  const explicit = Array.isArray(site.workPoiIds) ? site.workPoiIds.filter((id: unknown) => Number.isInteger(id)) as number[] : [];
  if (explicit.length > 0) { workPoisBySite.set(site as object, explicit); return explicit; }
  const buildingIds = new Set<number>();
  if (Number.isInteger(site.buildingId)) buildingIds.add(site.buildingId);
  if (Number.isInteger(site.officeBuildingId)) buildingIds.add(site.officeBuildingId);
  if (Number.isInteger(site.warehouseBuildingId)) buildingIds.add(site.warehouseBuildingId);
  const ids = poi.all().filter((p) => p.category === POICategory.Work && p.capacity > 0 && buildingIds.has(p.buildingId)).map((p) => p.id);
  workPoisBySite.set(site as object, ids);
  return ids;
}

const worldProto = World.prototype as unknown as Record<string, any>;
if (!worldProto.__citySimWorkplaceAttendanceV077) {
  const previousStepBeforePed = worldProto.stepBeforePed as AnyMethod;
  worldProto.stepBeforePed = function stepBeforePedWithWorkplaceAttendance(this: AnyWorld, ...args: any[]): any {
    refreshAttendance(this);
    return previousStepBeforePed.apply(this, args);
  };
  worldProto.__citySimWorkplaceAttendanceV077 = true;
}

const logisticsProto = LogisticsSystem.prototype as unknown as Record<string, any>;
if (!logisticsProto.__citySimStaffedProductionV077) {
  const previousUpdate = logisticsProto.update as AnyMethod;
  logisticsProto.update = function updateWithStaffedProduction(this: AnyLogistics, dt: number): void {
    const poi = this.poi as POIRegistry;
    const chain = supplyChainForPoi(poi);
    if (!chain) { previousUpdate.call(this, dt); return; }

    const touched: Array<{ site: ProductionSiteRecord & Record<string, any>; baseRate: number }> = [];
    for (const rawSite of chain.sites) {
      const site = rawSite as ProductionSiteRecord & Record<string, any>;
      let baseRate = baseRateBySite.get(site as object);
      if (baseRate == null) { baseRate = site.processRate; baseRateBySite.set(site as object, baseRate); }
      const ids = workPoiIdsForSite(poi, site);
      const staffing = aggregateWorkplaceStaffing(poi, ids);
      site.presentWorkers = staffing.present;
      site.workerCapacity = staffing.capacity;
      site.efficiency = staffing.efficiency;
      site.powerAdjustedEfficiency = staffing.efficiency;
      site.effectiveProcessRate = baseRate * staffing.efficiency;
      touched.push({ site, baseRate });
      site.processRate = site.effectiveProcessRate;
    }

    try { previousUpdate.call(this, dt); }
    finally { for (const item of touched) item.site.processRate = item.baseRate; }
  };
  logisticsProto.__citySimStaffedProductionV077 = true;
}
