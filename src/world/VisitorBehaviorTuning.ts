import { AgentState, type AgentStore } from '../agents/AgentStore';
import { World } from './World';
import {
  ExternalVisitorSystem,
  latestExternalVisitorSystem,
  type ExternalVisitorPurpose,
  type ExternalVisitorStationAccess,
} from './ExternalVisitorSystem';

type AnyMethod = (...args: any[]) => any;
type AnyWorld = any;
type VisitorRuntime = Record<string, any> & {
  store: AgentStore;
  active: Uint8Array;
  leaveAt: Float64Array;
};

const SHOPPING_MIN_HOURS = 6;
const SHOPPING_SPAN_HOURS = 12;
const HOTEL_MIN_HOURS = 24;
const HOTEL_SPAN_HOURS = 72;
const VISITOR_BUS_STOP_RADIUS = 520;
const VISITOR_BUS_MIN_TRIP = 120;
const HSR_SAFE_WAIT_SPAN = 180;

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function visitorRuntime(store: AgentStore): VisitorRuntime | null {
  const system = latestExternalVisitorSystem() as unknown as VisitorRuntime | null;
  return system?.store === store ? system : null;
}

const visitorProto = ExternalVisitorSystem.prototype as unknown as Record<string, any>;
if (!visitorProto.__citySimVisitorBehaviorV067) {
  const previousSpawn = visitorProto.spawnVisitor as AnyMethod;
  visitorProto.spawnVisitor = function spawnVisitorWithRequestedStay(
    this: VisitorRuntime,
    station: unknown,
    purpose: ExternalVisitorPurpose,
    now: number,
    salt: number,
    direction: 1 | -1,
  ): number {
    const id = previousSpawn.call(this, station, purpose, now, salt, direction) as number;
    if (id < 0) return id;

    if (purpose === 'shopping') {
      const hours = SHOPPING_MIN_HOURS + hash01(salt * 53 + 13) * SHOPPING_SPAN_HOURS;
      this.leaveAt[id] = now + hours * 3600;
    } else if (purpose === 'hotel') {
      const hours = HOTEL_MIN_HOURS + hash01(salt * 61 + 19) * HOTEL_SPAN_HOURS;
      this.leaveAt[id] = now + hours * 3600;
    }
    return id;
  };

  const previousRegister = visitorProto.registerHighSpeedStationAccess as AnyMethod;
  visitorProto.registerHighSpeedStationAccess = function registerHighSpeedStationAccessWithSafeWaitSpan(
    this: VisitorRuntime,
    accesses: ExternalVisitorStationAccess[],
    railProvider?: unknown,
  ): void {
    const safeAccesses = accesses.map((access) => ({
      ...access,
      waitSpan: Math.min(access.waitSpan, HSR_SAFE_WAIT_SPAN),
    }));
    previousRegister.call(this, safeAccesses, railProvider);
  };

  visitorProto.__citySimVisitorBehaviorV067 = true;
}

const worldProto = World.prototype as unknown as Record<string, any>;
if (!worldProto.__citySimVisitorTransitBiasV067) {
  const previousBeginTrip = worldProto.beginTrip as AnyMethod;
  worldProto.beginTrip = function beginTripWithVisitorTransitBias(this: AnyWorld, agent: number): void {
    previousBeginTrip.call(this, agent);

    const runtime = visitorRuntime(this.store);
    if (!runtime || runtime.active[agent] !== 1) return;

    const s = this.store;
    if (s.state[agent] !== AgentState.Traveling) return;

    const tripDistance = Math.hypot(s.goalX[agent] - s.posX[agent], s.goalZ[agent] - s.posZ[agent]);
    if (tripDistance < VISITOR_BUS_MIN_TRIP) return;

    const board = this.bus.nearestStop(s.posX[agent], s.posZ[agent], VISITOR_BUS_STOP_RADIUS);
    const alight = this.bus.nearestStop(s.goalX[agent], s.goalZ[agent], VISITOR_BUS_STOP_RADIUS);
    const route = this.bus.sharedRoute(board, alight);
    if (route < 0) return;

    s.boardStop[agent] = board;
    s.alightStop[agent] = alight;
    s.busRoute[agent] = route;
    const stop = this.bus.stopById(board);
    this.assignWalkPath(agent, stop.x, stop.z);
    s.state[agent] = AgentState.ToBusStop;
  };

  worldProto.__citySimVisitorTransitBiasV067 = true;
}
