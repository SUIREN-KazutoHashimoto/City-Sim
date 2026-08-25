export enum AgentState { Idle = 0, Routing = 2, Traveling = 3, Engaged = 4, Driving = 5, ToVehicle = 6, ToBusStop = 7, WaitingBus = 8, OnBus = 9, ToRailStation = 10, WaitingTrain = 11, OnTrain = 12 }
export enum Occupation { Office = 0, ShiftEarly = 1, ShiftLate = 2, NightShift = 3, Student = 4, Retail = 5, Freelance = 6, Unemployed = 7, Retiree = 8 }
export const OCCUPATION_LABEL: Record<Occupation, string> = {
  [Occupation.Office]: '会社員', [Occupation.ShiftEarly]: '早番勤務', [Occupation.ShiftLate]: '遅番勤務', [Occupation.NightShift]: '夜勤',
  [Occupation.Student]: '学生', [Occupation.Retail]: '販売/サービス', [Occupation.Freelance]: '自由業', [Occupation.Unemployed]: '無職', [Occupation.Retiree]: '退職者',
};

/**
 * Agent SoA store. cross-origin isolated環境ではSharedArrayBufferを使い、
 * Agent Worker Poolから同じ配列をコピー無しで更新できる。
 */
export class AgentStore {
  readonly capacity: number; count = 0;
  readonly sharedMemory: boolean;
  posX: Float32Array; posZ: Float32Array; velX: Float32Array; velZ: Float32Array; heading: Float32Array; maxSpeed: Float32Array;
  energy: Float32Array; hunger: Float32Array; social: Float32Array; hygiene: Float32Array; fun: Float32Array;
  wealth: Float32Array; age: Uint8Array; occupation: Uint8Array; workStart: Float32Array; workEnd: Float32Array; extrovert: Float32Array;
  state: Uint8Array;
  homePOI: Int32Array; workPOI: Int32Array; goalPOI: Int32Array; goalCategory: Uint8Array; goalX: Float32Array; goalZ: Float32Array;
  pathHandle: Int32Array; pathCursor: Uint16Array; waiting: Uint8Array;
  dwellUntil: Float32Array; nextDecideAt: Float32Array; activityExit: Uint8Array;
  ownsCar: Uint8Array; car: Int32Array; destParkPOI: Int32Array; destParkSlot: Int32Array;
  boardStop: Int32Array; alightStop: Int32Array; busRoute: Int32Array;

  constructor(capacity: number, preferShared = true) {
    this.capacity = capacity;
    this.sharedMemory = preferShared && typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;
    const alloc = (bytes: number): ArrayBufferLike => this.sharedMemory ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    const f = () => new Float32Array(alloc(capacity * Float32Array.BYTES_PER_ELEMENT));
    const u8 = () => new Uint8Array(alloc(capacity * Uint8Array.BYTES_PER_ELEMENT));
    const u16 = () => new Uint16Array(alloc(capacity * Uint16Array.BYTES_PER_ELEMENT));
    const i32 = () => new Int32Array(alloc(capacity * Int32Array.BYTES_PER_ELEMENT));

    this.posX = f(); this.posZ = f(); this.velX = f(); this.velZ = f(); this.heading = f(); this.maxSpeed = f();
    this.energy = f(); this.hunger = f(); this.social = f(); this.hygiene = f(); this.fun = f();
    this.wealth = f(); this.age = u8(); this.occupation = u8();
    this.workStart = f(); this.workEnd = f(); this.extrovert = f();
    this.state = u8();
    this.homePOI = i32(); this.homePOI.fill(-1); this.workPOI = i32(); this.workPOI.fill(-1); this.goalPOI = i32(); this.goalPOI.fill(-1);
    this.goalCategory = u8(); this.goalCategory.fill(255);
    this.goalX = f(); this.goalZ = f();
    this.pathHandle = i32(); this.pathHandle.fill(-1); this.pathCursor = u16(); this.waiting = u8();
    this.dwellUntil = f(); this.nextDecideAt = f(); this.activityExit = u8();
    this.ownsCar = u8(); this.car = i32(); this.car.fill(-1); this.destParkPOI = i32(); this.destParkPOI.fill(-1); this.destParkSlot = i32(); this.destParkSlot.fill(-1);
    this.boardStop = i32(); this.boardStop.fill(-1); this.alightStop = i32(); this.alightStop.fill(-1); this.busRoute = i32(); this.busRoute.fill(-1);
  }

  /**
   * Spawn-time attributes must be reproducible for a fixed city/population layout.
   * Derive an independent deterministic stream from agent id + spawn position instead
   * of Math.random(), which otherwise changes later seeded population RNG consumption.
   */
  private static spawnSeed(agent: number, x: number, z: number): number {
    const xi = Math.round(x * 16) | 0, zi = Math.round(z * 16) | 0;
    return (
      Math.imul((agent + 1) | 0, 0x9e3779b1)
      ^ Math.imul(xi, 0x85ebca6b)
      ^ Math.imul(zi, 0xc2b2ae35)
    ) >>> 0;
  }

  private static spawnRandom(seed: number, salt: number): number {
    let v = (seed ^ Math.imul(salt | 0, 0x27d4eb2d)) | 0;
    v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
    v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  }

  spawn(x: number, z: number): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.posX[i] = x; this.posZ[i] = z; this.velX[i] = 0; this.velZ[i] = 0;

    const seed = AgentStore.spawnSeed(i, this.posX[i], this.posZ[i]);
    const r = (salt: number): number => AgentStore.spawnRandom(seed, salt);
    this.maxSpeed[i] = 1.2 + r(1) * 0.6;
    this.energy[i] = 0.5 + r(2) * 0.5; this.hunger[i] = 0.5 + r(3) * 0.5;
    this.social[i] = 0.4 + r(4) * 0.6; this.hygiene[i] = 0.7 + r(5) * 0.3; this.fun[i] = 0.4 + r(6) * 0.6;
    this.wealth[i] = r(7); this.age[i] = 16 + Math.floor(r(8) * 70); this.extrovert[i] = r(9);
    this.state[i] = AgentState.Idle; this.goalCategory[i] = 255; this.activityExit[i] = 0;
    return i;
  }
}
