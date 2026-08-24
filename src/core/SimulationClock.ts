export class SimulationClock {
  timeScale = 60;
  private _totalSeconds = 8 * 3600;
  private _accumulator = 0;
  readonly fixedStep = 1 / 30;
  maxSubSteps = 40;
  stepDt = 1 / 30;
  private readonly maxAdaptiveStep = 1.5;

  /**
   * Convert real elapsed time into simulation work without silently discarding elapsed time.
   *
   * Runtime scheduling may intentionally pass more than 0.1 real seconds when it is catching up
   * after a slow batch. That requested time is accumulated as simulation debt. A single simulation
   * step is capped at 1.5s because pedestrian path-node/signal transitions are still coordinated on
   * the main thread; much larger dt values can jump across the current target node. Excess debt is
   * retained for later batches rather than being dropped.
   */
  advance(realDeltaSec: number): number {
    const real = Number.isFinite(realDeltaSec) ? Math.max(0, realDeltaSec) : 0;
    this._accumulator += real * Math.max(0, this.timeScale);
    const needed = Math.floor(this._accumulator / this.fixedStep);
    if (needed <= 0) { this.stepDt = this.fixedStep; return 0; }

    if (needed <= this.maxSubSteps) {
      this.stepDt = this.fixedStep;
      let steps = 0;
      while (this._accumulator >= this.fixedStep && steps < this.maxSubSteps) {
        this._totalSeconds += this.fixedStep;
        this._accumulator -= this.fixedStep;
        steps++;
      }
      return steps;
    }

    const processable = Math.min(this._accumulator, this.maxSubSteps * this.maxAdaptiveStep);
    this.stepDt = processable / this.maxSubSteps;
    this._totalSeconds += processable;
    this._accumulator -= processable;
    return this.maxSubSteps;
  }

  get pendingSimSeconds(): number { return Math.max(0, this._accumulator); }
  get pendingRealSeconds(): number {
    const scale = Math.max(0, this.timeScale);
    return scale > 0 ? this.pendingSimSeconds / scale : 0;
  }
  get totalSeconds(): number { return this._totalSeconds; }
  get hour(): number { return Math.floor((this._totalSeconds / 3600) % 24); }
  get minute(): number { return Math.floor((this._totalSeconds / 60) % 60); }
  get second(): number { return Math.floor(this._totalSeconds % 60); }
  get hourF(): number { return (this._totalSeconds / 3600) % 24; }
  get dayPhase(): number { return (this._totalSeconds / 86400) % 1; }
  get day(): number { return Math.floor(this._totalSeconds / 86400); }
  format(): string { return `Day ${this.day}  ${String(this.hour).padStart(2, '0')}:${String(this.minute).padStart(2, '0')}`; }
}
