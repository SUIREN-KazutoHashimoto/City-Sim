import { AgentStore } from '../agents/AgentStore';

interface PendingJob { remaining: number; resolve: () => void; reject: (reason?: unknown) => void; }

/** SharedArrayBuffer上のAgent SoAを複数Web Workerで分割更新する。 */
export class AgentWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private nextJobId = 1;

  constructor(private readonly store: AgentStore) {
    if (!store.sharedMemory || typeof Worker === 'undefined') return;
    const hc = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
    const count = Math.max(1, Math.min(8, hc - 2));
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
    };
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('../workers/agentWorker.ts', import.meta.url), { type: 'module', name: `city-agent-${i}` });
      worker.onmessage = (ev: MessageEvent<{ type: string; jobId: number }>) => {
        if (ev.data.type !== 'done') return;
        const job = this.pending.get(ev.data.jobId); if (!job) return;
        job.remaining--; if (job.remaining <= 0) { this.pending.delete(ev.data.jobId); job.resolve(); }
      };
      worker.onerror = (ev) => {
        const err = new Error(`Agent worker failed: ${ev.message}`);
        for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(err); }
      };
      worker.postMessage({ type: 'init', buffers });
      this.workers.push(worker);
    }
  }

  get active(): boolean { return this.workers.length > 0; }
  get workerCount(): number { return this.workers.length; }

  updateAgentBatch(dt: number, now: number, count = this.store.count): Promise<void> {
    if (!this.active || count <= 0 || dt <= 0) return Promise.resolve();
    const used = Math.min(this.workers.length, count), jobId = this.nextJobId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(jobId, { remaining: used, resolve, reject });
      for (let w = 0; w < used; w++) {
        const begin = Math.floor((count * w) / used), end = Math.floor((count * (w + 1)) / used);
        this.workers[w].postMessage({ type: 'agent-batch', jobId, begin, end, dt, now });
      }
    });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate(); this.workers.length = 0;
    for (const [id, job] of this.pending) { this.pending.delete(id); job.reject(new Error('Agent worker pool disposed')); }
  }
}
