import { AgentStore } from '../agents/AgentStore';
import { resolveSimulationWorkerTopology } from './WorkerTopology';

interface PendingJob { resolve: () => void; reject: (reason?: unknown) => void; }
interface WorkerReply { type: 'done'; jobId: number; }
interface WaitAsyncResult { async: boolean; value: string | Promise<string>; }
interface AtomicsWithWaitAsync { waitAsync?: (array: Int32Array, index: number, value: number, timeout?: number) => WaitAsyncResult; }

const JOB_EPOCH = 0;
const JOB_ID = 1;
const ACTIVE_WORKERS = 2;
const DONE_COUNT = 3;
const DONE_EPOCH = 4;
const CONTROL_SIZE = 5;
const PARAM_DT = 0;
const PARAM_NOW = 1;

/**
 * SharedArrayBuffer上のAgent SoAを複数Web Workerで分割更新する。
 *
 * Workers are persistent and sleep on JOB_EPOCH. This removes the per-batch fan-out of
 * postMessage calls and, where Atomics.waitAsync is available, also removes Worker->main done
 * message delivery. Agent behavior and partition ranges are unchanged.
 */
export class AgentWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private readonly exitIds: Int32Array;
  private readonly exitCount: Int32Array;
  private readonly control: Int32Array;
  private readonly ranges: Int32Array;
  private readonly params: Float64Array;
  private readonly useAtomicsCompletion: boolean;
  private nextJobId = 1;

  constructor(private readonly store: AgentStore) {
    const shared = store.sharedMemory && typeof SharedArrayBuffer !== 'undefined';
    const topology = resolveSimulationWorkerTopology();
    const workerCount = topology.agentWorkers;
    const waitAsync = (Atomics as unknown as AtomicsWithWaitAsync).waitAsync;
    this.useAtomicsCompletion = shared && typeof waitAsync === 'function';
    const alloc = (bytes: number): ArrayBufferLike => shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);

    this.exitIds = new Int32Array(alloc(store.capacity * Int32Array.BYTES_PER_ELEMENT));
    this.exitCount = new Int32Array(alloc(Int32Array.BYTES_PER_ELEMENT));
    this.control = new Int32Array(alloc(CONTROL_SIZE * Int32Array.BYTES_PER_ELEMENT));
    this.ranges = new Int32Array(alloc(workerCount * 2 * Int32Array.BYTES_PER_ELEMENT));
    this.params = new Float64Array(alloc(2 * Float64Array.BYTES_PER_ELEMENT));

    if (!shared || typeof Worker === 'undefined') return;
    const buffers = {
      energy: store.energy.buffer as SharedArrayBuffer,
      hunger: store.hunger.buffer as SharedArrayBuffer,
      social: store.social.buffer as SharedArrayBuffer,
      hygiene: store.hygiene.buffer as SharedArrayBuffer,
      fun: store.fun.buffer as SharedArrayBuffer,
      wealth: store.wealth.buffer as SharedArrayBuffer,
      state: store.state.buffer as SharedArrayBuffer,
      goalCategory: store.goalCategory.buffer as SharedArrayBuffer,
      dwellUntil: store.dwellUntil.buffer as SharedArrayBuffer,
      activityExit: store.activityExit.buffer as SharedArrayBuffer,
      exitIds: this.exitIds.buffer as SharedArrayBuffer,
      exitCount: this.exitCount.buffer as SharedArrayBuffer,
      control: this.control.buffer as SharedArrayBuffer,
      ranges: this.ranges.buffer as SharedArrayBuffer,
      params: this.params.buffer as SharedArrayBuffer,
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL('../workers/agentWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
        if (ev.data.type !== 'done') return;
        const job = this.pending.get(ev.data.jobId); if (!job) return;
        this.pending.delete(ev.data.jobId); job.resolve();
      };
      worker.onerror = (ev) => {
        const err = new Error(`Agent worker failed: ${ev.message}`);
        for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(err); }
        for (const w of this.workers) w.terminate();
        this.workers.length = 0;
      };
      worker.postMessage({
        type: 'init', workerId: i, workerCount, completionByAtomics: this.useAtomicsCompletion, buffers,
      });
      this.workers.push(worker);
    }
  }

  get active(): boolean { return this.workers.length > 0; }
  get workerCount(): number { return this.workers.length; }
  get completionMode(): 'atomics' | 'message' { return this.useAtomicsCompletion ? 'atomics' : 'message'; }

  updateAgentBatch(dt: number, now: number, count = this.store.count): Promise<void> {
    if (!this.active || count <= 0 || dt <= 0) return Promise.resolve();
    Atomics.store(this.exitCount, 0, 0);
    const used = Math.min(this.workers.length, count), jobId = this.nextJobId++;

    for (let w = 0; w < this.workers.length; w++) {
      const begin = w < used ? Math.floor((count * w) / used) : 0;
      const end = w < used ? Math.floor((count * (w + 1)) / used) : 0;
      this.ranges[w * 2] = begin; this.ranges[w * 2 + 1] = end;
    }
    this.params[PARAM_DT] = dt; this.params[PARAM_NOW] = now;

    if (this.useAtomicsCompletion) {
      const expectedDoneEpoch = Atomics.load(this.control, DONE_EPOCH);
      return new Promise<void>((resolve, reject) => {
        this.pending.set(jobId, { resolve, reject });
        const done = this.waitForDone(expectedDoneEpoch);
        done.then(() => {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId); job.resolve();
        }, (reason) => {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId); job.reject(reason);
        });
        try { this.dispatch(jobId, used); }
        catch (reason) {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId); job.reject(reason);
        }
      });
    }

    return new Promise<void>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.dispatch(jobId, used);
    });
  }

  private dispatch(jobId: number, used: number): void {
    Atomics.store(this.control, JOB_ID, jobId);
    Atomics.store(this.control, ACTIVE_WORKERS, used);
    Atomics.store(this.control, DONE_COUNT, 0);
    Atomics.add(this.control, JOB_EPOCH, 1);
    // Atomics.notify cannot choose specific waiters, so wake the full persistent pool. Workers with
    // an empty range immediately participate in completion without touching Agent state.
    Atomics.notify(this.control, JOB_EPOCH, this.workers.length);
  }

  private async waitForDone(expectedEpoch: number): Promise<void> {
    const fn = (Atomics as unknown as AtomicsWithWaitAsync).waitAsync;
    if (typeof fn !== 'function') throw new Error('Atomics.waitAsync unavailable after atomics completion was selected');
    const result = fn(this.control, DONE_EPOCH, expectedEpoch);
    if (result.async) await result.value;
  }

  /** IDs flagged by the last completed worker batch. Returned view is copied before the next batch. */
  drainActivityExits(): Int32Array {
    const count = Math.min(this.store.count, Math.max(0, Atomics.load(this.exitCount, 0)));
    return this.exitIds.slice(0, count);
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(new Error('Agent worker pool disposed')); }
  }
}
