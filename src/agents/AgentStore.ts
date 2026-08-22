/** データ指向 実行層 (SoA)。全エージェント状態を列ごとの TypedArray で保持。 */
export enum AgentState {
  Idle = 0,
  Routing = 2,
  Traveling = 3,   // 徒歩移動中(歩道経路追従)
  Engaged = 4,     // 目的地で活動中
  Driving = 5,     // 車で移動中
  ToVehicle = 6,   // 駐車中の自車まで徒歩で向かう
}

/**
 * 職業/ライフスタイル。時間帯ごとの行動を多様化し、
 * 「昼は全員職場、夜は全員自宅」で街が空になるのを防ぐ。
 */
export enum Occupation {
  Office = 0,     // 会社員 9-18
  ShiftEarly = 1, // 早番 6-14
  ShiftLate = 2,  // 遅番 14-22
  NightShift = 3, // 夜勤 22-6
  Student = 4,    // 学生 8-15
  Retail = 5,     // 店員/サービス 10-20
  Freelance = 6,  // 自由業(在宅/外出が不定)
  Unemployed = 7, // 無職/求職(日中に街をうろつく)
  Retiree = 8,    // 退職者(日中の外出多い)
}

export const OCCUPATION_LABEL: Record<Occupation, string> = {
  [Occupation.Office]: '会社員',
  [Occupation.ShiftEarly]: '早番勤務',
  [Occupation.ShiftLate]: '遅番勤務',
  [Occupation.NightShift]: '夜勤',
  [Occupation.Student]: '学生',
  [Occupation.Retail]: '販売/サービス',
  [Occupation.Freelance]: '自由業',
  [Occupation.Unemployed]: '無職',
  [Occupation.Retiree]: '退職者',
};

export class AgentStore {
  readonly capacity: number;
  count = 0;

  posX: Float32Array; posZ: Float32Array;
  velX: Float32Array; velZ: Float32Array;
  heading: Float32Array; maxSpeed: Float32Array;

  energy: Float32Array; hunger: Float32Array; social: Float32Array;
  hygiene: Float32Array; fun: Float32Array;

  wealth: Float32Array;
  age: Uint8Array;
  occupation: Uint8Array;   // Occupation
  workStart: Float32Array;  // 勤務開始(時, 0..24)
  workEnd: Float32Array;    // 勤務終了(時, 翌日にまたがる場合 end<start)
  extrovert: Float32Array;  // 外向性 0..1(娯楽/社交の頻度)

  state: Uint8Array;
  homePOI: Int32Array; workPOI: Int32Array; goalPOI: Int32Array;
  goalX: Float32Array; goalZ: Float32Array;

  pathHandle: Int32Array;  // 歩道経路を持つ(1)/持たない(-1)
  pathCursor: Uint16Array;
  waiting: Uint8Array;     // 信号待ち

  dwellUntil: Float32Array;
  nextDecideAt: Float32Array;

  // --- 車両所有・駐車 ---
  ownsCar: Uint8Array;     // 自家用車を持つか
  car: Int32Array;         // 所有車両index(-1=なし)
  destParkPOI: Int32Array; // 運転トリップの到着先駐車場POI(-1=なし)

  constructor(capacity: number) {
    this.capacity = capacity;
    const f = () => new Float32Array(capacity);
    this.posX = f(); this.posZ = f(); this.velX = f(); this.velZ = f();
    this.heading = f(); this.maxSpeed = f();
    this.energy = f(); this.hunger = f(); this.social = f();
    this.hygiene = f(); this.fun = f(); this.wealth = f();
    this.age = new Uint8Array(capacity);
    this.occupation = new Uint8Array(capacity);
    this.workStart = f(); this.workEnd = f(); this.extrovert = f();
    this.state = new Uint8Array(capacity);
    this.homePOI = new Int32Array(capacity).fill(-1);
    this.workPOI = new Int32Array(capacity).fill(-1);
    this.goalPOI = new Int32Array(capacity).fill(-1);
    this.goalX = f(); this.goalZ = f();
    this.pathHandle = new Int32Array(capacity).fill(-1);
    this.pathCursor = new Uint16Array(capacity);
    this.waiting = new Uint8Array(capacity);
    this.dwellUntil = f(); this.nextDecideAt = f();
    this.ownsCar = new Uint8Array(capacity);
    this.car = new Int32Array(capacity).fill(-1);
    this.destParkPOI = new Int32Array(capacity).fill(-1);
  }

  spawn(x: number, z: number): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.posX[i] = x; this.posZ[i] = z;
    this.velX[i] = 0; this.velZ[i] = 0;
    this.maxSpeed[i] = 1.2 + Math.random() * 0.6;
    this.energy[i] = 0.5 + Math.random() * 0.5;
    this.hunger[i] = 0.5 + Math.random() * 0.5;
    this.social[i] = 0.4 + Math.random() * 0.6;
    this.hygiene[i] = 0.7 + Math.random() * 0.3;
    this.fun[i] = 0.4 + Math.random() * 0.6;
    this.wealth[i] = Math.random();
    this.age[i] = 16 + Math.floor(Math.random() * 70);
    this.extrovert[i] = Math.random();
    this.state[i] = AgentState.Idle;
    return i;
  }
}
