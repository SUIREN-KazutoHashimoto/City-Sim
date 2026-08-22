import { AgentStore, AgentState } from './AgentStore';
import { SimulationClock } from '../core/SimulationClock';
import { POIRegistry, POICategory } from '../world/POI';

/** Utility AI: ニーズ → 効用最大の目的 → 目的地POI検索 → 移動。 */
interface ActionDef {
  readonly name: string;
  readonly category: POICategory;
  score(store: AgentStore, i: number, clock: SimulationClock): number;
}

const urgency = (need: number): number => {
  const inv = 1 - need;
  return inv * inv;
};

const ACTIONS: ActionDef[] = [
  {
    name: 'sleep', category: POICategory.Home,
    score: (s, i, clock) => {
      const night = clock.hour >= 22 || clock.hour < 6 ? 0.4 : 0;
      return Math.min(1, urgency(s.energy[i]) + night);
    },
  },
  {
    name: 'eat', category: POICategory.Food,
    score: (s, i) => urgency(s.hunger[i]) * (0.5 + 0.5 * s.wealth[i] + 0.5),
  },
  {
    name: 'work', category: POICategory.Work,
    score: (s, i, clock) => {
      if (s.workPOI[i] < 0) return 0;
      const inHours = clock.hour >= 8 && clock.hour < 18 ? 0.9 : 0.05;
      const survivalPressure = 0.6 * Math.max(urgency(s.energy[i]), urgency(s.hunger[i]));
      return Math.max(0, inHours - survivalPressure);
    },
  },
  {
    name: 'socialize', category: POICategory.Leisure,
    score: (s, i) => urgency(s.social[i]) * 0.8,
  },
  {
    name: 'recreation', category: POICategory.Leisure,
    score: (s, i) => urgency(s.fun[i]) * 0.7,
  },
  {
    name: 'routine-home', category: POICategory.Home,
    score: (s, i, clock) => {
      if (s.homePOI[i] < 0) return 0;
      const evening = clock.hour >= 19 || clock.hour < 7;
      return evening ? 0.35 : 0.12;
    },
  },
];

export class UtilityBrain {
  constructor(private readonly poi: POIRegistry) {}

  decide(store: AgentStore, i: number, clock: SimulationClock): void {
    let best: ActionDef | null = null;
    let bestScore = 0.05;
    for (const a of ACTIONS) {
      const sc = a.score(store, i, clock);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    if (!best) { store.state[i] = AgentState.Idle; return; }

    let target = -1;
    if (best.name === 'work') target = store.workPOI[i];
    else if (best.name === 'sleep' || best.name === 'routine-home') target = store.homePOI[i];
    else target = this.poi.findBest(best.category, store.posX[i], store.posZ[i], store.wealth[i]);

    if (target < 0) { store.state[i] = AgentState.Idle; return; }

    const p = this.poi.get(target);
    store.goalPOI[i] = target;
    store.goalX[i] = p.x;
    store.goalZ[i] = p.z;
    store.state[i] = AgentState.Routing;
  }
}
