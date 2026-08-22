import { AgentState } from '../agents/AgentStore';
import { POICategory } from '../world/POI';

type Buffers = {
  energy: SharedArrayBuffer; hunger: SharedArrayBuffer; social: SharedArrayBuffer; hygiene: SharedArrayBuffer; fun: SharedArrayBuffer;
  wealth: SharedArrayBuffer; state: SharedArrayBuffer; goalCategory: SharedArrayBuffer; dwellUntil: SharedArrayBuffer; activityExit: SharedArrayBuffer;
};

type InitMessage = { type: 'init'; buffers: Buffers };
type BatchMessage = { type: 'agent-batch'; jobId: number; begin: number; end: number; dt: number; now: number };
type Message = InitMessage | BatchMessage;

let energy!: Float32Array, hunger!: Float32Array, social!: Float32Array, hygiene!: Float32Array, fun!: Float32Array, wealth!: Float32Array;
let state!: Uint8Array, goalCategory!: Uint8Array, dwellUntil!: Float32Array, activityExit!: Uint8Array;

const clamp01 = (v: number): number => v < 0 ? 0 : v > 1 ? 1 : v;

self.onmessage = (ev: MessageEvent<Message>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    energy = new Float32Array(msg.buffers.energy); hunger = new Float32Array(msg.buffers.hunger); social = new Float32Array(msg.buffers.social);
    hygiene = new Float32Array(msg.buffers.hygiene); fun = new Float32Array(msg.buffers.fun); wealth = new Float32Array(msg.buffers.wealth);
    state = new Uint8Array(msg.buffers.state); goalCategory = new Uint8Array(msg.buffers.goalCategory);
    dwellUntil = new Float32Array(msg.buffers.dwellUntil); activityExit = new Uint8Array(msg.buffers.activityExit);
    return;
  }

  const dEnergy = 1 / (16 * 3600), dHunger = 1 / (6 * 3600), dSocial = 1 / (10 * 3600), dHygiene = 1 / (14 * 3600), dFun = 1 / (8 * 3600);
  for (let i = msg.begin; i < msg.end; i++) {
    energy[i] = clamp01(energy[i] - dEnergy * msg.dt);
    hunger[i] = clamp01(hunger[i] - dHunger * msg.dt);
    social[i] = clamp01(social[i] - dSocial * msg.dt);
    hygiene[i] = clamp01(hygiene[i] - dHygiene * msg.dt);
    fun[i] = clamp01(fun[i] - dFun * msg.dt);
    activityExit[i] = 0;

    if (state[i] !== AgentState.Engaged) continue;
    const cat = goalCategory[i];
    switch (cat) {
      case POICategory.Home:
        energy[i] = clamp01(energy[i] + msg.dt / 1800); hygiene[i] = clamp01(hygiene[i] + msg.dt / 1200); fun[i] = clamp01(fun[i] + msg.dt / 6000); break;
      case POICategory.Food: hunger[i] = clamp01(hunger[i] + msg.dt / 600); break;
      case POICategory.Work: wealth[i] = clamp01(wealth[i] + msg.dt / 20000); break;
      case POICategory.Leisure: fun[i] = clamp01(fun[i] + msg.dt / 1800); social[i] = clamp01(social[i] + msg.dt / 2400); break;
      case POICategory.Retail: fun[i] = clamp01(fun[i] + msg.dt / 4000); break;
      default: fun[i] = clamp01(fun[i] + msg.dt / 3000); break;
    }
    const critical = (cat !== POICategory.Food && hunger[i] < 0.05) || (cat !== POICategory.Home && energy[i] < 0.05);
    if (msg.now >= dwellUntil[i] || critical) activityExit[i] = 1;
  }

  postMessage({ type: 'done', jobId: msg.jobId });
};
