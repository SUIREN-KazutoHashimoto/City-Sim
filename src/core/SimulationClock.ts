export class SimulationClock {
  private _timeScale = 60;
  private _totalSeconds = 8 * 3600;
  private _accumulator = 0;
  private _speedEpoch = 0;
  readonly fixedStep = 1 / 30;
  maxSubSteps = 40;
  stepDt = 1 / 30;
  private readonly maxAdaptiveStep = 1.5;

  get timeScale(): number { return this._timeScale; }
  set timeScale(value: number) {
    const next = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (next === this._timeScale) return;
    this._timeScale = next;
    // Work accumulated under a previous user-selected speed is a scheduler target, not completed
    // simulation state. Carrying it into the new speed made a later slow preset continue consuming
    // an old fast-mode target for minutes. Rebase only the unprocessed clock debt; completed state
    // and the fixed/adaptive step semantics are untouched.
    this._accumulator = 0;
    this.stepDt = this.fixedStep;
    this._speedEpoch++;
  }

  /** Increments only when the requested time scale changes. */
  get speedEpoch(): number { return this._speedEpoch; }

  /**
   * Set the initial world time before the runtime scheduler starts. Used by the boot pre-roll only;
   * no completed simulation state is rewound and no runtime wall-time debt is created.
   */
  setBootstrapTime(totalSeconds: number): void {
    const next = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
    this._totalSeconds = next;
    this._accumulator = 0;
    this.stepDt = this.fixedStep;
  }

  /**
   * Convert real elapsed time into simulation work without silently discarding elapsed time.
   *
   * Runtime scheduling may intentionally pass more than 0.1 real seconds when it is catching up
   * after a slow batch. That requested time is accumulated as simulation debt. A single simulation
   * step is capped at 1.5s because pedestrian path-node/signal transitions are still coordinated on
   * the main thread; much larger dt values can jump across the current target node. Excess debt is
   * retained for later batches rather than being dropped. A user speed change rebases only this
   * unprocessed target debt so old high-speed work is not replayed at the new speed.
   */
  advance(realDeltaSec: number): number {
    const real = Number.isFinite(realDeltaSec) ? Math.max(0, realDeltaSec) : 0;
    this._accumulator += real * this._timeScale;
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
  get pendingRealSeconds(): number { return this._timeScale > 0 ? this.pendingSimSeconds / this._timeScale : 0; }
  get totalSeconds(): number { return this._totalSeconds; }
  get hour(): number { return Math.floor((this._totalSeconds / 3600) % 24); }
  get minute(): number { return Math.floor((this._totalSeconds / 60) % 60); }
  get second(): number { return Math.floor(this._totalSeconds % 60); }
  get hourF(): number { return (this._totalSeconds / 3600) % 24; }
  get dayPhase(): number { return (this._totalSeconds / 86400) % 1; }
  get day(): number { return Math.floor(this._totalSeconds / 86400); }
  format(): string { return `Day ${this.day}  ${String(this.hour).padStart(2, '0')}:${String(this.minute).padStart(2, '0')}`; }
}
