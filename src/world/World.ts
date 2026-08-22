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

    const now = this.clock.totalSeconds;

    // 1. ニーズ減衰(全体、安価)
    this.needs.update(s, dtSec);

    // 2. 意思決定を時間分割 + nextDecideAt で間引く。
    //    Idle でも「次に考える時刻」まではスキップ → 思考の連打(振動)と負荷を抑制。
    const budget = Math.min(s.count, 512);
    for (let k = 0; k < budget; k++) {
      const i = (this.decideCursor + k) % s.count;
      if (s.state[i] === AgentState.Idle && now >= s.nextDecideAt[i]) {
        this.brain.decide(s, i, this.clock);
        // 目的が見つからず Idle のままなら、しばらく再考しない(15〜45 分後)
        if (s.state[i] === AgentState.Idle) {
          s.nextDecideAt[i] = now + 900 + Math.random() * 1800;
        }
      }
    }
    this.decideCursor = (this.decideCursor + budget) % Math.max(1, s.count);

    // 3. 経路発行(デモは目的地直行。拡張点: A*経路をpathHandleへ)
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Routing) s.state[i] = AgentState.Traveling;
    }

    // 4. ステアリング。空間インデックスは「移動中の個体だけ」で構築するので
    //    停滞中の大多数を挿入せず、挿入コスト・近接クエリ候補を大幅削減できる。
    this.buildTravelerIndex();
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Traveling) this.steer(i, dtSec);
    }

    // 5. 到達・活動(滞在時間 dwellUntil を尊重)
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Engaged) this.activity(i, now);
    }
  }

  /** 移動中(Traveling)の個体のみを空間ハッシュへ登録する。 */
  private buildTravelerIndex(): void {
    this.grid.clear();
    const s = this.store;
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Traveling) this.grid.insert(i, s.posX[i], s.posZ[i]);
    }
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
      if (p) {
        p.occupancy++;
        // 到着時に「この活動をいつまで続けるか」を確定 → 即時離脱(振動)を防ぐ
        s.dwellUntil[i] = this.computeDwellUntil(p.category);
      }
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
   * 到着した活動の「滞在終了シミュ時刻」を決める。
   * これを一度確定させることで、到着直後に別条件で追い出される振動を根絶する。
   */
  private computeDwellUntil(cat: POICategory): number {
    const now = this.clock.totalSeconds;
    const hour = this.clock.hour;
    const H = 3600;
    switch (cat) {
      case POICategory.Home: {
        // 夜なら翌朝7時まで就寝。日中の在宅は 1.5〜3 時間。
        if (hour >= 22 || hour < 7) {
          const secToday = now % 86400;
          const wake = 7 * H;
          const until = secToday < wake ? now + (wake - secToday) : now + (24 * H - secToday) + wake;
          return until;
        }
        return now + (1.5 + Math.random() * 1.5) * H;
      }
      case POICategory.Work: {
        // 就業しているなら 18 時まで勤務(最低でも 1 時間は滞在)。
        const secToday = now % 86400;
        const endToday = 18 * H;
        const until = secToday < endToday ? now + (endToday - secToday) : now + 1 * H;
        return Math.max(until, now + 1 * H);
      }
      case POICategory.Food:
        return now + (0.5 + Math.random() * 0.5) * H; // 30〜60 分
      case POICategory.Leisure:
        return now + (1 + Math.random()) * H;          // 1〜2 時間
      default:
        return now + 0.5 * H;
    }
  }

  /**
   * 目的地での活動。dwellUntil まではその場に滞在してニーズを回復する。
   * 期限到来、または「本当に危機的なニーズ」のときだけ離脱する(=在館が安定維持)。
   */
  private activity(i: number, now: number): void {
    const s = this.store;
    const poi = this.city.poi.get(s.goalPOI[i]);
    if (!poi) { s.state[i] = AgentState.Idle; return; }
    const dt = this.clock.fixedStep;
    // 回復速度は「1シミュ秒あたり」で定義し dt を掛ける(ステップ数に依存しない)。
    // 例: perSec=1/1800 なら 30 分で満タン。時間ベースなので timeScale を変えても安定。
    const rec = (perSec: number) => perSec * dt;

    // ニーズ回復(用途ごと。エネルギー消耗は NeedSystem の緩やかな日次減衰に一元化し、
    // ここで per-step の急減衰を作らない ← 以前のエネルギー暴落バグの是正)。
    switch (poi.category) {
      case POICategory.Home:
        s.energy[i] = Math.min(1, s.energy[i] + rec(1 / 1800));  // 30分で全快
        s.hygiene[i] = Math.min(1, s.hygiene[i] + rec(1 / 1200));
        s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 6000));
        break;
      case POICategory.Food:
        s.hunger[i] = Math.min(1, s.hunger[i] + rec(1 / 600));   // 10分で満腹
        break;
      case POICategory.Work:
        // 勤務は賃金を得るのみ。エネルギーはNeedSystemの日次減衰に任せる(急減させない)。
        s.wealth[i] = Math.min(1, s.wealth[i] + rec(1 / 20000));
        break;
      case POICategory.Leisure:
        s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 1800));
        s.social[i] = Math.min(1, s.social[i] + rec(1 / 2400));
        break;
      default:
        s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 3000));
    }

    // 危機的オーバーライド: 本当に極端なときだけ滞在を打ち切る(通常は dwell を尊重)。
    const critical =
      (poi.category !== POICategory.Food && s.hunger[i] < 0.05) ||
      (poi.category !== POICategory.Home && s.energy[i] < 0.05);

    // 滞在期限が来た、または危機的なら離脱 → Idle にして次の意思決定へ。
    if (now >= s.dwellUntil[i] || critical) {
      poi.occupancy = Math.max(0, poi.occupancy - 1);
      s.goalPOI[i] = -1;
      s.state[i] = AgentState.Idle;
      s.nextDecideAt[i] = now; // 退出直後は即時に次の目的を選ばせる
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

  /**
   * 現在の活動分布スナップショット(時間帯グラフ用)。
   * 移動中/在宅/勤務/飲食/娯楽/待機 の人数を1パスで集計する。安価。
   */
  activitySnapshot(): {
    traveling: number; home: number; work: number;
    food: number; leisure: number; idle: number;
  } {
    const s = this.store;
    let traveling = 0, home = 0, work = 0, food = 0, leisure = 0, idle = 0;
    for (let i = 0; i < s.count; i++) {
      const st = s.state[i];
      if (st === AgentState.Traveling || st === AgentState.Routing) { traveling++; continue; }
      if (st === AgentState.Engaged) {
        const g = s.goalPOI[i];
        const cat = g >= 0 ? this.city.poi.get(g).category : -1;
        switch (cat) {
          case POICategory.Home: home++; break;
          case POICategory.Work: work++; break;
          case POICategory.Food: food++; break;
          case POICategory.Leisure: leisure++; break;
          default: idle++;
        }
        continue;
      }
      idle++;
    }
    return { traveling, home, work, food, leisure, idle };
  }
}
