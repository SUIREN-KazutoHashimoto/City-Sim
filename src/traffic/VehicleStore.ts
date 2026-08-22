export enum VehicleState { Parked = 0, Driving = 1, Arrived = 2 }
export class VehicleStore {
  readonly capacity: number;
  count = 0;
  posX: Float32Array; posZ: Float32Array; heading: Float32Array;
  speed: Float32Array; maxSpeed: Float32Array; accel: Float32Array;
  length: Float32Array; aMax: Float32Array; bComf: Float32Array; t0: Float32Array; s0: Float32Array;
  fromNode: Int32Array; toNode: Int32Array; edge: Int32Array; segT: Float32Array; segLen: Float32Array;
  state: Uint8Array; driver: Int32Array; parkPOI: Int32Array; colorIdx: Uint8Array;
  paths: Int32Array[] = []; pathCursor: Uint16Array;
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
    this.parkPOI = new Int32Array(capacity).fill(-1);
    this.colorIdx = new Uint8Array(capacity);
    this.pathCursor = new Uint16Array(capacity);
    for (let i = 0; i < capacity; i++) this.paths.push(new Int32Array(0));
  }
  create(driver: number, parkPOI: number, x: number, z: number): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.driver[i] = driver; this.parkPOI[i] = parkPOI;
    this.posX[i] = x; this.posZ[i] = z; this.speed[i] = 0; this.accel[i] = 0;
    this.length[i] = 4.2 + Math.random() * 0.8;
    this.aMax[i] = 1.4 + Math.random() * 0.6;
    this.bComf[i] = 2.0 + Math.random() * 0.8;
    this.t0[i] = 1.1 + Math.random() * 0.6;
    this.s0[i] = 2.0 + Math.random() * 0.5;
    this.state[i] = VehicleState.Parked;
    this.colorIdx[i] = Math.floor(Math.random() * 7);
    this.segT[i] = 0; this.pathCursor[i] = 0;
    return i;
  }
}
