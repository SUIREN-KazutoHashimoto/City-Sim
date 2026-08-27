import { PowerSystem } from './PowerSystem';

type AnyMethod = (...args: any[]) => any;
type PowerConsumer = Record<string, any>;

export interface PowerPerformanceSnapshot {
  updateCount: number;
  distributionCount: number;
  demandUpdateCount: number;
  topologyRebuildCount: number;
  skippedDemandUpdateCount: number;
  consumerCount: number;
  cachedPathCount: number;
  lastUpdateMs: number;
  averageUpdateMs: number;
  maxUpdateMs: number;
  lastDistributionMs: number;
  averageDistributionMs: number;
  lastDemandUpdateMs: number;
  averageDemandUpdateMs: number;
  lastTopologyRebuildMs: number;
  averageTopologyRebuildMs: number;
  demandUpdateIntervalSec: number;
  placementFingerprint: string;
}

interface PerfState {
  consumers: PowerConsumer[] | null;
  lastDemandSimSeconds: number;
  updateCount: number;
  distributionCount: number;
  demandUpdateCount: number;
  topologyRebuildCount: number;
  skippedDemandUpdateCount: number;
  cachedPathCount: number;
  lastUpdateMs: number;
  totalUpdateMs: number;
  maxUpdateMs: number;
  lastDistributionMs: number;
  totalDistributionMs: number;
  lastDemandUpdateMs: number;
  totalDemandUpdateMs: number;
  lastTopologyRebuildMs: number;
  totalTopologyRebuildMs: number;
}

const states = new WeakMap<PowerSystem, PerfState>();
const combinedPathCache = new WeakMap<object, WeakMap<object, number[]>>();

function stateOf(system: PowerSystem): PerfState {
  let state = states.get(system);
  if (!state) {
    state = {
      consumers: null, lastDemandSimSeconds: Number.NEGATIVE_INFINITY,
      updateCount: 0, distributionCount: 0, demandUpdateCount: 0, topologyRebuildCount: 0, skippedDemandUpdateCount: 0, cachedPathCount: 0,
      lastUpdateMs: 0, totalUpdateMs: 0, maxUpdateMs: 0,
      lastDistributionMs: 0, totalDistributionMs: 0,
      lastDemandUpdateMs: 0, totalDemandUpdateMs: 0,
      lastTopologyRebuildMs: 0, totalTopologyRebuildMs: 0,
    };
    states.set(system, state);
  }
  return state;
}

function nowMs(): number { return globalThis.performance?.now?.() ?? Date.now(); }
function demandInterval(system: PowerSystem): number {
  const configured = Number((system.config as unknown as Record<string, unknown>).demandUpdateIntervalSec);
  return Number.isFinite(configured) ? Math.max(system.config.updateIntervalSec, configured) : Math.max(system.config.updateIntervalSec, 15);
}
function fingerprint(system: PowerSystem): string {
  let hash = 2166136261 >>> 0;
  const feed = (value: number): void => {
    hash ^= Math.round(value * 10) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  for (const item of system.generationFacilities) { feed(item.x); feed(item.z); feed(item.roadNodeId); }
  for (const item of system.substations) { feed(item.x); feed(item.z); feed(item.roadNodeId); }
  return hash.toString(16).padStart(8, '0');
}

declare module './PowerSystem' {
  interface PowerSystem { powerPerformanceSnapshot(): PowerPerformanceSnapshot; }
}

const proto = PowerSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimPowerPerformanceV1011) {
  const previousAllConsumers = proto.allConsumers as AnyMethod;
  proto.allConsumers = function cachedAllConsumers(this: PowerSystem): PowerConsumer[] {
    const state = stateOf(this);
    if (!state.consumers) state.consumers = previousAllConsumers.call(this) as PowerConsumer[];
    return state.consumers;
  };

  const previousUniquePath = proto.uniquePath as AnyMethod;
  proto.uniquePath = function cachedUniquePath(this: PowerSystem, a: readonly number[], b: readonly number[]): number[] {
    const aKey = a as unknown as object, bKey = b as unknown as object;
    let bySecond = combinedPathCache.get(aKey);
    if (!bySecond) { bySecond = new WeakMap<object, number[]>(); combinedPathCache.set(aKey, bySecond); }
    const cached = bySecond.get(bKey);
    if (cached) return cached;
    const path = previousUniquePath.call(this, a, b) as number[];
    bySecond.set(bKey, path);
    stateOf(this).cachedPathCount++;
    return path;
  };

  const previousDemand = proto.updateDemand as AnyMethod;
  proto.updateDemand = function throttledDemand(this: PowerSystem, totalSimSeconds: number): void {
    const state = stateOf(this), interval = demandInterval(this);
    if (Number.isFinite(state.lastDemandSimSeconds) && totalSimSeconds >= state.lastDemandSimSeconds && totalSimSeconds - state.lastDemandSimSeconds + 1e-9 < interval) {
      state.skippedDemandUpdateCount++;
      return;
    }
    const start = nowMs();
    previousDemand.call(this, totalSimSeconds);
    const elapsed = nowMs() - start;
    state.lastDemandSimSeconds = totalSimSeconds;
    state.demandUpdateCount++;
    state.lastDemandUpdateMs = elapsed;
    state.totalDemandUpdateMs += elapsed;
  };

  const previousTopology = proto.rebuildTopology as AnyMethod;
  proto.rebuildTopology = function measuredTopology(this: PowerSystem): void {
    const state = stateOf(this), start = nowMs();
    previousTopology.call(this);
    const elapsed = nowMs() - start;
    state.topologyRebuildCount++;
    state.lastTopologyRebuildMs = elapsed;
    state.totalTopologyRebuildMs += elapsed;
  };

  const previousDistribute = proto.distributePower as AnyMethod;
  proto.distributePower = function measuredDistribution(this: PowerSystem): void {
    const state = stateOf(this), start = nowMs();
    previousDistribute.call(this);
    const elapsed = nowMs() - start;
    state.distributionCount++;
    state.lastDistributionMs = elapsed;
    state.totalDistributionMs += elapsed;
  };

  const previousUpdate = proto.update as AnyMethod;
  proto.update = function measuredPowerUpdate(this: PowerSystem, ...args: any[]): void {
    const state = stateOf(this), before = state.distributionCount, start = nowMs();
    previousUpdate.apply(this, args);
    if (state.distributionCount === before) return;
    const elapsed = nowMs() - start;
    state.updateCount++;
    state.lastUpdateMs = elapsed;
    state.totalUpdateMs += elapsed;
    state.maxUpdateMs = Math.max(state.maxUpdateMs, elapsed);
  };

  proto.powerPerformanceSnapshot = function powerPerformanceSnapshot(this: PowerSystem): PowerPerformanceSnapshot {
    const state = stateOf(this), consumerCount = state.consumers?.length ?? this.buildingConnections.size + this.infrastructureLoads.length;
    return {
      updateCount: state.updateCount,
      distributionCount: state.distributionCount,
      demandUpdateCount: state.demandUpdateCount,
      topologyRebuildCount: state.topologyRebuildCount,
      skippedDemandUpdateCount: state.skippedDemandUpdateCount,
      consumerCount,
      cachedPathCount: state.cachedPathCount,
      lastUpdateMs: state.lastUpdateMs,
      averageUpdateMs: state.updateCount ? state.totalUpdateMs / state.updateCount : 0,
      maxUpdateMs: state.maxUpdateMs,
      lastDistributionMs: state.lastDistributionMs,
      averageDistributionMs: state.distributionCount ? state.totalDistributionMs / state.distributionCount : 0,
      lastDemandUpdateMs: state.lastDemandUpdateMs,
      averageDemandUpdateMs: state.demandUpdateCount ? state.totalDemandUpdateMs / state.demandUpdateCount : 0,
      lastTopologyRebuildMs: state.lastTopologyRebuildMs,
      averageTopologyRebuildMs: state.topologyRebuildCount ? state.totalTopologyRebuildMs / state.topologyRebuildCount : 0,
      demandUpdateIntervalSec: demandInterval(this),
      placementFingerprint: fingerprint(this),
    };
  };

  proto.__citySimPowerPerformanceV1011 = true;
}
