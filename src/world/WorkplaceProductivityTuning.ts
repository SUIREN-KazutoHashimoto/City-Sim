import { AgentState } from '../agents/AgentStore';
import { isWorkTime } from '../agents/UtilityBrain';
import { supplyChainForPoi, type ProductionSiteRecord } from '../generation/RuralIndustryAndDepotTuning';
import { powerOperationalFactorForBuilding } from '../power/PowerRuntimeRegistry';
import { LogisticsSystem } from '../traffic/LogisticsSystem';
import { lifelineWorkplaceForPoi } from './LifelineWorkforce';
import { POICategory, type POIRegistry } from './POI';
import { World } from './World';

type AnyWorld = any;
type AnyLogistics = any;
type AnyMethod = (...args: any[]) => any;

const LIFELINE_SHIFT_HANDOVER_GRACE_SEC = 45 * 60;
const LIFELINE_STARTUP_GRACE_SEC = 60 * 60;

export interface WorkplaceStaffing {
  present: number;
  onDuty: number;
  scheduled: number;
  assigned: number;
  capacity: number;
  efficiency: number;
  initialized: boolean;
}

interface StaffingRuntime {
  present: Int32Array;
  onDuty: Int32Array;
  scheduled: Int32Array;
  assigned: Int32Array;
  capacity: Int32Array;
  efficiency: Float32Array;
  initialized: boolean;
}

interface LifelineCheckInRuntime {
  shiftStartByAgent: Float64Array;
  workPoiByAgent: Int32Array;
  startupGraceUntil: number;
}

const staffingByPoi = new WeakMap<POIRegistry, StaffingRuntime>();
const lifelineCheckInByStore = new WeakMap<object, LifelineCheckInRuntime>();
const baseRateBySite = new WeakMap<object, number>();
const workPoisBySite = new WeakMap<object, number[]>();

function ensureRuntime(poi: POIRegistry): StaffingRuntime {
  let runtime = staffingByPoi.get(poi);
  if (runtime && runtime.present.length === poi.size) return runtime;
  runtime = {
    present: new Int32Array(poi.size),
    onDuty: new Int32Array(poi.size),
    scheduled: new Int32Array(poi.size),
    assigned: new Int32Array(poi.size),
    capacity: new Int32Array(poi.size),
    efficiency: new Float32Array(poi.size),
    initialized: false,
  };
  for (const p of poi.all()) if (p.category === POICategory.Work && p.capacity > 0) runtime.capacity[p.id] = p.capacity;
  staffingByPoi.set(poi, runtime);
  return runtime;
}

function ensureLifelineCheckIns(store: any, now: number): LifelineCheckInRuntime {
  const capacity = Math.max(1, Number(store.capacity) || Number(store.count) || 1);
  let runtime = lifelineCheckInByStore.get(store as object);
  if (runtime && runtime.shiftStartByAgent.length === capacity) return runtime;
  const shiftStartByAgent = new Float64Array(capacity);
  shiftStartByAgent.fill(Number.NEGATIVE_INFINITY);
  const workPoiByAgent = new Int32Array(capacity);
  workPoiByAgent.fill(-1);
  runtime = { shiftStartByAgent, workPoiByAgent, startupGraceUntil: now + LIFELINE_STARTUP_GRACE_SEC };
  lifelineCheckInByStore.set(store as object, runtime);
  return runtime;
}

function activeShiftStartSeconds(now: number, hour: number, start: number, end: number): number {
  const dayStart = now - hour * 3600;
  if (start < end) return dayStart + start * 3600;
  return hour >= start ? dayStart + start * 3600 : dayStart - 86400 + start * 3600;
}

function refreshAttendance(world: AnyWorld): void {
  const poi = world.city.poi as POIRegistry;
  const runtime = ensureRuntime(poi);
  runtime.present.fill(0);
  runtime.onDuty.fill(0);
  runtime.scheduled.fill(0);
  runtime.assigned.fill(0);
  const store = world.store;
  const hour = world.clock.hourF;
  const now = world.clock.totalSeconds;
  const checkIns = ensureLifelineCheckIns(store, now);

  for (let agent = 0; agent < store.count; agent++) {
    const work = store.workPOI[agent];
    if (work < 0 || work >= runtime.present.length) continue;
    runtime.assigned[work]++;

    const scheduled = isWorkTime(store.occupation[agent], store.workStart[agent], store.workEnd[agent], hour);
    if (scheduled) runtime.scheduled[work]++;

    const physicallyPresent = scheduled
      && store.state[agent] === AgentState.Engaged
      && store.goalPOI[agent] === work;
    if (physicallyPresent) runtime.present[work]++;

    const lifeline = lifelineWorkplaceForPoi(poi, work);
    if (!lifeline) {
      if (physicallyPresent) runtime.onDuty[work]++;
      continue;
    }
    if (!scheduled) continue;

    const shiftStart = activeShiftStartSeconds(now, hour, store.workStart[agent], store.workEnd[agent]);
    if (physicallyPresent) {
      checkIns.shiftStartByAgent[agent] = shiftStart;
      checkIns.workPoiByAgent[agent] = work;
    }

    const checkedIn = checkIns.workPoiByAgent[agent] === work
      && Math.abs(checkIns.shiftStartByAgent[agent] - shiftStart) < 1;
    const shiftAge = Math.max(0, now - shiftStart);
    const handoverGrace = shiftAge <= LIFELINE_SHIFT_HANDOVER_GRACE_SEC;
    const startupGrace = now <= checkIns.startupGraceUntil;
    if (checkedIn || handoverGrace || startupGrace) runtime.onDuty[work]++;
  }

  for (let id = 0; id < runtime.present.length; id++) {
    const cap = runtime.capacity[id];
    if (cap <= 0) { runtime.efficiency[id] = 0; continue; }
    const lifeline = lifelineWorkplaceForPoi(poi, id);
    const attendanceTarget = lifeline?.concurrentStaff ?? cap;
    const attendanceCount = lifeline ? runtime.onDuty[id] : runtime.present[id];
    const attendance = Math.max(0, Math.min(1, attendanceCount / Math.max(1, attendanceTarget)));
    const p = poi.get(id);
    const power = p?.buildingId >= 0 ? powerOperationalFactorForBuilding(poi, p.buildingId) : 1;
    runtime.efficiency[id] = attendance * power;
  }
  runtime.initialized = true;
}

export function workplaceStaffingForPoi(poi: POIRegistry, poiId: number): WorkplaceStaffing {
  const runtime = ensureRuntime(poi);
  if (poiId < 0 || poiId >= runtime.present.length) {
    return { present: 0, onDuty: 0, scheduled: 0, assigned: 0, capacity: 0, efficiency: 0, initialized: runtime.initialized };
  }
  return {
    present: runtime.present[poiId],
    onDuty: runtime.onDuty[poiId],
    scheduled: runtime.scheduled[poiId],
    assigned: runtime.assigned[poiId],
    capacity: runtime.capacity[poiId],
    efficiency: runtime.efficiency[poiId],
    initialized: runtime.initialized,
  };
}

export function aggregateWorkplaceStaffing(poi: POIRegistry, poiIds: readonly number[]): WorkplaceStaffing {
  let present = 0, onDuty = 0, scheduled = 0, assigned = 0, capacity = 0, effectiveCapacity = 0;
  let initialized = poiIds.length > 0;
  for (const id of poiIds) {
    const staffing = workplaceStaffingForPoi(poi, id);
    present += staffing.present;
    onDuty += staffing.onDuty;
    scheduled += staffing.scheduled;
    assigned += staffing.assigned;
    capacity += staffing.capacity;
    effectiveCapacity += staffing.capacity * staffing.efficiency;
    initialized = initialized && staffing.initialized;
  }
  return {
    present,
    onDuty,
    scheduled,
    assigned,
    capacity,
    efficiency: capacity > 0 ? Math.max(0, Math.min(1, effectiveCapacity / capacity)) : 0,
    initialized,
  };
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
if (!worldProto.__citySimWorkplaceAttendanceV1020) {
  const previousStepBeforePed = worldProto.stepBeforePed as AnyMethod;
  worldProto.stepBeforePed = function stepBeforePedWithWorkplaceAttendance(this: AnyWorld, ...args: any[]): any {
    refreshAttendance(this);
    return previousStepBeforePed.apply(this, args);
  };
  worldProto.__citySimWorkplaceAttendanceV1020 = true;
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
