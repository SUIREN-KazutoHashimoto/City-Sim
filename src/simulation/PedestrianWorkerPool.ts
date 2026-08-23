import { AgentStore } from '../agents/AgentStore';

interface PendingJob { remaining: number; resolve: () => void; reject: (reason?: unknown) => void; }
interface WorkerReply { type: 'done'; jobId: number; }

/**
 * Pedestrian spatial index / avoidance / movement integration worker pool.
 *
 * Coordinator side only resolves path cursor, signals and state transitions. The worker pool:
 * 1. snapshots active pedestrian positions,
 * 2. builds a shared linked-cell spatial index,
 * 3. calculates separation/avoidance,
 * 4. integrates velocity/position/heading/energy.
 *
 * The snapshot makes neighbor queries deterministic within a step even while other workers
 * write the live position arrays.
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

  private activeCount = 0;
  private moveCount = 0;
  private readonly cellSize = 8;
  private readonly gridOrigin = -32;
  private readonly gridWidth: number;

  constructor(private readonly store: AgentStore, worldSizeMeters: number) {
    const shared = store.sharedMemory && typeof SharedArrayBuffer !== 'undefined';
    const alloc = (bytes: number): ArrayBufferLike => shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    const f32 = () => new Float32Array(alloc(store.capacity * Float32Array.BYTES_PER_ELEMENT));
    const i32 = () => new Int32Array(alloc(store.capacity * Int32Array.BYTES_PER_ELEMENT));

    this.desiredX = f32(); this.desiredZ = f32();
    this.activeIds = i32(); this.moveIds = i32();
    this.snapshotX = f32(); this.snapshotZ = f32(); this.nextInCell = i32();

    // 32m padding on each side. At a 10km city this is about 1.58M Int32 cells (~6.3MB).
    this.gridWidth = Math.max(8, Math.ceil((worldSizeMeters - this.gridOrigin + 32) / this.cellSize) + 1);
    this.cellHead = new Int32Array(alloc(this.gridWidth * this.gridWidth * Int32Array.BYTES_PER_ELEMENT));
    this.cellHead.fill(-1);

    if (!shared || typeof Worker === 'undefined') return;

    const hc = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
    const count = Math.max(1, Math.min(4, hc - 2));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('../workers/pedestrianWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
        if (ev.data.type !== 'done') return;
        const job = this.pending.get(ev.data.jobId); if (!job) return;
        job.remaining--;
        if (job.remaining <= 0) { this.pending.delete(ev.data.jobId); job.resolve(); }
      };
      worker.onerror = (ev) => {
        const err = new Error(`Pedestrian worker failed: ${ev.message}`);
        for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(err); }
      };
      worker.postMessage({
        type: 'init',
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
        },
      });
      this.workers.push(worker);
    }
  }

  get active(): boolean { return this.workers.length > 0; }
  get workerCount(): number { return this.workers.length; }
  get queuedPedestrians(): number { return this.activeCount; }
  get queuedMovers(): number { return this.moveCount; }

  begin(): void { this.activeCount = 0; this.moveCount = 0; }

  /** Include a pedestrian in neighbor avoidance even when it is currently waiting/stopped. */
  include(agent: number): void {
    if (this.activeCount >= this.activeIds.length) return;
    this.activeIds[this.activeCount++] = agent;
  }

  /** Queue the base desired direction. Separation is added in the Worker. */
  queue(agent: number, desiredX: number, desiredZ: number): void {
    if (this.moveCount >= this.moveIds.length) return;
    this.desiredX[agent] = desiredX; this.desiredZ[agent] = desiredZ;
    this.moveIds[this.moveCount++] = agent;
  }

  /** Build snapshot/index first, then run avoidance + movement in parallel. */
  async flush(dt: number): Promise<void> {
    if (!this.active || this.activeCount <= 0 || this.moveCount <= 0 || dt <= 0) return;

    const indexJobId = this.nextJobId++;
    await new Promise<void>((resolve, reject) => {
      this.pending.set(indexJobId, { remaining: 1, resolve, reject });
      this.workers[0].postMessage({ type: 'index', jobId: indexJobId, activeCount: this.activeCount });
    });

    const used = Math.min(this.workers.length, this.moveCount), moveJobId = this.nextJobId++;
    await new Promise<void>((resolve, reject) => {
      this.pending.set(moveJobId, { remaining: used, resolve, reject });
      for (let w = 0; w < used; w++) {
        const begin = Math.floor((this.moveCount * w) / used), end = Math.floor((this.moveCount * (w + 1)) / used);
        this.workers[w].postMessage({ type: 'move', jobId: moveJobId, begin, end, dt });
      }
    });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(new Error('Pedestrian worker pool disposed')); }
  }
}
