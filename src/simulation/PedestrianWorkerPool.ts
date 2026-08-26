import { AgentStore } from '../agents/AgentStore';

export interface PedestrianWorkerTiming {
  prepMs: number;
  indexMs: number;
  avoidMoveMs: number;
  barrierMs: number;
  totalMs: number;
  wakeMs: number;
  returnMs: number;
}

interface PendingJob { resolve: () => void; reject: (reason?: unknown) => void; }
interface WorkerReply { type: 'done'; jobId: number; }
interface WaitAsyncResult { async: boolean; value: string | Promise<string>; }
interface AtomicsWithWaitAsync { waitAsync?: (array: Int32Array, index: number, value: number, timeout?: number) => WaitAsyncResult; }

const ZERO_TIMING: PedestrianWorkerTiming = { prepMs: 0, indexMs: 0, avoidMoveMs: 0, barrierMs: 0, totalMs: 0, wakeMs: 0, returnMs: 0 };
const METRIC_STRIDE = 6;
const M_PREP = 0;
const M_INDEX = 1;
const M_AVOID_MOVE = 2;
const M_BARRIER = 3;
const M_TOTAL = 4;
const M_WAKE = 5;
const USED_CELL_COUNT = 2;
const JOB_EPOCH = 4;
const JOB_ID = 5;
const JOB_ACTIVE_COUNT = 6;
const JOB_MOVE_COUNT = 7;
const JOB_DT_MICROS = 8;
const DONE_EPOCH = 9;
const DISPATCH_TIME_MS = 10;
const DONE_TIME_MS = 11;
const CONTROL_SIZE = 12;
const TIME_MASK = 0x3fffffff;

// Below this active-pedestrian count, BENCH data shows Worker compute is tiny compared with
// Worker -> main continuation latency. Run the same snapshot/index/avoidance integration on the
// Coordinator thread and keep the 4-worker path for dense crowds/cold-start bursts.
const SYNC_ACTIVE_THRESHOLD = 4096;

const nowMs32 = (): number => Date.now() & TIME_MASK;
const elapsedMs32 = (start: number, end: number): number => (end - start + TIME_MASK + 1) & TIME_MASK;

/**
 * Pedestrian spatial index / avoidance / movement integration worker pool.
 *
 * Workers are initialized once and then sleep on a SharedArrayBuffer job epoch. Both hot-path
 * directions avoid Worker message delivery when Atomics.waitAsync is available:
 * - main -> workers: JOB_EPOCH + Atomics.notify
 * - workers -> main: DONE_EPOCH + Atomics.notify / Atomics.waitAsync
 *
 * Sparse settled steps use a synchronous path with the same snapshot/index/avoidance equations
 * to avoid paying an event-loop roundtrip that is much larger than the actual computation.
 * Dense steps still use the persistent Worker pool.
 *
 * postMessage remains only as a compatibility fallback for browsers without Atomics.waitAsync.
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
  private readonly useAtomicsCompletion: boolean;

  private activeCount = 0;
  private moveCount = 0;
  private readonly cellSize = 8;
  private readonly invCellSize = 1 / 8;
  private readonly gridOrigin = -32;
  private readonly gridWidth: number;
  private latestTimingState: PedestrianWorkerTiming = { ...ZERO_TIMING };

  constructor(private readonly store: AgentStore, worldSizeMeters: number) {
    const shared = store.sharedMemory && typeof SharedArrayBuffer !== 'undefined';
    const waitAsync = (Atomics as unknown as AtomicsWithWaitAsync).waitAsync;
    this.useAtomicsCompletion = shared && typeof waitAsync === 'function';
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
        this.latestTimingState = this.collectTiming();
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
        completionByAtomics: this.useAtomicsCompletion,
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
  get completionMode(): 'atomics' | 'message' { return this.useAtomicsCompletion ? 'atomics' : 'message'; }

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

  /** Use the Coordinator for sparse work, otherwise wake persistent workers and await completion. */
  async flush(dt: number): Promise<void> {
    if (!this.active || this.activeCount <= 0 || this.moveCount <= 0 || dt <= 0) {
      this.latestTimingState = { ...ZERO_TIMING };
      return;
    }

    if (this.activeCount <= SYNC_ACTIVE_THRESHOLD) {
      this.flushSynchronous(dt);
      return;
    }

    const jobId = this.nextJobId++;
    if (this.useAtomicsCompletion) {
      const expectedDoneEpoch = Atomics.load(this.control, DONE_EPOCH);
      await new Promise<void>((resolve, reject) => {
        this.pending.set(jobId, { resolve, reject });
        const done = this.waitForDone(expectedDoneEpoch);
        done.then(() => {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId);
          this.latestTimingState = this.collectTiming();
          job.resolve();
        }, (reason) => {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId); job.reject(reason);
        });
        try { this.dispatch(jobId, dt); }
        catch (reason) {
          const job = this.pending.get(jobId); if (!job) return;
          this.pending.delete(jobId); job.reject(reason);
        }
      });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.dispatch(jobId, dt);
    });
  }

  private cellOf(x: number, z: number): number {
    const cx = Math.floor((x - this.gridOrigin) * this.invCellSize);
    const cz = Math.floor((z - this.gridOrigin) * this.invCellSize);
    if (cx < 0 || cz < 0 || cx >= this.gridWidth || cz >= this.gridWidth) return -1;
    return cz * this.gridWidth + cx;
  }

  /**
   * Single-thread equivalent of pedestrianWorker.runStep for sparse settled traffic.
   * Worker threads are sleeping while this runs, so shared work buffers are safe to reuse.
   */
  private flushSynchronous(dt: number): void {
    const totalStart = performance.now();
    const s = this.store;

    const prepStart = performance.now();
    const previousUsed = Atomics.load(this.control, USED_CELL_COUNT);
    for (let n = 0; n < previousUsed; n++) this.cellHead[this.usedCells[n]] = -1;
    Atomics.store(this.control, USED_CELL_COUNT, 0);
    for (let n = 0; n < this.activeCount; n++) {
      const agent = this.activeIds[n];
      this.snapshotX[agent] = s.posX[agent];
      this.snapshotZ[agent] = s.posZ[agent];
    }
    const prepMs = performance.now() - prepStart;

    const indexStart = performance.now();
    let usedCount = 0;
    for (let n = 0; n < this.activeCount; n++) {
      const agent = this.activeIds[n];
      const cell = this.cellOf(this.snapshotX[agent], this.snapshotZ[agent]);
      if (cell < 0) { this.nextInCell[agent] = -1; continue; }
      const previous = this.cellHead[cell];
      this.cellHead[cell] = agent;
      this.nextInCell[agent] = previous;
      if (previous === -1) this.usedCells[usedCount++] = cell;
    }
    Atomics.store(this.control, USED_CELL_COUNT, usedCount);
    const indexMs = performance.now() - indexStart;

    const moveStart = performance.now();
    const radius = 2, radius2 = radius * radius;
    for (let n = 0; n < this.moveCount; n++) {
      const agent = this.moveIds[n];
      const px = this.snapshotX[agent], pz = this.snapshotZ[agent];
      let desX = this.desiredX[agent], desZ = this.desiredZ[agent], sepX = 0, sepZ = 0, neighbors = 0;

      const minCx = Math.max(0, Math.floor((px - radius - this.gridOrigin) * this.invCellSize));
      const maxCx = Math.min(this.gridWidth - 1, Math.floor((px + radius - this.gridOrigin) * this.invCellSize));
      const minCz = Math.max(0, Math.floor((pz - radius - this.gridOrigin) * this.invCellSize));
      const maxCz = Math.min(this.gridWidth - 1, Math.floor((pz + radius - this.gridOrigin) * this.invCellSize));

      for (let cz = minCz; cz <= maxCz; cz++) for (let cx = minCx; cx <= maxCx; cx++) {
        let other = this.cellHead[cz * this.gridWidth + cx];
        while (other >= 0) {
          if (other !== agent) {
            const dx = px - this.snapshotX[other], dz = pz - this.snapshotZ[other], d2 = dx * dx + dz * dz;
            if (d2 > 0 && d2 < radius2) {
              const inv = 1 / Math.sqrt(d2); sepX += dx * inv; sepZ += dz * inv; neighbors++;
            }
          }
          other = this.nextInCell[other];
        }
      }

      if (neighbors > 0) { desX += (sepX / neighbors) * 0.6; desZ += (sepZ / neighbors) * 0.6; }
      const mag = Math.hypot(desX, desZ) || 1, sp = s.maxSpeed[agent];
      const vx = (desX / mag) * sp, vz = (desZ / mag) * sp;
      s.velX[agent] = vx; s.velZ[agent] = vz;
      s.posX[agent] += vx * dt; s.posZ[agent] += vz * dt; s.heading[agent] = Math.atan2(vz, vx);
      s.energy[agent] = Math.max(0, s.energy[agent] - (1 / (2.5 * 3600)) * dt);
    }
    const avoidMoveMs = performance.now() - moveStart;

    this.latestTimingState = {
      prepMs,
      indexMs,
      avoidMoveMs,
      barrierMs: 0,
      totalMs: performance.now() - totalStart,
      wakeMs: 0,
      returnMs: 0,
    };
  }

  private dispatch(jobId: number, dt: number): void {
    Atomics.store(this.control, JOB_ID, jobId);
    Atomics.store(this.control, JOB_ACTIVE_COUNT, this.activeCount);
    Atomics.store(this.control, JOB_MOVE_COUNT, this.moveCount);
    Atomics.store(this.control, JOB_DT_MICROS, Math.max(1, Math.min(0x7fffffff, Math.round(dt * 1_000_000))));
    Atomics.store(this.control, DISPATCH_TIME_MS, nowMs32());
    Atomics.add(this.control, JOB_EPOCH, 1);
    Atomics.notify(this.control, JOB_EPOCH, this.workers.length);
  }

  private async waitForDone(expectedEpoch: number): Promise<void> {
    const fn = (Atomics as unknown as AtomicsWithWaitAsync).waitAsync;
    if (typeof fn !== 'function') throw new Error('Atomics.waitAsync unavailable after atomics completion was selected');
    const result = fn(this.control, DONE_EPOCH, expectedEpoch);
    if (result.async) await result.value;
  }

  private collectTiming(): PedestrianWorkerTiming {
    let prepMs = 0, indexMs = 0, avoidMoveMs = 0, barrierMs = 0, totalMs = 0, wakeMs = 0;
    for (let w = 0; w < this.workers.length; w++) {
      const base = w * METRIC_STRIDE;
      prepMs = Math.max(prepMs, this.metrics[base + M_PREP]);
      indexMs = Math.max(indexMs, this.metrics[base + M_INDEX]);
      avoidMoveMs = Math.max(avoidMoveMs, this.metrics[base + M_AVOID_MOVE]);
      barrierMs = Math.max(barrierMs, this.metrics[base + M_BARRIER]);
      totalMs = Math.max(totalMs, this.metrics[base + M_TOTAL]);
      wakeMs = Math.max(wakeMs, this.metrics[base + M_WAKE]);
    }
    const doneAt = Atomics.load(this.control, DONE_TIME_MS);
    const returnMs = elapsedMs32(doneAt, nowMs32());
    return { prepMs, indexMs, avoidMoveMs, barrierMs, totalMs, wakeMs, returnMs };
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const job of this.pending.values()) job.reject(new Error('Pedestrian worker pool disposed'));
    this.pending.clear();
  }
}
