export {};

type Buffers = {
  posX: SharedArrayBuffer; posZ: SharedArrayBuffer; velX: SharedArrayBuffer; velZ: SharedArrayBuffer;
  heading: SharedArrayBuffer; maxSpeed: SharedArrayBuffer; energy: SharedArrayBuffer;
  desiredX: SharedArrayBuffer; desiredZ: SharedArrayBuffer;
  activeIds: SharedArrayBuffer; moveIds: SharedArrayBuffer;
  snapshotX: SharedArrayBuffer; snapshotZ: SharedArrayBuffer;
  cellHead: SharedArrayBuffer; nextInCell: SharedArrayBuffer;
};
type InitMessage = { type: 'init'; cellSize: number; gridOrigin: number; gridWidth: number; buffers: Buffers };
type IndexMessage = { type: 'index'; jobId: number; activeCount: number };
type MoveMessage = { type: 'move'; jobId: number; begin: number; end: number; dt: number };
type Message = InitMessage | IndexMessage | MoveMessage;

let posX!: Float32Array, posZ!: Float32Array, velX!: Float32Array, velZ!: Float32Array;
let heading!: Float32Array, maxSpeed!: Float32Array, energy!: Float32Array;
let desiredX!: Float32Array, desiredZ!: Float32Array, snapshotX!: Float32Array, snapshotZ!: Float32Array;
let activeIds!: Int32Array, moveIds!: Int32Array, cellHead!: Int32Array, nextInCell!: Int32Array;
let cellSize = 8, invCell = 1 / 8, gridOrigin = -32, gridWidth = 8;
let usedCells = new Int32Array(0), usedCellCount = 0;

const cellOf = (x: number, z: number): number => {
  const cx = Math.floor((x - gridOrigin) * invCell), cz = Math.floor((z - gridOrigin) * invCell);
  if (cx < 0 || cz < 0 || cx >= gridWidth || cz >= gridWidth) return -1;
  return cz * gridWidth + cx;
};

function rebuildIndex(activeCount: number): void {
  // Sparse clear: only reset cells that were populated in the previous step.
  for (let i = 0; i < usedCellCount; i++) cellHead[usedCells[i]] = -1;
  usedCellCount = 0;

  for (let n = 0; n < activeCount; n++) {
    const agent = activeIds[n], x = posX[agent], z = posZ[agent];
    snapshotX[agent] = x; snapshotZ[agent] = z;
    const cell = cellOf(x, z);
    if (cell < 0) { nextInCell[agent] = -1; continue; }
    if (cellHead[cell] === -1) usedCells[usedCellCount++] = cell;
    nextInCell[agent] = cellHead[cell]; cellHead[cell] = agent;
  }
}

function moveRange(begin: number, end: number, dt: number): void {
  const radius = 2, radius2 = radius * radius;
  for (let n = begin; n < end; n++) {
    const agent = moveIds[n], px = snapshotX[agent], pz = snapshotZ[agent];
    let desX = desiredX[agent], desZ = desiredZ[agent], sepX = 0, sepZ = 0, neighbors = 0;

    const minCx = Math.max(0, Math.floor((px - radius - gridOrigin) * invCell));
    const maxCx = Math.min(gridWidth - 1, Math.floor((px + radius - gridOrigin) * invCell));
    const minCz = Math.max(0, Math.floor((pz - radius - gridOrigin) * invCell));
    const maxCz = Math.min(gridWidth - 1, Math.floor((pz + radius - gridOrigin) * invCell));

    for (let cz = minCz; cz <= maxCz; cz++) for (let cx = minCx; cx <= maxCx; cx++) {
      let other = cellHead[cz * gridWidth + cx];
      while (other >= 0) {
        if (other !== agent) {
          const dx = px - snapshotX[other], dz = pz - snapshotZ[other], d2 = dx * dx + dz * dz;
          if (d2 > 0 && d2 < radius2) {
            const inv = 1 / Math.sqrt(d2); sepX += dx * inv; sepZ += dz * inv; neighbors++;
          }
        }
        other = nextInCell[other];
      }
    }

    if (neighbors > 0) { desX += (sepX / neighbors) * 0.6; desZ += (sepZ / neighbors) * 0.6; }
    const mag = Math.hypot(desX, desZ) || 1, sp = maxSpeed[agent];
    const vx = (desX / mag) * sp, vz = (desZ / mag) * sp;
    velX[agent] = vx; velZ[agent] = vz;
    posX[agent] += vx * dt; posZ[agent] += vz * dt; heading[agent] = Math.atan2(vz, vx);
    energy[agent] = Math.max(0, energy[agent] - (1 / (2.5 * 3600)) * dt);
  }
}

self.onmessage = (ev: MessageEvent<Message>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    cellSize = msg.cellSize; invCell = 1 / cellSize; gridOrigin = msg.gridOrigin; gridWidth = msg.gridWidth;
    posX = new Float32Array(msg.buffers.posX); posZ = new Float32Array(msg.buffers.posZ);
    velX = new Float32Array(msg.buffers.velX); velZ = new Float32Array(msg.buffers.velZ);
    heading = new Float32Array(msg.buffers.heading); maxSpeed = new Float32Array(msg.buffers.maxSpeed); energy = new Float32Array(msg.buffers.energy);
    desiredX = new Float32Array(msg.buffers.desiredX); desiredZ = new Float32Array(msg.buffers.desiredZ);
    activeIds = new Int32Array(msg.buffers.activeIds); moveIds = new Int32Array(msg.buffers.moveIds);
    snapshotX = new Float32Array(msg.buffers.snapshotX); snapshotZ = new Float32Array(msg.buffers.snapshotZ);
    cellHead = new Int32Array(msg.buffers.cellHead); nextInCell = new Int32Array(msg.buffers.nextInCell);
    usedCells = new Int32Array(nextInCell.length); return;
  }
  if (msg.type === 'index') { rebuildIndex(msg.activeCount); postMessage({ type: 'done', jobId: msg.jobId }); return; }
  moveRange(msg.begin, msg.end, msg.dt); postMessage({ type: 'done', jobId: msg.jobId });
};
