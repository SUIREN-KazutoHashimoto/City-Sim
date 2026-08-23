export {};

type BestQuery = { category: number; x: number; z: number; wealth: number };
type NearestQuery = { category: number; x: number; z: number };

let cellSize = 200, invCell = 1 / 200;
let x = new Float32Array(0), z = new Float32Array(0), priceTier = new Float32Array(0);
let capacity = new Int32Array(0), category = new Uint8Array(0), occupancy = new Int32Array(0);
const grids = new Map<number, Map<number, number[]>>();
const gridDim = 1 << 16;
const key = (cx: number, cz: number): number => ((cx + (gridDim >> 1)) << 16) | (cz + (gridDim >> 1));
const occupied = (id: number): number => typeof SharedArrayBuffer !== 'undefined' && occupancy.buffer instanceof SharedArrayBuffer ? Atomics.load(occupancy, id) : occupancy[id];

function buildIndex(): void {
  grids.clear();
  for (let i = 0; i < category.length; i++) {
    let grid = grids.get(category[i]); if (!grid) { grid = new Map<number, number[]>(); grids.set(category[i], grid); }
    const cx = Math.floor(x[i] * invCell), cz = Math.floor(z[i] * invCell), k = key(cx, cz);
    let bucket = grid.get(k); if (!bucket) { bucket = []; grid.set(k, bucket); } bucket.push(i);
  }
}

function queryExpanding(cat: number, qx: number, qz: number, radii: readonly number[], evaluate: (id: number) => void, shouldStop: () => boolean): void {
  const grid = grids.get(cat); if (!grid) return;
  let prevMinCx = 1, prevMaxCx = 0, prevMinCz = 1, prevMaxCz = 0;
  for (const radius of radii) {
    const minCx = Math.floor((qx - radius) * invCell), maxCx = Math.floor((qx + radius) * invCell);
    const minCz = Math.floor((qz - radius) * invCell), maxCz = Math.floor((qz + radius) * invCell);
    for (let cx = minCx; cx <= maxCx; cx++) for (let cz = minCz; cz <= maxCz; cz++) {
      if (cx >= prevMinCx && cx <= prevMaxCx && cz >= prevMinCz && cz <= prevMaxCz) continue;
      const bucket = grid.get(key(cx, cz)); if (bucket) for (let i = 0; i < bucket.length; i++) evaluate(bucket[i]);
    }
    prevMinCx = minCx; prevMaxCx = maxCx; prevMinCz = minCz; prevMaxCz = maxCz;
    if (shouldStop()) return;
  }
}

function findBest(q: BestQuery): number {
  let bestId = -1, bestCost = Infinity;
  queryExpanding(q.category, q.x, q.z, [300, 800, 2000, 5000], (id) => {
    if (occupied(id) >= capacity[id]) return;
    const dx = x[id] - q.x, dz = z[id] - q.z, pm = Math.abs(priceTier[id] - q.wealth);
    const cost = dx * dx + dz * dz + pm * pm * 400 * 400;
    if (cost < bestCost) { bestCost = cost; bestId = id; }
  }, () => bestId >= 0);
  return bestId;
}

function findNearest(q: NearestQuery): number {
  let bestId = -1, bestD = Infinity;
  queryExpanding(q.category, q.x, q.z, [300, 800, 2000, 5000, 12000], (id) => {
    if (occupied(id) >= capacity[id]) return;
    const dx = x[id] - q.x, dz = z[id] - q.z, d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; bestId = id; }
  }, () => bestId >= 0);
  return bestId;
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'init') {
    cellSize = m.cellSize; invCell = 1 / cellSize;
    x = m.x; z = m.z; priceTier = m.priceTier; capacity = m.capacity; category = m.category; occupancy = m.occupancy;
    buildIndex(); return;
  }
  if (m.type !== 'search') return;
  const queries = m.queries as (BestQuery | NearestQuery)[], results = new Int32Array(queries.length);
  for (let i = 0; i < queries.length; i++) results[i] = m.kind === 'best' ? findBest(queries[i] as BestQuery) : findNearest(queries[i] as NearestQuery);
  postMessage({ type: 'result', jobId: m.jobId, offset: m.offset, results });
};
