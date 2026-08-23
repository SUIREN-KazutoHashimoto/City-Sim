import * as THREE from 'three';
import { AgentState, Occupation } from '../agents/AgentStore';
import type { RailLine, RailNetworkPlan, RailStation } from '../generation/RailPlanning';
import { VehicleState } from '../traffic/VehicleStore';
import { POICategory } from './POI';
import { World } from './World';
import '../rendering/RailPassengerBridge';
import '../rendering/RailPassengerStationAccess';
import { EnhancedRenderer } from '../rendering/EnhancedRenderer';
import type { RailBoardingTrainSnapshot, RailPassengerTrainPosition } from '../rendering/RailPassengerBridge';
import type { RailPassengerPoint3D, RailPassengerStationAccess } from '../rendering/RailPassengerStationAccess';

export interface RailTransitProvider {
  boardingTrains(): RailBoardingTrainSnapshot[];
  passengerTrainPosition(id: number): RailPassengerTrainPosition | null;
  passengerStationAccesses(stationId: number, lineId: number, direction: 1 | -1): RailPassengerStationAccess[];
}

declare module './World' {
  interface World {
    attachRailTransit(provider: RailTransitProvider): void;
    railPassengerCount(): number;
  }
}

type AnyWorld = any;
type RouteFinish = 'wait' | 'exit';
type RailWalkRoute = { points: RailPassengerPoint3D[]; cursor: number; finish: RouteFinish };
type PassengerVisual = { active: Uint8Array; y: Float32Array };
type PassengerData = {
  provider: RailTransitProvider | null;
  boardStation: Int32Array;
  alightStation: Int32Array;
  line: Int32Array;
  nextLine: Int32Array;
  finalStation: Int32Array;
  train: Int32Array;
  access: Map<number, RailPassengerStationAccess>;
  routes: Map<number, RailWalkRoute>;
  visual: PassengerVisual;
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
const visualByStore = new WeakMap<object, PassengerVisual>();
const EMPTY_PATH = new Int32Array(0);

function i32(size: number): Int32Array {
  const out = new Int32Array(size); out.fill(-1); return out;
}

function dataFor(world: AnyWorld): PassengerData {
  let data = dataByWorld.get(world);
  if (data) return data;
  const size = world.store.capacity as number;
  const visual = { active: new Uint8Array(size), y: new Float32Array(size) };
  data = {
    provider: null,
    boardStation: i32(size), alightStation: i32(size), line: i32(size),
    nextLine: i32(size), finalStation: i32(size), train: i32(size),
    access: new Map<number, RailPassengerStationAccess>(),
    routes: new Map<number, RailWalkRoute>(),
    visual,
  };
  dataByWorld.set(world, data);
  visualByStore.set(world.store, visual);
  return data;
}

function railOf(world: AnyWorld): RailNetworkPlan { return world.city.planning.rail as RailNetworkPlan; }
function lineById(rail: RailNetworkPlan, id: number): RailLine | undefined { return rail.lines.find((line) => line.id === id); }
function stationById(rail: RailNetworkPlan, id: number): RailStation | null {
  const direct = rail.stations[id];
  if (direct?.id === id) return direct;
  return rail.stations.find((station) => station?.id === id) ?? null;
}
function stationDistance(a: RailStation, b: RailStation): number { return Math.hypot(a.x - b.x, a.z - b.z); }

function lineDistance(rail: RailNetworkPlan, lineId: number, aStation: number, bStation: number): number {
  const line = lineById(rail, lineId); if (!line) return Infinity;
  const a = line.stationIds.indexOf(aStation), b = line.stationIds.indexOf(bStation);
  if (a < 0 || b < 0) return Infinity;
  if (a === b) return 0;
  let total = 0;
  for (let i = Math.min(a, b); i < Math.max(a, b); i++) {
    const sa = stationById(rail, line.stationIds[i]), sb = stationById(rail, line.stationIds[i + 1]);
    if (!sa || !sb) return Infinity;
    total += stationDistance(sa, sb);
  }
  return total;
}

function nearbyStations(rail: RailNetworkPlan, x: number, z: number): Array<{ station: RailStation; distance: number }> {
  const out: Array<{ station: RailStation; distance: number }> = [];
  for (const station of rail.stations) {
    if (!station || !Number.isFinite(station.x) || !Number.isFinite(station.z)) continue;
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

function directionOnLine(rail: RailNetworkPlan, lineId: number, fromStation: number, toStation: number): 1 | -1 | null {
  const line = lineById(rail, lineId); if (!line) return null;
  const from = line.stationIds.indexOf(fromStation), to = line.stationIds.indexOf(toStation);
  if (from < 0 || to < 0 || from === to) return null;
  return to > from ? 1 : -1;
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

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function individualAccess(access: RailPassengerStationAccess, agent: number): RailPassengerStationAccess {
  const along = (hash01(agent * 1619 + access.stationId * 313 + access.lineId * 37) - 0.5) * access.waitSpan;
  return {
    ...access,
    platformWait: {
      x: access.platformWait.x + Math.cos(access.heading) * along,
      y: access.platformWait.y,
      z: access.platformWait.z + Math.sin(access.heading) * along,
    },
  };
}

function nearestAccess(
  provider: RailTransitProvider | null,
  stationId: number,
  lineId: number,
  direction: 1 | -1,
  x: number,
  z: number,
  point: 'entrance' | 'concourse' | 'platformWait',
): RailPassengerStationAccess | null {
  if (!provider) return null;
  const accesses = provider.passengerStationAccesses(stationId, lineId, direction);
  let best: RailPassengerStationAccess | null = null, bestD = Infinity;
  for (const access of accesses) {
    const p = access[point];
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestD) { bestD = d; best = access; }
  }
  return best;
}

function arrivalAccess(
  provider: RailTransitProvider | null,
  stationId: number,
  lineId: number,
  trainX: number,
  trainZ: number,
): RailPassengerStationAccess | null {
  const a = nearestAccess(provider, stationId, lineId, 1, trainX, trainZ, 'platformWait');
  const b = nearestAccess(provider, stationId, lineId, -1, trainX, trainZ, 'platformWait');
  if (!a) return b;
  if (!b) return a;
  const da = Math.hypot(a.platformWait.x - trainX, a.platformWait.z - trainZ);
  const db = Math.hypot(b.platformWait.x - trainX, b.platformWait.z - trainZ);
  return da <= db ? a : b;
}

function clearPlan(data: PassengerData, agent: number): void {
  data.boardStation[agent] = -1; data.alightStation[agent] = -1; data.line[agent] = -1;
  data.nextLine[agent] = -1; data.finalStation[agent] = -1; data.train[agent] = -1;
  data.access.delete(agent); data.routes.delete(agent);
  data.visual.active[agent] = 0; data.visual.y[agent] = 0;
}

function beginRoute(world: AnyWorld, agent: number, points: RailPassengerPoint3D[], finish: RouteFinish): void {
  if (points.length < 2) return;
  const data = dataFor(world), s = world.store;
  data.routes.set(agent, { points, cursor: 0, finish });
  data.visual.active[agent] = 1; data.visual.y[agent] = points[0].y;
  s.posX[agent] = points[0].x; s.posZ[agent] = points[0].z;
  s.velX[agent] = 0; s.velZ[agent] = 0; s.pathHandle[agent] = -1; world.walkPaths[agent] = EMPTY_PATH;
  s.state[agent] = AgentState.ToRailStation; s.waiting[agent] = 0;
}

function completeRoute(world: AnyWorld, agent: number, finish: RouteFinish): void {
  const data = dataFor(world), s = world.store;
  data.routes.delete(agent); s.velX[agent] = 0; s.velZ[agent] = 0;
  if (finish === 'wait') {
    s.state[agent] = AgentState.WaitingTrain; s.waiting[agent] = 1; data.visual.active[agent] = 1;
    return;
  }
  data.visual.active[agent] = 0; data.visual.y[agent] = 0;
  clearPlan(data, agent);
  world.assignWalkPath(agent, s.goalX[agent], s.goalZ[agent]);
  s.state[agent] = AgentState.Traveling; s.waiting[agent] = 0;
}

function stepRoute(world: AnyWorld, agent: number, dt: number): void {
  const data = dataFor(world), route = data.routes.get(agent); if (!route) return;
  const s = world.store;
  let budget = Math.max(0, dt) * Math.max(0.9, Math.min(1.55, s.maxSpeed[agent] || 1.25));
  while (budget > 1e-6 && route.cursor < route.points.length - 1) {
    const target = route.points[route.cursor + 1];
    const dx = target.x - s.posX[agent], dz = target.z - s.posZ[agent], dy = target.y - data.visual.y[agent];
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 0.03) {
      s.posX[agent] = target.x; s.posZ[agent] = target.z; data.visual.y[agent] = target.y; route.cursor++; continue;
    }
    if (distance <= budget) {
      s.posX[agent] = target.x; s.posZ[agent] = target.z; data.visual.y[agent] = target.y;
      if (Math.hypot(dx, dz) > 0.01) s.heading[agent] = Math.atan2(dz, dx);
      budget -= distance; route.cursor++; continue;
    }
    const t = budget / distance;
    s.posX[agent] += dx * t; s.posZ[agent] += dz * t; data.visual.y[agent] += dy * t;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal > 0.01) {
      s.heading[agent] = Math.atan2(dz, dx);
      s.velX[agent] = dx / horizontal * Math.max(0.9, s.maxSpeed[agent]);
      s.velZ[agent] = dz / horizontal * Math.max(0.9, s.maxSpeed[agent]);
    }
    budget = 0;
  }
  if (route.cursor >= route.points.length - 1) completeRoute(world, agent, route.finish);
}

function startRailTrip(world: AnyWorld, agent: number, plan: RailTripPlan): void {
  const data = dataFor(world), rail = railOf(world), station = stationById(rail, plan.boardStation); if (!station) return;
  data.boardStation[agent] = plan.boardStation;
  data.alightStation[agent] = plan.firstAlightStation;
  data.line[agent] = plan.firstLine;
  data.nextLine[agent] = plan.transferLine;
  data.finalStation[agent] = plan.finalStation;
  data.train[agent] = -1;
  data.visual.active[agent] = 0; data.visual.y[agent] = 0;

  const direction = directionOnLine(rail, plan.firstLine, plan.boardStation, plan.firstAlightStation);
  const rawAccess = direction == null ? null : nearestAccess(data.provider, plan.boardStation, plan.firstLine, direction, world.store.posX[agent], world.store.posZ[agent], 'entrance');
  if (rawAccess) {
    const access = individualAccess(rawAccess, agent);
    data.access.set(agent, access);
    world.assignWalkPath(agent, access.entrance.x, access.entrance.z);
  } else {
    data.access.delete(agent);
    world.assignWalkPath(agent, station.x, station.z);
  }
  world.store.state[agent] = AgentState.ToRailStation;
}

function startExitFromPlatform(world: AnyWorld, agent: number, stop: RailBoardingTrainSnapshot): void {
  const data = dataFor(world);
  const raw = arrivalAccess(data.provider, stop.stationId, stop.lineId, stop.x, stop.z);
  if (!raw) {
    clearPlan(data, agent);
    world.assignWalkPath(agent, world.store.goalX[agent], world.store.goalZ[agent]);
    world.store.state[agent] = AgentState.Traveling; world.store.waiting[agent] = 0;
    return;
  }
  const access = individualAccess(raw, agent);
  data.access.set(agent, access);
  beginRoute(world, agent, [access.platformWait, access.platformLanding, access.concourse, access.stairTop, access.entrance], 'exit');
}

function startTransferAcrossStation(world: AnyWorld, agent: number, stop: RailBoardingTrainSnapshot): void {
  const data = dataFor(world), rail = railOf(world), nextLine = data.nextLine[agent], finalStation = data.finalStation[agent];
  if (nextLine < 0 || finalStation < 0) { startExitFromPlatform(world, agent, stop); return; }
  const arrivalRaw = arrivalAccess(data.provider, stop.stationId, stop.lineId, stop.x, stop.z);
  const nextDirection = directionOnLine(rail, nextLine, stop.stationId, finalStation);
  const departureRaw = nextDirection == null ? null : nearestAccess(
    data.provider, stop.stationId, nextLine, nextDirection,
    arrivalRaw?.concourse.x ?? stop.x, arrivalRaw?.concourse.z ?? stop.z, 'concourse',
  );

  data.boardStation[agent] = stop.stationId;
  data.line[agent] = nextLine;
  data.alightStation[agent] = finalStation;
  data.nextLine[agent] = -1;

  if (!arrivalRaw || !departureRaw) {
    const fallback = departureRaw ? individualAccess(departureRaw, agent) : null;
    if (fallback) {
      data.access.set(agent, fallback);
      world.store.posX[agent] = fallback.platformWait.x; world.store.posZ[agent] = fallback.platformWait.z;
      data.visual.active[agent] = 1; data.visual.y[agent] = fallback.platformWait.y;
    } else {
      data.visual.active[agent] = 0; data.visual.y[agent] = 0;
    }
    world.store.state[agent] = AgentState.WaitingTrain; world.store.waiting[agent] = 1;
    return;
  }

  const arrival = individualAccess(arrivalRaw, agent);
  const departure = individualAccess(departureRaw, agent);
  data.access.set(agent, departure);
  beginRoute(world, agent, [
    arrival.platformWait,
    arrival.platformLanding,
    arrival.concourse,
    departure.concourse,
    departure.platformLanding,
    departure.platformWait,
  ], 'wait');
}

function processRailPassengers(world: AnyWorld): void {
  const data = dataFor(world), provider = data.provider; if (!provider) return;
  const s = world.store;
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
    data.train[i] = -1;
    if (data.nextLine[i] >= 0) startTransferAcrossStation(world, i, stop);
    else startExitFromPlatform(world, i, stop);
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
      data.routes.delete(agent); data.access.delete(agent);
      data.visual.active[agent] = 0; data.visual.y[agent] = 0;
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
  const data = dataFor(world), s = world.store;
  if (data.routes.has(i)) { stepRoute(world, i, dt); return; }
  const access = data.access.get(i);
  const station = stationById(railOf(world), data.boardStation[i]);
  if (!access && !station) {
    clearPlan(data, i); world.assignWalkPath(i, s.goalX[i], s.goalZ[i]); s.state[i] = AgentState.Traveling; return;
  }
  const targetX = access?.entrance.x ?? station!.x, targetZ = access?.entrance.z ?? station!.z;
  const gx = s.goalX[i], gz = s.goalZ[i];
  s.goalX[i] = targetX; s.goalZ[i] = targetZ; s.state[i] = AgentState.Traveling;
  originalWalkStep.call(world, i, dt, false);
  s.goalX[i] = gx; s.goalZ[i] = gz;
  if (s.state[i] === AgentState.Engaged) {
    s.dwellUntil[i] = 0; s.velX[i] = 0; s.velZ[i] = 0;
    if (access) {
      beginRoute(world, i, [access.entrance, access.stairTop, access.concourse, access.platformLanding, access.platformWait], 'wait');
    } else {
      s.state[i] = AgentState.WaitingTrain; s.waiting[i] = 1;
    }
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

function ensureRailPassengerMeshes(renderer: AnyWorld, capacity: number): void {
  if (renderer.__railPassengerBody && renderer.__railPassengerCapacity >= capacity) return;
  const scene = renderer.sceneRef as THREE.Scene | undefined; if (!scene) return;
  if (renderer.__railPassengerBody) scene.remove(renderer.__railPassengerBody);
  if (renderer.__railPassengerHead) scene.remove(renderer.__railPassengerHead);
  const cap = Math.max(64, Math.pow(2, Math.ceil(Math.log2(Math.max(1, capacity)))));
  const body = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x657f9d, roughness: 0.86 }),
    cap,
  );
  const head = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.23, 7, 5),
    new THREE.MeshStandardMaterial({ color: 0xd9b08c, roughness: 0.9 }),
    cap,
  );
  for (const mesh of [body, head]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; scene.add(mesh);
  }
  renderer.__railPassengerBody = body; renderer.__railPassengerHead = head; renderer.__railPassengerCapacity = cap;
  renderer.__railPassengerDummy = renderer.__railPassengerDummy ?? new THREE.Object3D();
}

function syncRailPassengerMeshes(renderer: AnyWorld, store: AnyWorld, visual: PassengerVisual | undefined, camera?: THREE.Vector3): void {
  const existingBody = renderer.__railPassengerBody as THREE.InstancedMesh | undefined;
  const existingHead = renderer.__railPassengerHead as THREE.InstancedMesh | undefined;
  if (!visual) {
    if (existingBody) existingBody.count = 0;
    if (existingHead) existingHead.count = 0;
    return;
  }
  let needed = 0;
  for (let i = 0; i < store.count; i++) if (visual.active[i] && store.state[i] !== AgentState.OnTrain) needed++;
  if (needed <= 0) {
    if (existingBody) existingBody.count = 0;
    if (existingHead) existingHead.count = 0;
    return;
  }
  ensureRailPassengerMeshes(renderer, needed);
  const body = renderer.__railPassengerBody as THREE.InstancedMesh | undefined;
  const head = renderer.__railPassengerHead as THREE.InstancedMesh | undefined;
  const d = renderer.__railPassengerDummy as THREE.Object3D | undefined;
  if (!body || !head || !d) return;
  let count = 0;
  for (let i = 0; i < store.count; i++) {
    if (!visual.active[i] || store.state[i] === AgentState.OnTrain) continue;
    const x = store.posX[i], z = store.posZ[i], y = visual.y[i];
    if (camera && (x - camera.x) ** 2 + (z - camera.z) ** 2 > 3_000 ** 2) continue;
    d.position.set(x, y + 0.74, z); d.rotation.set(0, -store.heading[i], 0); d.scale.set(0.42, 1.45, 0.28); d.updateMatrix();
    body.setMatrixAt(count, d.matrix);
    d.position.set(x, y + 1.62, z); d.scale.set(1, 1, 1); d.updateMatrix(); head.setMatrixAt(count, d.matrix);
    count++;
  }
  body.count = count; head.count = count; body.instanceMatrix.needsUpdate = true; head.instanceMatrix.needsUpdate = true;
}

const rendererProto: AnyWorld = EnhancedRenderer.prototype as any;
const originalSyncAgents = rendererProto.syncAgents;
rendererProto.syncAgents = function syncAgentsWithoutRailPassengers(this: EnhancedRenderer, store: AnyWorld, ...args: AnyWorld[]): void {
  const visual = visualByStore.get(store);
  const moved: Array<[number, number, number]> = [];
  for (let i = 0; i < store.count; i++) {
    if (store.state[i] !== AgentState.OnTrain && !visual?.active[i]) continue;
    moved.push([i, store.posX[i], store.posZ[i]]); store.posX[i] = 1e9; store.posZ[i] = 1e9;
  }
  try { originalSyncAgents.call(this, store, ...args); }
  finally { for (const [i, x, z] of moved) { store.posX[i] = x; store.posZ[i] = z; } }
  const camera = args[1] instanceof THREE.Vector3 ? args[1] : undefined;
  syncRailPassengerMeshes(this as unknown as AnyWorld, store, visual, camera);
};
