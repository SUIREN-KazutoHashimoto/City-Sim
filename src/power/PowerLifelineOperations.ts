import { workplaceStaffingForPoi } from '../world/WorkplaceProductivityTuning';
import { lifelineWorkplaceForKey } from '../world/LifelineWorkforce';
import {
  consumeGenerationFuel,
  generationFuelAvailabilityFactor,
  generationFuelSnapshots,
  type GenerationFuelInventorySnapshot,
} from './GenerationFuelModel';
import { PowerSystem } from './PowerSystem';

export interface LifelineGenerationSnapshot {
  facilityId: string;
  workplacePoiId: number | null;
  concurrentStaffTarget: number;
  rosterTarget: number;
  presentStaff: number;
  staffingFactor: number;
  fuelFactor: number;
  operationalFactor: number;
}

type AnyMethod = (...args: any[]) => any;
interface RuntimeState { lastFuelSimSeconds: number | null; }
const states = new WeakMap<PowerSystem, RuntimeState>();
const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function stateOf(system: PowerSystem): RuntimeState {
  let state = states.get(system);
  if (!state) { state = { lastFuelSimSeconds: null }; states.set(system, state); }
  return state;
}

function staffingFactor(system: PowerSystem, facilityId: string): { poiId: number | null; concurrent: number; roster: number; present: number; factor: number } {
  const spec = lifelineWorkplaceForKey(system.city.poi, `power-generation:${facilityId}`);
  if (!spec) return { poiId: null, concurrent: 0, roster: 0, present: 0, factor: 1 };
  const staffing = workplaceStaffingForPoi(system.city.poi, spec.poiId);
  const factor = spec.concurrentStaff > 0 ? clamp01(staffing.present / spec.concurrentStaff) : 1;
  return { poiId: spec.poiId, concurrent: spec.concurrentStaff, roster: spec.rosterTarget, present: staffing.present, factor };
}

declare module './PowerSystem' {
  interface PowerSystem {
    generationFuelSnapshots(): GenerationFuelInventorySnapshot[];
    lifelineGenerationSnapshots(): LifelineGenerationSnapshot[];
  }
}

const proto = PowerSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimPowerLifelineOperationsV1015) {
  const previousAvailable = proto.updateAvailableGeneration as AnyMethod;
  proto.updateAvailableGeneration = function updateAvailableGenerationWithLifelineStaffing(this: PowerSystem, totalSimSeconds: number): void {
    previousAvailable.call(this, totalSimSeconds);
    for (const facility of this.generationFacilities) {
      if (facility.availableOutputKw <= 0) continue;
      const staff = staffingFactor(this, facility.id);
      const fuel = generationFuelAvailabilityFactor(this, facility.id);
      facility.availableOutputKw *= staff.factor * fuel;
    }
  };

  const previousUpdate = proto.update as AnyMethod;
  proto.update = function updateWithFuelConsumption(this: PowerSystem, dtSec: number, totalSimSeconds: number, force = false): void {
    previousUpdate.call(this, dtSec, totalSimSeconds, force);
    const runtime = stateOf(this);
    const actualSim = Number((this as unknown as Record<string, unknown>).lastUpdateSimSeconds);
    if (!Number.isFinite(actualSim)) return;
    if (runtime.lastFuelSimSeconds == null) { runtime.lastFuelSimSeconds = actualSim; return; }
    if (actualSim < runtime.lastFuelSimSeconds) { runtime.lastFuelSimSeconds = actualSim; return; }
    const elapsed = actualSim - runtime.lastFuelSimSeconds;
    if (elapsed <= 0) return;
    consumeGenerationFuel(this, elapsed);
    runtime.lastFuelSimSeconds = actualSim;
  };

  proto.generationFuelSnapshots = function generationFuelSnapshotsApi(this: PowerSystem): GenerationFuelInventorySnapshot[] {
    return generationFuelSnapshots(this);
  };

  proto.lifelineGenerationSnapshots = function lifelineGenerationSnapshotsApi(this: PowerSystem): LifelineGenerationSnapshot[] {
    return this.generationFacilities.map((facility) => {
      const staff = staffingFactor(this, facility.id);
      const fuel = generationFuelAvailabilityFactor(this, facility.id);
      return {
        facilityId: facility.id,
        workplacePoiId: staff.poiId,
        concurrentStaffTarget: staff.concurrent,
        rosterTarget: staff.roster,
        presentStaff: staff.present,
        staffingFactor: staff.factor,
        fuelFactor: fuel,
        operationalFactor: staff.factor * fuel,
      };
    });
  };

  proto.__citySimPowerLifelineOperationsV1015 = true;
}
