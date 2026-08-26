import { LogisticsSystem } from './LogisticsSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';
import type { TrafficSystem } from './TrafficSystem';
import type { POIRegistry } from '../world/POI';
import {
  fleetDepotForNetwork,
  supplyChainForPoi,
  type FleetDepotRecord,
  type ProductionSiteRecord,
  type SupplyChainRuntime,
} from '../generation/RuralIndustryAndDepotTuning';
import { setVehicleHazard } from './VehicleSignalRuntime';

type Phase = 'idle' | 'toSource' | 'loading' | 'toDestination' | 'unloading' | 'returning';
type DestinationKind = 'site' | 'retail' | 'export';

interface FreightJob {
  stage: 0 | 1 | 2;
  amount: number;
  sourceSite: number;
  destinationKind: DestinationKind;
  destinationId: number;
  destinationX: number;
  destinationZ: number;
}

interface TruckRuntime {
  vehicle: number;
  phase: Phase;
  cargo: number;
  capacity: number;
  timer: number;
  job: FreightJob | null;
  homeX: number;
  homeZ: number;
}

interface LogisticsRuntime {
  chain: SupplyChainRuntime;
  depot: FleetDepotRecord;
  trucks: TruckRuntime[];
  retailReserved: Map<number, number>;
  dispatchCursor: number;
}

type AnyLogistics = any;
type AnyMethod = (...args: any[]) => any;

const runtimeBySystem = new WeakMap<LogisticsSystem, LogisticsRuntime>();
const LOAD_SECONDS = 5;
const UNLOAD_SECONDS = 6;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function slot(depot: FleetDepotRecord, index: number): { x: number; z: number } {
  const n = Math.max(1, depot.slotX.length), i = index % n;
  return { x: depot.slotX[i] ?? depot.x, z: depot.slotZ[i] ?? depot.z };
}

function updateProduction(chain: SupplyChainRuntime, dt: number): void {
  for (const site of chain.sites) {
    const room = Math.max(0, site.outputCapacity - site.outputStock);
    if (room <= 0) continue;
    if (site.inputStage < 0) {
      site.outputStock += Math.min(room, site.processRate * dt);
      continue;
    }
    if (site.inputStock <= 0) continue;
    const consumed = Math.min(site.inputStock, room / 0.92, site.processRate * dt);
    site.inputStock -= consumed;
    site.outputStock += consumed * 0.92;
  }
}

function siteDistance(a: ProductionSiteRecord, b: ProductionSiteRecord): number {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}

function chooseFactoryDestination(chain: SupplyChainRuntime, source: ProductionSiteRecord, stage: 0 | 1): ProductionSiteRecord | null {
  let best: ProductionSiteRecord | null = null, bestScore = Infinity;
  for (const site of chain.sites) {
    if (site.inputStage !== stage || site.id === source.id) continue;
    const available = site.inputCapacity - site.inputStock - site.reservedInput;
    if (available < 40) continue;
    const fill = (site.inputStock + site.reservedInput) / Math.max(1, site.inputCapacity);
    const score = siteDistance(source, site) * (0.65 + fill * 0.75);
    if (score < bestScore) { best = site; bestScore = score; }
  }
  return best;
}

function releaseJobReservation(rt: LogisticsRuntime, job: FreightJob): void {
  if (job.destinationKind === 'site') {
    const dest = rt.chain.sites[job.destinationId];
    if (dest) dest.reservedInput = Math.max(0, dest.reservedInput - job.amount);
  } else if (job.destinationKind === 'retail') {
    const value = Math.max(0, (rt.retailReserved.get(job.destinationId) ?? 0) - job.amount);
    if (value <= 0) rt.retailReserved.delete(job.destinationId); else rt.retailReserved.set(job.destinationId, value);
  }
}

function reserveJob(rt: LogisticsRuntime, capacity: number, poi: POIRegistry): FreightJob | null {
  const sources = rt.chain.sites
    .filter((site) => site.outputStock >= 40)
    .sort((a, b) => (b.outputStock / Math.max(1, b.outputCapacity)) - (a.outputStock / Math.max(1, a.outputCapacity)));
  if (sources.length === 0) return null;

  const start = rt.dispatchCursor++ % sources.length;
  for (let offset = 0; offset < sources.length; offset++) {
    const source = sources[(start + offset) % sources.length];
    const stage = source.outputStage;
    const baseAmount = Math.min(capacity, source.outputStock);
    if (baseAmount < 40) continue;

    if (stage < 2) {
      const dest = chooseFactoryDestination(rt.chain, source, stage as 0 | 1);
      if (!dest) continue;
      const room = dest.inputCapacity - dest.inputStock - dest.reservedInput;
      const amount = Math.min(baseAmount, room);
      if (amount < 40) continue;
      source.outputStock -= amount;
      dest.reservedInput += amount;
      return { stage, amount, sourceSite: source.id, destinationKind: 'site', destinationId: dest.id, destinationX: dest.x, destinationZ: dest.z };
    }

    const preferExport = ((rt.dispatchCursor + source.id) % 5) < 2;
    if (!preferExport) {
      let best: { id: number; x: number; z: number; need: number } | null = null, bestScore = Infinity;
      for (const id of rt.chain.retailerPoiIds) {
        const p = poi.get(id); if (!p || p.capacity <= 0 || p.maxStock <= 0) continue;
        const reserved = rt.retailReserved.get(id) ?? 0, need = p.maxStock - p.stock - reserved;
        if (need < 30) continue;
        const d2 = (p.x - source.x) ** 2 + (p.z - source.z) ** 2;
        const score = d2 * (0.7 + (p.stock + reserved) / Math.max(1, p.maxStock));
        if (score < bestScore) { bestScore = score; best = { id, x: p.x, z: p.z, need }; }
      }
      if (best) {
        const amount = Math.min(baseAmount, best.need);
        if (amount >= 30) {
          source.outputStock -= amount;
          rt.retailReserved.set(best.id, (rt.retailReserved.get(best.id) ?? 0) + amount);
          return { stage: 2, amount, sourceSite: source.id, destinationKind: 'retail', destinationId: best.id, destinationX: best.x, destinationZ: best.z };
        }
      }
    }

    if (rt.chain.gateNodes.length > 0) {
      const gateId = rt.chain.gateNodes[(source.id + rt.dispatchCursor) % rt.chain.gateNodes.length];
      const net = (rt as any).net as any;
      const node = net?.nodes?.[gateId];
      if (node) {
        const amount = Math.min(baseAmount, capacity);
        source.outputStock -= amount;
        return { stage: 2, amount, sourceSite: source.id, destinationKind: 'export', destinationId: gateId, destinationX: node.x, destinationZ: node.z };
      }
    }
  }
  return null;
}

function dispatch(traffic: TrafficSystem, vs: VehicleStore, truck: TruckRuntime, x: number, z: number): boolean {
  return traffic.dispatch(truck.vehicle, vs.posX[truck.vehicle], vs.posZ[truck.vehicle], x, z);
}

function hold(vs: VehicleStore, vehicle: number): void {
  vs.speed[vehicle] = 0; vs.accel[vehicle] = 0;
}

const proto = LogisticsSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimIndustrialSupplyChainV076) {
  const previousBuild = proto.build as AnyMethod;
  const previousUpdate = proto.update as AnyMethod;
  const truckCountDescriptor = Object.getOwnPropertyDescriptor(proto, 'truckCount');
  const previousTruckPhase = proto.truckPhase as AnyMethod;
  const previousTruckCargo = proto.truckCargo as AnyMethod;
  const previousTruckCapacity = proto.truckCapacity as AnyMethod;

  proto.build = function buildIndustrialFleet(this: AnyLogistics, trucksPerGate = 2): void {
    const net = (this.traffic as any).net;
    const chain = supplyChainForPoi(this.poi);
    const depot = net ? fleetDepotForNetwork(net, 'freight') : null;
    if (!chain || !depot) { previousBuild.call(this, trucksPerGate); return; }

    const siteCount = chain.sites.length;
    const fleetSize = clamp(Math.ceil(siteCount / 3.5), 18, 72);
    const rt: LogisticsRuntime = { chain, depot, trucks: [], retailReserved: new Map(), dispatchCursor: 0 };
    (rt as any).poi = this.poi;
    (rt as any).net = net;
    runtimeBySystem.set(this, rt);
    const vs = this.vs as VehicleStore;
    for (let i = 0; i < fleetSize; i++) {
      const p = slot(depot, i), vehicle = vs.spawnTruck(i, p.x, p.z);
      if (vehicle < 0) break;
      rt.trucks.push({ vehicle, phase: 'idle', cargo: 0, capacity: 240, timer: 0, job: null, homeX: p.x, homeZ: p.z });
    }
  };

  proto.update = function updateIndustrialSupplyChain(this: AnyLogistics, dt: number): void {
    const rt = runtimeBySystem.get(this);
    if (!rt) { previousUpdate.call(this, dt); return; }
    const vs = this.vs as VehicleStore, traffic = this.traffic as TrafficSystem, poi = this.poi as POIRegistry;
    updateProduction(rt.chain, dt);

    for (const truck of rt.trucks) {
      const v = truck.vehicle;
      if (truck.phase === 'idle') {
        const job = reserveJob(rt, truck.capacity, poi);
        if (!job) continue;
        truck.job = job; truck.cargo = 0;
        const source = rt.chain.sites[job.sourceSite];
        if (!source || !dispatch(traffic, vs, truck, source.x, source.z)) {
          if (source) source.outputStock = Math.min(source.outputCapacity, source.outputStock + job.amount);
          releaseJobReservation(rt, job); truck.job = null; continue;
        }
        truck.phase = 'toSource';
        continue;
      }

      if (truck.phase === 'toSource') {
        if (vs.state[v] !== VehicleState.Arrived) continue;
        hold(vs, v); setVehicleHazard(vs, v, true); truck.timer = LOAD_SECONDS; truck.phase = 'loading';
        continue;
      }

      if (truck.phase === 'loading') {
        hold(vs, v); truck.timer -= dt; if (truck.timer > 0) continue;
        const job = truck.job; if (!job) { truck.phase = 'returning'; continue; }
        truck.cargo = job.amount; setVehicleHazard(vs, v, false);
        if (!dispatch(traffic, vs, truck, job.destinationX, job.destinationZ)) {
          const source = rt.chain.sites[job.sourceSite]; if (source) source.outputStock = Math.min(source.outputCapacity, source.outputStock + job.amount);
          releaseJobReservation(rt, job); truck.cargo = 0; truck.job = null;
          if (!dispatch(traffic, vs, truck, truck.homeX, truck.homeZ)) { vs.state[v] = VehicleState.Arrived; }
          truck.phase = 'returning';
        } else truck.phase = 'toDestination';
        continue;
      }

      if (truck.phase === 'toDestination') {
        if (vs.state[v] !== VehicleState.Arrived) continue;
        hold(vs, v); setVehicleHazard(vs, v, true); truck.timer = UNLOAD_SECONDS; truck.phase = 'unloading';
        continue;
      }

      if (truck.phase === 'unloading') {
        hold(vs, v); truck.timer -= dt; if (truck.timer > 0) continue;
        const job = truck.job;
        if (job) {
          if (job.destinationKind === 'site') {
            const dest = rt.chain.sites[job.destinationId];
            if (dest) {
              dest.reservedInput = Math.max(0, dest.reservedInput - job.amount);
              dest.inputStock = Math.min(dest.inputCapacity, dest.inputStock + job.amount);
            }
          } else if (job.destinationKind === 'retail') {
            const p = poi.get(job.destinationId);
            if (p) p.stock = Math.min(p.maxStock, p.stock + job.amount);
            releaseJobReservation(rt, job);
          } else {
            rt.chain.exportedUnits += job.amount;
          }
        }
        truck.cargo = 0; truck.job = null; setVehicleHazard(vs, v, false);
        if (!dispatch(traffic, vs, truck, truck.homeX, truck.homeZ)) vs.state[v] = VehicleState.Arrived;
        truck.phase = 'returning';
        continue;
      }

      if (truck.phase === 'returning' && vs.state[v] === VehicleState.Arrived) {
        vs.state[v] = VehicleState.Parked; hold(vs, v); vs.posX[v] = truck.homeX; vs.posZ[v] = truck.homeZ;
        setVehicleHazard(vs, v, false); truck.phase = 'idle';
      }
    }
  };

  Object.defineProperty(proto, 'truckCount', {
    configurable: true,
    get(this: LogisticsSystem): number {
      return runtimeBySystem.get(this)?.trucks.length ?? truckCountDescriptor?.get?.call(this) ?? 0;
    },
  });

  proto.truckPhase = function truckPhaseIndustrial(this: LogisticsSystem, id: number): string {
    return runtimeBySystem.get(this)?.trucks[id]?.phase ?? previousTruckPhase.call(this, id);
  };
  proto.truckCargo = function truckCargoIndustrial(this: LogisticsSystem, id: number): number {
    return runtimeBySystem.get(this)?.trucks[id]?.cargo ?? previousTruckCargo.call(this, id);
  };
  proto.truckCapacity = function truckCapacityIndustrial(this: LogisticsSystem, id: number): number {
    return runtimeBySystem.get(this)?.trucks[id]?.capacity ?? previousTruckCapacity.call(this, id);
  };

  proto.__citySimIndustrialSupplyChainV076 = true;
}
