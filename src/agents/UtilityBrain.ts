import { AgentStore, AgentState, Occupation } from './AgentStore';
import { SimulationClock } from '../core/SimulationClock';
import { POIRegistry, POICategory } from '../world/POI';
const urgency = (need: number): number => { const inv = 1 - need; return inv * inv; };
export function isWorkTime(occ: Occupation, start: number, end: number, hour: number): boolean {
  if (occ === Occupation.Unemployed || occ === Occupation.Retiree) return false;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
interface ActionDef { readonly name: string; readonly category: POICategory; score(s: AgentStore, i: number, clock: SimulationClock): number; }
const ACTIONS: ActionDef[] = [
  { name: 'sleep', category: POICategory.Home, score: (s, i, clock) => { const occ = s.occupation[i] as Occupation; const h = clock.hourF; let sleepy: number; if (occ === Occupation.NightShift) sleepy = (h >= 8 && h < 15) ? 0.5 : 0; else sleepy = (h >= 23 || h < 6) ? 0.5 : 0; return Math.min(1, urgency(s.energy[i]) + sleepy); } },
  { name: 'eat', category: POICategory.Food, score: (s, i, clock) => { const h = clock.hourF; const meal = (Math.abs(h - 8) < 1 || Math.abs(h - 12.5) < 1 || Math.abs(h - 20) < 1.5) ? 0.25 : 0; return Math.min(1, urgency(s.hunger[i]) * 1.1 + meal); } },
  { name: 'work', category: POICategory.Work, score: (s, i, clock) => { if (s.workPOI[i] < 0) return 0; const occ = s.occupation[i] as Occupation; if (!isWorkTime(occ, s.workStart[i], s.workEnd[i], clock.hourF)) return 0; const survival = 0.5 * Math.max(urgency(s.energy[i]), urgency(s.hunger[i])); return Math.max(0, 0.95 - survival); } },
  { name: 'shopping', category: POICategory.Retail, score: (s, i, clock) => { const occ = s.occupation[i] as Occupation; const h = clock.hourF; if (h < 9 || h >= 21) return 0; if (h < 11 && s.extrovert[i] < (11 - h) * 0.4) return 0; if (isWorkTime(occ, s.workStart[i], s.workEnd[i], h)) return 0.05; const idle = occ === Occupation.Unemployed || occ === Occupation.Retiree || occ === Occupation.Freelance; return (idle ? 0.22 : 0.1) * (0.4 + 0.6 * s.wealth[i]); } },
  { name: 'leisure', category: POICategory.Leisure, score: (s, i, clock) => { const h = clock.hourF; const occ = s.occupation[i] as Occupation; if (isWorkTime(occ, s.workStart[i], s.workEnd[i], h)) return 0; const evening = (h >= 18 && h < 24) ? 0.3 : 0; return (urgency(s.fun[i]) * 0.6 + urgency(s.social[i]) * 0.4 + evening) * (0.4 + 0.6 * s.extrovert[i]); } },
  { name: 'routine-home', category: POICategory.Home, score: (s, i, clock) => { if (s.homePOI[i] < 0) return 0; const h = clock.hourF; return (h >= 21 || h < 6) ? 0.3 : 0.18; } },
];
export class UtilityBrain {
  constructor(private readonly poi: POIRegistry) {}
  decide(s: AgentStore, i: number, clock: SimulationClock): void {
    let best: ActionDef | null = null, bestScore = 0.06;
    for (const a of ACTIONS) { const sc = a.score(s, i, clock); if (sc > bestScore) { bestScore = sc; best = a; } }
    if (!best) { s.state[i] = AgentState.Idle; return; }
    let target = -1;
    if (best.name === 'work') target = s.workPOI[i];
    else if (best.name === 'sleep' || best.name === 'routine-home') target = s.homePOI[i];
    else target = this.poi.findBest(best.category, s.posX[i], s.posZ[i], s.wealth[i]);
    if (target < 0) { s.state[i] = AgentState.Idle; return; }
    const p = this.poi.get(target);
    s.goalPOI[i] = target; s.goalCategory[i] = p.category; s.goalX[i] = p.x; s.goalZ[i] = p.z;
    s.state[i] = AgentState.Routing;
  }
}
