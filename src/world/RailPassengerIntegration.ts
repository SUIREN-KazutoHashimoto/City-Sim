import { AgentState, Occupation } from '../agents/AgentStore';
import type { RailLine, RailNetworkPlan, RailStation } from '../generation/RailPlanning';
import { VehicleState } from '../traffic/VehicleStore';
import { POICategory } from './POI';
import { World } from './World';
import '../rendering/RailPassengerBridge';
import { EnhancedRenderer } from '../rendering/EnhancedRenderer';
import type { RailBoardingTrainSnapshot, RailPassengerTrainPosition } from '../rendering/RailPassengerBridge';

export interface RailTransitProvider {
  boardingTrains(): RailBoardingTrainSnapshot[];
  passengerTrainPosition(id: number): RailPassengerTrainPosition | null;
}

declare module './World' {
  interface World {
    attachRailTransit(provider: RailTransitProvider): void;
    railPassengerCount(): number;
  }
}

type AnyWorld = any;
type PassengerData = {
  provider: RailTransitProvider | null;
  boardStation: Int32Array;
  alightStation: Int32Array;
  line: Int32Array;
  nextLine: Int32Array;
  finalStation: Int32Array;
  train: Int32Array;
};
type RailTripPlan = {
  boardStation: number;
  firstAlightStation: number;
  firstLine: number;
  transferLine: number;
  finalStation: number;
  seconds: number;
};

const dataByWorld = new WeakMap<object, PassengerData>();
const EMPTY_PATH = new Int32Array(0);

function i32(size: number): Int32Array {
  const out = new Int32Array(size); out.fill(-1); return out;
}

function dataFor(world: AnyWorld): PassengerData {
  let data = dataByWorld.get(world);
  if (data) return data;
  const size = world.store.capacity as number;
  data = {
    provider: null,
    boardStation: i32(size), alightStation: i32(size), line: i32(size),
    nextLine: i32(size), finalStation: i32(size), train: i32(size),
  };
  dataByWorld.set(world, data);
  return data;
}

function railOf(world: AnyWorld): RailNetworkPlan { return world.city.planning.rail as RailNetworkPlan; }
function lineById(rail: RailNetworkPlan, id: number): RailLine | undefined { return rail.lines.find((line) => line.id === id); }
function stationDistance(a: RailStation, b: RailStation): number { return Math.hypot(a.x - b.x, a.z - b.z); }

function lineDistance(rail: RailNetworkPlan, lineId: number, aStation: number, bStation: number): number {
  const line = lineById(rail, lineId); if (!line) return Infinity;
  const a = line.stationIds.indexOf(aStation), b = line.stationIds.indexOf(bStation);
  if (a < 0 || b < 0) return Infinity;
  if (a === b) return 0;
  let total = 0;
  for (let i = Math.min(a, b); i < Math.max(a, b); i++) {
    const sa = rail.stations[line.stationIds[i]], sb = rail.stations[line.stationIds[i + 1]];
    if (!sa || !sb) return Infinity;
    total += stationDistance(sa, sb);
  }
  return total;
}

function nearbyStations(rail: RailNetworkPlan, x: number, z: number): Array<{ station: RailStation; distance: number }> {
  const out: Array<{ station: RailStation; distance: number }> = [];
  for (const station of rail.stations) {
    const distance = Math.hypot(station.x - x, station.z - z);
    if (distance <= 760) out.push({ station, distance });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, 6);
}

function transferStations(rail: RailNetworkPlan, firstLine: number, secondLine: number): number[] {
  const a = lineById(rail, firstLine), b = lineById(rail, secondLine); if (!a || !b) return [];
  const bSet = new Set(b.stationIds);
  return a.stationIds.filter((stationId) => bSet.has(stationId));
}

function chooseRailTrip(world: AnyWorld, agent: number, tripDistance: number): RailTripPlan | null {
  if (tripDistance < 520) return null;
  const rail = railOf(world), s = world.store;
  if (!rail?.stations.length) return null;
  const origins = nearbyStations(rail, s.posX[agent], s.posZ[agent]);
  const destinations = nearbyStations(rail, s.goalX[agent], s.goalZ[agent]);
  if (!origins.length || !destinations.length) return null;

  const WALK = 1.45, TRAIN = 19.0, WAIT = 105, TRANSFER = 145;
  let best: RailTripPlan | null = null;
  for (const origin of origins) for (const destination of destinations) {
    if (origin.station.id === destination.station.id) continue;
    for (const lineId of origin.station.lineIds) {
      if (!destination.station.lineIds.includes(lineId)) continue;
      const distance = lineDistance(rail, lineId, origin.station.id, destination.station.id);
      if (!Number.isFinite(distance) || distance <= 0) continue;
      const seconds = origin.distance / WALK + destination.distance / WALK + distance / TRAIN + WAIT;
      if (!best || seconds < best.seconds) best = {
        boardStation: origin.station.id, firstAlightStation: destination.station.id,
        firstLine: lineId, transferLine: -1, finalStation: destination.station.id, seconds,
      };
    }
    for (const firstLine of origin.station.lineIds) for (const secondLine of destination.station.lineIds) {
      if (firstLine === secondLine) continue;
      for (const transfer of transferStations(rail, firstLine, secondLine)) {
        if (transfer === origin.station.id || transfer === destination.station.id) continue;
        const d1 = lineDistance(rail, firstLine, origin.station.id, transfer);
        const d2 = lineDistance(rail, secondLine, transfer, destination.station.id);
        if (!Number.isFinite(d1) || !Number.isFinite(d2)) continue;
        const seconds = origin.distance / WALK + destination.distance / WALK + (d1 + d2) / TRAIN + WAIT + TRANSFER;
        if (!best || seconds < best.seconds) best = {
          boardStation: origin.station.id, firstAlightStation: transfer,
          firstLine, transferLine: secondLine, finalStation: destination.station.id, seconds,
        };
      }
    }
  }
  if (!best) return null;
  return best.seconds <= tripDistance / WALK * 0.92 ? best : null;
}

function clearPlan(data: PassengerData, agent: number): void {
  data.boardStation[agent] = -1; data.alightStation[agent] = -1; data.line[agent] = -1;
  data.nextLine[agent] = -1; data.finalStation[agent] = -1; data.train[agent] = -1;
}

function startRailTrip(world: AnyWorld, agent: number, plan: RailTripPlan): void {
  const data = dataFor(world), station = railOf(world).stations[plan.boardStation]; if (!station) return;
  data.boardStation[agent] = plan.boardStation;
  data.alightStation[agent] = plan.firstAlightStation;
  data.line[agent] = plan.firstLine;
  data.nextLine[agent] = plan.transferLine;
  data.finalStation[agent] = plan.finalStation;
  data.train[agent] = -1;
  world.assignWalkPath(agent, station.x, station.z);
  world.store.state[agent] = AgentState.ToRailStation;
}

function processRailPassengers(world: AnyWorld): void {
  const data = dataFor(world), provider = data.provider; if (!provider) return;
  const rail = railOf(world), s = world.store;
  const docked = provider.boardingTrains();
  const byTrain = new Map<number, RailBoardingTrainSnapshot>();
  for (const train of docked) byTrain.set(train.trainId, train);

  for (let i = 0; i < s.count; i++) {
    if (s.state[i] !== AgentState.OnTrain) continue;
    const trainId = data.train[i];
    const pos = trainId >= 0 ? provider.passengerTrainPosition(trainId) : null;
    if (pos) { s.posX[i] = pos.x; s.posZ[i] = pos.z; s.heading[i] = pos.heading; }
    const stop = trainId >= 0 ? byTrain.get(trainId) : undefined;
    if (!stop || stop.stationId !== data.alightStation[i]) continue;
    const station = rail.stations[stop.stationId];
    if (station) { s.posX[i] = station.x; s.posZ[i] = station.z; }
    data.train[i] = -1;
    if (data.nextLine[i] >= 0) {
      data.boardStation[i] = stop.stationId;
      data.line[i] = data.nextLine[i];
      data.alightStation[i] = data.finalStation[i];
      data.nextLine[i] = -1;
      s.state[i] = AgentState.WaitingTrain; s.waiting[i] = 1;
    } else {
      clearPlan(data, i);
      world.assignWalkPath(i, s.goalX[i], s.goalZ[i]);
      s.state[i] = AgentState.Traveling; s.waiting[i] = 0;
    }
  }

  const occupancy = new Map<number, number>();
  const waiting = new Map<string, number[]>();
  for (let i = 0; i < s.count; i++) {
    if (s.state[i] === AgentState.OnTrain && data.train[i] >= 0) occupancy.set(data.train[i], (occupancy.get(data.train[i]) ?? 0) + 1);
    if (s.state[i] !== AgentState.WaitingTrain || data.boardStation[i] < 0 || data.line[i] < 0) continue;
    const key = `${data.boardStation[i]}:${data.line[i]}`;
    const list = waiting.get(key); if (list) list.push(i); else waiting.set(key, [i]);
  }

  for (const train of docked) {
    const list = waiting.get(`${train.stationId}:${train.lineId}`); if (!list) continue;
    let onboard = occupancy.get(train.trainId) ?? 0;
    for (const agent of list) {
      if (onboard >= train.capacity) break;
      if (s.state[agent] !== AgentState.WaitingTrain || !train.stopsAhead.includes(data.alightStation[agent])) continue;
      data.train[agent] = train.trainId;
      s.state[agent] = AgentState.OnTrain; s.waiting[agent] = 0; s.velX[agent] = 0; s.velZ[agent] = 0;
      s.pathHandle[agent] = -1; world.walkPaths[agent] = EMPTY_PATH; s.posX[agent] = train.x; s.posZ[agent] = train.z;
      onboard++;
    }
    occupancy.set(train.trainId, onboard);
  }
}

const proto: AnyWorld = World.prototype as any;
const originalPopulate = proto.populate;
const originalStepBeforePed = proto.stepBeforePed;
const originalWalkStep = proto.walkStep;
const originalActivitySnapshot = proto.activitySnapshot;

proto.attachRailTransit = function attachRailTransit(this: AnyWorld, provider: RailTransitProvider): void { dataFor(this).provider = provider; };
proto.railPassengerCount = function railPassengerCount(this: AnyWorld): number {
  let count = 0; for (let i = 0; i < this.store.count; i++) if (this.store.state[i] === AgentState.OnTrain) count++; return count;
};

proto.populate = function populateWithTransitJobs(this: AnyWorld, count: number): void {
  originalPopulate.call(this, count);
  const s = this.store;
  for (let i = 0; i < s.count; i++) {
    if (s.ownsCar[i] || s.workPOI[i] >= 0) continue;
    const occupation = s.occupation[i] as Occupation;
    if (occupation === Occupation.Unemployed || occupation === Occupation.Retiree || s.homePOI[i] < 0) continue;
    const home = this.city.poi.get(s.homePOI[i]);
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = this.city.poi.findBest(POICategory.Work, this.rng() * this.city.sizeMeters, this.rng() * this.city.sizeMeters, s.wealth[i]);
      if (candidate < 0) continue;
      const work = this.city.poi.get(candidate); if (Math.hypot(work.x - home.x, work.z - home.z) < 650) continue;
      s.workPOI[i] = candidate; break;
    }
  }
};

proto.beginTrip = function beginTripWithRail(this: AnyWorld, i: number): void {
  const s = this.store;
  if (!this.reserveGoal(i)) {
    s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle;
    s.nextDecideAt[i] = this.clock.totalSeconds + 120 + this.rng() * 300; return;
  }
  const tripDist = Math.hypot(s.goalX[i] - s.posX[i], s.goalZ[i] - s.posZ[i]);
  const far = tripDist >= this.driveThreshold || (tripDist >= 90 && s.energy[i] < 0.4);

  if (far && s.ownsCar[i] && s.car[i] >= 0) {
    const v = s.car[i];
    if (this.vehicles.state[v] === VehicleState.Parked) {
      const destLot = this.city.poi.findNearestFree(POICategory.Parking, s.goalX[i], s.goalZ[i]);
      if (destLot >= 0 && this.city.poi.reserve(destLot)) {
        s.destParkPOI[i] = destLot; s.destParkSlot[i] = this.city.takeSlot(destLot);
        const dCar = Math.hypot(s.posX[i] - this.vehicles.posX[v], s.posZ[i] - this.vehicles.posZ[v]);
        if (dCar < 25) this.startDriving(i); else { this.assignWalkPath(i, this.vehicles.posX[v], this.vehicles.posZ[v]); s.state[i] = AgentState.ToVehicle; }
        return;
      }
    }
  }

  if (far && dataFor(this).provider) {
    const plan = chooseRailTrip(this, i, tripDist); if (plan) { startRailTrip(this, i, plan); return; }
  }
  if (far) {
    const board = this.bus.nearestStop(s.posX[i], s.posZ[i], 350), alight = this.bus.nearestStop(s.goalX[i], s.goalZ[i], 350);
    const route = this.bus.sharedRoute(board, alight);
    if (route >= 0) {
      s.boardStop[i] = board; s.alightStop[i] = alight; s.busRoute[i] = route;
      const bs = this.bus.stopById(board); this.assignWalkPath(i, bs.x, bs.z); s.state[i] = AgentState.ToBusStop; return;
    }
  }
  this.assignWalkPath(i, s.goalX[i], s.goalZ[i]);
  if (s.pathHandle[i] <= 0 && tripDist > 300) {
    this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle;
    s.nextDecideAt[i] = this.clock.totalSeconds + 300 + this.rng() * 600; return;
  }
  s.state[i] = AgentState.Traveling;
};

function walkRailAgent(world: AnyWorld, i: number, dt: number): void {
  const s = world.store, data = dataFor(world), station = railOf(world).stations[data.boardStation[i]];
  if (!station) { clearPlan(data, i); world.assignWalkPath(i, s.goalX[i], s.goalZ[i]); s.state[i] = AgentState.Traveling; return; }
  const gx = s.goalX[i], gz = s.goalZ[i];
  s.goalX[i] = station.x; s.goalZ[i] = station.z; s.state[i] = AgentState.Traveling;
  originalWalkStep.call(world, i, dt, false);
  s.goalX[i] = gx; s.goalZ[i] = gz;
  if (s.state[i] === AgentState.Engaged) {
    s.state[i] = AgentState.WaitingTrain; s.dwellUntil[i] = 0; s.waiting[i] = 1; s.velX[i] = 0; s.velZ[i] = 0;
  } else if (s.state[i] === AgentState.Traveling) s.state[i] = AgentState.ToRailStation;
  else if (s.state[i] === AgentState.Idle) clearPlan(data, i);
}

proto.stepBeforePed = function stepBeforePedWithRail(this: AnyWorld, dt: number, needs: boolean, decisions: boolean): number {
  const now = originalStepBeforePed.call(this, dt, needs, decisions);
  processRailPassengers(this);
  for (let i = 0; i < this.store.count; i++) if (this.store.state[i] === AgentState.ToRailStation) walkRailAgent(this, i, dt);
  return now;
};

proto.activitySnapshot = function activitySnapshotWithRail(this: AnyWorld): Record<string, number> {
  const snapshot = originalActivitySnapshot.call(this) as Record<string, number>;
  let moving = 0, onboard = 0;
  for (let i = 0; i < this.store.count; i++) {
    const state = this.store.state[i];
    if (state === AgentState.ToRailStation || state === AgentState.WaitingTrain) moving++;
    else if (state === AgentState.OnTrain) onboard++;
  }
  snapshot.idle = Math.max(0, (snapshot.idle ?? 0) - moving - onboard);
  snapshot.traveling = (snapshot.traveling ?? 0) + moving;
  snapshot.ontrain = onboard;
  return snapshot;
};

const rendererProto: AnyWorld = EnhancedRenderer.prototype as any;
const originalSyncAgents = rendererProto.syncAgents;
rendererProto.syncAgents = function syncAgentsWithoutRailPassengers(this: EnhancedRenderer, store: any, ...args: any[]): void {
  const moved: Array<[number, number, number]> = [];
  for (let i = 0; i < store.count; i++) {
    if (store.state[i] !== AgentState.OnTrain) continue;
    moved.push([i, store.posX[i], store.posZ[i]]); store.posX[i] = 1e9; store.posZ[i] = 1e9;
  }
  try { originalSyncAgents.call(this, store, ...args); }
  finally { for (const [i, x, z] of moved) { store.posX[i] = x; store.posZ[i] = z; } }
};
