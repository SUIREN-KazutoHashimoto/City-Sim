import { RailRenderer } from './RailRenderer';
import { installExternalRailConnection } from './ExternalRailConnection';
import { installRailInterlockingSafety } from './RailInterlockingSafety';

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
  inputSeconds: number;
  steps: number;
  processedSeconds: number;
  averageStepSeconds: number;
  backlogSeconds: number;
}

export interface RailFastForwardProfile {
  operationsMs: number;
  inputSeconds: number;
  steps: number;
  processedSeconds: number;
  backlogSeconds: number;
}

/**
 * Cooperative high-speed scheduler for RailRenderer.
 *
 * Rail operations must follow completed simulation time, not target wall-clock time. Feeding this
 * scheduler with `realDt * timeScale` made rail continue accumulating future work while the world
 * itself was behind, and render throttling amplified that drift. The caller now supplies only the
 * simulation seconds that have actually completed since the previous rendered frame.
 *
 * The scheduler still preserves the 0.5s operational slice at normal speed, uses bounded multirate
 * slices at accelerated speeds, and caps each rendered frame to at most six operation passes plus a
 * small CPU budget. Any real rail work that cannot be consumed stays in `pendingSeconds`; nothing is
 * silently dropped.
 */
export class RailFrameScheduler {
  private readonly runtime: RailRuntimeInternals;
  private pendingSeconds = 0;

  constructor(renderer: RailRenderer) {
    // City-rail safety owns only the existing network. The external high-speed line is installed
    // afterwards and advances from the same completed rail time without joining city blocks/routes.
    installRailInterlockingSafety(renderer);
    installExternalRailConnection(renderer);
    this.runtime = renderer as unknown as RailRuntimeInternals;
  }

  update(completedSimSeconds: number, timeScale: number, paused: boolean): RailFrameProfile {
    const totalStart = performance.now();
    const inputSeconds = Number.isFinite(completedSimSeconds) ? Math.max(0, completedSimSeconds) : 0;
    const scale = Number.isFinite(timeScale) ? Math.max(0, timeScale) : 0;

    if (!paused && inputSeconds > 0) this.pendingSeconds += inputSeconds;

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
      inputSeconds,
      steps,
      processedSeconds,
      averageStepSeconds: steps > 0 ? processedSeconds / steps : 0,
      backlogSeconds: this.pendingSeconds,
    };
  }

  /**
   * Drain all completed rail time without touching meshes or issuing WebGL work. Runtime time-jump
   * calls this alongside each renderless World batch, then the first normal frame performs one visual
   * synchronization before rendering. Two-second operational slices are intentionally finer than the
   * general high-speed scheduler so station/platform and crossover interlocking cannot be skipped by
   * a coarse renderless jump.
   */
  fastForward(completedSimSeconds: number): RailFastForwardProfile {
    const inputSeconds = Number.isFinite(completedSimSeconds) ? Math.max(0, completedSimSeconds) : 0;
    if (inputSeconds > 0) this.pendingSeconds += inputSeconds;

    const operationsStart = performance.now();
    let steps = 0;
    let processedSeconds = 0;
    const maxStepSeconds = 2;

    while (this.pendingSeconds > 1e-5) {
      const stepSeconds = Math.min(maxStepSeconds, this.pendingSeconds);
      this.runtime.stepOperations(stepSeconds);
      this.pendingSeconds -= stepSeconds;
      processedSeconds += stepSeconds;
      steps++;
    }

    return {
      operationsMs: performance.now() - operationsStart,
      inputSeconds,
      steps,
      processedSeconds,
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
