import { AgentStore } from '../agents/AgentStore';

export interface PedestrianWorkerTiming {
  prepMs: number;
  indexMs: number;
  avoidMoveMs: number;
  barrierMs: number;
  totalMs: number;
}

interface PendingJob { resolve: () => void; reject: (reason?: unknown) => void; }
interface WorkerReply { type: 'done'; jobId: number; timing: PedestrianWorkerTiming; }

const ZERO_TIMING: PedestrianWorkerTiming = { prepMs: 0, indexMs: 0, avoidMoveMs: 0, barrierMs: 0, totalMs: 0 };
const METRIC_STRIDE = 5;
const JOB_EPOCH = 4;
const JOB_ID = 5;
const JOB_ACTIVE_COUNT = 6;
const JOB_MOVE_COUNT = 7;
const JOB_DT_MICROS = 8;
const CONTROL_SIZE = 9;

/**
 * Pedestrian spatial index / avoidance / movement integration worker pool.
 *
 * Workers are initialized once and then sleep on a SharedArrayBuffer job epoch. A simulation
 * step is dispatched with Atomics.store/notify rather than one postMessage per worker. This
 * leaves only the final completion postMessage on the hot path and substantially reduces
 * browser task-delivery/scheduling overhead (DispatchGap).
 *
 * Each step:
 * 1. clears only cells used by the previous step and snapshots active pedestrian positions,
 * 2. builds the linked-cell index in parallel using Atomics.exchange,
 * 3. calculates separation/avoidance and integrates movement in parallel.
 */
export class PedestrianWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private nextJobId = 1;

  private readonly desiredX: Float32Array;
  private readonly desiredZ: Float32Array;
  private readonly activeIds: Int32Array;
  private readonly moveIds: Int32Array;
  private readonly snapshotX: Float32Array;
  private readonly snapshotZ: Float32Array;
  private readonly cellHead: Int32Array;
  private readonly nextInCell: Int32Array;
  private readonly usedCells: Int32Array;
  private readonly control: Int32Array;
  private readonly metrics: Float32Array;

  private activeCount = 0;
  private moveCount = 0;
  private readonly cellSize = 8;
  private readonly gridOrigin = -32;
  private readonly gridWidth: number;
  private latestTimingState: PedestrianWorkerTiming = { ...ZERO_TIMING };

  constructor(store: AgentStore, worldSizeMeters: number) {
    const shared = store.sharedMemory && typeof SharedArrayBuffer !== 'undefined';
    const alloc = (bytes: number): ArrayBufferLike => shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    const f32 = () => new Float32Array(alloc(store.capacity * Float32Array.BYTES_PER_ELEMENT));
    const i32 = () => new Int32Array(alloc(store.capacity * Int32Array.BYTES_PER_ELEMENT));
    const hc = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
    const desiredWorkerCount = Math.max(1, Math.min(4, hc - 2));

    this.desiredX = f32(); this.desiredZ = f32();
    this.activeIds = i32(); this.moveIds = i32();
    this.snapshotX = f32(); this.snapshotZ = f32(); this.nextInCell = i32(); this.usedCells = i32();
    this.control = new Int32Array(alloc(CONTROL_SIZE * Int32Array.BYTES_PER_ELEMENT));
    this.metrics = new Float32Array(alloc(desiredWorkerCount * METRIC_STRIDE * Float32Array.BYTES_PER_ELEMENT));

    this.gridWidth = Math.max(8, Math.ceil((worldSizeMeters - this.gridOrigin + 32) / this.cellSize) + 1);
    this.cellHead = new Int32Array(alloc(this.gridWidth * this.gridWidth * Int32Array.BYTES_PER_ELEMENT));
    this.cellHead.fill(-1);

    if (!shared || typeof Worker === 'undefined') return;

    for (let i = 0; i < desiredWorkerCount; i++) {
      const worker = new Worker(new URL('../workers/pedestrianWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
        if (ev.data.type !== 'done') return;
        const job = this.pending.get(ev.data.jobId); if (!job) return;
        this.pending.delete(ev.data.jobId);
        this.latestTimingState = ev.data.timing;
        job.resolve();
      };
      worker.onerror = (ev) => {
        const err = new Error(`Pedestrian worker failed: ${ev.message}`);
        for (const job of this.pending.values()) job.reject(err);
        this.pending.clear();
        for (const w of this.workers) w.terminate();
        this.workers.length = 0;
      };
      worker.postMessage({
        type: 'init',
        workerId: i,
        workerCount: desiredWorkerCount,
        cellSize: this.cellSize,
        gridOrigin: this.gridOrigin,
        gridWidth: this.gridWidth,
        buffers: {
          posX: store.posX.buffer, posZ: store.posZ.buffer, velX: store.velX.buffer, velZ: store.velZ.buffer,
          heading: store.heading.buffer, maxSpeed: store.maxSpeed.buffer, energy: store.energy.buffer,
          desiredX: this.desiredX.buffer, desiredZ: this.desiredZ.buffer,
          activeIds: this.activeIds.buffer, moveIds: this.moveIds.buffer,
          snapshotX: this.snapshotX.buffer, snapshotZ: this.snapshotZ.buffer,
          cellHead: this.cellHead.buffer, nextInCell: this.nextInCell.buffer,
          usedCells: this.usedCells.buffer, control: this.control.buffer, metrics: this.metrics.buffer,
        },
      });
      this.workers.push(worker);
    }
  }

  get active(): boolean { return this.workers.length > 0; }
  get workerCount(): number { return this.workers.length; }
  get queuedPedestrians(): number { return this.activeCount; }
  get queuedMovers(): number { return this.moveCount; }
  get latestTiming(): PedestrianWorkerTiming { return this.latestTimingState; }

  begin(): void { this.activeCount = 0; this.moveCount = 0; }

  include(agent: number): void {
    if (this.activeCount >= this.activeIds.length) return;
    this.activeIds[this.activeCount++] = agent;
  }

  queue(agent: number, desiredX: number, desiredZ: number): void {
    if (this.moveCount >= this.moveIds.length) return;
    this.desiredX[agent] = desiredX; this.desiredZ[agent] = desiredZ;
    this.moveIds[this.moveCount++] = agent;
  }

  /** Wake all persistent workers through the shared job epoch; no per-step worker postMessage. */
  flush(dt: number): Promise<void> {
    if (!this.active || this.activeCount <= 0 || this.moveCount <= 0 || dt <= 0) {
      this.latestTimingState = { ...ZERO_TIMING };
      return Promise.resolve();
    }

    const jobId = this.nextJobId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      Atomics.store(this.control, JOB_ID, jobId);
      Atomics.store(this.control, JOB_ACTIVE_COUNT, this.activeCount);
      Atomics.store(this.control, JOB_MOVE_COUNT, this.moveCount);
      Atomics.store(this.control, JOB_DT_MICROS, Math.max(1, Math.min(0x7fffffff, Math.round(dt * 1_000_000))));
      Atomics.add(this.control, JOB_EPOCH, 1);
      Atomics.notify(this.control, JOB_EPOCH, this.workers.length);
    });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const job of this.pending.values()) job.reject(new Error('Pedestrian worker pool disposed'));
    this.pending.clear();
  }
}
