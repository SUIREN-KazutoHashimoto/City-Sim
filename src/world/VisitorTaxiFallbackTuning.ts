import { AgentState } from '../agents/AgentStore';
import { TaxiSystem, taxiPassengerInfo } from '../traffic/TaxiSystem';
import { visitorPresentationInfo } from './VisitorPresentation';
import { World } from './World';

type AnyWorld = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const MIN_FALLBACK_TAXI_TRIP = 300;

function clearSurfaceState(world: AnyWorld, agent: number): void {
  const s = world.store;
  s.boardStop[agent] = -1;
  s.alightStop[agent] = -1;
  s.busRoute[agent] = -1;
  s.pathHandle[agent] = -1;
  s.pathCursor[agent] = 0;
  s.waiting[agent] = 0;
  s.velX[agent] = 0;
  s.velZ[agent] = 0;
  const paths = world.walkPaths as Int32Array[] | undefined;
  if (paths && agent < paths.length) paths[agent] = new Int32Array(0);
}

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

const proto = World.prototype as unknown as AnyWorld;
if (!proto.__citySimVisitorTaxiFallbackV102) {
  const previousBeginTrip = proto.beginTrip as AnyMethod;
  proto.beginTrip = function beginTripWithVisitorTaxiFallback(this: AnyWorld, agent: number): void {
    previousBeginTrip.call(this, agent);

    const visitor = visitorPresentationInfo(this.store, agent);
    if (!visitor || taxiPassengerInfo(this.store, agent)) return;

    // A visitor still in Traveling after the normal rail/bus/taxi selection has no usable
    // public-transport itinerary. Prefer a taxi instead of making a long fallback walk.
    const s = this.store;
    if (s.state[agent] !== AgentState.Traveling) return;
    const distance = Math.hypot(s.goalX[agent] - s.posX[agent], s.goalZ[agent] - s.posZ[agent]);
    if (distance < MIN_FALLBACK_TAXI_TRIP) return;

    const probability = visitor.purpose === 'hotel' ? 0.98 : visitor.purpose === 'tourism' ? 0.94 : 0.90;
    const tripSalt = Math.max(0, s.goalPOI[agent]) * 131 + Math.floor(this.clock.totalSeconds / 1800) * 17;
    if (hash01(agent * 8191 + tripSalt) >= probability) return;

    const taxi = this.__taxiSystem as TaxiSystem | undefined;
    if (!taxi?.request(agent, s.posX[agent], s.posZ[agent], s.goalX[agent], s.goalZ[agent])) return;
    clearSurfaceState(this, agent);
    s.state[agent] = taxiPassengerInfo(s, agent)?.phase === 'onboard' ? AgentState.OnBus : AgentState.WaitingBus;
  };
  proto.__citySimVisitorTaxiFallbackV102 = true;
}
