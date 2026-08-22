/**
 * ============================================================================
 *  VehicleStore (SoA) — 車両の状態を列指向で保持
 * ============================================================================
 * 歩行者(AgentStore)と同様、車両も TypedArray の列で持つ。
 * 車両は「道路グラフのエッジ上を、経路(ノード列)に沿って進む1次元的な存在」で、
 * 横位置(車線)よりまず縦方向(車間・速度)の物理を IDM で解くのが交通の本質。
 *
 * 位置表現:
 *   - path[]        : 通過するノードID列(A* の結果)
 *   - pathCursor    : 現在向かっているノードが path 上のどのインデックスか
 *   - segT          : 現在エッジ上の進捗(0..1)。ワールド座標は from→to の線形補間で得る。
 *   - これにより「エッジ上の前方車との車間」を segT 差で厳密に測れる。
 */
export enum VehicleState {
  Idle = 0,      // 未使用(プール空き)
  Driving = 1,   // 走行中
  Arrived = 2,   // 目的地ノード到達(降車待ち)
}

export class VehicleStore {
  readonly capacity: number;
  count = 0;

  // ワールド座標(描画・ピッキング用。物理は segT で解く)
  posX: Float32Array;
  posZ: Float32Array;
  heading: Float32Array;

  // 縦方向の運動(IDM)
  speed: Float32Array;       // m/s(スカラー、進行方向）
  maxSpeed: Float32Array;    // 各車の希望速度(道路制限×個体差)
  accel: Float32Array;       // 現在加速度(デバッグ/描画用)

  // 車両諸元(IDMパラメータ)
  length: Float32Array;      // 車長 m
  aMax: Float32Array;        // 最大加速 m/s^2
  bComf: Float32Array;       // 快適減速 m/s^2
  t0: Float32Array;          // 目標車頭時間 s
  s0: Float32Array;          // 最小車間 m

  // 経路・位置
  fromNode: Int32Array;      // 現在エッジの始点ノード
  toNode: Int32Array;        // 現在エッジの終点ノード
  edge: Int32Array;          // 現在エッジID(-1 = なし)
  segT: Float32Array;        // 現在エッジ上の進捗 0..1
  segLen: Float32Array;      // 現在エッジ長 m(キャッシュ)

  state: Uint8Array;         // VehicleState
  driver: Int32Array;        // 運転者のエージェント index(-1 = なし)

  // 経路本体はプレーン配列で保持(SoA外だが車両数は歩行者より桁が小さい想定)
  paths: Int32Array[] = [];  // paths[i] = ノードID列
  pathCursor: Uint16Array;   // 次に目指す path インデックス

  constructor(capacity: number) {
    this.capacity = capacity;
    const f = () => new Float32Array(capacity);
    this.posX = f(); this.posZ = f(); this.heading = f();
    this.speed = f(); this.maxSpeed = f(); this.accel = f();
    this.length = f(); this.aMax = f(); this.bComf = f(); this.t0 = f(); this.s0 = f();
    this.fromNode = new Int32Array(capacity).fill(-1);
    this.toNode = new Int32Array(capacity).fill(-1);
    this.edge = new Int32Array(capacity).fill(-1);
    this.segT = f(); this.segLen = f();
    this.state = new Uint8Array(capacity);
    this.driver = new Int32Array(capacity).fill(-1);
    this.pathCursor = new Uint16Array(capacity);
    for (let i = 0; i < capacity; i++) this.paths.push(new Int32Array(0));
  }

  /** 車両を1台確保。諸元は個体差を持たせて初期化。 */
  spawn(driver: number): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.driver[i] = driver;
    this.speed[i] = 0; this.accel[i] = 0;
    this.length[i] = 4.2 + Math.random() * 0.8;
    this.aMax[i] = 1.4 + Math.random() * 0.6;   // 1.4-2.0 m/s^2
    this.bComf[i] = 2.0 + Math.random() * 0.8;  // 2.0-2.8 m/s^2
    this.t0[i] = 1.1 + Math.random() * 0.6;     // 車頭時間 1.1-1.7 s
    this.s0[i] = 2.0 + Math.random() * 0.5;     // 停止車間 2.0-2.5 m
    this.state[i] = VehicleState.Driving;
    this.segT[i] = 0;
    this.pathCursor[i] = 0;
    return i;
  }
}
