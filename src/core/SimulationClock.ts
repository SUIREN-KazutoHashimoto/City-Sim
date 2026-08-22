/**
 * シミュレーション時刻とゲーム内カレンダーを管理する。
 * 実時間(フレーム)とは切り離し、固定ステップで積分するための時間源。
 * 歩行者AIの「昼は仕事、夜は帰宅」のような意味的判断はここの時刻を参照する。
 */
export class SimulationClock {
  /** 実時間に対するシミュレーション倍率 (1 = 等速, 60 = 1秒で1分進む) */
  timeScale = 60;

  /** ゲーム内の累積秒数 (0時0分0秒からの経過) */
  private _totalSeconds = 8 * 3600; // 朝8時スタート

  /** 固定ステップの端数を貯めるアキュムレータ (秒) */
  private _accumulator = 0;

  /** シミュレーションの固定タイムステップ (秒)。挙動の安定性のため固定。 */
  readonly fixedStep = 1 / 30;

  /**
   * 実フレーム経過(秒)を渡すと、実行すべき固定ステップ数を返す。
   * 呼び出し側はこの回数だけ world.step(fixedStep) を回す。
   */
  advance(realDeltaSec: number): number {
    // スパイク時に死のスパイラルへ陥らないよう上限を設ける
    const scaled = Math.min(realDeltaSec, 0.25) * this.timeScale;
    this._accumulator += scaled;
    let steps = 0;
    while (this._accumulator >= this.fixedStep && steps < 8) {
      this._totalSeconds += this.fixedStep;
      this._accumulator -= this.fixedStep;
      steps++;
    }
    return steps;
  }

  get totalSeconds(): number { return this._totalSeconds; }
  get hour(): number { return Math.floor((this._totalSeconds / 3600) % 24); }
  get minute(): number { return Math.floor((this._totalSeconds / 60) % 60); }
  /** 0..1 の一日の位相。0=深夜0時, 0.5=正午。日照/交通量カーブに使う。 */
  get dayPhase(): number { return (this._totalSeconds / 86400) % 1; }
  get day(): number { return Math.floor(this._totalSeconds / 86400); }

  format(): string {
    const h = String(this.hour).padStart(2, '0');
    const m = String(this.minute).padStart(2, '0');
    return `Day ${this.day}  ${h}:${m}`;
  }
}
