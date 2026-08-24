export {};

let cellSize = 200, invCell = 1 / 200;
let x = new Float32Array(0), z = new Float32Array(0), priceTier = new Float32Array(0);
let capacity = new Int32Array(0), category = new Uint8Array(0), occupancy = new Int32Array(0);

// Dense category/cell linked lists. For a 10km city at 200m cells this is only a few
// tens of thousands of Int32 heads and is substantially cheaper to traverse than nested Maps.
let minCx = 0, minCz = 0, gridWidth = 0, gridHeight = 0, cellsPerCategory = 0, categoryCount = 0;
let cellHead = new Int32Array(0), nextInCell = new Int32Array(0);

const JOB_EPOCH = 0;
const JOB_ID = 1;
const JOB_KIND = 2;
const DONE_COUNT = 4;
const DONE_EPOCH = 5;
const KIND_BEST = 0;

let workerId = 0, workerCount = 1, completionByAtomics = false;
let control!: Int32Array, ranges!: Int32Array, queryCategories!: Uint8Array;
let queryXs!: Float32Array, queryZs!: Float32Array, queryWealth!: Float32Array, results!: Int32Array;

const occupied = (id: number): number => typeof SharedArrayBuffer !== 'undefined' && occupancy.buffer instanceof SharedArrayBuffer ? Atomics.load(occupancy, id) : occupancy[id];

function cellIndex(cx: number, cz: number): number {
  const lx = cx - minCx, lz = cz - minCz;
  if (lx < 0 || lz < 0 || lx >= gridWidth || lz >= gridHeight) return -1;
  return lz * gridWidth + lx;
}

function buildIndex(): void {
  if (category.length === 0) {
    minCx = minCz = 0; gridWidth = gridHeight = cellsPerCategory = categoryCount = 0;
    cellHead = new Int32Array(0); nextInCell = new Int32Array(0); return;
  }

  let maxCx = -Infinity, maxCz = -Infinity; minCx = Infinity; minCz = Infinity; categoryCount = 1;
  for (let i = 0; i < category.length; i++) {
    const cx = Math.floor(x[i] * invCell), cz = Math.floor(z[i] * invCell);
    if (cx < minCx) minCx = cx; if (cx > maxCx) maxCx = cx;
    if (cz < minCz) minCz = cz; if (cz > maxCz) maxCz = cz;
    categoryCount = Math.max(categoryCount, category[i] + 1);
  }

  gridWidth = Math.max(1, maxCx - minCx + 1); gridHeight = Math.max(1, maxCz - minCz + 1);
  cellsPerCategory = gridWidth * gridHeight;
  cellHead = new Int32Array(categoryCount * cellsPerCategory); cellHead.fill(-1);
  nextInCell = new Int32Array(category.length); nextInCell.fill(-1);

  for (let i = 0; i < category.length; i++) {
    const ci = cellIndex(Math.floor(x[i] * invCell), Math.floor(z[i] * invCell));
    if (ci < 0) continue;
    const headIndex = category[i] * cellsPerCategory + ci;
    nextInCell[i] = cellHead[headIndex]; cellHead[headIndex] = i;
  }
}

function queryExpanding(cat: number, qx: number, qz: number, radii: readonly number[], evaluate: (id: number) => void, shouldStop: () => boolean): void {
  if (cat < 0 || cat >= categoryCount || cellsPerCategory <= 0) return;
  let prevMinCx = 1, prevMaxCx = 0, prevMinCz = 1, prevMaxCz = 0;
  for (const radius of radii) {
    const qMinCx = Math.floor((qx - radius) * invCell), qMaxCx = Math.floor((qx + radius) * invCell);
    const qMinCz = Math.floor((qz - radius) * invCell), qMaxCz = Math.floor((qz + radius) * invCell);
    for (let cx = qMinCx; cx <= qMaxCx; cx++) for (let cz = qMinCz; cz <= qMaxCz; cz++) {
      if (cx >= prevMinCx && cx <= prevMaxCx && cz >= prevMinCz && cz <= prevMaxCz) continue;
      const ci = cellIndex(cx, cz); if (ci < 0) continue;
      let id = cellHead[cat * cellsPerCategory + ci];
      while (id >= 0) { evaluate(id); id = nextInCell[id]; }
    }
    prevMinCx = qMinCx; prevMaxCx = qMaxCx; prevMinCz = qMinCz; prevMaxCz = qMaxCz;
    if (shouldStop()) return;
  }
}

function findBest(cat: number, qx: number, qz: number, wealth: number): number {
  let bestId = -1, bestCost = Infinity;
  queryExpanding(cat, qx, qz, [300, 800, 2000, 5000], (id) => {
    if (capacity[id] <= 0 || occupied(id) >= capacity[id]) return;
    const dx = x[id] - qx, dz = z[id] - qz, pm = Math.abs(priceTier[id] - wealth);
    const cost = dx * dx + dz * dz + pm * pm * 400 * 400;
    if (cost < bestCost) { bestCost = cost; bestId = id; }
  }, () => bestId >= 0);
  return bestId;
}

function findNearest(cat: number, qx: number, qz: number): number {
  let bestId = -1, bestD = Infinity;
  queryExpanding(cat, qx, qz, [300, 800, 2000, 5000, 12000], (id) => {
    if (capacity[id] <= 0 || occupied(id) >= capacity[id]) return;
    const dx = x[id] - qx, dz = z[id] - qz, d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; bestId = id; }
  }, () => bestId >= 0);
  return bestId;
}

function runRange(begin: number, end: number, kind: number): void {
  for (let i = begin; i < end; i++) {
    results[i] = kind === KIND_BEST
      ? findBest(queryCategories[i], queryXs[i], queryZs[i], queryWealth[i])
      : findNearest(queryCategories[i], queryXs[i], queryZs[i]);
  }
}

function finish(jobId: number): void {
  const done = Atomics.add(control, DONE_COUNT, 1) + 1;
  if (done !== workerCount) return;
  Atomics.add(control, DONE_EPOCH, 1);
  Atomics.notify(control, DONE_EPOCH, 1);
  if (!completionByAtomics) postMessage({ type: 'done', jobId });
}

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
    const jobId = Atomics.load(control, JOB_ID), kind = Atomics.load(control, JOB_KIND);
    runRange(ranges[workerId * 2], ranges[workerId * 2 + 1], kind);
    finish(jobId);
  }
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type !== 'init') return;
  workerId = m.workerId; workerCount = m.workerCount; completionByAtomics = m.completionByAtomics;
  cellSize = m.cellSize; invCell = 1 / cellSize;
  x = m.x; z = m.z; priceTier = m.priceTier; capacity = m.capacity; category = m.category; occupancy = m.occupancy;
  control = new Int32Array(m.shared.control); ranges = new Int32Array(m.shared.ranges);
  queryCategories = new Uint8Array(m.shared.categories); queryXs = new Float32Array(m.shared.xs); queryZs = new Float32Array(m.shared.zs);
  queryWealth = new Float32Array(m.shared.wealth); results = new Int32Array(m.shared.results);
  buildIndex();
  runLoop();
};
