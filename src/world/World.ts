import { SimulationClock } from '../core/SimulationClock';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { AgentStore, AgentState } from '../agents/AgentStore';
import { NeedSystem } from '../agents/NeedSystem';
import { UtilityBrain } from '../agents/UtilityBrain';
import { CityGenerator, CityConfig } from '../generation/CityGenerator';
import { AStar } from '../traffic/AStar';
import { POICategory } from './POI';

/**
 * ============================================================================
 *  World: 全システムのオーケストレータ
 * ============================================================================
 * 固定ステップで各システムを順に駆動する。責務は「配線と実行順序」のみで、
 * ロジック本体は各システムへ委譲(単一責任の徹底)。
 *
 * 実行順序(1ステップ):
 *   1. NeedSystem      : ニーズ減衰
 *   2. UtilityBrain    : Idle のエージェントに目的選定 → 目的地割当
 *   3. Routing         : Routing のエージェントに A* で経路発行(本デモは直線/最寄ノード)
 *   4. Steering        : Traveling のエージェントを目的地へ移動 + 近接回避
 *   5. Arrival/Activity: 到達判定 → Engaged でニーズ回復 → Idle へ戻す
 */
export class World {
  readonly clock = new SimulationClock();
  readonly store: AgentStore;
  readonly city: CityGenerator;
  private readonly grid = new SpatialHashGrid(8);
  private readonly needs = new NeedSystem();
  private readonly brain: UtilityBrain;
  private astar: AStar;

  // 1フレームに全エージェントを意思決定させると重いので分割走査するカーソル
  private decideCursor = 0;

  constructor(cityCfg: CityConfig, agentCapacity: number) {
    this.store = new AgentStore(agentCapacity);
    this.city = new CityGenerator(cityCfg);
    this.city.generate();
    this.astar = new AStar(this.city.net);
    this.brain = new UtilityBrain(this.city.poi);
  }

  /** POIの位置を初期分布として市民をスポーンし、住居/職場を割り当てる。 */
  populate(count: number): void {
    const poiReg = this.city.poi;
    if (poiReg.size === 0) return;
    for (let n = 0; n < count; n++) {
      // 適当な住居POI付近にスポーン
      let homeId = -1;
      for (let tries = 0; tries < 8; tries++) {
        const cand = Math.floor(Math.random() * poiReg.size);
        if (poiReg.get(cand).category === POICategory.Home) { homeId = cand; break; }
      }
      const home = homeId >= 0 ? poiReg.get(homeId) : poiReg.get(0);
      const i = this.store.spawn(home.x + (Math.random() - 0.5) * 8, home.z + (Math.random() - 0.5) * 8);
      if (i < 0) break;
      this.store.homePOI[i] = homeId;
      // 職場: 近くの Work POI を1つ
      this.store.workPOI[i] = poiReg.findBest(POICategory.Work, home.x, home.z, this.store.wealth[i]);
    }
  }

  /** 固定ステップ更新。dtSec は clock.fixedStep。 */
  step(dtSec: number): void {
    const s = this.store;

    // 1. ニーズ減衰(全体、安価)
    this.needs.update(s, dtSec);

    // 2. 意思決定を時間分割(1ステップあたり最大 budget 体)
    const budget = Math.min(s.count, 512);
    for (let k = 0; k < budget; k++) {
      const i = (this.decideCursor + k) % s.count;
      if (s.state[i] === AgentState.Idle) this.brain.decide(s, i, this.clock);
    }
    this.decideCursor = (this.decideCursor + budget) % Math.max(1, s.count);

    // 3. 経路発行(デモは最寄ノード同士でA* → 経路長のみ利用し、実移動は目的地直行)
    //    ※実装拡張点: 経路ノード列を pathHandle に格納し 4 で追従させる。
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Routing) s.state[i] = AgentState.Traveling;
    }

    // 4. ステアリング(目的地へ移動 + 近接回避)
    this.buildSpatialIndex();
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Traveling) this.steer(i, dtSec);
    }

    // 5. 到達・活動
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Engaged) this.activity(i, dtSec);
    }
  }

  private buildSpatialIndex(): void {
    this.grid.clear();
    const s = this.store;
    for (let i = 0; i < s.count; i++) this.grid.insert(i, s.posX[i], s.posZ[i]);
  }

  /** 目的地方向へのシーク + 近接エージェントとの分離(簡易ボイド)。 */
  private steer(i: number, dt: number): void {
    const s = this.store;
    const dx = s.goalX[i] - s.posX[i];
    const dz = s.goalZ[i] - s.posZ[i];
    const d2 = dx * dx + dz * dz;
    if (d2 < 4) { // 2m以内で到着
      s.state[i] = AgentState.Engaged;
      s.velX[i] = 0; s.velZ[i] = 0;
      const p = this.city.poi.get(s.goalPOI[i]);
      if (p) p.occupancy++;
      return;
    }
    const inv = 1 / Math.sqrt(d2);
    let desX = dx * inv, desZ = dz * inv;

    // 分離: 半径2m内の他者から離れる
    let sepX = 0, sepZ = 0, nn = 0;
    this.grid.queryNeighbors(s.posX[i], s.posZ[i], 2, (j) => {
      if (j === i) return;
      const ddx = s.posX[i] - s.posX[j];
      const ddz = s.posZ[i] - s.posZ[j];
      const dd = ddx * ddx + ddz * ddz;
      if (dd > 0 && dd < 4) {
        const w = 1 / Math.sqrt(dd);
        sepX += ddx * w; sepZ += ddz * w; nn++;
      }
    });
    if (nn > 0) { desX += (sepX / nn) * 0.8; desZ += (sepZ / nn) * 0.8; }

    const mag = Math.hypot(desX, desZ) || 1;
    const sp = s.maxSpeed[i];
    s.velX[i] = (desX / mag) * sp;
    s.velZ[i] = (desZ / mag) * sp;
    s.posX[i] += s.velX[i] * dt;
    s.posZ[i] += s.velZ[i] * dt;
    s.heading[i] = Math.atan2(s.velZ[i], s.velX[i]);
  }

  /**
   * 目的地での活動。関連ニーズを回復しつつ、原則その場に「滞在」する。
   * すぐ退店せず、時刻や別の切迫ニーズに引かれて初めて離れる(=在館人数が安定して残る)。
   */
  private activity(i: number, dt: number): void {
    const s = this.store;
    const poi = this.city.poi.get(s.goalPOI[i]);
    if (!poi) { s.state[i] = AgentState.Idle; return; }
    const hour = this.clock.hour;
    const rate = 0.05 * dt; // 活動によるニーズ回復速度

    // ニーズ回復(用途ごと)
    switch (poi.category) {
      case POICategory.Home:
        s.energy[i] = Math.min(1, s.energy[i] + rate * 1.5);
        s.hygiene[i] = Math.min(1, s.hygiene[i] + rate);
        break;
      case POICategory.Food:
        s.hunger[i] = Math.min(1, s.hunger[i] + rate * 3);
        break;
      case POICategory.Work:
        s.wealth[i] = Math.min(1, s.wealth[i] + rate * 0.2);
        s.energy[i] = Math.max(0, s.energy[i] - rate * 0.2);
        s.hunger[i] = Math.max(0, s.hunger[i] - rate * 0.1);
        break;
      case POICategory.Leisure:
        s.fun[i] = Math.min(1, s.fun[i] + rate * 2);
        s.social[i] = Math.min(1, s.social[i] + rate);
        break;
      default:
        s.fun[i] = Math.min(1, s.fun[i] + rate);
    }

    // 退店判定: 「用途に応じた終了条件」または「別の切迫ニーズ」でのみ離れる。
    // これにより住居は夜間、職場は日中、それぞれ長時間滞在して在館人数が維持される。
    const starving = s.hunger[i] < 0.25;
    const exhausted = s.energy[i] < 0.2;
    const hasWork = s.workPOI[i] >= 0;
    let leave = false;
    switch (poi.category) {
      case POICategory.Home:
        // 勤務時間(8-18)になり職があれば通勤に出る。空腹/娯楽枯渇でも外出。
        leave = (hour >= 8 && hour < 18 && hasWork) || starving || s.fun[i] < 0.15;
        break;
      case POICategory.Work:
        // 勤務時間を終えたら退勤。生存ニーズが逼迫すれば早退。
        leave = hour >= 18 || hour < 8 || exhausted || starving;
        break;
      case POICategory.Food:
        leave = s.hunger[i] > 0.9; // 食事は短時間
        break;
      case POICategory.Leisure:
        leave = s.fun[i] > 0.9 || starving || exhausted;
        break;
      default:
        leave = true;
    }

    if (leave) {
      poi.occupancy = Math.max(0, poi.occupancy - 1);
      s.goalPOI[i] = -1;
      s.state[i] = AgentState.Idle;
    }
  }

  /** デバッグ統計 */
  stats(): { agents: number; buildings: number; nodes: number; pois: number } {
    return {
      agents: this.store.count,
      buildings: this.city.buildings.length,
      nodes: this.city.net.nodes.length,
      pois: this.city.poi.size,
    };
  }
}
