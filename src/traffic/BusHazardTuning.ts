import { BusSystem } from './BusSystem';
import type { VehicleStore } from './VehicleStore';
import { setVehicleHazard } from './VehicleSignalRuntime';

type AnyBusSystem = any;
type UpdateMethod = (...args: any[]) => any;

const proto = BusSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimBusHazardV074) {
  const previousUpdate = proto.update as UpdateMethod;
  proto.update = function updateWithBusHazards(this: AnyBusSystem, ...args: any[]): any {
    const result = previousUpdate.apply(this, args);
    const vs = this.vs as VehicleStore;
    for (const bus of this.buses as Array<{ vehicle: number; dwell: number }>) {
      setVehicleHazard(vs, bus.vehicle, bus.dwell > 0);
    }
    return result;
  };
  proto.__citySimBusHazardV074 = true;
}
