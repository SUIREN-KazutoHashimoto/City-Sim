import { AgentStore, AgentState, Occupation } from './AgentStore';
import { SimulationClock } from '../core/SimulationClock';
import { POIRegistry, POICategory } from '../world/POI';

/**
 * ============================================================================
 *  Utility AI(効用ベース意思決定)+ 職業別スケジュール
 * ============================================================================
 * 「ニーズ → 効用最大の目的 → 目的地POI検索 → 移動」。
 * 職業ごとに勤務時間が異なり、無職/退職者/自由業は日中も街に出るため、
 * どの時間帯でも多様な人が移動・活動して街が空にならない。
 */

const urgency = (need: number): number => { const inv = 1 - need; return inv * inv; };

/** 勤務時間内か(夜勤の日跨ぎに対応)。 */
export function isWorkTime(occ: Occupation, start: number, end: number, hour: number): boolean {
  if (occ === Occupation.Unemployed || occ === Occupation.Retiree) return false;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // 日跨ぎ(夜勤)
}

interface ActionDef {
  readonly name: string;
  readonly category: POICategory;
  score(s: AgentStore, i: number, clock: SimulationClock): number;
}

const ACTIONS: ActionDef[] = [
  {
    // 睡眠: 各自の「夜」に強い。夜勤者は昼に寝る。
    name: 'sleep', category: POICategory.Home,
    score: (s, i, clock) => {
      const occ = s.occupation[i] as Occupation;
      const h = clock.hourF;
      // 自分の勤務外の「休息帯」を求める: 夜勤なら日中、通常は深夜
      let sleepy: number;
      if (occ === Occupation.NightShift) sleepy = (h >= 8 && h < 15) ? 0.5 : 0;
      else sleepy = (h >= 23 || h < 6) ? 0.5 : 0;
      return Math.min(1, urgency(s.energy[i]) + sleepy);
    },
  },
  {
    name: 'eat', category: POICategory.Food,
    score: (s, i, clock) => {
      const h = clock.hourF;
      // 食事のピーク(朝7-9, 昼12-13, 夜19-21)で外食欲を後押し
      const meal = (Math.abs(h - 8) < 1 || Math.abs(h - 12.5) < 1 || Math.abs(h - 20) < 1.5) ? 0.25 : 0;
      return Math.min(1, urgency(s.hunger[i]) * 1.1 + meal);
    },
  },
  {
    name: 'work', category: POICategory.Work,
    score: (s, i, clock) => {
      if (s.workPOI[i] < 0) return 0;
      const occ = s.occupation[i] as Occupation;
      const onDuty = isWorkTime(occ, s.workStart[i], s.workEnd[i], clock.hourF);
      if (!onDuty) return 0;
      const survival = 0.5 * Math.max(urgency(s.energy[i]), urgency(s.hunger[i]));
      return Math.max(0, 0.95 - survival);
    },
  },
  {
    // 買い物: 日中いつでも一定の需要。無職/退職者/自由業/店員休みで街に出る主因。
    name: 'shopping', category: POICategory.Retail,
    score: (s, i, clock) => {
      const occ = s.occupation[i] as Occupation;
      const h = clock.hourF;
      if (h < 9 || h >= 21) return 0;
      // 開店直後(9-11時)は各自バラつくよう外向性で確率的に抑制し、殺到を防ぐ
      if (h < 11 && s.extrovert[i] < (11 - h) * 0.4) return 0;
      const onDuty = isWorkTime(occ, s.workStart[i], s.workEnd[i], h);
      if (onDuty) return 0.05; // 勤務中はほぼしない
      const idleClass = occ === Occupation.Unemployed || occ === Occupation.Retiree || occ === Occupation.Freelance;
      const base = idleClass ? 0.22 : 0.1;
      return base * (0.4 + 0.6 * s.wealth[i]);
    },
  },
  {
    name: 'leisure', category: POICategory.Leisure,
    score: (s, i, clock) => {
      const h = clock.hourF;
      const occ = s.occupation[i] as Occupation;
      const onDuty = isWorkTime(occ, s.workStart[i], s.workEnd[i], h);
      if (onDuty) return 0;
      // 夜(18-24)は娯楽ピーク。外向的な人ほど出る。
      const evening = (h >= 18 && h < 24) ? 0.3 : 0;
      return (urgency(s.fun[i]) * 0.6 + urgency(s.social[i]) * 0.4 + evening) * (0.4 + 0.6 * s.extrovert[i]);
    },
  },
  {
    // 既定: 特に切迫が無いときの居場所。勤務外の日中は「外出(散歩/用事)」も選ぶ。
    name: 'routine-home', category: POICategory.Home,
    score: (s, i, clock) => {
      if (s.homePOI[i] < 0) return 0;
      const h = clock.hourF;
      // 夜は帰宅、日中の在宅は「用事の合間の受け皿」。買物/娯楽と拮抗させ分散させる。
      return (h >= 21 || h < 6) ? 0.3 : 0.18;
    },
  },
];

export class UtilityBrain {
  constructor(private readonly poi: POIRegistry) {}

  decide(s: AgentStore, i: number, clock: SimulationClock): void {
    let best: ActionDef | null = null;
    let bestScore = 0.06;
    for (const a of ACTIONS) {
      const sc = a.score(s, i, clock);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    if (!best) { s.state[i] = AgentState.Idle; return; }

    let target = -1;
    if (best.name === 'work') target = s.workPOI[i];
    else if (best.name === 'sleep' || best.name === 'routine-home') target = s.homePOI[i];
    else target = this.poi.findBest(best.category, s.posX[i], s.posZ[i], s.wealth[i]);

    if (target < 0) { s.state[i] = AgentState.Idle; return; }
    const p = this.poi.get(target);
    s.goalPOI[i] = target;
    s.goalX[i] = p.x;
    s.goalZ[i] = p.z;
    s.state[i] = AgentState.Routing;
  }
}
