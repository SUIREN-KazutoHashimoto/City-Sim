import { AgentState } from '../agents/AgentStore';
import { latestRailPassengerProvider } from '../rendering/RailPassengerBridge';
import { World } from './World';

declare module './World' {
  interface World {
    railTrainPassengerCount(trainId: number): number;
  }
}

type AnyWorld = any;
const countsByWorld = new WeakMap<object, Map<number, number>>();

function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function refreshRailPassengerCounts(world: World): void {
  const provider = latestRailPassengerProvider();
  const counts = new Map<number, number>();
  countsByWorld.set(world, counts);
  if (!provider) return;

  const trains = provider.passengerTrainPositions();
  if (!trains.length) return;

  const cell = 2;
  const index = new Map<string, typeof trains>();
  const key = (x: number, z: number): string => `${Math.round(x / cell)}:${Math.round(z / cell)}`;
  for (const train of trains) {
    const k = key(train.x, train.z);
    const list = index.get(k);
    if (list) list.push(train); else index.set(k, [train]);
  }

  const store = world.store;
  for (let agent = 0; agent < store.count; agent++) {
    if (store.state[agent] !== AgentState.OnTrain) continue;
    const cx = Math.round(store.posX[agent] / cell), cz = Math.round(store.posZ[agent] / cell);
    let bestId = -1, bestScore = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const list = index.get(`${cx + dx}:${cz + dz}`); if (!list) continue;
      for (const train of list) {
        const distance = Math.hypot(store.posX[agent] - train.x, store.posZ[agent] - train.z);
        if (distance > 5) continue;
        const score = distance + angleDelta(store.heading[agent], train.heading) * 0.35;
        if (score < bestScore) { bestScore = score; bestId = train.id; }
      }
    }
    if (bestId >= 0) counts.set(bestId, (counts.get(bestId) ?? 0) + 1);
  }
}

const proto = World.prototype as unknown as AnyWorld;
const originalStepBeforePed = proto.stepBeforePed as (dt: number, needs: boolean, decisions: boolean) => number;

proto.stepBeforePed = function stepBeforePedWithRailMetrics(this: World, dt: number, needs: boolean, decisions: boolean): number {
  const result = originalStepBeforePed.call(this, dt, needs, decisions);
  refreshRailPassengerCounts(this);
  return result;
};

proto.railTrainPassengerCount = function railTrainPassengerCount(this: World, trainId: number): number {
  return countsByWorld.get(this)?.get(trainId) ?? 0;
};
