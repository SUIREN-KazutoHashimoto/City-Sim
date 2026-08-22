/**
 * データ指向 実行層 (Structure of Arrays)。
 * 全エージェントの状態を列ごとの TypedArray で保持する。
 */
export enum AgentState {
  Idle = 0,
  Deciding = 1,
  Routing = 2,
  Traveling = 3,   // 徒歩移動中(歩道経路追従)
  Engaged = 4,     // 目的地で活動中
  Driving = 5,     // 車両で移動中
}

export class AgentStore {
  readonly capacity: number;
  count = 0;

  posX: Float32Array; posZ: Float32Array;
  velX: Float32Array; velZ: Float32Array;
  heading: Float32Array;
  maxSpeed: Float32Array;

  energy: Float32Array; hunger: Float32Array; social: Float32Array;
  hygiene: Float32Array; fun: Float32Array;

  wealth: Float32Array;
  age: Uint8Array;
  occupation: Uint8Array;

  state: Uint8Array;
  homePOI: Int32Array; workPOI: Int32Array; goalPOI: Int32Array;
  goalX: Float32Array; goalZ: Float32Array;

  /** 歩道経路を持つか(1)/持たないか(-1)。持つ場合は World.walkPaths[i] を辿る。 */
  pathHandle: Int32Array;
  /** 歩道経路上の現在ノードインデックス。 */
  pathCursor: Uint16Array;
  /** 信号待ちで停止中か(1=待機)。歩行者信号の可視化・挙動に使う。 */
  waiting: Uint8Array;

  dwellUntil: Float32Array;
  nextDecideAt: Float32Array;
  vehicle: Int32Array;

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
    this.waiting = new Uint8Array(capacity);
    this.dwellUntil = f();
    this.nextDecideAt = f();
    this.vehicle = new Int32Array(capacity).fill(-1);
  }

  spawn(x: number, z: number): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.posX[i] = x; this.posZ[i] = z;
    this.velX[i] = 0; this.velZ[i] = 0;
    this.maxSpeed[i] = 1.2 + Math.random() * 0.6;
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
