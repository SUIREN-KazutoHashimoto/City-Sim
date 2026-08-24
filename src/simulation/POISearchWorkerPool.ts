import { POICategory, POIRegistry, POISearchSnapshot } from '../world/POI';

export interface POIBestQuery { category: POICategory; x: number; z: number; wealth: number; }
export interface POINearestQuery { category: POICategory; x: number; z: number; }
export interface POIWorkerTiming { totalMs: number; computeMs: number; returnMs: number; workers: number; }
interface PendingJob {
  remaining: number;
  results: Int32Array;
  resolve: (value: Int32Array) => void;
  reject: (reason?: unknown) => void;
  startedAt: number;
  maxComputeMs: number;
  workers: number;
}
interface WorkerReply { type: 'result'; jobId: number; offset: number; results: Int32Array; computeMs: number; }

const ZERO_TIMING: POIWorkerTiming = { totalMs: 0, computeMs: 0, returnMs: 0, workers: 0 };
// The normal Agent decision budget is 512 queries/step. BENCH data shows these small
// batches spend far more time waiting for Worker -> main resumption than searching.
// Keep Workers for future/larger bulk queries, but execute normal batches synchronously.
const MAIN_THREAD_QUERY_THRESHOLD = 512;

/**
 * 読み取り専用POI検索を複数Web Workerへ分配する。
 * occupancyだけSharedArrayBufferで共有し、reserve/release自体はCoordinator側に残す。
 *
 * Runtime query batches are converted to compact TypedArrays and transferred to workers.
 * This avoids structured-cloning hundreds of small JS objects on every simulation step.
 * Normal decision-sized batches intentionally stay on the Coordinator thread because the
 * indexed POI lookup is sub-millisecond while Worker completion latency is often tens of ms.
 */
export class POISearchWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private nextJobId = 1;
  private latestTimingValue: POIWorkerTiming = ZERO_TIMING;

  constructor(private readonly poi: POIRegistry) {
    if (typeof Worker === 'undefined') return;
    const snapshot = poi.createSearchSnapshot();
    if (typeof SharedArrayBuffer === 'undefined' || !(snapshot.occupancy.buffer instanceof SharedArrayBuffer)) return;
    const hc = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
    const count = Math.max(1, Math.min(3, Math.floor(Math.max(2, hc - 2) / 3)));
    for (let i = 0; i < count; i++) this.addWorker(snapshot);
  }

  private addWorker(snapshot: POISearchSnapshot): void {
    const worker = new Worker(new URL('../workers/poiWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
      if (ev.data.type !== 'result') return;
      const job = this.pending.get(ev.data.jobId); if (!job) return;
      job.results.set(ev.data.results, ev.data.offset);
      job.maxComputeMs = Math.max(job.maxComputeMs, Math.max(0, ev.data.computeMs));
      job.remaining--;
      if (job.remaining <= 0) {
        this.pending.delete(ev.data.jobId);
        const totalMs = performance.now() - job.startedAt;
        this.latestTimingValue = {
          totalMs,
          computeMs: job.maxComputeMs,
          returnMs: Math.max(0, totalMs - job.maxComputeMs),
          workers: job.workers,
        };
        job.resolve(job.results);
      }
    };
    worker.onerror = (ev) => {
      const err = new Error(`POI worker failed: ${ev.message}`);
      for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(err); }
    };
    worker.postMessage({
      type: 'init', cellSize: snapshot.cellSize,
      x: snapshot.x, z: snapshot.z, priceTier: snapshot.priceTier,
      capacity: snapshot.capacity, category: snapshot.category,
      occupancy: snapshot.occupancy,
    });
    this.workers.push(worker);
  }

  get active(): boolean { return this.workers.length > 0; }
  get workerCount(): number { return this.workers.length; }
  get latestTiming(): POIWorkerTiming { return this.latestTimingValue; }

  findBestBatch(queries: readonly POIBestQuery[]): Promise<Int32Array> {
    if (queries.length === 0) { this.latestTimingValue = ZERO_TIMING; return Promise.resolve(new Int32Array(0)); }
    if (!this.active || queries.length <= MAIN_THREAD_QUERY_THRESHOLD) {
      this.latestTimingValue = ZERO_TIMING;
      return Promise.resolve(Int32Array.from(queries, (q) => this.poi.findBest(q.category, q.x, q.z, q.wealth)));
    }
    return this.dispatch('best', queries);
  }

  findNearestBatch(queries: readonly POINearestQuery[]): Promise<Int32Array> {
    if (queries.length === 0) { this.latestTimingValue = ZERO_TIMING; return Promise.resolve(new Int32Array(0)); }
    if (!this.active || queries.length <= MAIN_THREAD_QUERY_THRESHOLD) {
      this.latestTimingValue = ZERO_TIMING;
      return Promise.resolve(Int32Array.from(queries, (q) => this.poi.findNearestFree(q.category, q.x, q.z)));
    }
    return this.dispatch('nearest', queries);
  }

  private dispatch(kind: 'best' | 'nearest', queries: readonly (POIBestQuery | POINearestQuery)[]): Promise<Int32Array> {
    const used = Math.min(this.workers.length, queries.length), jobId = this.nextJobId++;
    const results = new Int32Array(queries.length); results.fill(-1);
    const startedAt = performance.now();
    return new Promise<Int32Array>((resolve, reject) => {
      this.pending.set(jobId, { remaining: used, results, resolve, reject, startedAt, maxComputeMs: 0, workers: used });
      for (let w = 0; w < used; w++) {
        const begin = Math.floor((queries.length * w) / used), end = Math.floor((queries.length * (w + 1)) / used), count = end - begin;
        const categories = new Uint8Array(count), xs = new Float32Array(count), zs = new Float32Array(count), wealth = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const q = queries[begin + i];
          categories[i] = q.category; xs[i] = q.x; zs[i] = q.z;
          wealth[i] = 'wealth' in q ? q.wealth : 0;
        }
        this.workers[w].postMessage(
          { type: 'search', kind, jobId, offset: begin, categories, xs, zs, wealth },
          [categories.buffer, xs.buffer, zs.buffer, wealth.buffer],
        );
      }
    });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(new Error('POI worker pool disposed')); }
  }
}
