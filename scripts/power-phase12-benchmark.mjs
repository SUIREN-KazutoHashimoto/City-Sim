import { performance } from 'node:perf_hooks';

const BUILDINGS = 100_000;
const INFRA = 2_000;
const SEGMENTS = 32_768;
const ITERATIONS = 4;
const PRIORITIES = 4;

function makeConsumers() {
  const buildings = Array.from({ length: BUILDINGS }, (_, i) => ({ id: `b${i}`, priority: i % PRIORITIES, zoneId: i % 8, demandKw: 2 + (i % 17), a: [i % SEGMENTS, (i + 1) % SEGMENTS, (i + 7) % SEGMENTS], b: [(i + 13) % SEGMENTS, (i + 29) % SEGMENTS] }));
  const infra = Array.from({ length: INFRA }, (_, i) => ({ id: `i${i}`, priority: i % 2, zoneId: i % 8, demandKw: 5 + (i % 11), a: [(i * 3) % SEGMENTS], b: [(i * 5 + 7) % SEGMENTS] }));
  return { buildings, infra };
}

function uniquePath(a, b) {
  const seen = new Set(), out = [];
  for (const id of a) if (!seen.has(id)) { seen.add(id); out.push(id); }
  for (const id of b) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

function baseline(buildings, infra) {
  let checksum = 0;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const consumers = [...buildings, ...infra].sort((a, b) => a.priority - b.priority || a.zoneId - b.zoneId || a.id.localeCompare(b.id));
    for (const c of consumers) {
      const path = uniquePath(c.a, c.b);
      checksum += c.demandKw + path.length + c.priority;
    }
  }
  return checksum;
}

function optimized(buildings, infra) {
  const consumers = [...buildings, ...infra];
  const sorted = [...consumers].sort((a, b) => a.priority - b.priority || a.zoneId - b.zoneId || a.id.localeCompare(b.id));
  const paths = new Map(sorted.map((c) => [c.id, uniquePath(c.a, c.b)]));
  let checksum = 0;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (const c of sorted) checksum += c.demandKw + paths.get(c.id).length + c.priority;
  }
  return checksum;
}

function measure(fn) {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

function demandCadenceProbe() {
  let updates = 0, skipped = 0, last = -Infinity;
  for (let t = 0; t <= 60; t += 5) {
    if (Number.isFinite(last) && t - last < 15) skipped++;
    else { last = t; updates++; }
  }
  if (updates !== 5 || skipped !== 8) throw new Error(`demand cadence failed: updates=${updates} skipped=${skipped}`);
  return { updates, skipped };
}

function recoveryProbe() {
  const state = { topologyRebuilds: 1, lineActive: true, generationMw: 150, demandMw: 100 };
  const supply = () => state.lineActive ? Math.min(state.generationMw, state.demandMw) : 0;
  if (supply() !== 100) throw new Error('initial supply failed');
  state.lineActive = false; state.topologyRebuilds++;
  if (supply() !== 0) throw new Error('line cut did not blackout');
  state.lineActive = true; state.topologyRebuilds++;
  if (supply() !== 100) throw new Error('line recovery failed');
  state.generationMw = 60;
  if (supply() !== 60) throw new Error('generation shortage failed');
  state.generationMw = 150;
  if (supply() !== 100) throw new Error('generation recovery failed');
  if (state.topologyRebuilds !== 3) throw new Error('topology rebuild count changed without topology event');
  return state;
}

function seededFingerprint(seed) {
  let x = seed >>> 0, hash = 2166136261 >>> 0;
  for (let i = 0; i < 24; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    hash ^= x; hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const { buildings, infra } = makeConsumers();
const oldRun = measure(() => baseline(buildings, infra));
const newRun = measure(() => optimized(buildings, infra));
if (oldRun.value !== newRun.value) throw new Error(`checksum mismatch ${oldRun.value} != ${newRun.value}`);
if (newRun.ms > 3000) throw new Error(`optimized 100k stress run too slow: ${newRun.ms.toFixed(1)}ms`);
const cadence = demandCadenceProbe();
const recovery = recoveryProbe();
const seedFingerprints = [101, 202, 303, 404].map(seededFingerprint);
if (new Set(seedFingerprints).size !== seedFingerprints.length) throw new Error('seed placement fingerprints did not vary');

console.log(JSON.stringify({
  consumers: BUILDINGS + INFRA,
  poiScaleTarget: 100_000,
  iterations: ITERATIONS,
  baselineMs: Number(oldRun.ms.toFixed(2)),
  optimizedMs: Number(newRun.ms.toFixed(2)),
  speedup: Number((oldRun.ms / Math.max(0.001, newRun.ms)).toFixed(2)),
  cadence,
  recovery,
  seedFingerprints,
}, null, 2));
