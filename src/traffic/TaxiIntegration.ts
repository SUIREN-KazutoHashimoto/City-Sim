import { AgentState } from '../agents/AgentStore';
import { World } from '../world/World';
import { visitorPresentationInfo } from '../world/VisitorPresentation';
import { TaxiSystem, taxiPassengerInfo } from './TaxiSystem';

type AnyWorld = any;
type AnyMethod = (...args: any[]) => any;

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function taxiChoiceProbability(world: AnyWorld, agent: number, originalState: number, tripDistance: number): number {
  const s = world.store;
  const visitor = visitorPresentationInfo(s, agent);
  if (visitor) {
    if (visitor.purpose === 'hotel') return 0.64;
    if (visitor.purpose === 'tourism') return 0.38;
    return 0.32;
  }

  const hour = (world.clock.totalSeconds / 3600) % 24;
  const night = hour >= 22 || hour < 5 ? 0.16 : 0;
  const wealth = s.wealth[agent];
  const distanceBonus = Math.min(0.12, Math.max(0, tripDistance - 700) / 6000);
  const fallbackBonus = originalState === AgentState.Traveling ? 0.07 : 0;
  return Math.min(0.52, 0.04 + wealth * 0.24 + night + distanceBonus + fallbackBonus);
}

function clearSurfaceTransitState(world: AnyWorld, agent: number): void {
  const s = world.store;
  s.boardStop[agent] = -1;
  s.alightStop[agent] = -1;
  s.busRoute[agent] = -1;
  s.pathHandle[agent] = -1;
  s.waiting[agent] = 0;
  s.velX[agent] = 0;
  s.velZ[agent] = 0;
  const paths = world.walkPaths as Int32Array[] | undefined;
  if (paths && agent < paths.length) paths[agent] = new Int32Array(0);
}

function finishTaxiDropoff(world: AnyWorld, agent: number, x: number, z: number): void {
  const s = world.store;
  s.posX[agent] = x;
  s.posZ[agent] = z;
  s.velX[agent] = 0;
  s.velZ[agent] = 0;
  s.boardStop[agent] = -1;
  s.alightStop[agent] = -1;
  s.busRoute[agent] = -1;

  const distance = Math.hypot(s.goalX[agent] - x, s.goalZ[agent] - z);
  if (distance < 8) {
    const poi = s.goalPOI[agent] >= 0 ? world.city.poi.get(s.goalPOI[agent]) : null;
    s.state[agent] = AgentState.Engaged;
    s.dwellUntil[agent] = poi ? world.computeDwellUntil(poi.category) : world.clock.totalSeconds + 300;
    return;
  }
  world.assignWalkPath(agent, s.goalX[agent], s.goalZ[agent]);
  s.state[agent] = AgentState.Traveling;
}

function cancelTaxi(world: AnyWorld, agent: number): void {
  const s = world.store;
  s.boardStop[agent] = -1;
  s.alightStop[agent] = -1;
  s.busRoute[agent] = -1;
  world.assignWalkPath(agent, s.goalX[agent], s.goalZ[agent]);
  s.state[agent] = AgentState.Traveling;
}

const proto = World.prototype as unknown as Record<string, any>;
if (!proto.__citySimTaxiServiceV071) {
  const previousPopulate = proto.populate as AnyMethod;
  proto.populate = function populateWithTaxis(this: AnyWorld, count: number): void {
    previousPopulate.call(this, count);
    if (!this.__taxiSystem) {
      const system = new TaxiSystem(this.store, this.vehicles, this.traffic, this.city, this.clock);
      system.buildFleet(count);
      this.__taxiSystem = system;
    }
  };

  const previousBeginTrip = proto.beginTrip as AnyMethod;
  proto.beginTrip = function beginTripWithTaxiChoice(this: AnyWorld, agent: number): void {
    previousBeginTrip.call(this, agent);
    const taxi = this.__taxiSystem as TaxiSystem | undefined;
    if (!taxi || taxiPassengerInfo(this.store, agent)) return;

    const s = this.store;
    const mode = s.state[agent];
    if (mode !== AgentState.Traveling && mode !== AgentState.ToBusStop) return;
    const tripDistance = Math.hypot(s.goalX[agent] - s.posX[agent], s.goalZ[agent] - s.posZ[agent]);
    if (tripDistance < 350) return;

    const probability = taxiChoiceProbability(this, agent, mode, tripDistance);
    const day = Math.floor(this.clock.totalSeconds / 86400);
    const roll = hash01(agent * 8191 + Math.max(0, s.goalPOI[agent]) * 131 + day * 17);
    if (roll >= probability) return;

    if (!taxi.request(agent, s.posX[agent], s.posZ[agent], s.goalX[agent], s.goalZ[agent])) return;
    clearSurfaceTransitState(this, agent);
    s.state[agent] = taxiPassengerInfo(s, agent)?.phase === 'onboard' ? AgentState.OnBus : AgentState.WaitingBus;
  };

  const previousStepAfterPed = proto.stepAfterPed as AnyMethod;
  proto.stepAfterPed = function stepAfterPedWithTaxis(
    this: AnyWorld,
    now: number,
    updateActivities: boolean,
    dtSec: number,
  ): void {
    const taxi = this.__taxiSystem as TaxiSystem | undefined;
    if (taxi) {
      taxi.update(
        (agent, x, z) => finishTaxiDropoff(this, agent, x, z),
        (agent) => cancelTaxi(this, agent),
      );
      taxi.forEachPassenger((agent, phase) => {
        this.store.state[agent] = phase === 'onboard' ? AgentState.OnBus : AgentState.WaitingBus;
      });
    }
    previousStepAfterPed.call(this, now, updateActivities, dtSec);
  };

  const previousActivitySnapshot = proto.activitySnapshot as AnyMethod;
  proto.activitySnapshot = function activitySnapshotWithTaxis(this: AnyWorld): Record<string, number> {
    const snapshot = previousActivitySnapshot.call(this) as Record<string, number>;
    let onTaxi = 0;
    const taxi = this.__taxiSystem as TaxiSystem | undefined;
    taxi?.forEachPassenger((_agent, phase) => { if (phase === 'onboard') onTaxi++; });
    if (typeof snapshot.onbus === 'number') snapshot.onbus = Math.max(0, snapshot.onbus - onTaxi);
    snapshot.ontaxi = onTaxi;
    return snapshot;
  };

  proto.__citySimTaxiServiceV071 = true;
}
