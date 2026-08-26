import { BusSystem } from './BusSystem';
import { TaxiSystem } from './TaxiSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';
import { fleetDepotForNetwork, type FleetDepotRecord } from '../generation/RuralIndustryAndDepotTuning';
import { setVehicleHazard } from './VehicleSignalRuntime';

type AnyTaxi = any;
type AnyBus = any;
type AnyMethod = (...args: any[]) => any;

function slot(depot: FleetDepotRecord, index: number): { x: number; z: number } {
  const count = Math.max(1, depot.slotX.length);
  const i = ((index % count) + count) % count;
  return { x: depot.slotX[i] ?? depot.x, z: depot.slotZ[i] ?? depot.z };
}

const taxiProto = TaxiSystem.prototype as unknown as Record<string, any>;
if (!taxiProto.__citySimTaxiDepotV076) {
  const previousBuildFleet = taxiProto.buildFleet as AnyMethod;
  taxiProto.buildFleet = function buildFleetFromDepot(this: AnyTaxi, population: number): void {
    previousBuildFleet.call(this, population);
    const depot = fleetDepotForNetwork(this.city.net, 'taxi');
    if (!depot) return;
    const vs = this.vehicles as VehicleStore;
    const taxis = this.taxis as Array<{ vehicle: number }>;
    for (let i = 0; i < taxis.length; i++) {
      const v = taxis[i].vehicle, p = slot(depot, i);
      vs.posX[v] = p.x; vs.posZ[v] = p.z; vs.heading[v] = 0;
      vs.speed[v] = 0; vs.accel[v] = 0; vs.state[v] = VehicleState.Parked;
      vs.edge[v] = -1; vs.fromNode[v] = -1; vs.toNode[v] = -1; vs.segT[v] = 0;
      vs.paths[v] = new Int32Array(0); vs.pathCursor[v] = 0;
      setVehicleHazard(vs, v, false);
    }
  };
  taxiProto.nearestIdleTaxi = function nearestIdleTaxiFromDepot(this: AnyTaxi, x: number, z: number): any {
    let best: any = null;
    const radius = Math.max(2500, this.city.sizeMeters * 0.85);
    let bestD2 = radius * radius;
    for (const taxi of this.taxis as Array<{ phase: string; vehicle: number }>) {
      if (taxi.phase !== 'idle') continue;
      const v = taxi.vehicle;
      if (this.vehicles.state[v] !== VehicleState.Parked && this.vehicles.state[v] !== VehicleState.Arrived) continue;
      const dx = this.vehicles.posX[v] - x, dz = this.vehicles.posZ[v] - z, d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      best = taxi; bestD2 = d2;
    }
    return best;
  };
  taxiProto.__citySimTaxiDepotV076 = true;
}

const busProto = BusSystem.prototype as unknown as Record<string, any>;
if (!busProto.__citySimBusDepotV076) {
  const previousSpawnBusOnRoute = busProto.spawnBusOnRoute as AnyMethod;
  busProto.spawnBusOnRoute = function spawnBusOnRouteFromDepot(this: AnyBus, routeId: number, startSeq: number): void {
    const depot = fleetDepotForNetwork(this.net, 'bus');
    if (!depot) { previousSpawnBusOnRoute.call(this, routeId, startSeq); return; }
    const route = this.routes[routeId];
    if (!route || route.stopSeq.length < 2) return;
    const busId = this.buses.length;
    const p = slot(depot, busId);
    const v = this.vs.spawnBus(busId, p.x, p.z);
    if (v < 0) return;
    this.vs.busId[v] = busId;
    const seqIdx = ((startSeq - 1) % route.stopSeq.length + route.stopSeq.length) % route.stopSeq.length;
    this.buses.push({ vehicle: v, route: routeId, seqIdx, dwell: 0, onboard: [], capacity: 30 });
    this.departToNextStop(busId);
  };
  busProto.__citySimBusDepotV076 = true;
}
