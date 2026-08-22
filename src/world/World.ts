import { SimulationClock } from '../core/SimulationClock';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { AgentStore, AgentState } from '../agents/AgentStore';
import { NeedSystem } from '../agents/NeedSystem';
import { UtilityBrain } from '../agents/UtilityBrain';
import { CityGenerator, CityConfig } from '../generation/CityGenerator';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { TrafficSystem } from '../traffic/TrafficSystem';
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
 *   3. Routing 処理    : 距離に応じて「運転」か「徒歩」を選択。運転なら車両を発行
 *   4. TrafficSystem   : 車両を IDM で前進(交通網)
 *   5. Steering        : 徒歩エージェントを目的地へ移動 + 近接回避
 *   6. 到着車両の降車 & Arrival/Activity
 */
export class World {
  readonly clock = new SimulationClock();
  readonly store: AgentStore;
  readonly vehicles: VehicleStore;
  readonly city: CityGenerator;
  readonly traffic: TrafficSystem;
  private readonly grid = new SpatialHashGrid(8);
  private readonly needs = new NeedSystem();
  private readonly brain: UtilityBrain;

  /** この距離(m)以上の移動は車を使う。未満は徒歩。 */
  driveThreshold = 250;

  private decideCursor = 0;

  constructor(cityCfg: CityConfig, agentCapacity: number, vehicleCapacity = 4000) {
    this.store = new AgentStore(agentCapacity);
    this.vehicles = new VehicleStore(vehicleCapacity);
    this.city = new CityGenerator(cityCfg);
    this.city.generate();
    this.brain = new UtilityBrain(this.city.poi);
    this.traffic = new TrafficSystem(this.city.net, this.vehicles);
  }

  /** POIの位置を初期分布として市民をスポーンし、住居/職場を割り当てる。 */
  populate(count: number): void {
    const poiReg = this.city.poi;
    if (poiReg.size === 0) return;
    for (let n = 0; n < count; n++) {
      let homeId = -1;
      for (let tries = 0; tries < 8; tries++) {
        const cand = Math.floor(Math.random() * poiReg.size);
        if (poiReg.get(cand).category === POICategory.Home) { homeId = cand; break; }
      }
      const home = homeId >= 0 ? poiReg.get(homeId) : poiReg.get(0);
      const i = this.store.spawn(home.x + (Math.random() - 0.5) * 8, home.z + (Math.random() - 0.5) * 8);
      if (i < 0) break;
      this.store.homePOI[i] = homeId;
      this.store.workPOI[i] = poiReg.findBest(POICategory.Work, home.x, home.z, this.store.wealth[i]);
    }
  }

  /** 固定ステップ更新。dtSec は clock.fixedStep。 */
  step(dtSec: number): void {
    const s = this.store;
    const now = this.clock.totalSeconds;

    // 1. ニーズ減衰
    this.needs.update(s, dtSec);

    // 2. 意思決定(時間分割 + nextDecideAt で間引き)
    const budget = Math.min(s.count, 512);
    for (let k = 0; k < budget; k++) {
      const i = (this.decideCursor + k) % s.count;
      if (s.state[i] === AgentState.Idle && now >= s.nextDecideAt[i]) {
        this.brain.decide(s, i, this.clock);
        if (s.state[i] === AgentState.Idle) {
          s.nextDecideAt[i] = now + 900 + Math.random() * 1800;
        }
      }
    }
    this.decideCursor = (this.decideCursor + budget) % Math.max(1, s.count);

    // 3. Routing のエージェント: 距離で運転/徒歩を分岐
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Routing) this.beginTrip(i);
    }

    // 4. 車両交通(IDM)
    this.traffic.update(dtSec);

    // 5. 徒歩ステアリング(移動中の個体のみ空間インデックス化)
    this.buildTravelerIndex();
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Traveling) this.steer(i, dtSec);
    }

    // 6. 到着車両の降車処理
    this.handleArrivedVehicles();

    // 7. 活動(滞在)
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Engaged) this.activity(i, now);
    }
  }

  /** Routing → 距離判定して運転(車両発行)or 徒歩。車が使えなければ徒歩フォールバック。 */
  private beginTrip(i: number): void {
    const s = this.store;
    const dx = s.goalX[i] - s.posX[i];
    const dz = s.goalZ[i] - s.posZ[i];
    const far = Math.hypot(dx, dz) >= this.driveThreshold;
    if (far) {
      const v = this.vehicles.spawn(i);
      if (v >= 0 && this.traffic.dispatch(v, s.posX[i], s.posZ[i], s.goalX[i], s.goalZ[i])) {
        s.vehicle[i] = v;
        s.state[i] = AgentState.Driving; // 車に同期して動く(描画は車両側)
        return;
      }
      // 車両発行失敗 → 徒歩
    }
    s.state[i] = AgentState.Traveling;
  }

  /** 目的地ノードに着いた車両を降車させ、運転者を徒歩の最終アプローチへ移す。 */
  private handleArrivedVehicles(): void {
    const vs = this.vehicles;
    const s = this.store;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Arrived) continue;
      const driver = vs.driver[v];
      if (driver >= 0) {
        // 運転者を降車地点(車両位置)へ移し、残りは徒歩で目的地へ
        s.posX[driver] = vs.posX[v];
        s.posZ[driver] = vs.posZ[v];
        s.vehicle[driver] = -1;
        s.state[driver] = AgentState.Traveling;
      }
      // 車両をプールへ戻す(末尾とスワップ)
      this.recycleVehicle(v);
    }
  }

  /** 到着/不要になった車両を除去(末尾スワップで count を縮める)。 */
  private recycleVehicle(v: number): void {
    const vs = this.vehicles;
    const last = vs.count - 1;
    if (v !== last) {
      // 末尾車両のデータを v へコピー
      vs.posX[v] = vs.posX[last]; vs.posZ[v] = vs.posZ[last]; vs.heading[v] = vs.heading[last];
      vs.speed[v] = vs.speed[last]; vs.maxSpeed[v] = vs.maxSpeed[last]; vs.accel[v] = vs.accel[last];
      vs.length[v] = vs.length[last]; vs.aMax[v] = vs.aMax[last]; vs.bComf[v] = vs.bComf[last];
      vs.t0[v] = vs.t0[last]; vs.s0[v] = vs.s0[last];
      vs.fromNode[v] = vs.fromNode[last]; vs.toNode[v] = vs.toNode[last]; vs.edge[v] = vs.edge[last];
      vs.segT[v] = vs.segT[last]; vs.segLen[v] = vs.segLen[last];
      vs.state[v] = vs.state[last]; vs.driver[v] = vs.driver[last];
      vs.paths[v] = vs.paths[last]; vs.pathCursor[v] = vs.pathCursor[last];
      // 付け替えた車両の運転者の参照を更新
      if (vs.driver[v] >= 0) this.store.vehicle[vs.driver[v]] = v;
    }
    vs.count--;
  }

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
    if (d2 < 4) {
      s.state[i] = AgentState.Engaged;
      s.velX[i] = 0; s.velZ[i] = 0;
      const p = this.city.poi.get(s.goalPOI[i]);
      if (p) { p.occupancy++; s.dwellUntil[i] = this.computeDwellUntil(p.category); }
      return;
    }
    const inv = 1 / Math.sqrt(d2);
    let desX = dx * inv, desZ = dz * inv;

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

  /** 到着した活動の滞在終了シミュ時刻を決める(振動防止)。 */
  private computeDwellUntil(cat: POICategory): number {
    const now = this.clock.totalSeconds;
    const hour = this.clock.hour;
    const H = 3600;
    switch (cat) {
      case POICategory.Home: {
        if (hour >= 22 || hour < 7) {
          const secToday = now % 86400;
          const wake = 7 * H;
          return secToday < wake ? now + (wake - secToday) : now + (24 * H - secToday) + wake;
        }
        return now + (1.5 + Math.random() * 1.5) * H;
      }
      case POICategory.Work: {
        const secToday = now % 86400;
        const endToday = 18 * H;
        const until = secToday < endToday ? now + (endToday - secToday) : now + 1 * H;
        return Math.max(until, now + 1 * H);
      }
      case POICategory.Food:
        return now + (0.5 + Math.random() * 0.5) * H;
      case POICategory.Leisure:
        return now + (1 + Math.random()) * H;
      default:
        return now + 0.5 * H;
    }
  }

  /** 目的地での活動。dwellUntil まで滞在してニーズ回復。 */
  private activity(i: number, now: number): void {
    const s = this.store;
    const poi = this.city.poi.get(s.goalPOI[i]);
    if (!poi) { s.state[i] = AgentState.Idle; return; }
    const dt = this.clock.fixedStep;
    const rec = (perSec: number) => perSec * dt;

    switch (poi.category) {
      case POICategory.Home:
        s.energy[i] = Math.min(1, s.energy[i] + rec(1 / 1800));
        s.hygiene[i] = Math.min(1, s.hygiene[i] + rec(1 / 1200));
        s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 6000));
        break;
      case POICategory.Food:
        s.hunger[i] = Math.min(1, s.hunger[i] + rec(1 / 600));
        break;
      case POICategory.Work:
        s.wealth[i] = Math.min(1, s.wealth[i] + rec(1 / 20000));
        break;
      case POICategory.Leisure:
        s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 1800));
        s.social[i] = Math.min(1, s.social[i] + rec(1 / 2400));
        break;
      default:
        s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 3000));
    }

    const critical =
      (poi.category !== POICategory.Food && s.hunger[i] < 0.05) ||
      (poi.category !== POICategory.Home && s.energy[i] < 0.05);

    if (now >= s.dwellUntil[i] || critical) {
      poi.occupancy = Math.max(0, poi.occupancy - 1);
      s.goalPOI[i] = -1;
      s.state[i] = AgentState.Idle;
      s.nextDecideAt[i] = now;
    }
  }

  /** デバッグ統計 */
  stats(): { agents: number; buildings: number; nodes: number; pois: number; vehicles: number } {
    return {
      agents: this.store.count,
      buildings: this.city.buildings.length,
      nodes: this.city.net.nodes.length,
      pois: this.city.poi.size,
      vehicles: this.vehicles.count,
    };
  }

  /** 現在の活動分布スナップショット(時間帯グラフ用)。 */
  activitySnapshot(): {
    traveling: number; home: number; work: number;
    food: number; leisure: number; idle: number; driving: number;
  } {
    const s = this.store;
    let traveling = 0, home = 0, work = 0, food = 0, leisure = 0, idle = 0, driving = 0;
    for (let i = 0; i < s.count; i++) {
      const st = s.state[i];
      if (st === AgentState.Driving) { driving++; continue; }
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
    return { traveling, home, work, food, leisure, idle, driving };
  }
}
