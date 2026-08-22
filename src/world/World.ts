import { SimulationClock } from '../core/SimulationClock';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { AgentStore, AgentState, Occupation } from '../agents/AgentStore';
import { NeedSystem } from '../agents/NeedSystem';
import { UtilityBrain } from '../agents/UtilityBrain';
import { AgentWorkerPool } from '../simulation/AgentWorkerPool';
import { CityGenerator, CityConfig } from '../generation/CityGenerator';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { TrafficSystem } from '../traffic/TrafficSystem';
import { SignalSystem } from '../traffic/SignalSystem';
import { SidewalkNetwork } from '../traffic/SidewalkNetwork';
import { BusSystem } from '../traffic/BusSystem';
import { LogisticsSystem } from '../traffic/LogisticsSystem';
import { AStar } from '../traffic/AStar';
import { POICategory } from './POI';
import { makeRng } from '../core/math';
const EMPTY_PATH = new Int32Array(0);

export class World {
  readonly clock = new SimulationClock();
  readonly store: AgentStore; readonly vehicles: VehicleStore; readonly city: CityGenerator;
  readonly traffic: TrafficSystem; readonly signals: SignalSystem; readonly sidewalk: SidewalkNetwork;
  readonly bus: BusSystem; readonly logistics: LogisticsSystem;
  private readonly grid = new SpatialHashGrid(8);
  private readonly needs = new NeedSystem(); private readonly brain: UtilityBrain; private readonly walkAstar: AStar;
  private readonly agentWorkers: AgentWorkerPool;
  private walkPaths: Int32Array[]; private rng = makeRng(999);
  driveThreshold = 180; private decideCursor = 0;
  private pedBlock: Uint8Array; private vehBlock!: Uint8Array;

  constructor(cityCfg: CityConfig, agentCapacity: number, vehicleCapacity = 8000) {
    this.store = new AgentStore(agentCapacity); this.vehicles = new VehicleStore(vehicleCapacity);
    this.agentWorkers = new AgentWorkerPool(this.store);
    this.city = new CityGenerator(cityCfg); this.city.generate();
    this.brain = new UtilityBrain(this.city.poi);
    this.signals = new SignalSystem(this.city.net, cityCfg.seed ^ 0x51ed);
    this.traffic = new TrafficSystem(this.city.net, this.vehicles, this.signals);
    this.sidewalk = new SidewalkNetwork(this.city.net);
    this.walkAstar = new AStar(this.sidewalk, 'walk');
    this.walkPaths = new Array(agentCapacity).fill(EMPTY_PATH);
    this.bus = new BusSystem(this.city.net, this.vehicles, this.traffic, cityCfg.seed ^ 0xb05); this.bus.build(cityCfg.sizeMeters);
    const gates = this.city.gateNodes.map((n) => ({ node: n, x: this.city.net.nodes[n].x, z: this.city.net.nodes[n].z }));
    this.logistics = new LogisticsSystem(this.vehicles, this.traffic, this.city.poi, gates, cityCfg.seed ^ 0x10a); this.logistics.build(2);
    this.pedBlock = new Uint8Array(this.city.net.nodes.length);
    this.traffic.pedBlockedFn = (node: number) => this.pedBlock[node] === 1;
  }

  get simulationWorkerCount(): number { return this.agentWorkers.workerCount; }
  get sharedAgentMemory(): boolean { return this.store.sharedMemory; }

  private assignOccupation(): { occ: Occupation; start: number; end: number } {
    const r = this.rng();
    if (r < 0.25) return { occ: Occupation.Office, start: 9, end: 18 };
    if (r < 0.33) return { occ: Occupation.ShiftEarly, start: 6, end: 14 };
    if (r < 0.41) return { occ: Occupation.ShiftLate, start: 14, end: 22 };
    if (r < 0.46) return { occ: Occupation.NightShift, start: 22, end: 6 };
    if (r < 0.61) return { occ: Occupation.Student, start: 8, end: 15 };
    if (r < 0.73) return { occ: Occupation.Retail, start: 10, end: 20 };
    if (r < 0.80) return { occ: Occupation.Freelance, start: 10, end: 16 };
    if (r < 0.88) return { occ: Occupation.Unemployed, start: 0, end: 0 };
    return { occ: Occupation.Retiree, start: 0, end: 0 };
  }

  populate(count: number): void {
    const poiReg = this.city.poi; if (poiReg.size === 0) return;
    const homeCount = new Map<number, number>(); const workCount = new Map<number, number>();
    const pickHome = (x: number, z: number): number => {
      for (let t = 0; t < 12; t++) {
        const c = poiReg.findBest(POICategory.Home, x + (this.rng() - 0.5) * 400, z + (this.rng() - 0.5) * 400, this.rng()); if (c < 0) continue;
        const cnt = homeCount.get(c) ?? 0; if (cnt < poiReg.get(c).capacity) { homeCount.set(c, cnt + 1); return c; }
      }
      return -1;
    };
    const pickWork = (x: number, z: number, wealth: number, farRnd: boolean): number => {
      const bx = farRnd ? this.rng() * this.city.sizeMeters : x, bz = farRnd ? this.rng() * this.city.sizeMeters : z;
      for (let t = 0; t < 12; t++) {
        const c = poiReg.findBest(POICategory.Work, bx + (this.rng() - 0.5) * 300, bz + (this.rng() - 0.5) * 300, wealth); if (c < 0) continue;
        const cnt = workCount.get(c) ?? 0; if (cnt < poiReg.get(c).capacity) { workCount.set(c, cnt + 1); return c; }
      }
      return -1;
    };

    for (let n = 0; n < count; n++) {
      const seed = poiReg.findBest(POICategory.Home, this.rng() * this.city.sizeMeters, this.rng() * this.city.sizeMeters, this.rng()); if (seed < 0) break;
      const sp = poiReg.get(seed); const homeId = pickHome(sp.x, sp.z); if (homeId < 0) continue;
      const home = poiReg.get(homeId); const i = this.store.spawn(home.x + (this.rng() - 0.5) * 8, home.z + (this.rng() - 0.5) * 8); if (i < 0) break;
      const s = this.store; s.homePOI[i] = homeId;
      const { occ, start, end } = this.assignOccupation(); s.occupation[i] = occ; s.workStart[i] = start; s.workEnd[i] = end;
      let carProb = 0.35; if (occ === Occupation.Office || occ === Occupation.Retiree) carProb = 0.5; if (occ === Occupation.Student || occ === Occupation.Unemployed) carProb = 0.15;
      const willOwnCar = this.rng() < carProb;
      const working = occ !== Occupation.Unemployed && occ !== Occupation.Retiree;
      let wp = working ? pickWork(home.x, home.z, s.wealth[i], willOwnCar && this.rng() < 0.5) : -1;
      if (wp >= 0 && !willOwnCar) {
        const wpp = poiReg.get(wp); if (Math.hypot(wpp.x - home.x, wpp.z - home.z) > 700) { workCount.set(wp, (workCount.get(wp) ?? 1) - 1); wp = -1; }
      }
      s.workPOI[i] = wp;
      if (willOwnCar) {
        const lot = poiReg.findNearestFree(POICategory.Parking, home.x, home.z);
        if (lot >= 0 && poiReg.reserve(lot)) {
          const slot = this.city.takeSlot(lot); const px = slot >= 0 ? this.city.slotX(lot, slot) : poiReg.get(lot).x, pz = slot >= 0 ? this.city.slotZ(lot, slot) : poiReg.get(lot).z;
          const v = this.vehicles.create(i, lot, px, pz);
          if (v >= 0) { s.ownsCar[i] = 1; s.car[i] = v; this.vehicles.parkSlot[v] = slot; }
          else { poiReg.release(lot); if (slot >= 0) this.city.giveSlot(lot, slot); }
        }
      }
    }
  }

  /** 従来互換の同期step。Workerが使えない環境でも動作する。 */
  step(dtSec: number): void { this.stepCore(dtSec, true, true); }

  /**
   * 1描画フレーム内の複数固定stepをまとめる。
   * Needs + 既存Engaged活動回復はWorker Poolへ一括し、残りの依存系システムは順序保証のためCoordinatorで実行する。
   */
  async stepBatchAsync(dtSec: number, steps: number): Promise<void> {
    if (steps <= 0) return;
    if (!this.agentWorkers.active) {
      for (let i = 0; i < steps; i++) this.stepCore(dtSec, true, true);
      return;
    }

    const totalDt = dtSec * steps, now = this.clock.totalSeconds;
    await this.agentWorkers.updateAgentBatch(totalDt, now, this.store.count);
    for (let i = 0; i < steps; i++) this.stepCore(dtSec, false, false);
    this.processParallelActivityExits(now);
  }

  private stepCore(dtSec: number, updateNeeds: boolean, updateActivities: boolean): void {
    const s = this.store; const now = this.clock.totalSeconds;
    this.signals.update(dtSec); if (updateNeeds) this.needs.update(s, dtSec);
    const budget = Math.min(s.count, 512);
    for (let k = 0; k < budget; k++) {
      const i = (this.decideCursor + k) % s.count;
      if (s.state[i] === AgentState.Idle && now >= s.nextDecideAt[i]) {
        this.brain.decide(s, i, this.clock);
        if (s.state[i] === AgentState.Idle) s.nextDecideAt[i] = now + 600 + this.rng() * 1200;
      }
    }
    this.decideCursor = (this.decideCursor + budget) % Math.max(1, s.count);
    for (let i = 0; i < s.count; i++) if (s.state[i] === AgentState.Routing) this.beginTrip(i);
    this.computePedBlocks(); this.traffic.update(dtSec);
    this.bus.update(dtSec, (agent: number, stop: { x: number; z: number }) => this.onBusAlight(agent, stop), (stop: { id: number }, routeId: number, freeSeats: number) => this.collectBoarders(stop, routeId, freeSeats));
    this.bus.syncOnboard((agent: number, x: number, z: number) => { s.posX[agent] = x; s.posZ[agent] = z; });
    this.logistics.update(dtSec);
    this.buildTravelerIndex();
    for (let i = 0; i < s.count; i++) {
      const st = s.state[i]; if (st === AgentState.Traveling || st === AgentState.ToVehicle || st === AgentState.ToBusStop) this.walkStep(i, dtSec);
    }
    this.handleArrivedVehicles();
    if (updateActivities) for (let i = 0; i < s.count; i++) if (s.state[i] === AgentState.Engaged) this.activity(i, now, dtSec);
  }

  private processParallelActivityExits(now: number): void {
    const s = this.store;
    for (let i = 0; i < s.count; i++) {
      if (s.activityExit[i] === 0) continue; s.activityExit[i] = 0;
      if (s.state[i] !== AgentState.Engaged || s.goalPOI[i] < 0) continue;
      const poi = this.city.poi.get(s.goalPOI[i]);
      if (poi.maxStock > 0 && poi.stock > 0) poi.stock -= 1;
      this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = now;
    }
  }

  private collectBoarders(stop: { id: number }, routeId: number, freeSeats: number): number[] {
    const s = this.store; const out: number[] = [];
    for (let i = 0; i < s.count && out.length < freeSeats; i++) {
      if (s.state[i] !== AgentState.WaitingBus) continue; if (s.boardStop[i] !== stop.id || s.busRoute[i] !== routeId) continue;
      this.bus.setAlight(i, s.alightStop[i]); s.state[i] = AgentState.OnBus; s.waiting[i] = 0; out.push(i);
    }
    return out;
  }

  private onBusAlight(agent: number, stop: { x: number; z: number }): void {
    const s = this.store; s.posX[agent] = stop.x; s.posZ[agent] = stop.z; s.boardStop[agent] = -1; s.alightStop[agent] = -1; s.busRoute[agent] = -1;
    this.assignWalkPath(agent, s.goalX[agent], s.goalZ[agent]); s.state[agent] = AgentState.Traveling;
  }

  private computePedBlocks(): void {
    this.pedBlock.fill(0); if (!this.vehBlock) this.vehBlock = new Uint8Array(this.city.net.nodes.length); this.vehBlock.fill(0);
    const s = this.store, sw = this.sidewalk, net = this.city.net;
    for (let i = 0; i < s.count; i++) {
      const st = s.state[i]; if (st !== AgentState.Traveling && st !== AgentState.ToVehicle && st !== AgentState.ToBusStop) continue; if (s.pathHandle[i] <= 0) continue;
      const path = this.walkPaths[i]; const cur = s.pathCursor[i]; if (cur + 1 >= path.length) continue;
      const e = sw.edgeBetween(path[cur], path[cur + 1]); if (!e || !e.crossing) continue;
      const node = sw.nodes[path[cur]]; if (node.roadNode < 0) continue; const rn = net.nodes[node.roadNode];
      if ((s.posX[i] - rn.x) ** 2 + (s.posZ[i] - rn.z) ** 2 < 16 * 16) this.pedBlock[node.roadNode] = 1;
    }
    const vs = this.vehicles;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving || vs.speed[v] < 1) continue;
      const nt = net.nodes[vs.toNode[v]], nf = net.nodes[vs.fromNode[v]];
      if (nt && (vs.posX[v] - nt.x) ** 2 + (vs.posZ[v] - nt.z) ** 2 < 100) this.vehBlock[vs.toNode[v]] = 1;
      if (nf && (vs.posX[v] - nf.x) ** 2 + (vs.posZ[v] - nf.z) ** 2 < 100) this.vehBlock[vs.fromNode[v]] = 1;
    }
  }

  private storeUsable(id: number): boolean {
    const p = this.city.poi.get(id); if (p.occupancy >= p.capacity) return false; if (p.maxStock > 0 && p.stock <= 0) return false; return true;
  }

  private reserveGoal(i: number): boolean {
    const s = this.store; const poi = this.city.poi; const g = s.goalPOI[i]; if (g < 0) return false;
    if (this.storeUsable(g) && poi.reserve(g)) { s.goalCategory[i] = poi.get(g).category; return true; }
    const cat = poi.get(g).category;
    if (cat === POICategory.Food || cat === POICategory.Retail || cat === POICategory.Leisure) {
      const alt = poi.findBest(cat, s.posX[i], s.posZ[i], s.wealth[i]);
      if (alt >= 0 && this.storeUsable(alt) && poi.reserve(alt)) {
        s.goalPOI[i] = alt; const p = poi.get(alt); s.goalCategory[i] = p.category; s.goalX[i] = p.x; s.goalZ[i] = p.z; return true;
      }
    }
    return false;
  }

  private beginTrip(i: number): void {
    const s = this.store;
    if (!this.reserveGoal(i)) { s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = this.clock.totalSeconds + 120 + this.rng() * 300; return; }
    const tripDist = Math.hypot(s.goalX[i] - s.posX[i], s.goalZ[i] - s.posZ[i]);
    const far = tripDist >= this.driveThreshold || (tripDist >= 90 && s.energy[i] < 0.4);
    if (far && s.ownsCar[i] && s.car[i] >= 0) {
      const v = s.car[i];
      if (this.vehicles.state[v] === VehicleState.Parked) {
        const destLot = this.city.poi.findNearestFree(POICategory.Parking, s.goalX[i], s.goalZ[i]);
        if (destLot >= 0 && this.city.poi.reserve(destLot)) {
          s.destParkPOI[i] = destLot; s.destParkSlot[i] = this.city.takeSlot(destLot);
          const dCar = Math.hypot(s.posX[i] - this.vehicles.posX[v], s.posZ[i] - this.vehicles.posZ[v]);
          if (dCar < 25) this.startDriving(i); else { this.assignWalkPath(i, this.vehicles.posX[v], this.vehicles.posZ[v]); s.state[i] = AgentState.ToVehicle; }
          return;
        }
      }
    }
    if (far) {
      const board = this.bus.nearestStop(s.posX[i], s.posZ[i], 350), alight = this.bus.nearestStop(s.goalX[i], s.goalZ[i], 350); const route = this.bus.sharedRoute(board, alight);
      if (route >= 0) {
        s.boardStop[i] = board; s.alightStop[i] = alight; s.busRoute[i] = route; const bs = this.bus.stopById(board);
        this.assignWalkPath(i, bs.x, bs.z); s.state[i] = AgentState.ToBusStop; return;
      }
    }
    this.assignWalkPath(i, s.goalX[i], s.goalZ[i]);
    if (s.pathHandle[i] <= 0 && tripDist > 300) {
      this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = this.clock.totalSeconds + 300 + this.rng() * 600; return;
    }
    s.state[i] = AgentState.Traveling;
  }

  private startDriving(i: number): void {
    const s = this.store; const v = s.car[i]; const lot = this.city.poi.get(s.destParkPOI[i]); const origin = this.vehicles.parkPOI[v];
    if (this.traffic.dispatch(v, this.vehicles.posX[v], this.vehicles.posZ[v], lot.x, lot.z)) {
      if (origin >= 0) { this.city.poi.release(origin); this.city.giveSlot(origin, this.vehicles.parkSlot[v]); }
      this.vehicles.parkSlot[v] = -1; s.state[i] = AgentState.Driving;
    } else {
      this.city.poi.release(s.destParkPOI[i]); this.city.giveSlot(s.destParkPOI[i], s.destParkSlot[i]); s.destParkPOI[i] = -1; s.destParkSlot[i] = -1;
      this.assignWalkPath(i, s.goalX[i], s.goalZ[i]); s.state[i] = AgentState.Traveling;
    }
  }

  private assignWalkPath(i: number, tx: number, tz: number): void {
    const s = this.store; const startNode = this.sidewalk.nearestNode(s.posX[i], s.posZ[i]), goalNode = this.sidewalk.nearestNode(tx, tz);
    if (startNode < 0 || goalNode < 0 || startNode === goalNode) { this.walkPaths[i] = EMPTY_PATH; s.pathHandle[i] = -1; }
    else {
      const path = this.walkAstar.findPath(startNode, goalNode);
      if (path.length < 2) { this.walkPaths[i] = EMPTY_PATH; s.pathHandle[i] = -1; }
      else { this.walkPaths[i] = Int32Array.from(path); s.pathHandle[i] = 1; }
    }
    s.pathCursor[i] = 0; s.waiting[i] = 0;
  }

  private handleArrivedVehicles(): void {
    const vs = this.vehicles, s = this.store;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Arrived) continue; if (vs.isBus[v] || vs.isTruck[v]) continue;
      const driver = vs.driver[v]; let lotId = driver >= 0 ? s.destParkPOI[driver] : -1; let slot = driver >= 0 ? s.destParkSlot[driver] : -1;
      if (lotId < 0) { lotId = this.city.poi.findNearestFree(POICategory.Parking, vs.posX[v], vs.posZ[v]); if (lotId >= 0) { this.city.poi.reserve(lotId); slot = this.city.takeSlot(lotId); } }
      vs.state[v] = VehicleState.Parked; vs.parkPOI[v] = lotId; vs.parkSlot[v] = slot; vs.speed[v] = 0;
      if (lotId >= 0) {
        const px = slot >= 0 ? this.city.slotX(lotId, slot) : this.city.poi.get(lotId).x, pz = slot >= 0 ? this.city.slotZ(lotId, slot) : this.city.poi.get(lotId).z;
        vs.posX[v] = px; vs.posZ[v] = pz; vs.heading[v] = 0;
      }
      if (driver >= 0) {
        s.posX[driver] = vs.posX[v]; s.posZ[driver] = vs.posZ[v]; s.destParkPOI[driver] = -1; s.destParkSlot[driver] = -1;
        this.assignWalkPath(driver, s.goalX[driver], s.goalZ[driver]); s.state[driver] = AgentState.Traveling;
      }
    }
  }

  private buildTravelerIndex(): void {
    this.grid.clear(); const s = this.store;
    for (let i = 0; i < s.count; i++) {
      const st = s.state[i]; if (st === AgentState.Traveling || st === AgentState.ToVehicle || st === AgentState.ToBusStop) this.grid.insert(i, s.posX[i], s.posZ[i]);
    }
  }

  private walkStep(i: number, dt: number): void {
    const s = this.store; const sw = this.sidewalk; const path = this.walkPaths[i]; const hasPath = s.pathHandle[i] > 0 && path.length >= 2;
    let finalX: number, finalZ: number;
    if (s.state[i] === AgentState.ToVehicle && s.car[i] >= 0) { finalX = this.vehicles.posX[s.car[i]]; finalZ = this.vehicles.posZ[s.car[i]]; }
    else if (s.state[i] === AgentState.ToBusStop && s.boardStop[i] >= 0) { const bs = this.bus.stopById(s.boardStop[i]); finalX = bs.x; finalZ = bs.z; }
    else { finalX = s.goalX[i]; finalZ = s.goalZ[i]; }
    if (!hasPath && s.state[i] === AgentState.Traveling) {
      const dg = Math.hypot(finalX - s.posX[i], finalZ - s.posZ[i]);
      if (dg > 300) {
        if (s.goalPOI[i] >= 0) this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.waiting[i] = 0;
        s.nextDecideAt[i] = this.clock.totalSeconds + 300 + this.rng() * 600; return;
      }
    }
    let tx = finalX, tz = finalZ; let arriving = !hasPath;
    if (hasPath) {
      const cur = s.pathCursor[i];
      if (cur < path.length) {
        const node = sw.nodes[path[cur]]; tx = node.x; tz = node.z;
        if (cur + 1 < path.length) {
          const e = sw.edgeBetween(path[cur], path[cur + 1]);
          if (e && e.crossing) {
            const nearCurb = Math.hypot(s.posX[i] - node.x, s.posZ[i] - node.z) < 3; const signalized = this.signals.modeOf(node.roadNode) !== null;
            const redPed = signalized && !this.signals.pedWalk(node.roadNode, e.axis); const carInside = this.vehBlock && this.vehBlock[node.roadNode] === 1;
            if (nearCurb && (redPed || carInside)) { s.waiting[i] = 1; s.velX[i] = 0; s.velZ[i] = 0; return; }
          }
        }
        s.waiting[i] = 0;
        if (Math.hypot(s.posX[i] - node.x, s.posZ[i] - node.z) < 2.5) { s.pathCursor[i] = cur + 1; if (cur + 1 >= path.length) arriving = true; }
      } else arriving = true;
    }
    if (arriving) { tx = finalX; tz = finalZ; }
    const dx = tx - s.posX[i], dz = tz - s.posZ[i], d2 = dx * dx + dz * dz;
    if (arriving && d2 < 9) {
      if (s.state[i] === AgentState.ToVehicle) {
        s.velX[i] = 0; s.velZ[i] = 0; s.waiting[i] = 0; s.pathHandle[i] = -1; this.walkPaths[i] = EMPTY_PATH; this.startDriving(i); return;
      }
      if (s.state[i] === AgentState.ToBusStop) {
        s.velX[i] = 0; s.velZ[i] = 0; s.waiting[i] = 0; s.pathHandle[i] = -1; this.walkPaths[i] = EMPTY_PATH; s.state[i] = AgentState.WaitingBus; return;
      }
      s.state[i] = AgentState.Engaged; s.velX[i] = 0; s.velZ[i] = 0; s.waiting[i] = 0; s.pathHandle[i] = -1; this.walkPaths[i] = EMPTY_PATH;
      const p = this.city.poi.get(s.goalPOI[i]); if (p) { s.goalCategory[i] = p.category; s.dwellUntil[i] = this.computeDwellUntil(p.category); }
      return;
    }
    const inv = d2 > 1e-4 ? 1 / Math.sqrt(d2) : 0; let desX = dx * inv, desZ = dz * inv;
    let sepX = 0, sepZ = 0, nn = 0;
    this.grid.queryNeighbors(s.posX[i], s.posZ[i], 2, (j) => {
      if (j === i) return; const ddx = s.posX[i] - s.posX[j], ddz = s.posZ[i] - s.posZ[j], dd = ddx * ddx + ddz * ddz;
      if (dd > 0 && dd < 4) { const w = 1 / Math.sqrt(dd); sepX += ddx * w; sepZ += ddz * w; nn++; }
    });
    if (nn > 0) { desX += (sepX / nn) * 0.6; desZ += (sepZ / nn) * 0.6; }
    const mag = Math.hypot(desX, desZ) || 1; const sp = s.maxSpeed[i];
    s.velX[i] = (desX / mag) * sp; s.velZ[i] = (desZ / mag) * sp; s.posX[i] += s.velX[i] * dt; s.posZ[i] += s.velZ[i] * dt; s.heading[i] = Math.atan2(s.velZ[i], s.velX[i]);
    s.energy[i] = Math.max(0, s.energy[i] - (1 / (2.5 * 3600)) * dt);
  }

  private computeDwellUntil(cat: POICategory): number {
    const now = this.clock.totalSeconds, hour = this.clock.hour, H = 3600;
    switch (cat) {
      case POICategory.Home: {
        if (hour >= 22 || hour < 6) { const sec = now % 86400, wake = (6 + Math.random() * 2) * H; return sec < wake ? now + (wake - sec) : now + (24 * H - sec) + wake; }
        return now + (1 + Math.random() * 2) * H;
      }
      case POICategory.Work: return now + (3 + Math.random() * 3) * H;
      case POICategory.Food: return now + (0.4 + Math.random() * 0.5) * H;
      case POICategory.Leisure: return now + (1 + Math.random() * 1.5) * H;
      case POICategory.Retail: return now + (0.4 + Math.random() * 0.6) * H;
      default: return now + 0.5 * H;
    }
  }

  private activity(i: number, now: number, dt: number): void {
    const s = this.store; const poi = this.city.poi.get(s.goalPOI[i]); if (!poi) { s.state[i] = AgentState.Idle; s.goalCategory[i] = 255; return; }
    const rec = (perSec: number) => perSec * dt;
    switch (poi.category) {
      case POICategory.Home: s.energy[i] = Math.min(1, s.energy[i] + rec(1 / 1800)); s.hygiene[i] = Math.min(1, s.hygiene[i] + rec(1 / 1200)); s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 6000)); break;
      case POICategory.Food: s.hunger[i] = Math.min(1, s.hunger[i] + rec(1 / 600)); break;
      case POICategory.Work: s.wealth[i] = Math.min(1, s.wealth[i] + rec(1 / 20000)); break;
      case POICategory.Leisure: s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 1800)); s.social[i] = Math.min(1, s.social[i] + rec(1 / 2400)); break;
      case POICategory.Retail: s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 4000)); break;
      default: s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 3000));
    }
    const critical = (poi.category !== POICategory.Food && s.hunger[i] < 0.05) || (poi.category !== POICategory.Home && s.energy[i] < 0.05);
    if (now >= s.dwellUntil[i] || critical) {
      if (poi.maxStock > 0 && poi.stock > 0) poi.stock -= 1; this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = now;
    }
  }

  stats() {
    let driving = 0, parked = 0;
    for (let v = 0; v < this.vehicles.count; v++) {
      if (this.vehicles.isBus[v] || this.vehicles.isTruck[v]) continue; this.vehicles.state[v] === VehicleState.Driving ? driving++ : parked++;
    }
    let stores = 0, empty = 0; for (const p of this.city.poi.all()) { if (p.maxStock > 0) { stores++; if (p.stock <= 0) empty++; } }
    return { agents: this.store.count, buildings: this.city.buildings.length, nodes: this.city.net.nodes.length, pois: this.city.poi.size, vehiclesDriving: driving,
      vehiclesTotal: this.vehicles.count - this.bus.busCount - this.logistics.truckCount, parkingLots: this.city.parkingLots.length, signals: this.signals.count,
      buses: this.bus.busCount, busStops: this.bus.stops.length, busRoutes: this.bus.routes.length, trucks: this.logistics.truckCount, gates: this.city.gateNodes.length, stores, storesEmpty: empty };
  }

  activitySnapshot() {
    const s = this.store; let traveling = 0, home = 0, work = 0, food = 0, leisure = 0, idle = 0, driving = 0, onbus = 0;
    for (let i = 0; i < s.count; i++) {
      const st = s.state[i];
      if (st === AgentState.Driving) { driving++; continue; }
      if (st === AgentState.OnBus) { onbus++; continue; }
      if (st === AgentState.Traveling || st === AgentState.Routing || st === AgentState.ToVehicle || st === AgentState.ToBusStop || st === AgentState.WaitingBus) { traveling++; continue; }
      if (st === AgentState.Engaged) {
        const g = s.goalPOI[i]; const cat = g >= 0 ? this.city.poi.get(g).category : -1;
        if (cat === POICategory.Home) home++; else if (cat === POICategory.Work) work++; else if (cat === POICategory.Food) food++;
        else if (cat === POICategory.Leisure || cat === POICategory.Retail) leisure++; else idle++; continue;
      }
      idle++;
    }
    return { traveling, home, work, food, leisure, idle, driving, onbus };
  }
}
