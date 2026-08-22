export class SimulationClock {
  timeScale = 60;
  private _totalSeconds = 8 * 3600;
  private _accumulator = 0;
  readonly fixedStep = 1 / 30;
  maxSubSteps = 120;
  advance(realDeltaSec: number): number {
    const scaled = Math.min(realDeltaSec, 0.1) * this.timeScale;
    this._accumulator += scaled;
    let steps = 0;
    while (this._accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this._totalSeconds += this.fixedStep; this._accumulator -= this.fixedStep; steps++;
    }
    if (this._accumulator > this.fixedStep) this._accumulator = 0;
    return steps;
  }
  get totalSeconds(): number { return this._totalSeconds; }
  get hour(): number { return Math.floor((this._totalSeconds / 3600) % 24); }
  get minute(): number { return Math.floor((this._totalSeconds / 60) % 60); }
  get second(): number { return Math.floor(this._totalSeconds % 60); }
  get hourF(): number { return (this._totalSeconds / 3600) % 24; }
  get dayPhase(): number { return (this._totalSeconds / 86400) % 1; }
  get day(): number { return Math.floor(this._totalSeconds / 86400); }
  format(): string {
    return `Day ${this.day}  ${String(this.hour).padStart(2, '0')}:${String(this.minute).padStart(2, '0')}`;
  }
}
