import { RailRenderer } from './RailRenderer';

interface RailRuntimeInternals {
  stepOperations: (dt: number) => void;
  rebuildDispatchReservations: () => void;
  updateTrainMeshes: () => void;
  updateSignals: () => void;
  updateTurnoutIndicators: () => void;
  drawTimetable: (force: boolean) => void;
}

export interface RailFrameProfile {
  totalMs: number;
  operationsMs: number;
  visualsMs: number;
  steps: number;
  processedSeconds: number;
  averageStepSeconds: number;
  backlogSeconds: number;
}

/**
 * Cooperative high-speed scheduler for RailRenderer.
 *
 * RailRenderer's original public update path advances operations in fixed 0.5s slices. At
 * high simulation speeds that can turn a single RAF task into tens or hundreds of full rail
 * operation passes, starving Worker completion continuations on the browser main thread.
 *
 * This scheduler preserves the 0.5s slice at normal speed, but uses a bounded multirate slice
 * at accelerated speeds and caps each RAF to at most six operation passes plus a small CPU
 * budget. Unprocessed simulation seconds stay in a backlog and are consumed by later frames.
 * Visual mesh/signal synchronization still happens once per rendered frame.
 *
 * The internal-method adapter is intentionally isolated here. TypeScript `private` methods are
 * normal prototype methods at runtime in the current build; keeping this coupling in one file
 * makes it straightforward to move the scheduler into RailRenderer later.
 */
export class RailFrameScheduler {
  private readonly runtime: RailRuntimeInternals;
  private pendingSeconds = 0;

  constructor(renderer: RailRenderer) {
    this.runtime = renderer as unknown as RailRuntimeInternals;
  }

  update(realDt: number, timeScale: number, paused: boolean): RailFrameProfile {
    const totalStart = performance.now();
    // High-speed simulation may deliberately render at 10-30 FPS to leave the main thread free
    // for Worker continuations. Preserve those longer rendered-frame intervals instead of the
    // old 50ms clamp, otherwise rail time would run slow whenever render throttling is active.
    const frameDt = Math.max(0, Math.min(realDt, 0.1));
    const scale = Number.isFinite(timeScale) ? Math.max(0, timeScale) : 0;

    if (!paused && frameDt > 0 && scale > 0) {
      // Keep the original per-frame simulated-time safety cap, but carry any unfinished work.
      this.pendingSeconds += Math.min(frameDt * scale, 180);
    }

    const operationsStart = performance.now();
    let steps = 0;
    let processedSeconds = 0;

    if (!paused && scale > 0 && this.pendingSeconds > 1e-5) {
      const maxSteps = 6;
      const maxStepSeconds = this.maxStepSeconds(scale);
      const cpuBudgetMs = scale <= 60 ? 4 : scale <= 600 ? 6 : 8;

      while (steps < maxSteps && this.pendingSeconds > 1e-5) {
        const stepsLeft = Math.max(1, maxSteps - steps);
        const catchUpStep = this.pendingSeconds / stepsLeft;
        const stepSeconds = Math.min(this.pendingSeconds, Math.max(0.5, Math.min(maxStepSeconds, catchUpStep)));
        this.runtime.stepOperations(stepSeconds);
        this.pendingSeconds -= stepSeconds;
        processedSeconds += stepSeconds;
        steps++;

        if (performance.now() - operationsStart >= cpuBudgetMs) break;
      }
    }

    const operationsMs = performance.now() - operationsStart;
    const visualsStart = performance.now();
    this.runtime.rebuildDispatchReservations();
    this.runtime.updateTrainMeshes();
    this.runtime.updateSignals();
    this.runtime.updateTurnoutIndicators();
    this.runtime.drawTimetable(false);
    const visualsMs = performance.now() - visualsStart;

    return {
      totalMs: performance.now() - totalStart,
      operationsMs,
      visualsMs,
      steps,
      processedSeconds,
      averageStepSeconds: steps > 0 ? processedSeconds / steps : 0,
      backlogSeconds: this.pendingSeconds,
    };
  }

  private maxStepSeconds(scale: number): number {
    if (scale <= 60) return 0.5;
    if (scale <= 180) return 2;
    if (scale <= 600) return 10;
    if (scale <= 1800) return 20;
    return 60;
  }
}
