import { AgentStore, AgentState } from './AgentStore';
import { SimulationClock } from '../core/SimulationClock';
import { POIRegistry, POICategory } from '../world/POI';

/**
 * ============================================================================
 *  Utility AI (効用ベースの意思決定)
 * ============================================================================
 * 「ステータス(ニーズ)→ 最も切実な目的 → 目的地(POI)検索 → 移動」の意味的ループ。
 *
 * 各行動は「どれだけそのエージェントに必要か」をスコア化(効用)し、最大の行動を選ぶ。
 * ルールを追加したいときは ACTIONS に1エントリ足すだけで拡張できる(開放/閉鎖原則)。
 */

/** 1つの行動候補の定義。純粋関数の集合として宣言的に持つ。 */
interface ActionDef {
  readonly name: string;
  /** その行動を満たせる目的地カテゴリ */
  readonly category: POICategory;
  /** 効用スコア: 0=不要, 1=最優先。ニーズと時刻から算出。 */
  score(store: AgentStore, i: number, clock: SimulationClock): number;
}

/** 効用カーブ: ニーズが低いほど欲求が跳ね上がる(非線形)。 */
const urgency = (need: number): number => {
  const inv = 1 - need;
  return inv * inv; // 二乗で「切迫」を強調
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
      // 平日9-18時に働きたい。ニーズが逼迫していれば仕事より生存を優先させたい
      const inHours = clock.hour >= 9 && clock.hour < 18 ? 0.8 : 0.05;
      const survivalPressure = Math.max(urgency(s.energy[i]), urgency(s.hunger[i]));
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
];

export class UtilityBrain {
  constructor(private readonly poi: POIRegistry) {}

  /**
   * Idle 状態のエージェントに対し目的を選定し、目的地POIを検索して割り当てる。
   * 経路探索の発行は呼び出し側(World)が state=Routing を見て行う。
   */
  decide(store: AgentStore, i: number, clock: SimulationClock): void {
    let best: ActionDef | null = null;
    let bestScore = 0.05; // これ未満なら何もしない閾値
    for (const a of ACTIONS) {
      const sc = a.score(store, i, clock);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    if (!best) { store.state[i] = AgentState.Idle; return; }

    // 目的地検索: 「その行動を満たすPOIのうち、近くて条件に合うもの」を選ぶ。
    // work/home は固定POIを優先、それ以外は近傍探索。
    let target = -1;
    if (best.name === 'work') target = store.workPOI[i];
    else if (best.name === 'sleep') target = store.homePOI[i];
    else target = this.poi.findBest(best.category, store.posX[i], store.posZ[i], store.wealth[i]);

    if (target < 0) { store.state[i] = AgentState.Idle; return; }

    const p = this.poi.get(target);
    store.goalPOI[i] = target;
    store.goalX[i] = p.x;
    store.goalZ[i] = p.z;
    store.state[i] = AgentState.Routing; // World が経路探索を発行する
  }
}
