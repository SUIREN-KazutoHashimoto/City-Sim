export enum AgentState {
  Idle = 0, Routing = 2, Traveling = 3, Engaged = 4, Driving = 5, ToVehicle = 6,
}
export enum Occupation {
  Office = 0, ShiftEarly = 1, ShiftLate = 2, NightShift = 3, Student = 4,
  Retail = 5, Freelance = 6, Unemployed = 7, Retiree = 8,
}
export const OCCUPATION_LABEL: Record<Occupation, string> = {
  [Occupation.Office]: '会社員', [Occupation.ShiftEarly]: '早番勤務',
  [Occupation.ShiftLate]: '遅番勤務', [Occupation.NightShift]: '夜勤',
  [Occupation.Student]: '学生', [Occupation.Retail]: '販売/サービス',
  [Occupation.Freelance]: '自由業', [Occupation.Unemployed]: '無職', [Occupation.Retiree]: '退職者',
};

export class AgentStore {
  readonly capacity: number;
  count = 0;
  posX: Float32Array; posZ: Float32Array; velX: Float32Array; velZ: Float32Array;
  heading: Float32Array; maxSpeed: Float32Array;
  energy: Float32Array; hunger: Float32Array; social: Float32Array; hygiene: Float32Array; fun: Float32Array;
  wealth: Float32Array; age: Uint8Array; occupation: Uint8Array;
  workStart: Float32Array; workEnd: Float32Array; extrovert: Float32Array;
  state: Uint8Array;
  homePOI: Int32Array; workPOI: Int32Array; goalPOI: Int32Array; goalX: Float32Array; goalZ: Float32Array;
  pathHandle: Int32Array; pathCursor: Uint16Array; waiting: Uint8Array;
  dwellUntil: Float32Array; nextDecideAt: Float32Array;
  ownsCar: Uint8Array; car: Int32Array; destParkPOI: Int32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    const f = () => new Float32Array(capacity);
    this.posX = f(); this.posZ = f(); this.velX = f(); this.velZ = f();
    this.heading = f(); this.maxSpeed = f();
    this.energy = f(); this.hunger = f(); this.social = f(); this.hygiene = f(); this.fun = f();
    this.wealth = f(); this.age = new Uint8Array(capacity); this.occupation = new Uint8Array(capacity);
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
    this.posX[i] = x; this.posZ[i] = z; this.velX[i] = 0; this.velZ[i] = 0;
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
