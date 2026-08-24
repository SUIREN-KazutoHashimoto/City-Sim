export interface SimulationWorkerTopology {
  hardwareConcurrency: number;
  reservedThreads: number;
  agentWorkers: number;
  pedestrianWorkers: number;
  poiWorkers: number;
}

/**
 * Central worker-count policy.
 *
 * The pools currently execute mostly in separate simulation phases, so these numbers describe
 * per-phase parallelism rather than workers that are expected to be busy simultaneously. Keeping
 * the policy in one place makes it possible to tune for 8C/16T-class desktop CPUs without
 * scattering navigator.hardwareConcurrency heuristics across every pool.
 *
 * The current caps intentionally preserve the existing execution shape. The coordinator-worker
 * migration can raise/rebalance these caps later after state ownership is moved off the main
 * thread and measured with the same benchmark.
 */
export function resolveSimulationWorkerTopology(): SimulationWorkerTopology {
  const hc = typeof navigator !== 'undefined' ? Math.max(1, navigator.hardwareConcurrency || 4) : 4;
  const reservedThreads = Math.min(2, Math.max(1, hc - 1));
  const usable = Math.max(1, hc - reservedThreads);

  return {
    hardwareConcurrency: hc,
    reservedThreads,
    agentWorkers: Math.max(1, Math.min(8, usable)),
    pedestrianWorkers: Math.max(1, Math.min(4, usable)),
    poiWorkers: Math.max(1, Math.min(3, Math.floor(Math.max(2, usable) / 3))),
  };
}
