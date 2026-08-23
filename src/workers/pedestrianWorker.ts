export {};

type Buffers = {
  posX: SharedArrayBuffer; posZ: SharedArrayBuffer; velX: SharedArrayBuffer; velZ: SharedArrayBuffer;
  heading: SharedArrayBuffer; maxSpeed: SharedArrayBuffer; energy: SharedArrayBuffer;
  desiredX: SharedArrayBuffer; desiredZ: SharedArrayBuffer; moveMask: SharedArrayBuffer;
};
type InitMessage = { type: 'init'; buffers: Buffers };
type MoveMessage = { type: 'move'; jobId: number; begin: number; end: number; dt: number };
type Message = InitMessage | MoveMessage;

let posX!: Float32Array, posZ!: Float32Array, velX!: Float32Array, velZ!: Float32Array;
let heading!: Float32Array, maxSpeed!: Float32Array, energy!: Float32Array;
let desiredX!: Float32Array, desiredZ!: Float32Array, moveMask!: Uint8Array;

self.onmessage = (ev: MessageEvent<Message>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    posX = new Float32Array(msg.buffers.posX); posZ = new Float32Array(msg.buffers.posZ);
    velX = new Float32Array(msg.buffers.velX); velZ = new Float32Array(msg.buffers.velZ);
    heading = new Float32Array(msg.buffers.heading); maxSpeed = new Float32Array(msg.buffers.maxSpeed); energy = new Float32Array(msg.buffers.energy);
    desiredX = new Float32Array(msg.buffers.desiredX); desiredZ = new Float32Array(msg.buffers.desiredZ); moveMask = new Uint8Array(msg.buffers.moveMask);
    return;
  }

  for (let i = msg.begin; i < msg.end; i++) {
    if (moveMask[i] === 0) continue;
    const dx = desiredX[i], dz = desiredZ[i], mag = Math.hypot(dx, dz) || 1, sp = maxSpeed[i];
    const vx = (dx / mag) * sp, vz = (dz / mag) * sp;
    velX[i] = vx; velZ[i] = vz; posX[i] += vx * msg.dt; posZ[i] += vz * msg.dt; heading[i] = Math.atan2(vz, vx);
    energy[i] = Math.max(0, energy[i] - (1 / (2.5 * 3600)) * msg.dt);
    moveMask[i] = 0;
  }
  postMessage({ type: 'done', jobId: msg.jobId });
};
