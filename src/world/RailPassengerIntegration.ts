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

type AnyWorld = World & Record<string, any>;
type RailTripPlan = {
  boardStation: number;
  firstAlightStation: number;
  firstLine: number;
  transferLine: number;
  finalStation: number;
  generalizedSeconds: number;
};

type PassengerData = {
  provider: RailTransitProvider | null;
  boardStation: Int32Array;
  alightStation: Int32Array;
  line: Int32Array;
  nextLine: Int32Array;
  finalStation: Int32Array;
  train: Int32Array;
};

const dataByWorld = new WeakMap<World, PassengerData>();

function filledI32(size: number): Int32Array {
  const out = new Int32Array(size);
  out.fill(-1);
  return out;
}

function dataFor(world: World): PassengerData {
  let data = dataByWorld.get(world);
  if (data) return data;
  const size = world.store.capacity;
  data = {
    provider: null,
    boardStation: filledI32(size),
    alightStation: filledI32(size),
    line: filledI32(size),
    nextLine: filledI32(size),
    finalStation: filledI32(size),
    train: filledI32(size),
  };
  dataByWorld.set(world, data);
  return data;
}

function railOf(world: AnyWorld): RailNetworkPlan {
  return world.city.planning.rail as RailNetworkPlan;
}

function lineById(rail: RailNetworkPlan, id: number): RailLine | undefined {
  return rail.lines.find((line) => line.id === id);
}

function stationDistance(a: RailStation, b: RailStation): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function lineDistance(rail: RailNetworkPlan, lineId: number, fromStation: number, toStation: number): number {
  const line = lineById(rail, lineId);
  if (!line) return Infinity;
  const a = line.stationIds.indexOf(fromStation), b = line.stationIds.indexOf(toStation);
  if (a < 0 || b < 0 || a === b) return a === b ? 0 : Infinity;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  let distance = 0;
  for (let i = lo; i < hi; i++) {
    const sa = rail.stations[line.stationIds[i]], sb = rail.stations[line.stationIds[i + 1]];
    if (!sa || !sb) return Infinity;
    distance += stationDistance(sa, sb);
  }
  return distance;
}

function nearbyStations(rail: RailNetworkPlan, x: number, z: number, radius = 760, maxCount = 6): Array<{ station: RailStation; distance: number }> {
  const found: Array<{ station: RailStation; distance: number }> = [];
  for (const station of rail.stations) {
    const distance = Math.hypot(station.x - x, station.z - z);
    if (distance <= radius) found.push({ station, distance });
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.slice(0, maxCount);
}

function sharedTransfer(rail: RailNetworkPlan, firstLineId: number, secondLineId: number): number[] {
  const first = lineById(rail, firstLineId), second = lineById(rail, secondLineId);
  if (!first || !second) return [];
  const secondStations = new Set(second.stationIds);
  return first.stationIds.filter((stationId) => secondStations.has(stationId));
}

function chooseRailTrip(world: AnyWorld, agent: number, tripDistance: number): RailTripPlan | null {
  if (tripDistance < 520) return null;
  const rail = railOf(world);
  if (!rail?.stations.length || !rail.lines.length) return null;
  const s = world.store;
  const origins = nearbyStations(rail, s.posX[agent], s.posZ[agent]);
  const destinations = nearbyStations(rail, s.goalX[agent], s.goalZ[agent]);
  if (!origins.length || !destinations.length) return null;

  const WALK_SPEED = 1.45;
  const RAIL_SPEED = 19.0;
  const BASE_WAIT = 105;
  const TRANSFER_WAIT = 145;
  let best: RailTripPlan | null = null;

  for (const origin of origins) for (const destination of destinations) {
    if (origin.station.id === destination.station.id) continue;
    const common = origin.station.lineIds.filter((id) => destination.station.lineIds.includes(id));
    for (const lineId of common) {
      const railDistance = lineDistance(rail, lineId, origin.station.id, destination.station.id);
      if (!Number.isFinite(railDistance) || railDistance < 1) continue;
      const seconds = origin.distance / WALK_SPEED + destination.distance / WALK_SPEED + railDistance / RAIL_SPEED + BASE_WAIT;
      if (!best || seconds < best.generalizedSeconds) {
        best = {
          boardStation: origin.station.id,
          firstAlightStation: destination.station.id,
          firstLine: lineId,
          transferLine: -1,
          finalStation: destination.station.id,
          generalizedSeconds: seconds,
        };
      }
    }

    for (const firstLine of origin.station.lineIds) for (const secondLine of destination.station.lineIds) {
      if (firstLine === secondLine) continue;
      for (const transferStation of sharedTransfer(rail, firstLine, secondLine)) {
        if (transferStation === origin.station.id || transferStation === destination.station.id) continue;
        const firstDistance = lineDistance(rail, firstLine, origin.station.id, transferStation);
        const secondDistance = lineDistance(rail, secondLine, transferStation, destination.station.id);
        if (!Number.isFinite(firstDistance) || !Number.isFinite(secondDistance)) continue;
        const seconds = origin.distance / WALK_SPEED + destination.distance / WALK_SPEED
          + (firstDistance + secondDistance) / RAIL_SPEED + BASE_WAIT + TRANSFER_WAIT;
        if (!best || seconds < best.generalizedSeconds) {
          best = {
            boardStation: origin.station.id,
            firstAlightStation: transferStation,
            firstLine,
            transferLine: secondLine,
            finalStation: destination.station.id,
            generalizedSeconds: seconds,
          };
        }
      }
    }
  }

  if (!best) return null;
  const walkSeconds = tripDistance / 1.45;
  return best.generalizedSeconds <= walkSeconds * 0.92 ? best : null;
}

function clearRailPlan(data: PassengerData, agent: number): void {
  data.boardStation[agent] = -1;
  data.alightStation[agent] = -1;
  data.line[agent] = -1;
  data.nextLine[agent] = -1;
  data.finalStation[agent] = -1;
  data.train[agent] = -1;
}

function startRailTrip(world: AnyWorld, agent: number, plan: RailTripPlan): void {
  const data = dataFor(world);
  const station = railOf(world).stations[plan.boardStation];
  if (!station) return;
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
  const data = dataFor(world);
  const provider = data.provider;
  if (!provider) return;
  const rail = railOf(world);
  const s = world.store;
  const docked = provider.boardingTrains();
  const dockedByTrain = new Map<number, RailBoardingTrainSnapshot>();
  for (const train of docked) dockedByTrain.set(train.trainId, train);

  // 先に降車させて席を空ける。乗換駅ではそのまま次路線のホーム待ちへ移行する。
  for (let i = 0; i < s.count; i++) {
    if (s.state[i] !== AgentState.OnTrain) continue;
    const trainId = data.train[i];
    const position = trainId >= 0 ? provider.passengerTrainPosition(trainId) : null;
    if (position) {
      s.posX[i] = position.x;
      s.posZ[i] = position.z;
      s.heading[i] = position.heading;
    }
    const stop = trainId >= 0 ? dockedByTrain.get(trainId) : undefined;
    if (!stop || stop.stationId !== data.alightStation[i]) continue;

    const station = rail.stations[stop.stationId];
    if (station) { s.posX[i] = station.x; s.posZ[i] = station.z; }
    data.train[i] = -1;
    if (data.nextLine[i] >= 0) {
      data.boardStation[i] = stop.stationId;
      data.line[i] = data.nextLine[i];
      data.alightStation[i] = data.finalStation[i];
      data.nextLine[i] = -1;
      s.state[i] = AgentState.WaitingTrain;
      s.waiting[i] = 1;
      continue;
    }

    clearRailPlan(data, i);
    world.assignWalkPath(i, s.goalX[i], s.goalZ[i]);
    s.state[i] = AgentState.Traveling;
    s.waiting[i] = 0;
  }

  const occupancy = new Map<number, number>();
  const waiting = new Map<string, number[]>();
  for (let i = 0; i < s.count; i++) {
    if (s.state[i] === AgentState.OnTrain && data.train[i] >= 0) {
      occupancy.set(data.train[i], (occupancy.get(data.train[i]) ?? 0) + 1);
    } else if (s.state[i] === AgentState.WaitingTrain && data.boardStation[i] >= 0 && data.line[i] >= 0) {
      const key = `${data.boardStation[i]}:${data.line[i]}`;
      const list = waiting.get(key);
      if (list) list.push(i); else waiting.set(key, [i]);
    }
  }

  for (const train of docked) {
    const list = waiting.get(`${train.stationId}:${train.lineId}`);
    if (!list?.length) continue;
    let onboard = occupancy.get(train.trainId) ?? 0;
    for (const agent of list) {
      if (onboard >= train.capacity) break;
      if (s.state[agent] !== AgentState.WaitingTrain) continue;
      if (!train.stopsAhead.includes(data.alightStation[agent])) continue;
      data.train[agent] = train.trainId;
      s.state[agent] = AgentState.OnTrain;
      s.waiting[agent] = 0;
      s.velX[agent] = 0;
      s.velZ[agent] = 0;
      s.pathHandle[agent] = -1;
      world.walkPaths[agent] = new Int32Array(0);
      s.posX[agent] = train.x;
      s.posZ[agent] = train.z;
      onboard++;
    }
    occupancy.set(train.trainId, onboard);
  }
}

const proto = World.prototype as unknown as AnyWorld;
const originalPopulate = proto.populate as (count: number) => void;
const originalBeginTrip = proto.beginTrip as (agent: number) => void;
const originalStepBeforePed = proto.stepBeforePed as (dt: number, needs: boolean, decisions: boolean) => number;
const originalStepCore = proto.stepCore as (dt: number, needs: boolean, activities: boolean, decisions: boolean) => void;
const originalStepCoreAsync = proto.stepCoreAsync as (dt: number, needs: boolean, activities: boolean, decisions: boolean) => Promise<void>;
const originalWalkStep = proto.walkStep as (agent: number, dt: number, deferMovement: boolean) => void;
const originalComputePedBlocks = proto.computePedBlocks as () => void;
const originalBuildTravelerIndex = proto.buildTravelerIndex as () => void;
const originalActivitySnapshot = proto.activitySnapshot as () => Record<string, number>;

proto.attachRailTransit = function attachRailTransit(this: World, provider: RailTransitProvider): void {
  dataFor(this).provider = provider;
};

proto.railPassengerCount = function railPassengerCount(this: World): number {
  const s = this.store;
  let count = 0;
  for (let i = 0; i < s.count; i++) if (s.state[i] === AgentState.OnTrain) count++;
  return count;
};

proto.populate = function populateWithTransitJobs(this: AnyWorld, count: number): void {
  originalPopulate.call(this, count);
  // 旧仕様では非自動車世帯の勤務先を700m以内に制限していた。
  // 鉄道開通後は、勤務先未割当の非自動車就業者にも遠距離勤務先を与えて公共交通需要を作る。
  const s = this.store;
  for (let i = 0; i < s.count; i++) {
    if (s.ownsCar[i] || s.workPOI[i] >= 0) continue;
    const occupation = s.occupation[i] as Occupation;
    if (occupation === Occupation.Unemployed || occupation === Occupation.Retiree) continue;
    const homeId = s.homePOI[i];
    if (homeId < 0) continue;
    const home = this.city.poi.get(homeId);
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = this.rng() * this.city.sizeMeters;
      const z = this.rng() * this.city.sizeMeters;
      const candidate = this.city.poi.findBest(POICategory.Work, x, z, s.wealth[i]);
      if (candidate < 0) continue;
      const work = this.city.poi.get(candidate);
      if (Math.hypot(work.x - home.x, work.z - home.z) < 650) continue;
      s.workPOI[i] = candidate;
      break;
    }
  }
};

proto.beginTrip = function beginTripWithRail(this: AnyWorld, i: number): void {
  const s = this.store;
  if (!this.reserveGoal(i)) {
    s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle;
    s.nextDecideAt[i] = this.clock.totalSeconds + 120 + this.rng() * 300;
    return;
  }

  const tripDist = Math.hypot(s.goalX[i] - s.posX[i], s.goalZ[i] - s.posZ[i]);
  const far = tripDist >= this.driveThreshold || (tripDist >= 90 && s.energy[i] < 0.4);
  if (far && s.ownsCar[i] && s.car[i] >= 0) {
    const v = s.car[i];
    if (this.vehicles.state[v] === VehicleState.Parked) {
      const destLot = this.city.poi.findNearestFree(POICategory.Parking, s.goalX[i], s.goalZ[i]);
      if (destLot >= 0 && this.city.poi.reserve(destLot)) {
        s.destParkPOI[i] = destLot;
        s.destParkSlot[i] = this.city.takeSlot(destLot);
        const dCar = Math.hypot(s.posX[i] - this.vehicles.posX[v], s.posZ[i] - this.vehicles.posZ[v]);
        if (dCar < 25) this.startDriving(i);
        else { this.assignWalkPath(i, this.vehicles.posX[v], this.vehicles.posZ[v]); s.state[i] = AgentState.ToVehicle; }
        return;
      }
    }
  }

  if (far && dataFor(this).provider) {
    const plan = chooseRailTrip(this, i, tripDist);
    if (plan) { startRailTrip(this, i, plan); return; }
  }

  if (far) {
    const board = this.bus.nearestStop(s.posX[i], s.posZ[i], 350);
    const alight = this.bus.nearestStop(s.goalX[i], s.goalZ[i], 350);
    const route = this.bus.sharedRoute(board, alight);
    if (route >= 0) {
      s.boardStop[i] = board; s.alightStop[i] = alight; s.busRoute[i] = route;
      const bs = this.bus.stopById(board);
      this.assignWalkPath(i, bs.x, bs.z); s.state[i] = AgentState.ToBusStop; return;
    }
  }

  this.assignWalkPath(i, s.goalX[i], s.goalZ[i]);
  if (s.pathHandle[i] <= 0 && tripDist > 300) {
    this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255;
    s.state[i] = AgentState.Idle; s.nextDecideAt[i] = this.clock.totalSeconds + 300 + this.rng() * 600; return;
  }
  s.state[i] = AgentState.Traveling;
};

proto.stepBeforePed = function stepBeforePedWithRail(this: AnyWorld, dt: number, needs: boolean, decisions: boolean): number {
  const now = originalStepBeforePed.call(this, dt, needs, decisions);
  processRailPassengers(this);
  return now;
};

proto.stepCore = function stepCoreWithRail(this: AnyWorld, dt: number, needs: boolean, activities: boolean, decisions: boolean): void {
  originalStepCore.call(this, dt, needs, activities, decisions);
  const s = this.store;
  for (let i = 0; i < s.count; i++) if (s.state[i] === AgentState.ToRailStation) this.walkStep(i, dt, false);
};

proto.stepCoreAsync = async function stepCoreAsyncWithRail(this: AnyWorld, dt: number, needs: boolean, activities: boolean, decisions: boolean): Promise<void> {
  await originalStepCoreAsync.call(this, dt, needs, activities, decisions);
  const s = this.store;
  for (let i = 0; i < s.count; i++) if (s.state[i] === AgentState.ToRailStation) this.walkStep(i, dt, false);
};

proto.walkStep = function walkStepWithRail(this: AnyWorld, i: number, dt: number, deferMovement: boolean): void {
  const s = this.store;
  if (s.state[i] !== AgentState.ToRailStation) { originalWalkStep.call(this, i, dt, deferMovement); return; }
  const data = dataFor(this);
  const station = railOf(this).stations[data.boardStation[i]];
  if (!station) {
    clearRailPlan(data, i);
    this.assignWalkPath(i, s.goalX[i], s.goalZ[i]);
    s.state[i] = AgentState.Traveling;
    return;
  }

  const goalX = s.goalX[i], goalZ = s.goalZ[i];
  s.goalX[i] = station.x; s.goalZ[i] = station.z; s.state[i] = AgentState.Traveling;
  originalWalkStep.call(this, i, dt, deferMovement);
  s.goalX[i] = goalX; s.goalZ[i] = goalZ;

  if (s.state[i] === AgentState.Engaged) {
    s.state[i] = AgentState.WaitingTrain;
    s.dwellUntil[i] = 0;
    s.waiting[i] = 1;
    s.velX[i] = 0; s.velZ[i] = 0;
  } else if (s.state[i] === AgentState.Traveling) {
    s.state[i] = AgentState.ToRailStation;
  } else if (s.state[i] === AgentState.Idle) {
    clearRailPlan(data, i);
  }
};

proto.computePedBlocks = function computePedBlocksWithRail(this: AnyWorld): void {
  originalComputePedBlocks.call(this);
  const s = this.store;
  for (let i = 0; i < s.count; i++) {
    if (s.state[i] !== AgentState.ToRailStation) continue;
    const roadNode = this.pedCrossingRoadNode[i];
    if (roadNode < 0) continue;
    const rn = this.city.net.nodes[roadNode];
    if (rn && (s.posX[i] - rn.x) ** 2 + (s.posZ[i] - rn.z) ** 2 < 16 * 16) this.pedBlock[roadNode] = 1;
  }
};

proto.buildTravelerIndex = function buildTravelerIndexWithRail(this: AnyWorld): void {
  originalBuildTravelerIndex.call(this);
  if (this.workerPedStep) return;
  const s = this.store;
  for (let i = 0; i < s.count; i++) if (s.state[i] === AgentState.ToRailStation) this.grid.insert(i, s.posX[i], s.posZ[i]);
};

proto.activitySnapshot = function activitySnapshotWithRail(this: AnyWorld): Record<string, number> {
  const snapshot = originalActivitySnapshot.call(this);
  let approaching = 0, waiting = 0, onboard = 0;
  const s = this.store;
  for (let i = 0; i < s.count; i++) {
    if (s.state[i] === AgentState.ToRailStation) approaching++;
    else if (s.state[i] === AgentState.WaitingTrain) waiting++;
    else if (s.state[i] === AgentState.OnTrain) onboard++;
  }
  const railMoving = approaching + waiting;
  snapshot.idle = Math.max(0, (snapshot.idle ?? 0) - railMoving - onboard);
  snapshot.traveling = (snapshot.traveling ?? 0) + railMoving;
  snapshot.ontrain = onboard;
  return snapshot;
};

// 列車乗車中のAgent本体は地上へ描画しない。追跡用の論理座標はWorld側に保持する。
const rendererProto = EnhancedRenderer.prototype as unknown as Record<string, any>;
const originalSyncAgents = rendererProto.syncAgents as (...args: any[]) => void;
rendererProto.syncAgents = function syncAgentsWithoutRailPassengers(this: EnhancedRenderer, store: any, ...args: any[]): void {
  const moved: Array<[number, number, number]> = [];
  for (let i = 0; i < store.count; i++) {
    if (store.state[i] !== AgentState.OnTrain) continue;
    moved.push([i, store.posX[i], store.posZ[i]]);
    store.posX[i] = 1e9; store.posZ[i] = 1e9;
  }
  try { originalSyncAgents.call(this, store, ...args); }
  finally { for (const [i, x, z] of moved) { store.posX[i] = x; store.posZ[i] = z; } }
};

void originalBeginTrip;
