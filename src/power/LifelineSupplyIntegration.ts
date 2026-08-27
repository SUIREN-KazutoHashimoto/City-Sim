import { supplyChainForPoi, fleetDepotForNetwork, type ProductionSiteRecord, type SupplyChainRuntime } from '../generation/RuralIndustryAndDepotTuning';
import { LogisticsSystem } from '../traffic/LogisticsSystem';
import type { TrafficSystem } from '../traffic/TrafficSystem';
import { VehicleState, type VehicleStore } from '../traffic/VehicleStore';
import { setVehicleHazard } from '../traffic/VehicleSignalRuntime';
import type { POIRegistry } from '../world/POI';
import {
  cancelGenerationFuelInbound,
  generationFuelNeeds,
  receiveGenerationFuel,
  reserveGenerationFuelInbound,
} from './GenerationFuelModel';
import { powerSystemForPoi } from './PowerRuntimeRegistry';
import type { PowerSystem } from './PowerSystem';

const LOAD_SECONDS = 8;
const UNLOAD_SECONDS = 10;
const MIN_DISPATCH_UNITS = 40;

type FuelTruckPhase = 'idle' | 'to-source' | 'loading' | 'to-plant' | 'unloading' | 'returning';
type FuelSourceKind = 'internal' | 'external';

interface FuelJob {
  facilityId: string;
  amount: number;
  sourceKind: FuelSourceKind;
  sourceSiteId: number | null;
  sourceX: number;
  sourceZ: number;
  destinationX: number;
  destinationZ: number;
}

interface FuelTruck {
  vehicle: number;
  phase: FuelTruckPhase;
  cargo: number;
  capacity: number;
  timer: number;
  job: FuelJob | null;
  homeX: number;
  homeZ: number;
}

interface FuelFleetRuntime {
  system: PowerSystem;
  chain: SupplyChainRuntime;
  trucks: FuelTruck[];
}

type AnyLogistics = Record<string, any>;
type AnyMethod = (...args: any[]) => any;
const runtimeBySystem = new WeakMap<LogisticsSystem, FuelFleetRuntime>();

function slotPosition(depot: { x: number; z: number; slotX: Float32Array; slotZ: Float32Array }, index: number): { x: number; z: number } {
  const count = Math.max(1, depot.slotX.length);
  const i = index % count;
  return { x: depot.slotX[i] ?? depot.x, z: depot.slotZ[i] ?? depot.z };
}

function hold(vs: VehicleStore, vehicle: number): void {
  vs.speed[vehicle] = 0;
  vs.accel[vehicle] = 0;
}

function dispatch(traffic: TrafficSystem, vs: VehicleStore, truck: FuelTruck, x: number, z: number): boolean {
  return traffic.dispatch(truck.vehicle, vs.posX[truck.vehicle], vs.posZ[truck.vehicle], x, z);
}

function ensureRuntime(logistics: AnyLogistics): FuelFleetRuntime | null {
  const key = logistics as LogisticsSystem;
  const existing = runtimeBySystem.get(key);
  if (existing) return existing;
  const poi = logistics.poi as POIRegistry;
  const system = powerSystemForPoi(poi);
  if (!system || system.generationFuelSnapshots().length === 0) return null;
  const traffic = logistics.traffic as TrafficSystem;
  const net = (traffic as unknown as Record<string, any>).net;
  const chain = supplyChainForPoi(poi);
  const depot = net ? fleetDepotForNetwork(net, 'freight') : null;
  if (!chain || !depot) return null;

  const vs = logistics.vs as VehicleStore;
  const desired = Math.max(2, Math.min(system.config.thermalFuelFleetSize, system.generationFuelSnapshots().length * 5));
  const runtime: FuelFleetRuntime = { system, chain, trucks: [] };
  for (let i = 0; i < desired; i++) {
    const p = slotPosition(depot, i + 37);
    const vehicle = vs.spawnTruck(10_000 + i, p.x, p.z);
    if (vehicle < 0) break;
    vs.length[vehicle] = 10.8;
    vs.colorIdx[vehicle] = 5;
    runtime.trucks.push({
      vehicle,
      phase: 'idle',
      cargo: 0,
      capacity: system.config.thermalFuelTruckCapacityUnits,
      timer: 0,
      job: null,
      homeX: p.x,
      homeZ: p.z,
    });
  }
  runtimeBySystem.set(key, runtime);
  return runtime;
}

function internalSource(
  system: PowerSystem,
  chain: SupplyChainRuntime,
  destinationX: number,
  destinationZ: number,
  requested: number,
): { site: ProductionSiteRecord; amount: number } | null {
  let best: { site: ProductionSiteRecord; amount: number; score: number } | null = null;
  for (const site of chain.sites) {
    if (site.kind !== 'raw-factory') continue;
    const protectedStock = Math.max(MIN_DISPATCH_UNITS, site.outputCapacity * system.config.thermalFuelInternalReserveRatio);
    const available = Math.max(0, site.outputStock - protectedStock);
    if (available < MIN_DISPATCH_UNITS) continue;
    const amount = Math.min(requested, available);
    if (amount < MIN_DISPATCH_UNITS) continue;
    const d2 = (site.x - destinationX) ** 2 + (site.z - destinationZ) ** 2;
    const fillBias = 1 / Math.max(0.2, site.outputStock / Math.max(1, site.outputCapacity));
    const score = d2 * fillBias;
    if (!best || score < best.score) best = { site, amount, score };
  }
  return best ? { site: best.site, amount: best.amount } : null;
}

function externalSource(
  runtime: FuelFleetRuntime,
  destinationX: number,
  destinationZ: number,
): { x: number; z: number } | null {
  const net = runtime.system.city.net as unknown as { nodes: Array<{ x: number; z: number }> };
  let best: { x: number; z: number; d2: number } | null = null;
  for (const nodeId of runtime.chain.gateNodes) {
    const node = net.nodes[nodeId];
    if (!node) continue;
    const d2 = (node.x - destinationX) ** 2 + (node.z - destinationZ) ** 2;
    if (!best || d2 < best.d2) best = { x: node.x, z: node.z, d2 };
  }
  return best ? { x: best.x, z: best.z } : null;
}

function reserveJob(runtime: FuelFleetRuntime, truckCapacity: number): FuelJob | null {
  const needs = generationFuelNeeds(runtime.system);
  for (const need of needs) {
    const facility = runtime.system.generationFacilities.find((item) => item.id === need.facilityId);
    if (!facility) continue;
    const requested = Math.min(truckCapacity, need.neededUnits);
    if (requested < MIN_DISPATCH_UNITS) continue;

    const internal = internalSource(runtime.system, runtime.chain, facility.x, facility.z, requested);
    if (internal) {
      internal.site.outputStock = Math.max(0, internal.site.outputStock - internal.amount);
      if (!reserveGenerationFuelInbound(runtime.system, facility.id, internal.amount)) {
        internal.site.outputStock = Math.min(internal.site.outputCapacity, internal.site.outputStock + internal.amount);
        continue;
      }
      return {
        facilityId: facility.id,
        amount: internal.amount,
        sourceKind: 'internal',
        sourceSiteId: internal.site.id,
        sourceX: internal.site.x,
        sourceZ: internal.site.z,
        destinationX: facility.x,
        destinationZ: facility.z,
      };
    }

    const external = externalSource(runtime, facility.x, facility.z);
    if (!external) continue;
    if (!reserveGenerationFuelInbound(runtime.system, facility.id, requested)) continue;
    return {
      facilityId: facility.id,
      amount: requested,
      sourceKind: 'external',
      sourceSiteId: null,
      sourceX: external.x,
      sourceZ: external.z,
      destinationX: facility.x,
      destinationZ: facility.z,
    };
  }
  return null;
}

function cancelJob(runtime: FuelFleetRuntime, job: FuelJob): void {
  cancelGenerationFuelInbound(runtime.system, job.facilityId, job.amount);
  if (job.sourceKind !== 'internal' || job.sourceSiteId == null) return;
  const site = runtime.chain.sites[job.sourceSiteId];
  if (site) site.outputStock = Math.min(site.outputCapacity, site.outputStock + job.amount);
}

function returnHome(traffic: TrafficSystem, vs: VehicleStore, truck: FuelTruck): void {
  setVehicleHazard(vs, truck.vehicle, false);
  if (!dispatch(traffic, vs, truck, truck.homeX, truck.homeZ)) {
    vs.state[truck.vehicle] = VehicleState.Arrived;
    vs.posX[truck.vehicle] = truck.homeX;
    vs.posZ[truck.vehicle] = truck.homeZ;
  }
  truck.phase = 'returning';
}

function updateFuelFleet(logistics: AnyLogistics, dt: number): void {
  const runtime = ensureRuntime(logistics);
  if (!runtime) return;
  const vs = logistics.vs as VehicleStore;
  const traffic = logistics.traffic as TrafficSystem;

  for (const truck of runtime.trucks) {
    const vehicle = truck.vehicle;
    if (truck.phase === 'idle') {
      const job = reserveJob(runtime, truck.capacity);
      if (!job) continue;
      truck.job = job;
      truck.cargo = 0;
      if (!dispatch(traffic, vs, truck, job.sourceX, job.sourceZ)) {
        cancelJob(runtime, job);
        truck.job = null;
        continue;
      }
      truck.phase = 'to-source';
      continue;
    }

    if (truck.phase === 'to-source') {
      if (vs.state[vehicle] !== VehicleState.Arrived) continue;
      hold(vs, vehicle);
      setVehicleHazard(vs, vehicle, true);
      truck.timer = LOAD_SECONDS;
      truck.phase = 'loading';
      continue;
    }

    if (truck.phase === 'loading') {
      hold(vs, vehicle);
      truck.timer -= dt;
      if (truck.timer > 0) continue;
      const job = truck.job;
      if (!job) { returnHome(traffic, vs, truck); continue; }
      truck.cargo = job.amount;
      setVehicleHazard(vs, vehicle, false);
      if (!dispatch(traffic, vs, truck, job.destinationX, job.destinationZ)) {
        cancelJob(runtime, job);
        truck.cargo = 0;
        truck.job = null;
        returnHome(traffic, vs, truck);
      } else truck.phase = 'to-plant';
      continue;
    }

    if (truck.phase === 'to-plant') {
      if (vs.state[vehicle] !== VehicleState.Arrived) continue;
      hold(vs, vehicle);
      setVehicleHazard(vs, vehicle, true);
      truck.timer = UNLOAD_SECONDS;
      truck.phase = 'unloading';
      continue;
    }

    if (truck.phase === 'unloading') {
      hold(vs, vehicle);
      truck.timer -= dt;
      if (truck.timer > 0) continue;
      const job = truck.job;
      if (job) receiveGenerationFuel(runtime.system, job.facilityId, truck.cargo, job.sourceKind);
      truck.cargo = 0;
      truck.job = null;
      returnHome(traffic, vs, truck);
      continue;
    }

    if (truck.phase === 'returning' && vs.state[vehicle] === VehicleState.Arrived) {
      vs.state[vehicle] = VehicleState.Parked;
      vs.posX[vehicle] = truck.homeX;
      vs.posZ[vehicle] = truck.homeZ;
      hold(vs, vehicle);
      setVehicleHazard(vs, vehicle, false);
      truck.phase = 'idle';
    }
  }
}

declare module '../traffic/LogisticsSystem' {
  interface LogisticsSystem {
    readonly fuelTruckCount: number;
    fuelTruckPhase(id: number): string;
    fuelTruckCargo(id: number): number;
  }
}

const proto = LogisticsSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimLifelineFuelLogisticsV1015) {
  const previousUpdate = proto.update as AnyMethod;
  proto.update = function updateWithLifelineFuel(this: AnyLogistics, dt: number): void {
    previousUpdate.call(this, dt);
    updateFuelFleet(this, dt);
  };

  Object.defineProperty(proto, 'fuelTruckCount', {
    configurable: true,
    get(this: LogisticsSystem): number { return runtimeBySystem.get(this)?.trucks.length ?? 0; },
  });
  proto.fuelTruckPhase = function fuelTruckPhase(this: LogisticsSystem, id: number): string {
    return runtimeBySystem.get(this)?.trucks[id]?.phase ?? 'unavailable';
  };
  proto.fuelTruckCargo = function fuelTruckCargo(this: LogisticsSystem, id: number): number {
    return runtimeBySystem.get(this)?.trucks[id]?.cargo ?? 0;
  };

  proto.__citySimLifelineFuelLogisticsV1015 = true;
}
