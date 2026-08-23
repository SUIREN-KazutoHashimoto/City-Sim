import { AgentStore } from '../agents/AgentStore';

interface PendingJob { remaining: number; resolve: () => void; reject: (reason?: unknown) => void; }
interface WorkerReply { type: 'done'; jobId: number; }

/**
 * 歩行者の最終移動積分をSharedArrayBuffer上で並列化する。
 * 目標ノード、信号、到着、近傍回避の判断はCoordinator側で済ませ、
 * Workerは確定済みdesired vectorから速度・位置・向き・energyだけ更新する。
 */
export class PedestrianWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private nextJobId = 1;
  private readonly desiredX: Float32Array;
  private readonly desiredZ: Float32Array;
  private readonly moveMask: Uint8Array;

  constructor(private readonly store: AgentStore) {
    const shared = store.sharedMemory && typeof SharedArrayBuffer !== 'undefined';
    const fBuffer: ArrayBufferLike = shared ? new SharedArrayBuffer(store.capacity * Float32Array.BYTES_PER_ELEMENT) : new ArrayBuffer(store.capacity * Float32Array.BYTES_PER_ELEMENT);
    const zBuffer: ArrayBufferLike = shared ? new SharedArrayBuffer(store.capacity * Float32Array.BYTES_PER_ELEMENT) : new ArrayBuffer(store.capacity * Float32Array.BYTES_PER_ELEMENT);
    const mBuffer: ArrayBufferLike = shared ? new SharedArrayBuffer(store.capacity * Uint8Array.BYTES_PER_ELEMENT) : new ArrayBuffer(store.capacity * Uint8Array.BYTES_PER_ELEMENT);
    this.desiredX = new Float32Array(fBuffer); this.desiredZ = new Float32Array(zBuffer); this.moveMask = new Uint8Array(mBuffer);
    if (!shared || typeof Worker === 'undefined') return;

    const hc = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
    const count = Math.max(1, Math.min(4, hc - 2));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('../workers/pedestrianWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
        if (ev.data.type !== 'done') return;
        const job = this.pending.get(ev.data.jobId); if (!job) return;
        job.remaining--; if (job.remaining <= 0) { this.pending.delete(ev.data.jobId); job.resolve(); }
      };
      worker.onerror = (ev) => {
        const err = new Error(`Pedestrian worker failed: ${ev.message}`);
        for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(err); }
      };
      worker.postMessage({
        type: 'init',
        buffers: {
          posX: store.posX.buffer, posZ: store.posZ.buffer, velX: store.velX.buffer, velZ: store.velZ.buffer,
          heading: store.heading.buffer, maxSpeed: store.maxSpeed.buffer, energy: store.energy.buffer,
          desiredX: this.desiredX.buffer, desiredZ: this.desiredZ.buffer, moveMask: this.moveMask.buffer,
        },
      });
      this.workers.push(worker);
    }
  }

  get active(): boolean { return this.workers.length > 0; }
  get workerCount(): number { return this.workers.length; }

  begin(count = this.store.count): void { this.moveMask.fill(0, 0, count); }

  queue(agent: number, desiredX: number, desiredZ: number): void {
    this.desiredX[agent] = desiredX; this.desiredZ[agent] = desiredZ; this.moveMask[agent] = 1;
  }

  flush(dt: number, count = this.store.count): Promise<void> {
    if (!this.active || count <= 0 || dt <= 0) return Promise.resolve();
    const used = Math.min(this.workers.length, count), jobId = this.nextJobId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(jobId, { remaining: used, resolve, reject });
      for (let w = 0; w < used; w++) {
        const begin = Math.floor((count * w) / used), end = Math.floor((count * (w + 1)) / used);
        this.workers[w].postMessage({ type: 'move', jobId, begin, end, dt });
      }
    });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(new Error('Pedestrian worker pool disposed')); }
  }
}
