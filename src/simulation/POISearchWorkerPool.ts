import { POICategory, POIRegistry, POISearchSnapshot } from '../world/POI';

export interface POIBestQuery { category: POICategory; x: number; z: number; wealth: number; }
export interface POINearestQuery { category: POICategory; x: number; z: number; }
interface PendingJob { remaining: number; results: Int32Array; resolve: (value: Int32Array) => void; reject: (reason?: unknown) => void; }
interface WorkerReply { type: 'result'; jobId: number; offset: number; results: Int32Array; }

/**
 * 読み取り専用POI検索を複数Web Workerへ分配する。
 * occupancyだけSharedArrayBufferで共有し、reserve/release自体はCoordinator側に残す。
 */
export class POISearchWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private nextJobId = 1;

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
      job.remaining--;
      if (job.remaining <= 0) { this.pending.delete(ev.data.jobId); job.resolve(job.results); }
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

  findBestBatch(queries: readonly POIBestQuery[]): Promise<Int32Array> {
    if (queries.length === 0) return Promise.resolve(new Int32Array(0));
    if (!this.active) return Promise.resolve(Int32Array.from(queries, (q) => this.poi.findBest(q.category, q.x, q.z, q.wealth)));
    return this.dispatch('best', queries);
  }

  findNearestBatch(queries: readonly POINearestQuery[]): Promise<Int32Array> {
    if (queries.length === 0) return Promise.resolve(new Int32Array(0));
    if (!this.active) return Promise.resolve(Int32Array.from(queries, (q) => this.poi.findNearestFree(q.category, q.x, q.z)));
    return this.dispatch('nearest', queries);
  }

  private dispatch(kind: 'best' | 'nearest', queries: readonly (POIBestQuery | POINearestQuery)[]): Promise<Int32Array> {
    const used = Math.min(this.workers.length, queries.length), jobId = this.nextJobId++;
    const results = new Int32Array(queries.length); results.fill(-1);
    return new Promise<Int32Array>((resolve, reject) => {
      this.pending.set(jobId, { remaining: used, results, resolve, reject });
      for (let w = 0; w < used; w++) {
        const begin = Math.floor((queries.length * w) / used), end = Math.floor((queries.length * (w + 1)) / used);
        this.workers[w].postMessage({ type: 'search', kind, jobId, offset: begin, queries: queries.slice(begin, end) });
      }
    });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(new Error('POI worker pool disposed')); }
  }
}
