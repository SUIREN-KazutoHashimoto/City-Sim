export {};

type Buffers = {
  posX: SharedArrayBuffer; posZ: SharedArrayBuffer; velX: SharedArrayBuffer; velZ: SharedArrayBuffer;
  heading: SharedArrayBuffer; maxSpeed: SharedArrayBuffer; energy: SharedArrayBuffer;
  desiredX: SharedArrayBuffer; desiredZ: SharedArrayBuffer;
  activeIds: SharedArrayBuffer; moveIds: SharedArrayBuffer;
  snapshotX: SharedArrayBuffer; snapshotZ: SharedArrayBuffer;
  cellHead: SharedArrayBuffer; nextInCell: SharedArrayBuffer;
  usedCells: SharedArrayBuffer; control: SharedArrayBuffer; metrics: SharedArrayBuffer;
};
type InitMessage = {
  type: 'init'; workerId: number; workerCount: number;
  cellSize: number; gridOrigin: number; gridWidth: number; buffers: Buffers;
};

const BARRIER_COUNT = 0;
const BARRIER_EPOCH = 1;
const USED_CELL_COUNT = 2;
const DONE_COUNT = 3;
const JOB_EPOCH = 4;
const JOB_ID = 5;
const JOB_ACTIVE_COUNT = 6;
const JOB_MOVE_COUNT = 7;
const JOB_DT_MICROS = 8;
const METRIC_STRIDE = 5;
const M_PREP = 0;
const M_INDEX = 1;
const M_AVOID_MOVE = 2;
const M_BARRIER = 3;
const M_TOTAL = 4;

let posX!: Float32Array, posZ!: Float32Array, velX!: Float32Array, velZ!: Float32Array;
let heading!: Float32Array, maxSpeed!: Float32Array, energy!: Float32Array;
let desiredX!: Float32Array, desiredZ!: Float32Array, snapshotX!: Float32Array, snapshotZ!: Float32Array;
let activeIds!: Int32Array, moveIds!: Int32Array, cellHead!: Int32Array, nextInCell!: Int32Array, usedCells!: Int32Array;
let control!: Int32Array, metrics!: Float32Array;
let cellSize = 8, invCell = 1 / 8, gridOrigin = -32, gridWidth = 8;
let workerId = 0, workerCount = 1;

const cellOf = (x: number, z: number): number => {
  const cx = Math.floor((x - gridOrigin) * invCell), cz = Math.floor((z - gridOrigin) * invCell);
  if (cx < 0 || cz < 0 || cx >= gridWidth || cz >= gridWidth) return -1;
  return cz * gridWidth + cx;
};

function barrier(resetUsedCellCount: boolean): void {
  const epoch = Atomics.load(control, BARRIER_EPOCH);
  const arrived = Atomics.add(control, BARRIER_COUNT, 1) + 1;
  if (arrived === workerCount) {
    if (resetUsedCellCount) Atomics.store(control, USED_CELL_COUNT, 0);
    Atomics.store(control, BARRIER_COUNT, 0);
    Atomics.add(control, BARRIER_EPOCH, 1);
    Atomics.notify(control, BARRIER_EPOCH, workerCount - 1);
    return;
  }
  while (Atomics.load(control, BARRIER_EPOCH) === epoch) Atomics.wait(control, BARRIER_EPOCH, epoch);
}

function clearAndSnapshot(activeCount: number): void {
  const previousUsed = Atomics.load(control, USED_CELL_COUNT);
  const clearBegin = Math.floor((previousUsed * workerId) / workerCount);
  const clearEnd = Math.floor((previousUsed * (workerId + 1)) / workerCount);
  for (let n = clearBegin; n < clearEnd; n++) cellHead[usedCells[n]] = -1;

  const begin = Math.floor((activeCount * workerId) / workerCount);
  const end = Math.floor((activeCount * (workerId + 1)) / workerCount);
  for (let n = begin; n < end; n++) {
    const agent = activeIds[n];
    snapshotX[agent] = posX[agent]; snapshotZ[agent] = posZ[agent];
  }
}

function buildIndex(activeCount: number): void {
  const begin = Math.floor((activeCount * workerId) / workerCount);
  const end = Math.floor((activeCount * (workerId + 1)) / workerCount);
  for (let n = begin; n < end; n++) {
    const agent = activeIds[n], cell = cellOf(snapshotX[agent], snapshotZ[agent]);
    if (cell < 0) { nextInCell[agent] = -1; continue; }
    const previous = Atomics.exchange(cellHead, cell, agent);
    nextInCell[agent] = previous;
    if (previous === -1) {
      const slot = Atomics.add(control, USED_CELL_COUNT, 1);
      if (slot < usedCells.length) usedCells[slot] = cell;
    }
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

function finishStep(jobId: number, prepMs: number, indexMs: number, avoidMoveMs: number, barrierMs: number, totalMs: number): void {
  const base = workerId * METRIC_STRIDE;
  metrics[base + M_PREP] = prepMs;
  metrics[base + M_INDEX] = indexMs;
  metrics[base + M_AVOID_MOVE] = avoidMoveMs;
  metrics[base + M_BARRIER] = barrierMs;
  metrics[base + M_TOTAL] = totalMs;

  const done = Atomics.add(control, DONE_COUNT, 1) + 1;
  if (done !== workerCount) return;
  Atomics.store(control, DONE_COUNT, 0);

  let maxPrep = 0, maxIndex = 0, maxAvoidMove = 0, maxBarrier = 0, maxTotal = 0;
  for (let w = 0; w < workerCount; w++) {
    const p = w * METRIC_STRIDE;
    maxPrep = Math.max(maxPrep, metrics[p + M_PREP]);
    maxIndex = Math.max(maxIndex, metrics[p + M_INDEX]);
    maxAvoidMove = Math.max(maxAvoidMove, metrics[p + M_AVOID_MOVE]);
    maxBarrier = Math.max(maxBarrier, metrics[p + M_BARRIER]);
    maxTotal = Math.max(maxTotal, metrics[p + M_TOTAL]);
  }
  postMessage({ type: 'done', jobId, timing: { prepMs: maxPrep, indexMs: maxIndex, avoidMoveMs: maxAvoidMove, barrierMs: maxBarrier, totalMs: maxTotal } });
}

function runStep(jobId: number, activeCount: number, moveCount: number, dt: number): void {
  const totalStart = performance.now();

  const prepStart = performance.now();
  clearAndSnapshot(activeCount);
  const prepMs = performance.now() - prepStart;

  let barrierMs = 0;
  let waitStart = performance.now(); barrier(true); barrierMs += performance.now() - waitStart;

  const indexStart = performance.now();
  buildIndex(activeCount);
  const indexMs = performance.now() - indexStart;

  waitStart = performance.now(); barrier(false); barrierMs += performance.now() - waitStart;

  const moveBegin = Math.floor((moveCount * workerId) / workerCount);
  const moveEnd = Math.floor((moveCount * (workerId + 1)) / workerCount);
  const moveStart = performance.now();
  moveRange(moveBegin, moveEnd, dt);
  const avoidMoveMs = performance.now() - moveStart;

  finishStep(jobId, prepMs, indexMs, avoidMoveMs, barrierMs, performance.now() - totalStart);
}

/** Persistent worker loop. Main thread only advances JOB_EPOCH and Atomics.notify(). */
function runLoop(): never {
  let seenEpoch = 0;
  for (;;) {
    let epoch = Atomics.load(control, JOB_EPOCH);
    if (epoch === seenEpoch) {
      Atomics.wait(control, JOB_EPOCH, seenEpoch);
      epoch = Atomics.load(control, JOB_EPOCH);
      if (epoch === seenEpoch) continue;
    }
    seenEpoch = epoch;
    const jobId = Atomics.load(control, JOB_ID);
    const activeCount = Atomics.load(control, JOB_ACTIVE_COUNT);
    const moveCount = Atomics.load(control, JOB_MOVE_COUNT);
    const dt = Atomics.load(control, JOB_DT_MICROS) / 1_000_000;
    runStep(jobId, activeCount, moveCount, dt);
  }
}

self.onmessage = (ev: MessageEvent<InitMessage>) => {
  const msg = ev.data;
  if (msg.type !== 'init') return;
  workerId = msg.workerId; workerCount = msg.workerCount;
  cellSize = msg.cellSize; invCell = 1 / cellSize; gridOrigin = msg.gridOrigin; gridWidth = msg.gridWidth;
  posX = new Float32Array(msg.buffers.posX); posZ = new Float32Array(msg.buffers.posZ);
  velX = new Float32Array(msg.buffers.velX); velZ = new Float32Array(msg.buffers.velZ);
  heading = new Float32Array(msg.buffers.heading); maxSpeed = new Float32Array(msg.buffers.maxSpeed); energy = new Float32Array(msg.buffers.energy);
  desiredX = new Float32Array(msg.buffers.desiredX); desiredZ = new Float32Array(msg.buffers.desiredZ);
  activeIds = new Int32Array(msg.buffers.activeIds); moveIds = new Int32Array(msg.buffers.moveIds);
  snapshotX = new Float32Array(msg.buffers.snapshotX); snapshotZ = new Float32Array(msg.buffers.snapshotZ);
  cellHead = new Int32Array(msg.buffers.cellHead); nextInCell = new Int32Array(msg.buffers.nextInCell);
  usedCells = new Int32Array(msg.buffers.usedCells); control = new Int32Array(msg.buffers.control); metrics = new Float32Array(msg.buffers.metrics);
  runLoop();
};
