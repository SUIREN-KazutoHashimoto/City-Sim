import type { VehicleStore } from './VehicleStore';

export interface VehicleSignalState {
  laneChange: -1 | 0 | 1;
  hazard: boolean;
}

interface SignalRuntime {
  laneChange: Int8Array;
  hazard: Uint8Array;
  hazardVehicles: Set<number>;
}

const runtimeByStore = new WeakMap<VehicleStore, SignalRuntime>();

function runtime(vs: VehicleStore): SignalRuntime {
  let value = runtimeByStore.get(vs);
  if (value) return value;
  value = {
    laneChange: new Int8Array(vs.capacity),
    hazard: new Uint8Array(vs.capacity),
    hazardVehicles: new Set<number>(),
  };
  runtimeByStore.set(vs, value);
  return value;
}

export function setLaneChangeSignal(vs: VehicleStore, vehicle: number, direction: number): void {
  if (vehicle < 0 || vehicle >= vs.capacity) return;
  runtime(vs).laneChange[vehicle] = direction > 0 ? 1 : direction < 0 ? -1 : 0;
}

export function setVehicleHazard(vs: VehicleStore, vehicle: number, enabled: boolean): void {
  if (vehicle < 0 || vehicle >= vs.capacity) return;
  const state = runtime(vs);
  state.hazard[vehicle] = enabled ? 1 : 0;
  if (enabled) state.hazardVehicles.add(vehicle);
  else state.hazardVehicles.delete(vehicle);
}

export function vehicleSignalState(vs: VehicleStore, vehicle: number): VehicleSignalState {
  const state = runtimeByStore.get(vs);
  if (!state || vehicle < 0 || vehicle >= vs.capacity) return { laneChange: 0, hazard: false };
  const direction = state.laneChange[vehicle];
  return {
    laneChange: direction > 0 ? 1 : direction < 0 ? -1 : 0,
    hazard: state.hazard[vehicle] === 1,
  };
}

export function forEachHazardVehicle(vs: VehicleStore, fn: (vehicle: number) => void): void {
  const state = runtimeByStore.get(vs);
  if (!state) return;
  for (const vehicle of state.hazardVehicles) {
    if (vehicle >= 0 && vehicle < vs.count && state.hazard[vehicle] === 1) fn(vehicle);
  }
}
