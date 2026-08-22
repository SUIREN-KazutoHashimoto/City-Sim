/**
 * ============================================================================
 *  データ指向 実行層 (Structure of Arrays)
 * ============================================================================
 * 全エージェント(歩行者/ドライバー)の状態を「列」ごとの TypedArray で保持する。
 * これにより:
 *   - システムは配列を線形走査でき、CPUキャッシュに乗りやすい(挙動更新が速い)
 *   - SharedArrayBuffer に載せれば Web Worker と状態を共有できる(将来のマルチスレッド化)
 *   - InstancedMesh のバッファへ座標を一括コピーできる(描画が速い)
 *
 * GameObject 派生(Pedestrian等)は、この配列の index を指すハンドルに過ぎない。
 */

/** 意味的な行動状態。UtilityBrain が遷移させる。 */
export enum AgentState {
  Idle = 0,
  Deciding = 1,   // 次の目的を選定中
  Routing = 2,    // 目的地への経路探索待ち
  Traveling = 3,  // 移動中(経路追従)
  Engaged = 4,    // 目的地で活動中(仕事/食事/睡眠 等)
}

export class AgentStore {
  readonly capacity: number;
  count = 0;

  // --- 物理/運動 (XZ平面) ---
  posX: Float32Array;
  posZ: Float32Array;
  velX: Float32Array;
  velZ: Float32Array;
  heading: Float32Array;     // 進行方向(ラジアン)
  maxSpeed: Float32Array;    // m/s (歩行:約1.4, 走行車両:別途)

  // --- ニーズ(0..1, 1=完全に満たされている) ---
  energy: Float32Array;      // 睡眠欲の逆
  hunger: Float32Array;      // 満腹度
  social: Float32Array;      // 社会的充足
  hygiene: Float32Array;     // 衛生
  fun: Float32Array;         // 娯楽

  // --- 属性(意思決定のパラメータ) ---
  wealth: Float32Array;      // 所持金/経済力 0..1
  age: Uint8Array;
  occupation: Uint8Array;    // 職業種別(POIカテゴリ嗜好に対応)

  // --- 行動/経路 ---
  state: Uint8Array;         // AgentState
  homePOI: Int32Array;       // 住居のPOI id (-1 = なし)
  workPOI: Int32Array;       // 職場のPOI id
  goalPOI: Int32Array;       // 現在の目的地POI id
  goalX: Float32Array;
  goalZ: Float32Array;

  // 経路はノードID列。ここでは各エージェントの現在ノード進行度のみ保持し、
  // 経路本体は PathBuffer(別管理/ワーカー)へ持たせる想定のフックを置く。
  pathHandle: Int32Array;    // -1 = 経路なし
  pathCursor: Uint16Array;   // 経路上の現在インデックス

  constructor(capacity: number) {
    this.capacity = capacity;
    const f = () => new Float32Array(capacity);
    this.posX = f(); this.posZ = f(); this.velX = f(); this.velZ = f();
    this.heading = f(); this.maxSpeed = f();
    this.energy = f(); this.hunger = f(); this.social = f();
    this.hygiene = f(); this.fun = f(); this.wealth = f();
    this.age = new Uint8Array(capacity);
    this.occupation = new Uint8Array(capacity);
    this.state = new Uint8Array(capacity);
    this.homePOI = new Int32Array(capacity).fill(-1);
    this.workPOI = new Int32Array(capacity).fill(-1);
    this.goalPOI = new Int32Array(capacity).fill(-1);
    this.goalX = f(); this.goalZ = f();
    this.pathHandle = new Int32Array(capacity).fill(-1);
    this.pathCursor = new Uint16Array(capacity);
  }

  /** 新規エージェントを1体確保し index を返す。満杯なら -1。 */
  spawn(x: number, z: number): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.posX[i] = x; this.posZ[i] = z;
    this.velX[i] = 0; this.velZ[i] = 0;
    this.maxSpeed[i] = 1.2 + Math.random() * 0.6; // 個体差のある歩行速度
    this.energy[i] = 0.6 + Math.random() * 0.4;
    this.hunger[i] = 0.6 + Math.random() * 0.4;
    this.social[i] = 0.5 + Math.random() * 0.5;
    this.hygiene[i] = 0.7 + Math.random() * 0.3;
    this.fun[i] = 0.5 + Math.random() * 0.5;
    this.wealth[i] = Math.random();
    this.age[i] = 18 + Math.floor(Math.random() * 60);
    this.state[i] = AgentState.Idle;
    return i;
  }
}
