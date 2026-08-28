import { AgentState, type AgentStore } from '../agents/AgentStore';
import { UtilityBrain } from '../agents/UtilityBrain';
import { VehicleState, type VehicleStore } from '../traffic/VehicleStore';
import { TrafficSystem } from '../traffic/TrafficSystem';
import { POICategory } from './POI';
import { World } from './World';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

interface IdQueue {
  ids: number[];
  head: number;
  queued: Uint8Array;
}
interface WorldAuditState {
  routingCursor: number;
  arrivalCursor: number;
}
interface EdgeTransition {
  vehicle: number;
  fromEdge: number;
  toEdge: number;
}
interface TrafficActiveState {
  initialized: boolean;
  transitions: EdgeTransition[];
}
interface PackedVehicleView {
  count: number;
  state: Uint8Array;
  edge: Int32Array;
  length: Float32Array;
  segT: Float32Array;
  segLen: Float32Array;
  toNode: Int32Array;
  fromNode: Int32Array;
}

const ROUTING_AUDIT_PER_STEP = 2_048;
const ARRIVAL_AUDIT_PER_STEP = 512;

const routingQueues = new WeakMap<AgentStore, IdQueue>();
const arrivalQueues = new WeakMap<TrafficSystem, IdQueue>();
const newlyDrivingQueues = new WeakMap<TrafficSystem, IdQueue>();
const auditByWorld = new WeakMap<World, WorldAuditState>();
const activeTrafficStates = new WeakMap<TrafficSystem, TrafficActiveState>();
const packedVehiclesByWorld = new WeakMap<World, PackedVehicleView>();

function queueFor<T extends { capacity: number }>(map: WeakMap<object, IdQueue>, owner: object, store: T): IdQueue {
  let queue = map.get(owner);
  if (!queue || queue.queued.length !== store.capacity) {
    queue = { ids: [], head: 0, queued: new Uint8Array(store.capacity) };
    map.set(owner, queue);
  }
  return queue;
}

function enqueue(queue: IdQueue, id: number): void {
  if (id < 0 || id >= queue.queued.length || queue.queued[id]) return;
  queue.queued[id] = 1;
  queue.ids.push(id);
}

function drain(queue: IdQueue, visit: (id: number) => void, limit = Number.POSITIVE_INFINITY): number {
  let processed = 0;
  while (queue.head < queue.ids.length && processed < limit) {
    const id = queue.ids[queue.head++];
    queue.queued[id] = 0;
    visit(id);
    processed++;
  }
  if (queue.head >= queue.ids.length) {
    queue.ids.length = 0;
    queue.head = 0;
  } else if (queue.head > 1_024 && queue.head * 2 > queue.ids.length) {
    queue.ids = queue.ids.slice(queue.head);
    queue.head = 0;
  }
  return processed;
}

function auditState(world: World): WorldAuditState {
  let state = auditByWorld.get(world);
  if (!state) {
    state = { routingCursor: 0, arrivalCursor: 0 };
    auditByWorld.set(world, state);
  }
  return state;
}

function routingQueue(store: AgentStore): IdQueue {
  return queueFor(routingQueues as WeakMap<object, IdQueue>, store, store);
}

function arrivalQueue(traffic: TrafficSystem, vehicles: VehicleStore): IdQueue {
  return queueFor(arrivalQueues as WeakMap<object, IdQueue>, traffic, vehicles);
}

function newlyDrivingQueue(traffic: TrafficSystem, vehicles: VehicleStore): IdQueue {
  return queueFor(newlyDrivingQueues as WeakMap<object, IdQueue>, traffic, vehicles);
}

function trafficActiveState(traffic: TrafficSystem): TrafficActiveState {
  let state = activeTrafficStates.get(traffic);
  if (!state) { state = { initialized: false, transitions: [] }; activeTrafficStates.set(traffic, state); }
  return state;
}

function recordEdgeTransition(traffic: TrafficSystem, vehicle: number, fromEdge: number, toEdge: number): void {
  if (fromEdge === toEdge) return;
  trafficActiveState(traffic).transitions.push({ vehicle, fromEdge, toEdge });
}

function insertByProgress(occupants: number[], vehicle: number, segT: Float32Array): void {
  const t = segT[vehicle];
  let lo = 0, hi = occupants.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segT[occupants[mid]] <= t) lo = mid + 1;
    else hi = mid;
  }
  occupants.splice(lo, 0, vehicle);
}

function installRoutingActiveSet(): void {
  const brainProto = UtilityBrain.prototype as unknown as AnyHost;
  if (!brainProto.__machiSimRoutingQueueV117) {
    const previousApply = brainProto.applyTarget as AnyMethod | undefined;
    if (typeof previousApply === 'function') {
      brainProto.applyTarget = function queuedApplyTarget(this: UtilityBrain, store: AgentStore, agent: number, target: number): boolean {
        const ok = Boolean(previousApply.call(this, store, agent, target));
        if (ok && store.state[agent] === AgentState.Routing) enqueue(routingQueue(store), agent);
        return ok;
      };
    }
    brainProto.__machiSimRoutingQueueV117 = true;
  }

  const worldProto = World.prototype as unknown as AnyHost;
  if (worldProto.__machiSimRoutingActiveSetV117) return;
  const fallback = worldProto.processRoutingBudget as AnyMethod | undefined;
  if (typeof fallback !== 'function') return;

  worldProto.processRoutingBudget = function activeRoutingBudget(this: World): void {
    const host = this as unknown as AnyHost;
    const store = this.store;
    const count = store.count;
    if (count <= 0) return;

    const budget = Math.max(1, Number(host.routingBudget) || 384);
    const queue = routingQueue(store);
    let processed = 0;
    processed += drain(queue, (agent) => {
      if (store.state[agent] === AgentState.Routing) {
        (host.beginTrip as (id: number) => void).call(this, agent);
      }
    }, budget);

    // Compatibility audit: direct state writes from sidecars/extensions are discovered incrementally.
    // Resident UtilityBrain transitions are event-enqueued and therefore avoid this scan entirely.
    if (processed < budget) {
      const state = auditState(this);
      const audit = Math.min(count, ROUTING_AUDIT_PER_STEP);
      for (let n = 0; n < audit; n++) {
        const agent = (state.routingCursor + n) % count;
        if (store.state[agent] === AgentState.Routing) enqueue(queue, agent);
      }
      state.routingCursor = (state.routingCursor + audit) % count;
      drain(queue, (agent) => {
        if (store.state[agent] === AgentState.Routing) {
          (host.beginTrip as (id: number) => void).call(this, agent);
        }
      }, budget - processed);
    }
  };
  worldProto.__machiSimRoutingActiveSetV117 = true;
}

function installTrafficTransitionQueues(): void {
  const proto = TrafficSystem.prototype as unknown as AnyHost;
  if (proto.__machiSimTrafficTransitionQueuesV117) return;

  const previousEnterEdge = proto.enterEdge as AnyMethod | undefined;
  if (typeof previousEnterEdge === 'function') {
    proto.enterEdge = function queuedEnterEdge(this: TrafficSystem, vehicle: number, from: number, to: number): void {
      const vehicles = (this as unknown as AnyHost).vs as VehicleStore | undefined;
      const wasDriving = !!vehicles && vehicles.state[vehicle] === VehicleState.Driving;
      const oldEdge = wasDriving && vehicles ? vehicles.edge[vehicle] : -1;
      previousEnterEdge.call(this, vehicle, from, to);
      if (vehicles) recordEdgeTransition(this, vehicle, oldEdge, vehicles.edge[vehicle]);
    };
  }

  const wrapDispatch = (name: string): void => {
    const previous = proto[name] as AnyMethod | undefined;
    if (typeof previous !== 'function') return;
    proto[name] = function queuedDispatch(this: TrafficSystem, vehicle: number, ...args: any[]): any {
      const host = this as unknown as AnyHost;
      const vehicles = host.vs as VehicleStore | undefined;
      const wasDriving = !!vehicles && vehicles.state[vehicle] === VehicleState.Driving;
      const oldEdge = wasDriving && vehicles ? vehicles.edge[vehicle] : -1;
      const transitionCount = trafficActiveState(this).transitions.length;
      const result = previous.call(this, vehicle, ...args);
      if (result && vehicles && vehicles.state[vehicle] === VehicleState.Driving) {
        enqueue(newlyDrivingQueue(this, vehicles), vehicle);
        if (trafficActiveState(this).transitions.length === transitionCount) {
          recordEdgeTransition(this, vehicle, oldEdge, vehicles.edge[vehicle]);
        }
      }
      return result;
    };
  };
  wrapDispatch('dispatch');
  wrapDispatch('dispatchToEdgePoint');
  wrapDispatch('dispatchFromCurrentToEdgePoint');

  const previousArrive = proto.arrive as AnyMethod | undefined;
  if (typeof previousArrive === 'function') {
    proto.arrive = function queuedArrival(this: TrafficSystem, vehicle: number, t: number): void {
      const vehicles = (this as unknown as AnyHost).vs as VehicleStore | undefined;
      const oldEdge = vehicles && vehicles.state[vehicle] === VehicleState.Driving ? vehicles.edge[vehicle] : -1;
      previousArrive.call(this, vehicle, t);
      if (!vehicles) return;
      recordEdgeTransition(this, vehicle, oldEdge, -1);
      if (vehicles.state[vehicle] !== VehicleState.Arrived || vehicles.isBus[vehicle] || vehicles.isTruck[vehicle]) return;
      enqueue(arrivalQueue(this, vehicles), vehicle);
    };
  }

  const previousPlace = proto.placeAtEdgePoint as AnyMethod | undefined;
  if (typeof previousPlace === 'function') {
    proto.placeAtEdgePoint = function queuedPlaceAtEdgePoint(this: TrafficSystem, vehicle: number, ...args: any[]): boolean {
      const vehicles = (this as unknown as AnyHost).vs as VehicleStore | undefined;
      const wasDriving = !!vehicles && vehicles.state[vehicle] === VehicleState.Driving;
      const oldEdge = wasDriving && vehicles ? vehicles.edge[vehicle] : -1;
      const ok = Boolean(previousPlace.call(this, vehicle, ...args));
      if (ok && vehicles) {
        if (wasDriving) recordEdgeTransition(this, vehicle, oldEdge, -1);
        if (vehicles.state[vehicle] === VehicleState.Arrived && !vehicles.isBus[vehicle] && !vehicles.isTruck[vehicle]) {
          enqueue(arrivalQueue(this, vehicles), vehicle);
        }
      }
      return ok;
    };
  }

  proto.__machiSimTrafficTransitionQueuesV117 = true;
}

function installEventDrivenTrafficOccupancy(): void {
  const proto = TrafficSystem.prototype as unknown as AnyHost;
  if (proto.__machiSimEventDrivenOccupancyV117) return;
  const fallback = proto.rebuildOccupants as AnyMethod | undefined;
  if (typeof fallback !== 'function') return;

  proto.rebuildOccupants = function eventDrivenOccupants(this: TrafficSystem): void {
    const host = this as unknown as AnyHost;
    const vehicles = host.vs as VehicleStore | undefined;
    const edges = host.net?.edges as Array<{ occupants: number[] }> | undefined;
    const activeEdges = host.activeEdges as number[] | undefined;
    const edgeSeen = host.edgeSeen as Uint8Array | undefined;
    if (!vehicles || !edges || !activeEdges || !edgeSeen) { fallback.call(this); return; }

    const state = trafficActiveState(this);
    if (!state.initialized) {
      for (let i = 0; i < activeEdges.length; i++) { const edge = activeEdges[i]; edges[edge].occupants.length = 0; edgeSeen[edge] = 0; }
      activeEdges.length = 0;
      for (let vehicle = 0; vehicle < vehicles.count; vehicle++) {
        if (vehicles.state[vehicle] !== VehicleState.Driving) continue;
        const edge = vehicles.edge[vehicle]; if (edge < 0 || !edges[edge]) continue;
        if (edgeSeen[edge] === 0) { edgeSeen[edge] = 1; activeEdges.push(edge); }
        edges[edge].occupants.push(vehicle);
      }
      for (let i = 0; i < activeEdges.length; i++) {
        const occupants = edges[activeEdges[i]].occupants;
        if (occupants.length > 1) occupants.sort((a, b) => vehicles.segT[a] - vehicles.segT[b]);
      }
      state.transitions.length = 0;
      state.initialized = true;
      return;
    }

    const transitions = state.transitions;
    // Remove old memberships first so edgeSeen can be compacted before any re-additions.
    for (let i = 0; i < transitions.length; i++) {
      const { vehicle, fromEdge } = transitions[i];
      if (fromEdge < 0 || !edges[fromEdge]) continue;
      const occupants = edges[fromEdge].occupants;
      const at = occupants.indexOf(vehicle);
      if (at >= 0) occupants.splice(at, 1);
      if (occupants.length === 0) edgeSeen[fromEdge] = 0;
    }
    let write = 0;
    for (let i = 0; i < activeEdges.length; i++) {
      const edge = activeEdges[i];
      if (edgeSeen[edge] !== 0 && edges[edge].occupants.length > 0) activeEdges[write++] = edge;
      else edgeSeen[edge] = 0;
    }
    activeEdges.length = write;

    for (let i = 0; i < transitions.length; i++) {
      const { vehicle, toEdge } = transitions[i];
      if (toEdge < 0 || !edges[toEdge] || vehicles.state[vehicle] !== VehicleState.Driving || vehicles.edge[vehicle] !== toEdge) continue;
      if (edgeSeen[toEdge] === 0) { edgeSeen[toEdge] = 1; activeEdges.push(toEdge); }
      const occupants = edges[toEdge].occupants;
      if (occupants.indexOf(vehicle) < 0) insertByProgress(occupants, vehicle, vehicles.segT);
    }
    transitions.length = 0;

    // Vehicles do not intentionally overtake on one directed edge; preserve order and only sort on a detected inversion.
    for (let i = 0; i < activeEdges.length; i++) {
      const occupants = edges[activeEdges[i]].occupants;
      let inverted = false;
      for (let k = 1; k < occupants.length; k++) {
        if (vehicles.segT[occupants[k - 1]] > vehicles.segT[occupants[k]]) { inverted = true; break; }
      }
      if (inverted) occupants.sort((a, b) => vehicles.segT[a] - vehicles.segT[b]);
    }
  };
  proto.__machiSimEventDrivenOccupancyV117 = true;
}

function parkArrivedVehicle(world: World, vehicle: number): void {
  const host = world as unknown as AnyHost;
  const vehicles = world.vehicles;
  const store = world.store;
  if (vehicle < 0 || vehicle >= vehicles.count) return;
  if (vehicles.state[vehicle] !== VehicleState.Arrived || vehicles.isBus[vehicle] || vehicles.isTruck[vehicle]) return;

  const driver = vehicles.driver[vehicle];
  let lotId = driver >= 0 ? store.destParkPOI[driver] : -1;
  let slot = driver >= 0 ? store.destParkSlot[driver] : -1;
  if (lotId < 0) {
    lotId = world.city.poi.findNearestFree(POICategory.Parking, vehicles.posX[vehicle], vehicles.posZ[vehicle]);
    if (lotId >= 0) {
      world.city.poi.reserve(lotId);
      slot = world.city.takeSlot(lotId);
    }
  }

  vehicles.state[vehicle] = VehicleState.Parked;
  vehicles.parkPOI[vehicle] = lotId;
  vehicles.parkSlot[vehicle] = slot;
  vehicles.speed[vehicle] = 0;
  if (lotId >= 0) {
    const px = slot >= 0 ? world.city.slotX(lotId, slot) : world.city.poi.get(lotId).x;
    const pz = slot >= 0 ? world.city.slotZ(lotId, slot) : world.city.poi.get(lotId).z;
    vehicles.posX[vehicle] = px;
    vehicles.posZ[vehicle] = pz;
    vehicles.heading[vehicle] = 0;
  }
  if (driver >= 0) {
    store.posX[driver] = vehicles.posX[vehicle];
    store.posZ[driver] = vehicles.posZ[vehicle];
    store.destParkPOI[driver] = -1;
    store.destParkSlot[driver] = -1;
    (host.assignWalkPath as (agent: number, x: number, z: number) => void).call(world, driver, store.goalX[driver], store.goalZ[driver]);
    store.state[driver] = AgentState.Traveling;
  }
}

function installArrivalActiveSet(): void {
  const proto = World.prototype as unknown as AnyHost;
  if (proto.__machiSimArrivalActiveSetV117) return;
  const fallback = proto.handleArrivedVehicles as AnyMethod | undefined;
  if (typeof fallback !== 'function') return;

  proto.handleArrivedVehicles = function activeArrivals(this: World): void {
    const traffic = this.traffic;
    const vehicles = this.vehicles;
    const queue = arrivalQueue(traffic, vehicles);
    drain(queue, (vehicle) => parkArrivedVehicle(this, vehicle));

    // Slow compatibility audit catches any extension that writes VehicleState.Arrived directly.
    const count = vehicles.count;
    if (count <= 0) return;
    const state = auditState(this);
    const audit = Math.min(count, ARRIVAL_AUDIT_PER_STEP);
    for (let n = 0; n < audit; n++) {
      const vehicle = (state.arrivalCursor + n) % count;
      if (vehicles.state[vehicle] === VehicleState.Arrived && !vehicles.isBus[vehicle] && !vehicles.isTruck[vehicle]) {
        parkArrivedVehicle(this, vehicle);
      }
    }
    state.arrivalCursor = (state.arrivalCursor + audit) % count;
  };
  proto.__machiSimArrivalActiveSetV117 = true;
}

function packedVehicleView(world: World): PackedVehicleView {
  let packed = packedVehiclesByWorld.get(world);
  if (packed && packed.state.length === world.vehicles.capacity) return packed;
  const capacity = world.vehicles.capacity;
  packed = {
    count: 0,
    state: new Uint8Array(capacity),
    edge: new Int32Array(capacity),
    length: new Float32Array(capacity),
    segT: new Float32Array(capacity),
    segLen: new Float32Array(capacity),
    toNode: new Int32Array(capacity),
    fromNode: new Int32Array(capacity),
  };
  packedVehiclesByWorld.set(world, packed);
  return packed;
}

function appendPackedVehicle(packed: PackedVehicleView, vehicles: VehicleStore, vehicle: number): void {
  if (vehicle < 0 || vehicle >= vehicles.count || vehicles.state[vehicle] !== VehicleState.Driving || packed.count >= packed.state.length) return;
  const i = packed.count++;
  packed.state[i] = VehicleState.Driving;
  packed.edge[i] = vehicles.edge[vehicle];
  packed.length[i] = vehicles.length[vehicle];
  packed.segT[i] = vehicles.segT[vehicle];
  packed.segLen[i] = vehicles.segLen[vehicle];
  packed.toNode[i] = vehicles.toNode[vehicle];
  packed.fromNode[i] = vehicles.fromNode[vehicle];
}

function installPedBlockActiveVehicles(): void {
  const proto = World.prototype as unknown as AnyHost;
  if (proto.__machiSimPedBlockActiveVehiclesV117) return;
  const previous = proto.computePedBlocks as AnyMethod | undefined;
  if (typeof previous !== 'function') return;

  proto.computePedBlocks = function activeVehiclePedBlocks(this: World): void {
    const trafficHost = this.traffic as unknown as AnyHost;
    const activeEdges = trafficHost.activeEdges as number[] | undefined;
    if (!activeEdges) { previous.call(this); return; }

    const packed = packedVehicleView(this);
    packed.count = 0;
    const edges = this.city.net.edges;
    for (let i = 0; i < activeEdges.length; i++) {
      const occupants = edges[activeEdges[i]]?.occupants;
      if (!occupants) continue;
      for (let k = 0; k < occupants.length; k++) appendPackedVehicle(packed, this.vehicles, occupants[k]);
    }
    drain(newlyDrivingQueue(this.traffic, this.vehicles), (vehicle) => appendPackedVehicle(packed, this.vehicles, vehicle));

    // Preserve the crossing-safety implementation exactly, but feed it a dense view containing
    // only driving vehicles instead of forcing its `for (v < vs.count)` loop over every parked car.
    const host = this as unknown as AnyHost;
    const realVehicles = host.vehicles;
    host.vehicles = packed;
    try { previous.call(this); }
    finally { host.vehicles = realVehicles; }
  };
  proto.__machiSimPedBlockActiveVehiclesV117 = true;
}

installRoutingActiveSet();
installTrafficTransitionQueues();
installEventDrivenTrafficOccupancy();
installArrivalActiveSet();
installPedBlockActiveVehicles();