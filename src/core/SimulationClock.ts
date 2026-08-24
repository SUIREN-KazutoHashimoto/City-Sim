export class SimulationClock {
  timeScale = 60;
  private _totalSeconds = 8 * 3600;
  private _accumulator = 0;
  readonly fixedStep = 1 / 30;
  maxSubSteps = 40;
  stepDt = 1 / 30;

  /**
   * Convert real elapsed time into simulation work without silently discarding elapsed time.
   *
   * The caller owns long-pause protection. Runtime scheduling may intentionally pass more than
   * 0.1 real seconds when it is catching up after a slow batch, so this layer must not clamp the
   * delta. When more than maxSubSteps fixed steps are needed we preserve the requested simulated
   * duration by widening stepDt, matching the existing high-speed simulation-LOD behaviour.
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

    const total = this._accumulator;
    this.stepDt = total / this.maxSubSteps;
    this._totalSeconds += total;
    this._accumulator = 0;
    return this.maxSubSteps;
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
