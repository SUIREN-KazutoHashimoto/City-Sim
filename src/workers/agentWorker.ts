import { AgentState } from '../agents/AgentStore';
import { POICategory } from '../world/POI';

type Buffers = {
  energy: SharedArrayBuffer; hunger: SharedArrayBuffer; social: SharedArrayBuffer; hygiene: SharedArrayBuffer; fun: SharedArrayBuffer;
  wealth: SharedArrayBuffer; state: SharedArrayBuffer; goalCategory: SharedArrayBuffer; dwellUntil: SharedArrayBuffer; activityExit: SharedArrayBuffer;
  exitIds: SharedArrayBuffer; exitCount: SharedArrayBuffer;
  control: SharedArrayBuffer; ranges: SharedArrayBuffer; params: SharedArrayBuffer;
};
type InitMessage = { type: 'init'; workerId: number; workerCount: number; completionByAtomics: boolean; buffers: Buffers };

const JOB_EPOCH = 0;
const JOB_ID = 1;
const DONE_COUNT = 3;
const DONE_EPOCH = 4;
const PARAM_DT = 0;
const PARAM_NOW = 1;

let energy!: Float32Array, hunger!: Float32Array, social!: Float32Array, hygiene!: Float32Array, fun!: Float32Array, wealth!: Float32Array;
let state!: Uint8Array, goalCategory!: Uint8Array, dwellUntil!: Float32Array, activityExit!: Uint8Array;
let exitIds!: Int32Array, exitCount!: Int32Array, control!: Int32Array, ranges!: Int32Array, params!: Float64Array;
let workerId = 0, workerCount = 1, completionByAtomics = false;

const clamp01 = (v: number): number => v < 0 ? 0 : v > 1 ? 1 : v;

function runRange(begin: number, end: number, dt: number, now: number): void {
  const dEnergy = 1 / (16 * 3600), dHunger = 1 / (6 * 3600), dSocial = 1 / (10 * 3600), dHygiene = 1 / (14 * 3600), dFun = 1 / (8 * 3600);
  for (let i = begin; i < end; i++) {
    energy[i] = clamp01(energy[i] - dEnergy * dt);
    hunger[i] = clamp01(hunger[i] - dHunger * dt);
    social[i] = clamp01(social[i] - dSocial * dt);
    hygiene[i] = clamp01(hygiene[i] - dHygiene * dt);
    fun[i] = clamp01(fun[i] - dFun * dt);
    activityExit[i] = 0;

    if (state[i] !== AgentState.Engaged) continue;
    const cat = goalCategory[i];
    switch (cat) {
      case POICategory.Home:
        energy[i] = clamp01(energy[i] + dt / 1800); hygiene[i] = clamp01(hygiene[i] + dt / 1200); fun[i] = clamp01(fun[i] + dt / 6000); break;
      case POICategory.Food: hunger[i] = clamp01(hunger[i] + dt / 600); break;
      case POICategory.Work: wealth[i] = clamp01(wealth[i] + dt / 20000); break;
      case POICategory.Leisure: fun[i] = clamp01(fun[i] + dt / 1800); social[i] = clamp01(social[i] + dt / 2400); break;
      case POICategory.Retail: fun[i] = clamp01(fun[i] + dt / 4000); break;
      default: fun[i] = clamp01(fun[i] + dt / 3000); break;
    }
    const critical = (cat !== POICategory.Food && hunger[i] < 0.05) || (cat !== POICategory.Home && energy[i] < 0.05);
    if (now >= dwellUntil[i] || critical) {
      activityExit[i] = 1;
      const slot = Atomics.add(exitCount, 0, 1);
      if (slot < exitIds.length) exitIds[slot] = i;
    }
  }
}

function finish(jobId: number): void {
  const done = Atomics.add(control, DONE_COUNT, 1) + 1;
  if (done !== workerCount) return;
  Atomics.add(control, DONE_EPOCH, 1);
  Atomics.notify(control, DONE_EPOCH, 1);
  if (!completionByAtomics) postMessage({ type: 'done', jobId });
}

/** Persistent job loop. The Atomics epoch write is the memory-ordering handoff for params/ranges. */
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
    const begin = ranges[workerId * 2], end = ranges[workerId * 2 + 1];
    runRange(begin, end, params[PARAM_DT], params[PARAM_NOW]);
    finish(jobId);
  }
}

self.onmessage = (ev: MessageEvent<InitMessage>) => {
  const msg = ev.data;
  if (msg.type !== 'init') return;
  workerId = msg.workerId; workerCount = msg.workerCount; completionByAtomics = msg.completionByAtomics;
  energy = new Float32Array(msg.buffers.energy); hunger = new Float32Array(msg.buffers.hunger); social = new Float32Array(msg.buffers.social);
  hygiene = new Float32Array(msg.buffers.hygiene); fun = new Float32Array(msg.buffers.fun); wealth = new Float32Array(msg.buffers.wealth);
  state = new Uint8Array(msg.buffers.state); goalCategory = new Uint8Array(msg.buffers.goalCategory);
  dwellUntil = new Float32Array(msg.buffers.dwellUntil); activityExit = new Uint8Array(msg.buffers.activityExit);
  exitIds = new Int32Array(msg.buffers.exitIds); exitCount = new Int32Array(msg.buffers.exitCount);
  control = new Int32Array(msg.buffers.control); ranges = new Int32Array(msg.buffers.ranges); params = new Float64Array(msg.buffers.params);
  runLoop();
};
