import type { AgentStore } from '../agents/AgentStore';
import type { CityGenerator } from '../generation/CityGenerator';
import { FacilityType } from '../generation/SpecialFacilityPlanner';
import type { SimulationClock } from '../core/SimulationClock';
import { RoadClass } from './RoadNetwork';
import type { TrafficSystem } from './TrafficSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';

export type TaxiPhase = 'idle' | 'to-pickup' | 'occupied';

export interface TaxiVehicleInfo {
  taxiId: number;
  vehicle: number;
  phase: TaxiPhase;
  passenger: number;
  requestedAt: number;
  tripDistance: number;
}

export interface TaxiPassengerInfo {
  taxiId: number;
  vehicle: number;
  phase: 'waiting' | 'onboard';
  requestedAt: number;
  tripDistance: number;
}

interface TaxiRecord {
  id: number;
  vehicle: number;
  phase: TaxiPhase;
  passenger: number;
  requestedAt: number;
  pickupX: number;
  pickupZ: number;
  destinationX: number;
  destinationZ: number;
  tripDistance: number;
}

type DropoffHandler = (agent: number, x: number, z: number) => void;
type CancelHandler = (agent: number) => void;

const taxiByVehicles = new WeakMap<VehicleStore, TaxiSystem>();
const taxiByStore = new WeakMap<AgentStore, TaxiSystem>();

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

export class TaxiSystem {
  private readonly taxis: TaxiRecord[] = [];
  readonly agentTaxi: Int32Array;
  private readonly vehicleTaxi: Int32Array;
  private built = false;

  constructor(
    private readonly store: AgentStore,
    private readonly vehicles: VehicleStore,
    private readonly traffic: TrafficSystem,
    private readonly city: CityGenerator,
    private readonly clock: SimulationClock,
  ) {
    this.agentTaxi = new Int32Array(store.capacity);
    this.agentTaxi.fill(-1);
    this.vehicleTaxi = new Int32Array(vehicles.capacity);
    this.vehicleTaxi.fill(-1);
    taxiByVehicles.set(vehicles, this);
    taxiByStore.set(store, this);
  }

  buildFleet(population: number): void {
    if (this.built) return;
    this.built = true;
    const available = Math.max(0, this.vehicles.capacity - this.vehicles.count);
    const target = Math.min(available, Math.max(18, Math.min(120, Math.round(population / 800))));
    if (target <= 0 || this.city.net.nodes.length === 0) return;

    const preferred: number[] = [];
    const seen = new Set<number>();
    const pushNode = (node: number): void => {
      if (node < 0 || node >= this.city.net.nodes.length || seen.has(node)) return;
      seen.add(node); preferred.push(node);
    };

    for (const station of this.city.planning.rail.stations) {
      pushNode(station.roadNode >= 0 ? station.roadNode : this.city.net.nearestNode(station.x, station.z));
    }
    for (const facility of this.city.facilities) {
      if (facility.type === FacilityType.Hotel) pushNode(this.city.net.nearestNode(facility.x, facility.z));
    }
    pushNode(this.city.net.nearestNode(this.city.planning.cbd.x, this.city.planning.cbd.z));
    for (const center of this.city.planning.subCenters) pushNode(this.city.net.nearestNode(center.x, center.z));

    const roadCandidates = this.city.net.nodes
      .filter((node) => node.edges.some((eid) => {
        const cls = this.city.net.edges[eid]?.roadClass;
        return cls === RoadClass.Arterial || cls === RoadClass.Collector;
      }))
      .map((node) => ({ id: node.id, rank: hash01(node.id * 4099 + this.city.sizeMeters * 17) }))
      .sort((a, b) => a.rank - b.rank);
    for (const item of roadCandidates) pushNode(item.id);

    if (preferred.length === 0) return;
    for (let i = 0; i < target; i++) {
      const nodeId = preferred[Math.floor(i * preferred.length / target) % preferred.length];
      const node = this.city.net.nodes[nodeId];
      const vehicle = this.vehicles.create(-1, -1, node.x, node.z);
      if (vehicle < 0) break;
      this.vehicles.colorIdx[vehicle] = (i & 1) === 0 ? 3 : 2;
      this.vehicles.length[vehicle] = 4.65;
      this.vehicles.aMax[vehicle] = 1.65;
      this.vehicles.bComf[vehicle] = 2.35;
      this.vehicles.t0[vehicle] = 1.25;
      const taxiId = this.taxis.length;
      this.vehicleTaxi[vehicle] = taxiId;
      this.taxis.push({
        id: taxiId,
        vehicle,
        phase: 'idle',
        passenger: -1,
        requestedAt: 0,
        pickupX: node.x,
        pickupZ: node.z,
        destinationX: node.x,
        destinationZ: node.z,
        tripDistance: 0,
      });
    }
    console.info('[City-Sim] taxi fleet', { taxis: this.taxis.length, population });
  }

  request(agent: number, pickupX: number, pickupZ: number, destinationX: number, destinationZ: number): boolean {
    if (agent < 0 || agent >= this.store.count || this.agentTaxi[agent] >= 0) return false;
    const taxi = this.nearestIdleTaxi(pickupX, pickupZ);
    if (!taxi) return false;

    taxi.phase = 'to-pickup';
    taxi.passenger = agent;
    taxi.requestedAt = this.clock.totalSeconds;
    taxi.pickupX = pickupX;
    taxi.pickupZ = pickupZ;
    taxi.destinationX = destinationX;
    taxi.destinationZ = destinationZ;
    taxi.tripDistance = Math.hypot(destinationX - pickupX, destinationZ - pickupZ);
    this.agentTaxi[agent] = taxi.id;

    const v = taxi.vehicle;
    const distanceToTaxi = Math.hypot(this.vehicles.posX[v] - pickupX, this.vehicles.posZ[v] - pickupZ);
    if (distanceToTaxi < 45) {
      if (this.boardPassenger(taxi)) return true;
      this.resetTaxi(taxi);
      return false;
    }
    if (this.traffic.dispatch(v, this.vehicles.posX[v], this.vehicles.posZ[v], pickupX, pickupZ)) return true;

    this.resetTaxi(taxi);
    return false;
  }

  update(dropoff: DropoffHandler, cancel: CancelHandler): void {
    const now = this.clock.totalSeconds;
    for (const taxi of this.taxis) {
      const v = taxi.vehicle;
      if (taxi.phase === 'idle') continue;
      if (taxi.passenger < 0 || taxi.passenger >= this.store.count) {
        this.resetTaxi(taxi);
        continue;
      }

      if (taxi.phase === 'to-pickup') {
        if (now - taxi.requestedAt > 20 * 60) {
          const passenger = taxi.passenger;
          this.vehicles.state[v] = VehicleState.Parked;
          this.resetTaxi(taxi);
          cancel(passenger);
          continue;
        }
        if (this.vehicles.state[v] === VehicleState.Arrived || this.vehicles.state[v] === VehicleState.Parked) {
          if (!this.boardPassenger(taxi)) {
            const passenger = taxi.passenger;
            this.resetTaxi(taxi);
            cancel(passenger);
          }
        }
        continue;
      }

      const passenger = taxi.passenger;
      this.store.posX[passenger] = this.vehicles.posX[v];
      this.store.posZ[passenger] = this.vehicles.posZ[v];
      this.store.velX[passenger] = 0;
      this.store.velZ[passenger] = 0;
      this.store.heading[passenger] = this.vehicles.heading[v];

      if (this.vehicles.state[v] === VehicleState.Arrived) {
        const x = this.vehicles.posX[v], z = this.vehicles.posZ[v];
        this.vehicles.state[v] = VehicleState.Parked;
        this.agentTaxi[passenger] = -1;
        taxi.phase = 'idle';
        taxi.passenger = -1;
        taxi.requestedAt = 0;
        dropoff(passenger, x, z);
      }
    }
  }

  forEachPassenger(fn: (agent: number, phase: 'waiting' | 'onboard') => void): void {
    for (const taxi of this.taxis) {
      if (taxi.passenger < 0) continue;
      fn(taxi.passenger, taxi.phase === 'occupied' ? 'onboard' : 'waiting');
    }
  }

  forEachVehicle(fn: (info: TaxiVehicleInfo) => void): void {
    for (const taxi of this.taxis) fn(this.snapshot(taxi));
  }

  vehicleInfo(vehicle: number): TaxiVehicleInfo | null {
    if (vehicle < 0 || vehicle >= this.vehicleTaxi.length) return null;
    const taxiId = this.vehicleTaxi[vehicle];
    if (taxiId < 0 || taxiId >= this.taxis.length) return null;
    return this.snapshot(this.taxis[taxiId]);
  }

  passengerInfo(agent: number): TaxiPassengerInfo | null {
    if (agent < 0 || agent >= this.agentTaxi.length) return null;
    const taxiId = this.agentTaxi[agent];
    if (taxiId < 0 || taxiId >= this.taxis.length) return null;
    const taxi = this.taxis[taxiId];
    return {
      taxiId,
      vehicle: taxi.vehicle,
      phase: taxi.phase === 'occupied' ? 'onboard' : 'waiting',
      requestedAt: taxi.requestedAt,
      tripDistance: taxi.tripDistance,
    };
  }

  private snapshot(taxi: TaxiRecord): TaxiVehicleInfo {
    return {
      taxiId: taxi.id,
      vehicle: taxi.vehicle,
      phase: taxi.phase,
      passenger: taxi.passenger,
      requestedAt: taxi.requestedAt,
      tripDistance: taxi.tripDistance,
    };
  }

  private nearestIdleTaxi(x: number, z: number): TaxiRecord | null {
    let best: TaxiRecord | null = null;
    let bestD2 = 2500 * 2500;
    for (const taxi of this.taxis) {
      if (taxi.phase !== 'idle') continue;
      const v = taxi.vehicle;
      if (this.vehicles.state[v] !== VehicleState.Parked && this.vehicles.state[v] !== VehicleState.Arrived) continue;
      const dx = this.vehicles.posX[v] - x, dz = this.vehicles.posZ[v] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      best = taxi;
      bestD2 = d2;
    }
    return best;
  }

  private boardPassenger(taxi: TaxiRecord): boolean {
    const passenger = taxi.passenger;
    if (passenger < 0) return false;
    taxi.phase = 'occupied';
    this.store.posX[passenger] = this.vehicles.posX[taxi.vehicle];
    this.store.posZ[passenger] = this.vehicles.posZ[taxi.vehicle];

    const dx = taxi.destinationX - this.vehicles.posX[taxi.vehicle];
    const dz = taxi.destinationZ - this.vehicles.posZ[taxi.vehicle];
    if (Math.hypot(dx, dz) < 45) {
      this.vehicles.state[taxi.vehicle] = VehicleState.Arrived;
      return true;
    }
    if (this.traffic.dispatch(
      taxi.vehicle,
      this.vehicles.posX[taxi.vehicle],
      this.vehicles.posZ[taxi.vehicle],
      taxi.destinationX,
      taxi.destinationZ,
    )) return true;

    taxi.phase = 'to-pickup';
    return false;
  }

  private resetTaxi(taxi: TaxiRecord): void {
    if (taxi.passenger >= 0 && taxi.passenger < this.agentTaxi.length) this.agentTaxi[taxi.passenger] = -1;
    taxi.phase = 'idle';
    taxi.passenger = -1;
    taxi.requestedAt = 0;
    taxi.tripDistance = 0;
    this.vehicles.state[taxi.vehicle] = VehicleState.Parked;
    this.vehicles.speed[taxi.vehicle] = 0;
    this.vehicles.accel[taxi.vehicle] = 0;
  }
}

export function taxiVehicleInfo(vehicles: VehicleStore, vehicle: number): TaxiVehicleInfo | null {
  return taxiByVehicles.get(vehicles)?.vehicleInfo(vehicle) ?? null;
}

export function taxiPassengerInfo(store: AgentStore, agent: number): TaxiPassengerInfo | null {
  return taxiByStore.get(store)?.passengerInfo(agent) ?? null;
}

export function forEachTaxiVehicle(vehicles: VehicleStore, fn: (info: TaxiVehicleInfo) => void): void {
  taxiByVehicles.get(vehicles)?.forEachVehicle(fn);
}
