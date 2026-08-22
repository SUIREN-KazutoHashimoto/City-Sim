import { RoadNetwork } from './RoadNetwork';
import { makeRng } from '../core/math';

/**
 * ============================================================================
 *  SignalSystem — 車道信号と歩行者信号を *分離* して管理
 * ============================================================================
 * 車両は「車道信号」を、歩行者は「歩行者信号」を見る。両者を別の状態として持つため、
 * 将来のスクランブル交差点(完全歩車分離式)も自然に表現できる。
 *
 * 交差点は 2 軸(0=東西, 1=南北)を持ち、各交差点は制御方式(mode)を持つ:
 *
 *   ● Concurrent(並行式・一般的):
 *       軸Aの車が青のとき、軸Aに *平行して歩く* 歩行者も青(直交車道は赤=安全)。
 *       位相: [A車青+A歩青] → [A車黄+歩赤] → [B車青+B歩青] → [B車黄+歩赤] → …
 *
 *   ● Exclusive / Scramble(完全歩車分離・スクランブル):
 *       車の全方向が赤になる専用の歩行者フェーズを設け、その間は *全方向*(斜め含む)
 *       の歩行者が青。車と歩行者が交差点内で決して交錯しない。
 *       位相: [A車青(歩全赤)] → [A車黄] → [B車青(歩全赤)] → [B車黄] → [全車赤+歩全青] → …
 *
 * 各信号は「位相ステップ配列」を time で進めるだけの単純な状態機械。
 */

export enum SignalMode { Concurrent = 0, Scramble = 1 }

/** 1つの位相ステップの定義(車道側・歩行者側の状態を宣言的に保持)。 */
interface PhaseStep {
  /** 車が進める軸。-1 = 全方向赤。 */
  vehGreenAxis: -1 | 0 | 1;
  /** その軸が黄か(黄のときは進入不可扱い)。 */
  vehYellow: boolean;
  /** 歩行者が渡れる軸。-1=なし, 0/1=その軸, 2=全方向(スクランブル)。 */
  pedWalkAxis: -1 | 0 | 1 | 2;
  duration: number;
}

const GREEN = 14, YELLOW = 3, SCRAMBLE = 8;

function concurrentProgram(): PhaseStep[] {
  return [
    { vehGreenAxis: 0, vehYellow: false, pedWalkAxis: 0,  duration: GREEN },
    { vehGreenAxis: 0, vehYellow: true,  pedWalkAxis: -1, duration: YELLOW },
    { vehGreenAxis: 1, vehYellow: false, pedWalkAxis: 1,  duration: GREEN },
    { vehGreenAxis: 1, vehYellow: true,  pedWalkAxis: -1, duration: YELLOW },
  ];
}

function scrambleProgram(): PhaseStep[] {
  return [
    { vehGreenAxis: 0,  vehYellow: false, pedWalkAxis: -1, duration: GREEN },
    { vehGreenAxis: 0,  vehYellow: true,  pedWalkAxis: -1, duration: YELLOW },
    { vehGreenAxis: 1,  vehYellow: false, pedWalkAxis: -1, duration: GREEN },
    { vehGreenAxis: 1,  vehYellow: true,  pedWalkAxis: -1, duration: YELLOW },
    { vehGreenAxis: -1, vehYellow: false, pedWalkAxis: 2,  duration: SCRAMBLE },
  ];
}

export class SignalSystem {
  readonly nodeIds: number[] = [];
  private signalOf: Int32Array;

  private mode: Uint8Array;      // SignalMode
  private step: Uint8Array;      // 現在の位相ステップindex
  private timer: Float32Array;   // 現ステップの経過秒

  private programs: PhaseStep[][] = [concurrentProgram(), scrambleProgram()];

  /**
   * @param scrambleFraction 0..1。この割合の信号交差点をスクランブル方式にする。
   *        (完全歩車分離式のデモ。既定は少数のみ)
   */
  constructor(net: RoadNetwork, seed = 20240521, scrambleFraction = 0.15) {
    this.signalOf = new Int32Array(net.nodes.length).fill(-1);
    for (const n of net.nodes) {
      if (n.hasSignal && n.edges.length >= 3) {
        this.signalOf[n.id] = this.nodeIds.length;
        this.nodeIds.push(n.id);
      }
    }
    const cnt = this.nodeIds.length;
    const rng = makeRng(seed);
    this.mode = new Uint8Array(cnt);
    this.step = new Uint8Array(cnt);
    this.timer = new Float32Array(cnt);
    for (let k = 0; k < cnt; k++) {
      this.mode[k] = rng() < scrambleFraction ? SignalMode.Scramble : SignalMode.Concurrent;
      const prog = this.programs[this.mode[k]];
      // ランダムなステップ位相オフセットで全信号を非同期化
      this.step[k] = Math.floor(rng() * prog.length);
      this.timer[k] = rng() * prog[this.step[k]].duration;
    }
  }

  get count(): number { return this.nodeIds.length; }

  /** ある交差点の制御方式(表示用)。 */
  modeOf(node: number): SignalMode | null {
    const s = this.signalOf[node];
    return s < 0 ? null : (this.mode[s] as SignalMode);
  }

  update(dt: number): void {
    for (let k = 0; k < this.nodeIds.length; k++) {
      const prog = this.programs[this.mode[k]];
      this.timer[k] += dt;
      if (this.timer[k] >= prog[this.step[k]].duration) {
        this.timer[k] = 0;
        this.step[k] = (this.step[k] + 1) % prog.length;
      }
    }
  }

  private currentStep(node: number): PhaseStep | null {
    const s = this.signalOf[node];
    if (s < 0) return null;
    return this.programs[this.mode[s]][this.step[s]];
  }

  // ---- 車両用 ----
  /** 車両: ノード node で軸 axis が青(進入可)か。信号なしは常に true。 */
  vehicleGreen(node: number, axis: 0 | 1): boolean {
    const st = this.currentStep(node);
    if (!st) return true;
    return st.vehGreenAxis === axis && !st.vehYellow;
  }

  /** 描画用: 車道信号の灯色。 */
  vehicleColor(node: number, axis: 0 | 1): 'green' | 'yellow' | 'red' | null {
    const st = this.currentStep(node);
    if (!st) return null;
    if (st.vehGreenAxis === axis) return st.vehYellow ? 'yellow' : 'green';
    return 'red';
  }

  // ---- 歩行者用 ----
  /** 歩行者: ノード node で軸 axis 方向へ横断可(青)か。信号なしは常に true。 */
  pedWalk(node: number, axis: 0 | 1): boolean {
    const st = this.currentStep(node);
    if (!st) return true;
    return st.pedWalkAxis === axis || st.pedWalkAxis === 2;
  }

  /** 描画用: 歩行者信号の灯色('walk'=青人形, 'dont'=赤人形)。 */
  pedColor(node: number, axis: 0 | 1): 'walk' | 'dont' | null {
    const st = this.currentStep(node);
    if (!st) return null;
    return (st.pedWalkAxis === axis || st.pedWalkAxis === 2) ? 'walk' : 'dont';
  }

  /** スクランブル(全方向歩行者青)中か。描画で強調するために使える。 */
  isScrambleWalk(node: number): boolean {
    const st = this.currentStep(node);
    return !!st && st.pedWalkAxis === 2;
  }
}
