import { FacilityType } from '../generation/SpecialFacilityPlanner';
import { TaxiSystem } from './TaxiSystem';
import { VehicleState } from './VehicleStore';

type AnyTaxi = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

type TaxiRecordLite = {
  id: number;
  vehicle: number;
  phase: string;
};

type DemandAnchor = {
  id: number;
  x: number;
  z: number;
  weight: number;
};

interface CruiseState {
  anchors: DemandAnchor[];
  nextDepartureAt: Map<number, number>;
  targetAnchorByTaxi: Map<number, number>;
  lastAnchorByTaxi: Map<number, number>;
}

const stateBySystem = new WeakMap<object, CruiseState>();
const MAX_CRUISING_SHARE = 0.55;
const MIN_REPOSITION_DISTANCE = 450;
const INITIAL_STAGGER_SECONDS = 150;
const DWELL_MIN_SECONDS = 90;
const DWELL_SPAN_SECONDS = 180;

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function buildDemandAnchors(self: AnyTaxi): DemandAnchor[] {
  const cells = new Map<string, Omit<DemandAnchor, 'id'>>();
  const add = (x: number, z: number, weight: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(z) || weight <= 0) return;
    const key = `${Math.round(x / 120)}:${Math.round(z / 120)}`;
    const current = cells.get(key);
    if (!current || weight > current.weight) cells.set(key, { x, z, weight });
  };

  const planning = self.city?.planning;
  if (planning?.cbd) add(planning.cbd.x, planning.cbd.z, 7.5);
  for (const center of planning?.subCenters ?? []) add(center.x, center.z, 5.5);

  for (const station of planning?.rail?.stations ?? []) {
    const interchangeBonus = Math.min(2.5, Math.max(0, (station.lineIds?.length ?? 1) - 1) * 0.8);
    add(station.x, station.z, 6.0 + interchangeBonus);
  }

  for (const facility of self.city?.facilities ?? []) {
    let weight = 0;
    switch (facility.type as FacilityType) {
      case FacilityType.Hotel: weight = 7.5; break;
      case FacilityType.Stadium: weight = 7.0; break;
      case FacilityType.Mall: weight = 6.0; break;
      case FacilityType.University: weight = 4.5; break;
      case FacilityType.CityHall: weight = 4.0; break;
      case FacilityType.Hospital: weight = 3.8; break;
      case FacilityType.Supermarket: weight = 3.2; break;
      default: break;
    }
    if (weight > 0) add(facility.x, facility.z, weight);
  }

  return [...cells.values()].map((anchor, id) => ({ id, ...anchor }));
}

function stateFor(self: AnyTaxi): CruiseState {
  let state = stateBySystem.get(self);
  if (state) return state;
  state = {
    anchors: buildDemandAnchors(self),
    nextDepartureAt: new Map(),
    targetAnchorByTaxi: new Map(),
    lastAnchorByTaxi: new Map(),
  };
  stateBySystem.set(self, state);
  return state;
}

function scheduleInitial(state: CruiseState, taxiId: number, now: number): void {
  const delay = 25 + hash01(taxiId * 3253 + 17) * INITIAL_STAGGER_SECONDS;
  state.nextDepartureAt.set(taxiId, now + delay);
}

function scheduleDwell(state: CruiseState, taxiId: number, now: number): void {
  const delay = DWELL_MIN_SECONDS + hash01(taxiId * 6151 + Math.floor(now / 30)) * DWELL_SPAN_SECONDS;
  state.nextDepartureAt.set(taxiId, now + delay);
}

function anchorOccupancy(state: CruiseState): Map<number, number> {
  const out = new Map<number, number>();
  for (const anchorId of state.targetAnchorByTaxi.values()) out.set(anchorId, (out.get(anchorId) ?? 0) + 1);
  return out;
}

function chooseAnchor(
  self: AnyTaxi,
  state: CruiseState,
  taxi: TaxiRecordLite,
  occupancy: Map<number, number>,
  now: number,
): DemandAnchor | null {
  const vs = self.vehicles;
  const x = vs.posX[taxi.vehicle] as number;
  const z = vs.posZ[taxi.vehicle] as number;
  const lastAnchor = state.lastAnchorByTaxi.get(taxi.id) ?? -1;
  const citySize = Math.max(1000, self.city?.sizeMeters ?? 10_000);
  const timeBucket = Math.floor(now / 300);
  let best: DemandAnchor | null = null;
  let bestScore = -Infinity;

  for (const anchor of state.anchors) {
    const distance = Math.hypot(anchor.x - x, anchor.z - z);
    if (distance < MIN_REPOSITION_DISTANCE) continue;
    if (anchor.id === lastAnchor && state.anchors.length > 2) continue;

    const crowd = occupancy.get(anchor.id) ?? 0;
    const distanceScore = distance > citySize * 0.62
      ? -1.8
      : Math.min(1.4, distance / 2200);
    const jitter = hash01(taxi.id * 4099 + anchor.id * 131 + timeBucket * 17) * 3.0;
    const score = anchor.weight - crowd * 3.4 + distanceScore + jitter;
    if (score <= bestScore) continue;
    bestScore = score;
    best = anchor;
  }

  return best;
}

function updateCruising(self: AnyTaxi): void {
  const taxis = self.taxis as TaxiRecordLite[];
  if (!taxis?.length) return;
  const state = stateFor(self);
  if (!state.anchors.length) return;

  const vs = self.vehicles;
  const now = Number(self.clock?.totalSeconds ?? 0);

  for (const taxi of taxis) {
    if (taxi.phase !== 'idle') {
      state.targetAnchorByTaxi.delete(taxi.id);
      state.nextDepartureAt.delete(taxi.id);
      continue;
    }

    const vehicleState = vs.state[taxi.vehicle] as VehicleState;
    const targetAnchor = state.targetAnchorByTaxi.get(taxi.id);
    if (targetAnchor != null && vehicleState !== VehicleState.Driving) {
      state.targetAnchorByTaxi.delete(taxi.id);
      state.lastAnchorByTaxi.set(taxi.id, targetAnchor);
      scheduleDwell(state, taxi.id, now);
      continue;
    }

    if (targetAnchor == null && !state.nextDepartureAt.has(taxi.id)) scheduleInitial(state, taxi.id, now);
  }

  const idleTaxis = taxis.filter((taxi) => taxi.phase === 'idle');
  const maxCruising = Math.floor(idleTaxis.length * MAX_CRUISING_SHARE);
  let cruising = idleTaxis.reduce((count, taxi) => count + (vs.state[taxi.vehicle] === VehicleState.Driving ? 1 : 0), 0);
  if (cruising >= maxCruising) return;

  const occupancy = anchorOccupancy(state);
  for (const taxi of idleTaxis) {
    if (cruising >= maxCruising) break;
    if (state.targetAnchorByTaxi.has(taxi.id)) continue;

    const vehicleState = vs.state[taxi.vehicle] as VehicleState;
    if (vehicleState !== VehicleState.Parked && vehicleState !== VehicleState.Arrived) continue;
    const due = state.nextDepartureAt.get(taxi.id) ?? Infinity;
    if (now < due) continue;

    const anchor = chooseAnchor(self, state, taxi, occupancy, now);
    if (!anchor) {
      scheduleDwell(state, taxi.id, now);
      continue;
    }

    const v = taxi.vehicle;
    const dispatched = self.traffic.dispatch(v, vs.posX[v], vs.posZ[v], anchor.x, anchor.z) as boolean;
    if (!dispatched) {
      state.nextDepartureAt.set(taxi.id, now + 45 + hash01(taxi.id * 7919 + Math.floor(now)) * 45);
      continue;
    }

    state.targetAnchorByTaxi.set(taxi.id, anchor.id);
    state.nextDepartureAt.delete(taxi.id);
    occupancy.set(anchor.id, (occupancy.get(anchor.id) ?? 0) + 1);
    cruising++;
  }
}

const proto = TaxiSystem.prototype as unknown as AnyTaxi;
if (!proto.__citySimTaxiCruisingV106) {
  const previousUpdate = proto.update as AnyMethod;
  proto.update = function taxiUpdateWithCruising(this: AnyTaxi, ...args: any[]): any {
    const result = previousUpdate.apply(this, args);
    updateCruising(this);
    return result;
  };
  proto.__citySimTaxiCruisingV106 = true;
}
