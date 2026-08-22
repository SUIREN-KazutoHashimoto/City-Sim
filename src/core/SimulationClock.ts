/**
 * シミュレーション時刻とゲーム内カレンダーを管理する。
 * 実時間(フレーム)とは切り離し、固定ステップで積分するための時間源。
 */
export class SimulationClock {
  /** 実時間に対するシミュレーション倍率 (1 = 等速, 60 = 1秒で1分進む) */
  timeScale = 60;

  private _totalSeconds = 8 * 3600; // 朝8時スタート
  private _accumulator = 0;

  /** シミュレーションの固定タイムステップ (秒)。 */
  readonly fixedStep = 1 / 30;

  /** 1フレームに実行する物理サブステップの上限(処理落ちの暴走防止)。 */
  maxSubSteps = 120;

  advance(realDeltaSec: number): number {
    const scaled = Math.min(realDeltaSec, 0.1) * this.timeScale;
    this._accumulator += scaled;
    let steps = 0;
    while (this._accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this._totalSeconds += this.fixedStep;
      this._accumulator -= this.fixedStep;
      steps++;
    }
    if (this._accumulator > this.fixedStep) this._accumulator = 0;
    return steps;
  }

  get totalSeconds(): number { return this._totalSeconds; }
  get hour(): number { return Math.floor((this._totalSeconds / 3600) % 24); }
  get minute(): number { return Math.floor((this._totalSeconds / 60) % 60); }
  get second(): number { return Math.floor(this._totalSeconds % 60); }
  get dayPhase(): number { return (this._totalSeconds / 86400) % 1; }
  get day(): number { return Math.floor(this._totalSeconds / 86400); }

  format(): string {
    const h = String(this.hour).padStart(2, '0');
    const m = String(this.minute).padStart(2, '0');
    return `Day ${this.day}  ${h}:${m}`;
  }
}
