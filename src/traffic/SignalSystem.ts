import { RoadNetwork } from './RoadNetwork';
import { makeRng } from '../core/math';

/**
 * ============================================================================
 *  SignalSystem — 交差点信号(車両信号 & 歩行者信号を統一位相で管理)
 * ============================================================================
 * 各信号交差点は 2 軸(0=東西, 1=南北)を交互に青にする。位相は独立に進み、
 * 交差点ごとにランダムなオフセットを持つ(全信号が同時に変わらない)。
 *
 * 歩車分離の考え方(現実の並行式に一致):
 *   ある軸 A が「青」のとき、
 *     ・軸 A を走る *車両* は交差点を通過できる
 *     ・軸 A に *平行して歩く歩行者* は、直交する車道が赤=安全 なので横断できる
 *   → 車両信号と歩行者信号は同じ「軸Aが青か」で表現できる(isGreen で一元化)。
 *
 * 位相: GREEN(青, 通行可) → YELLOW(黄, 停止準備=進入不可) → 相手軸へ。
 */
export enum SignalPhase { Green = 0, Yellow = 1 }

export class SignalSystem {
  /** 信号交差点のノードID一覧。 */
  readonly nodeIds: number[] = [];
  /** nodeId → 内部信号index(-1 = 信号なし)。 */
  private signalOf: Int32Array;

  private greenAxis: Uint8Array;   // 現在青の軸(0/1)
  private phase: Uint8Array;       // SignalPhase
  private timer: Float32Array;     // 現位相の経過秒

  greenDuration = 16; // 青の長さ(秒)
  yellowDuration = 3; // 黄の長さ(秒)

  constructor(net: RoadNetwork, seed = 20240521) {
    this.signalOf = new Int32Array(net.nodes.length).fill(-1);
    for (const n of net.nodes) {
      // 信号は「信号フラグあり かつ 3方向以上が接続する交差点」に設置
      if (n.hasSignal && n.edges.length >= 3) {
        this.signalOf[n.id] = this.nodeIds.length;
        this.nodeIds.push(n.id);
      }
    }
    const cnt = this.nodeIds.length;
    const rng = makeRng(seed);
    this.greenAxis = new Uint8Array(cnt);
    this.phase = new Uint8Array(cnt);
    this.timer = new Float32Array(cnt);
    const cycle = this.greenDuration + this.yellowDuration;
    for (let k = 0; k < cnt; k++) {
      this.greenAxis[k] = rng() < 0.5 ? 0 : 1;
      // ランダム位相オフセットで非同期化
      this.timer[k] = rng() * cycle;
      if (this.timer[k] > this.greenDuration) { this.phase[k] = SignalPhase.Yellow; this.timer[k] -= this.greenDuration; }
    }
  }

  get count(): number { return this.nodeIds.length; }

  /** 全信号の位相を進める(固定ステップ)。 */
  update(dt: number): void {
    for (let k = 0; k < this.nodeIds.length; k++) {
      this.timer[k] += dt;
      if (this.phase[k] === SignalPhase.Green) {
        if (this.timer[k] >= this.greenDuration) { this.phase[k] = SignalPhase.Yellow; this.timer[k] = 0; }
      } else {
        if (this.timer[k] >= this.yellowDuration) {
          this.phase[k] = SignalPhase.Green;
          this.greenAxis[k] = this.greenAxis[k] ^ 1;
          this.timer[k] = 0;
        }
      }
    }
  }

  /** ノード node で軸 axis が「通行可(青)」か。信号なしノードは常に true。 */
  isGreen(node: number, axis: 0 | 1): boolean {
    const s = this.signalOf[node];
    if (s < 0) return true; // 信号なし = 常に通行可
    return this.phase[s] === SignalPhase.Green && this.greenAxis[s] === axis;
  }

  /** 描画用: ノード node・軸 axis の灯色を返す。'green'|'yellow'|'red'|null(信号なし)。 */
  color(node: number, axis: 0 | 1): 'green' | 'yellow' | 'red' | null {
    const s = this.signalOf[node];
    if (s < 0) return null;
    if (this.greenAxis[s] === axis) {
      return this.phase[s] === SignalPhase.Green ? 'green' : 'yellow';
    }
    return 'red';
  }
}
