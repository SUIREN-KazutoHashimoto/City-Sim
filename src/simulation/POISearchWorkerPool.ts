import { POICategory, POIRegistry, POISearchSnapshot } from '../world/POI';
import { resolveSimulationWorkerTopology } from './WorkerTopology';

export interface POIBestQuery { category: POICategory; x: number; z: number; wealth: number; }
export interface POINearestQuery { category: POICategory; x: number; z: number; }
interface PendingJob { resolve: () => void; reject: (reason?: unknown) => void; }
interface WorkerReply { type: 'done'; jobId: number; }
interface WaitAsyncResult { async: boolean; value: string | Promise<string>; }
interface AtomicsWithWaitAsync { waitAsync?: (array: Int32Array, index: number, value: number, timeout?: number) => WaitAsyncResult; }

const JOB_EPOCH = 0;
const JOB_ID = 1;
const JOB_KIND = 2;
const JOB_COUNT = 3;
const DONE_COUNT = 4;
const DONE_EPOCH = 5;
const CONTROL_SIZE = 6;
const KIND_BEST = 0;
const KIND_NEAREST = 1;
const MAX_SHARED_QUERY_BATCH = 8192;

/**
 * 読み取り専用POI検索を複数Web Workerへ分配する。
 * occupancyだけSharedArrayBufferで共有し、reserve/release自体はCoordinator側に残す。
 *
 * The hot path uses persistent workers plus reusable SharedArrayBuffer query/result arrays. This
 * preserves query order and search semantics while removing per-step TypedArray allocation,
 * structured clone/transfer, and Worker result-message fan-in. postMessage is retained only as a
 * completion fallback when Atomics.waitAsync is unavailable.
 */
export class POISearchWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private readonly control: Int32Array;
  private readonly ranges: Int32Array;
  private readonly categories: Uint8Array;
  private readonly xs: Float32Array;
  private readonly zs: Float32Array;
  private readonly wealth: Float32Array;
  private readonly results: Int32Array;
  private readonly useAtomicsCompletion: boolean;
  private nextJobId = 1;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly poi: POIRegistry) {
    const snapshot = poi.createSearchSnapshot();
    const shared = typeof SharedArrayBuffer !== 'undefined' && snapshot.occupancy.buffer instanceof SharedArrayBuffer;
    const topology = resolveSimulationWorkerTopology();
    const workerCount = topology.poiWorkers;
    const alloc = (bytes: number): ArrayBufferLike => shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    const waitAsync = (Atomics as unknown as AtomicsWithWaitAsync).waitAsync;
    this.useAtomicsCompletion = shared && typeof waitAsync === 'function';

    this.control = new Int32Array(alloc(CONTROL_SIZE * Int32Array.BYTES_PER_ELEMENT));
    this.ranges = new Int32Array(alloc(workerCount * 2 * Int32Array.BYTES_PER_ELEMENT));
    this.categories = new Uint8Array(alloc(MAX_SHARED_QUERY_BATCH * Uint8Array.BYTES_PER_ELEMENT));
    this.xs = new Float32Array(alloc(MAX_SHARED_QUERY_BATCH * Float32Array.BYTES_PER_ELEMENT));
    this.zs = new Float32Array(alloc(MAX_SHARED_QUERY_BATCH * Float32Array.BYTES_PER_ELEMENT));
    this.wealth = new Float32Array(alloc(MAX_SHARED_QUERY_BATCH * Float32Array.BYTES_PER_ELEMENT));
    this.results = new Int32Array(alloc(MAX_SHARED_QUERY_BATCH * Int32Array.BYTES_PER_ELEMENT));

    if (!shared || typeof Worker === 'undefined') return;
    for (let i = 0; i < workerCount; i++) this.addWorker(snapshot, i, workerCount);
  }

  private addWorker(snapshot: POISearchSnapshot, workerId: number, workerCount: number): void {
    const worker = new Worker(new URL('../workers/poiWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
      if (ev.data.type !== 'done') return;
      const job = this.pending.get(ev.data.jobId); if (!job) return;
      this.pending.delete(ev.data.jobId); job.resolve();
    };
    worker.onerror = (ev) => {
      const err = new Error(`POI worker failed: ${ev.message}`);
      for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(err); }
      for (const w of this.workers) w.terminate();
      this.workers.length = 0;
    };
    worker.postMessage({
      type: 'init', workerId, workerCount, completionByAtomics: this.useAtomicsCompletion, cellSize: snapshot.cellSize,
      x: snapshot.x, z: snapshot.z, priceTier: snapshot.priceTier,
      capacity: snapshot.capacity, category: snapshot.category, occupancy: snapshot.occupancy,
      shared: {
        control: this.control.buffer, ranges: this.ranges.buffer,
        categories: this.categories.buffer, xs: this.xs.buffer, zs: this.zs.buffer, wealth: this.wealth.buffer, results: this.results.buffer,
      },
    });
    this.workers.push(worker);
  }

  get active(): boolean { return this.workers.length > 0; }
  get workerCount(): number { return this.workers.length; }
  get completionMode(): 'atomics' | 'message' { return this.useAtomicsCompletion ? 'atomics' : 'message'; }

  findBestBatch(queries: readonly POIBestQuery[]): Promise<Int32Array> {
    if (queries.length === 0) return Promise.resolve(new Int32Array(0));
    if (!this.active) return Promise.resolve(Int32Array.from(queries, (q) => this.poi.findBest(q.category, q.x, q.z, q.wealth)));
    return this.enqueue(KIND_BEST, queries);
  }

  findNearestBatch(queries: readonly POINearestQuery[]): Promise<Int32Array> {
    if (queries.length === 0) return Promise.resolve(new Int32Array(0));
    if (!this.active) return Promise.resolve(Int32Array.from(queries, (q) => this.poi.findNearestFree(q.category, q.x, q.z)));
    return this.enqueue(KIND_NEAREST, queries);
  }

  /** Serialize access to the reusable shared buffers; current World calls are already sequential. */
  private enqueue(kind: number, queries: readonly (POIBestQuery | POINearestQuery)[]): Promise<Int32Array> {
    let resolveResult!: (value: Int32Array) => void;
    let rejectResult!: (reason?: unknown) => void;
    const resultPromise = new Promise<Int32Array>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const task = this.tail.then(async () => {
      try { resolveResult(await this.dispatchAll(kind, queries)); }
      catch (reason) { rejectResult(reason); }
    });
    this.tail = task.then(() => undefined, () => undefined);
    return resultPromise;
  }

  private async dispatchAll(kind: number, queries: readonly (POIBestQuery | POINearestQuery)[]): Promise<Int32Array> {
    if (queries.length <= MAX_SHARED_QUERY_BATCH) return this.dispatchShared(kind, queries);
    const out = new Int32Array(queries.length);
    for (let offset = 0; offset < queries.length; offset += MAX_SHARED_QUERY_BATCH) {
      const end = Math.min(queries.length, offset + MAX_SHARED_QUERY_BATCH);
      out.set(await this.dispatchShared(kind, queries.slice(offset, end)), offset);
    }
    return out;
  }

  private async dispatchShared(kind: number, queries: readonly (POIBestQuery | POINearestQuery)[]): Promise<Int32Array> {
    const count = queries.length;
    for (let i = 0; i < count; i++) {
      const q = queries[i];
      this.categories[i] = q.category; this.xs[i] = q.x; this.zs[i] = q.z;
      this.wealth[i] = 'wealth' in q ? q.wealth : 0;
    }
    const used = Math.min(this.workers.length, Math.max(1, count));
    for (let w = 0; w < this.workers.length; w++) {
      const begin = w < used ? Math.floor((count * w) / used) : 0;
      const end = w < used ? Math.floor((count * (w + 1)) / used) : 0;
      this.ranges[w * 2] = begin; this.ranges[w * 2 + 1] = end;
    }

    const jobId = this.nextJobId++;
    if (this.useAtomicsCompletion) {
      const expectedDoneEpoch = Atomics.load(this.control, DONE_EPOCH);
      await new Promise<void>((resolve, reject) => {
        this.pending.set(jobId, { resolve, reject });
        const done = this.waitForDone(expectedDoneEpoch);
        done.then(() => {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId); job.resolve();
        }, (reason) => {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId); job.reject(reason);
        });
        try { this.dispatch(jobId, kind, count); }
        catch (reason) {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId); job.reject(reason);
        }
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        this.pending.set(jobId, { resolve, reject });
        this.dispatch(jobId, kind, count);
      });
    }
    return this.results.slice(0, count);
  }

  private dispatch(jobId: number, kind: number, count: number): void {
    Atomics.store(this.control, JOB_ID, jobId);
    Atomics.store(this.control, JOB_KIND, kind);
    Atomics.store(this.control, JOB_COUNT, count);
    Atomics.store(this.control, DONE_COUNT, 0);
    Atomics.add(this.control, JOB_EPOCH, 1);
    Atomics.notify(this.control, JOB_EPOCH, this.workers.length);
  }

  private async waitForDone(expectedEpoch: number): Promise<void> {
    const fn = (Atomics as unknown as AtomicsWithWaitAsync).waitAsync;
    if (typeof fn !== 'function') throw new Error('Atomics.waitAsync unavailable after atomics completion was selected');
    const result = fn(this.control, DONE_EPOCH, expectedEpoch);
    if (result.async) await result.value;
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(new Error('POI worker pool disposed')); }
  }
}
