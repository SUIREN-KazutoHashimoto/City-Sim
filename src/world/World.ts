import { SimulationClock } from '../core/SimulationClock';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { AgentStore, AgentState } from '../agents/AgentStore';
import { NeedSystem } from '../agents/NeedSystem';
import { UtilityBrain } from '../agents/UtilityBrain';
import { CityGenerator, CityConfig } from '../generation/CityGenerator';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { TrafficSystem } from '../traffic/TrafficSystem';
import { SignalSystem } from '../traffic/SignalSystem';
import { AStar } from '../traffic/AStar';
import { POICategory } from './POI';

const EMPTY_PATH = new Int32Array(0);

/**
 * World: 全システムのオーケストレータ。
 *
 * 1ステップの順序:
 *   1. SignalSystem  信号位相を進める
 *   2. NeedSystem    ニーズ減衰
 *   3. UtilityBrain  Idle に目的選定
 *   4. beginTrip     Routing を「運転(車)」か「徒歩(歩道A*)」に分岐
 *   5. TrafficSystem 車両を IDM+信号 で前進
 *   6. walkStep      徒歩を歩道経路に沿って前進(交差点で歩行者信号待ち)
 *   7. 到着車両の降車 & 活動(滞在)
 */
export class World {
  readonly clock = new SimulationClock();
  readonly store: AgentStore;
  readonly vehicles: VehicleStore;
  readonly city: CityGenerator;
  readonly traffic: TrafficSystem;
  readonly signals: SignalSystem;

  private readonly grid = new SpatialHashGrid(8);
  private readonly needs = new NeedSystem();
  private readonly brain: UtilityBrain;
  private readonly walkAstar: AStar;

  /** 歩行者の歩道経路(ノードID列)。index = agent index。 */
  private walkPaths: Int32Array[];

  /** この距離(m)以上は車を使う。未満は徒歩。 */
  driveThreshold = 250;
  /** 歩道オフセット(道路中心から横にずらす量, m)。 */
  private sidewalkOffset = 4.0;

  private decideCursor = 0;

  constructor(cityCfg: CityConfig, agentCapacity: number, vehicleCapacity = 4000) {
    this.store = new AgentStore(agentCapacity);
    this.vehicles = new VehicleStore(vehicleCapacity);
    this.city = new CityGenerator(cityCfg);
    this.city.generate();
    this.brain = new UtilityBrain(this.city.poi);
    this.signals = new SignalSystem(this.city.net, cityCfg.seed ^ 0x51ed);
    this.traffic = new TrafficSystem(this.city.net, this.vehicles, this.signals);
    this.walkAstar = new AStar(this.city.net, 'walk');
    this.walkPaths = new Array(agentCapacity).fill(EMPTY_PATH);
  }

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

  step(dtSec: number): void {
    const s = this.store;
    const now = this.clock.totalSeconds;

    // 1. 信号位相
    this.signals.update(dtSec);

    // 2. ニーズ減衰
    this.needs.update(s, dtSec);

    // 3. 意思決定(時間分割 + 間引き)
    const budget = Math.min(s.count, 512);
    for (let k = 0; k < budget; k++) {
      const i = (this.decideCursor + k) % s.count;
      if (s.state[i] === AgentState.Idle && now >= s.nextDecideAt[i]) {
        this.brain.decide(s, i, this.clock);
        if (s.state[i] === AgentState.Idle) s.nextDecideAt[i] = now + 900 + Math.random() * 1800;
      }
    }
    this.decideCursor = (this.decideCursor + budget) % Math.max(1, s.count);

    // 4. Routing → 運転/徒歩に分岐
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Routing) this.beginTrip(i);
    }

    // 5. 車両交通(IDM + 信号)
    this.traffic.update(dtSec);

    // 6. 徒歩(歩道経路追従 + 歩行者信号)
    this.buildTravelerIndex();
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Traveling) this.walkStep(i, dtSec);
    }

    // 7. 到着車両の降車
    this.handleArrivedVehicles();

    // 8. 活動
    for (let i = 0; i < s.count; i++) {
      if (s.state[i] === AgentState.Engaged) this.activity(i, now);
    }
  }

  /** Routing → 距離判定して運転 or 徒歩(歩道A*で経路を組む)。 */
  private beginTrip(i: number): void {
    const s = this.store;
    const dx = s.goalX[i] - s.posX[i];
    const dz = s.goalZ[i] - s.posZ[i];
    const far = Math.hypot(dx, dz) >= this.driveThreshold;

    if (far) {
      const v = this.vehicles.spawn(i);
      if (v >= 0 && this.traffic.dispatch(v, s.posX[i], s.posZ[i], s.goalX[i], s.goalZ[i])) {
        s.vehicle[i] = v;
        s.state[i] = AgentState.Driving;
        return;
      }
    }
    // 徒歩: 歩道ネットワーク上の経路を計算(短距離は直行)
    this.assignWalkPath(i);
    s.state[i] = AgentState.Traveling;
  }

  /** 出発地→目的地の歩道ノード経路を計算し walkPaths に格納。 */
  private assignWalkPath(i: number): void {
    const s = this.store;
    const startNode = this.city.net.nearestNode(s.posX[i], s.posZ[i]);
    const goalNode = this.city.net.nearestNode(s.goalX[i], s.goalZ[i]);
    if (startNode < 0 || goalNode < 0 || startNode === goalNode) {
      this.walkPaths[i] = EMPTY_PATH;
      s.pathHandle[i] = -1;
      s.pathCursor[i] = 0;
      s.waiting[i] = 0;
      return;
    }
    const path = this.walkAstar.findPath(startNode, goalNode);
    if (path.length < 2) {
      this.walkPaths[i] = EMPTY_PATH;
      s.pathHandle[i] = -1;
    } else {
      this.walkPaths[i] = Int32Array.from(path);
      s.pathHandle[i] = 1;
    }
    s.pathCursor[i] = 0;
    s.waiting[i] = 0;
  }

  private handleArrivedVehicles(): void {
    const vs = this.vehicles;
    const s = this.store;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Arrived) continue;
      const driver = vs.driver[v];
      if (driver >= 0) {
        s.posX[driver] = vs.posX[v];
        s.posZ[driver] = vs.posZ[v];
        s.vehicle[driver] = -1;
        // 降車後は目的POIまで徒歩(最終アプローチは直行)
        this.walkPaths[driver] = EMPTY_PATH;
        s.pathHandle[driver] = -1;
        s.pathCursor[driver] = 0;
        s.waiting[driver] = 0;
        s.state[driver] = AgentState.Traveling;
      }
      this.recycleVehicle(v);
      v--; // スワップで来た車両を再評価
    }
  }

  private recycleVehicle(v: number): void {
    const vs = this.vehicles;
    const last = vs.count - 1;
    if (v !== last) {
      vs.posX[v] = vs.posX[last]; vs.posZ[v] = vs.posZ[last]; vs.heading[v] = vs.heading[last];
      vs.speed[v] = vs.speed[last]; vs.maxSpeed[v] = vs.maxSpeed[last]; vs.accel[v] = vs.accel[last];
      vs.length[v] = vs.length[last]; vs.aMax[v] = vs.aMax[last]; vs.bComf[v] = vs.bComf[last];
      vs.t0[v] = vs.t0[last]; vs.s0[v] = vs.s0[last];
      vs.fromNode[v] = vs.fromNode[last]; vs.toNode[v] = vs.toNode[last]; vs.edge[v] = vs.edge[last];
      vs.segT[v] = vs.segT[last]; vs.segLen[v] = vs.segLen[last];
      vs.state[v] = vs.state[last]; vs.driver[v] = vs.driver[last];
      vs.paths[v] = vs.paths[last]; vs.pathCursor[v] = vs.pathCursor[last];
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

  /**
   * 徒歩の1ステップ。歩道経路(walkPaths[i])に沿って進み、交差点では
   * 歩行者信号(=平行車道が青か)を見て赤なら手前で待機する。
   * 経路が無い場合は目的地へ直行(降車後の最終アプローチ・短距離)。
   */
  private walkStep(i: number, dt: number): void {
    const s = this.store;
    const net = this.city.net;
    const path = this.walkPaths[i];
    const hasPath = s.pathHandle[i] > 0 && path.length >= 2;

    // 目標点(tx,tz)を決める
    let tx = s.goalX[i], tz = s.goalZ[i];
    let arriving = !hasPath; // 経路なし→最終目的地へ

    if (hasPath) {
      const cur = s.pathCursor[i];
      if (cur < path.length) {
        const node = net.nodes[path[cur]];
        // 次ノードへの方向で歩道オフセット(道の端を歩く)
        let ox = 0, oz = 0;
        if (cur + 1 < path.length) {
          const nx = net.nodes[path[cur + 1]];
          const dxx = nx.x - node.x, dzz = nx.z - node.z;
          const L = Math.hypot(dxx, dzz) || 1;
          // 右手方向へオフセット
          ox = (dzz / L) * this.sidewalkOffset;
          oz = (-dxx / L) * this.sidewalkOffset;
        }
        tx = node.x + ox; tz = node.z + oz;

        const dNode = Math.hypot(s.posX[i] - node.x, s.posZ[i] - node.z);
        if (dNode < 5) {
          // 交差点に到達: 次セグメントの軸で歩行者信号を確認
          if (node.hasSignal && cur + 1 < path.length) {
            const axis = net.axisOf(path[cur], path[cur + 1]);
            if (!this.signals.isGreen(path[cur], axis)) {
              // 赤: この交差点手前で待機(横断しない)
              s.waiting[i] = 1;
              s.velX[i] = 0; s.velZ[i] = 0;
              return;
            }
          }
          s.waiting[i] = 0;
          s.pathCursor[i] = cur + 1;
          if (cur + 1 >= path.length) arriving = true;
        }
      } else {
        arriving = true;
      }
    }

    if (arriving) { tx = s.goalX[i]; tz = s.goalZ[i]; }

    const dx = tx - s.posX[i];
    const dz = tz - s.posZ[i];
    const d2 = dx * dx + dz * dz;

    // 最終目的地(POI)に到着
    if (arriving && d2 < 4) {
      s.state[i] = AgentState.Engaged;
      s.velX[i] = 0; s.velZ[i] = 0;
      s.waiting[i] = 0;
      s.pathHandle[i] = -1;
      this.walkPaths[i] = EMPTY_PATH;
      const p = this.city.poi.get(s.goalPOI[i]);
      if (p) { p.occupancy++; s.dwellUntil[i] = this.computeDwellUntil(p.category); }
      return;
    }

    const inv = d2 > 1e-4 ? 1 / Math.sqrt(d2) : 0;
    let desX = dx * inv, desZ = dz * inv;

    // 近接分離(歩行者同士)
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
    if (nn > 0) { desX += (sepX / nn) * 0.6; desZ += (sepZ / nn) * 0.6; }

    const mag = Math.hypot(desX, desZ) || 1;
    const sp = s.maxSpeed[i];
    s.velX[i] = (desX / mag) * sp;
    s.velZ[i] = (desZ / mag) * sp;
    s.posX[i] += s.velX[i] * dt;
    s.posZ[i] += s.velZ[i] * dt;
    s.heading[i] = Math.atan2(s.velZ[i], s.velX[i]);
    s.waiting[i] = 0;
  }

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

  stats(): { agents: number; buildings: number; nodes: number; pois: number; vehicles: number; signals: number } {
    return {
      agents: this.store.count,
      buildings: this.city.buildings.length,
      nodes: this.city.net.nodes.length,
      pois: this.city.poi.size,
      vehicles: this.vehicles.count,
      signals: this.signals.count,
    };
  }

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
