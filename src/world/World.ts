import { SimulationClock } from '../core/SimulationClock';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { AgentStore, AgentState, Occupation } from '../agents/AgentStore';
import { NeedSystem } from '../agents/NeedSystem';
import { UtilityBrain } from '../agents/UtilityBrain';
import { AgentWorkerPool } from '../simulation/AgentWorkerPool';
import { POISearchWorkerPool, POIBestQuery } from '../simulation/POISearchWorkerPool';
import { PedestrianWorkerPool } from '../simulation/PedestrianWorkerPool';
import { ActiveAgentIndex } from '../simulation/ActiveAgentIndex';
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
interface BusWaitQueue { ids: number[]; head: number; }

export class World {
  readonly clock = new SimulationClock();
  readonly store: AgentStore; readonly vehicles: VehicleStore; readonly city: CityGenerator;
  readonly traffic: TrafficSystem; readonly signals: SignalSystem; readonly sidewalk: SidewalkNetwork;
  readonly bus: BusSystem; readonly logistics: LogisticsSystem;
  private readonly grid = new SpatialHashGrid(8);
  private readonly needs = new NeedSystem(); private readonly brain: UtilityBrain; private readonly walkAstar: AStar;
  private readonly agentWorkers: AgentWorkerPool; private readonly poiWorkers: POISearchWorkerPool; private readonly pedWorkers: PedestrianWorkerPool;
  private readonly walkingAgents: ActiveAgentIndex;
  private readonly routingAgents: ActiveAgentIndex;
  private walkPaths: Int32Array[]; private rng = makeRng(999);
  driveThreshold = 180;
  private decideCursor = 0;
  private routingCursor = 0;
  private readonly routingBudget = 384;
  private workerPedStep = false;
  private pedBlock: Uint8Array; private vehBlock: Uint8Array;
  private readonly pedBlockedNodes: number[] = [];
  private readonly vehBlockedNodes: number[] = [];
  private readonly busWaitQueues = new Map<string, BusWaitQueue>();
  private readonly pedCrossingRoadNode: Int32Array;
  private readonly pedCrossingAxis: Uint8Array;

  constructor(cityCfg: CityConfig, agentCapacity: number, vehicleCapacity = 8000) {
    this.store = new AgentStore(agentCapacity); this.vehicles = new VehicleStore(vehicleCapacity);
    this.agentWorkers = new AgentWorkerPool(this.store); this.pedWorkers = new PedestrianWorkerPool(this.store, cityCfg.sizeMeters);
    this.city = new CityGenerator(cityCfg); this.city.generate();
    this.poiWorkers = new POISearchWorkerPool(this.city.poi);
    this.brain = new UtilityBrain(this.city.poi);
    this.signals = new SignalSystem(this.city.net, cityCfg.seed ^ 0x51ed);
    this.traffic = new TrafficSystem(this.city.net, this.vehicles, this.signals);
    this.sidewalk = new SidewalkNetwork(this.city.net);
    this.walkAstar = new AStar(this.sidewalk, 'walk');
    this.walkPaths = new Array(agentCapacity).fill(EMPTY_PATH);
    this.walkingAgents = new ActiveAgentIndex(agentCapacity);
    this.routingAgents = new ActiveAgentIndex(agentCapacity);
    this.pedCrossingRoadNode = new Int32Array(agentCapacity); this.pedCrossingRoadNode.fill(-1);
    this.pedCrossingAxis = new Uint8Array(agentCapacity); this.pedCrossingAxis.fill(255);
    this.bus = new BusSystem(this.city.net, this.vehicles, this.traffic, cityCfg.seed ^ 0xb05); this.bus.build(cityCfg.sizeMeters);
    const gates = this.city.gateNodes.map((n) => ({ node: n, x: this.city.net.nodes[n].x, z: this.city.net.nodes[n].z }));
    this.logistics = new LogisticsSystem(this.vehicles, this.traffic, this.city.poi, gates, cityCfg.seed ^ 0x10a); this.logistics.build(2);
    this.pedBlock = new Uint8Array(this.city.net.nodes.length);
    this.vehBlock = new Uint8Array(this.city.net.nodes.length);
    this.traffic.pedBlockedFn = (node: number) => this.pedBlock[node] === 1;
  }

  get simulationWorkerCount(): number { return this.agentWorkers.workerCount + this.poiWorkers.workerCount + this.pedWorkers.workerCount; }
  get agentWorkerCount(): number { return this.agentWorkers.workerCount; }
  get poiWorkerCount(): number { return this.poiWorkers.workerCount; }
  get pedestrianWorkerCount(): number { return this.pedWorkers.workerCount; }
  get sharedAgentMemory(): boolean { return this.store.sharedMemory; }
  get activePedestrianCount(): number { return this.walkingAgents.size; }
  get routingAgentCount(): number { return this.routingAgents.size; }

  private isWalkingState(state: AgentState): boolean {
    return state === AgentState.Traveling || state === AgentState.ToVehicle || state === AgentState.ToBusStop;
  }

  private syncWalkingAgent(i: number): void { this.walkingAgents.set(i, this.isWalkingState(this.store.state[i] as AgentState)); }
  private syncRoutingAgent(i: number): void { this.routingAgents.set(i, this.store.state[i] === AgentState.Routing); }

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

  step(dtSec: number): void { this.stepCore(dtSec, true, true, true); }

  async stepBatchAsync(dtSec: number, steps: number): Promise<void> {
    if (steps <= 0) return;
    const agentParallel = this.agentWorkers.active, poiParallel = this.poiWorkers.active, pedParallel = this.pedWorkers.active;
    const totalDt = dtSec * steps, now = this.clock.totalSeconds;
    if (agentParallel) await this.agentWorkers.updateAgentBatch(totalDt, now, this.store.count);
    for (let i = 0; i < steps; i++) {
      if (poiParallel) await this.decideAgentsAsync();
      if (pedParallel) await this.stepCoreAsync(dtSec, !agentParallel, !agentParallel, !poiParallel);
      else this.stepCore(dtSec, !agentParallel, !agentParallel, !poiParallel);
    }
    if (agentParallel) this.processParallelActivityExits(now);
  }

  private stepCore(dtSec: number, updateNeeds: boolean, updateActivities: boolean, updateDecisions: boolean): void {
    this.workerPedStep = false;
    const now = this.stepBeforePed(dtSec, updateNeeds, updateDecisions);
    this.walkingAgents.forEachAscending(this.store.count, (i) => this.walkStep(i, dtSec, false));
    this.stepAfterPed(now, updateActivities, dtSec);
  }

  private async stepCoreAsync(dtSec: number, updateNeeds: boolean, updateActivities: boolean, updateDecisions: boolean): Promise<void> {
    this.workerPedStep = true;
    try {
      const now = this.stepBeforePed(dtSec, updateNeeds, updateDecisions);
      this.pedWorkers.begin();
      this.walkingAgents.forEachAscending(this.store.count, (i) => this.walkStep(i, dtSec, true));
      await this.pedWorkers.flush(dtSec);
      this.stepAfterPed(now, updateActivities, dtSec);
    } finally { this.workerPedStep = false; }
  }

  private stepBeforePed(dtSec: number, updateNeeds: boolean, updateDecisions: boolean): number {
    const s = this.store, now = this.clock.totalSeconds;
    this.signals.update(dtSec); if (updateNeeds) this.needs.update(s, dtSec); if (updateDecisions) this.decideAgentsSync();
    this.processRoutingBudget();
    this.computePedBlocks(); this.traffic.update(dtSec);
    this.bus.update(dtSec, (agent: number, stop: { x: number; z: number }) => this.onBusAlight(agent, stop), (stop: { id: number }, routeId: number, freeSeats: number) => this.collectBoarders(stop, routeId, freeSeats));
    this.bus.syncOnboard((agent: number, x: number, z: number) => { s.posX[agent] = x; s.posZ[agent] = z; });
    this.logistics.update(dtSec); this.buildTravelerIndex(); return now;
  }

  private stepAfterPed(now: number, updateActivities: boolean, dtSec: number): void {
    const s = this.store; this.handleArrivedVehicles();
    if (updateActivities) for (let i = 0; i < s.count; i++) if (s.state[i] === AgentState.Engaged) this.activity(i, now, dtSec);
  }

  private decideAgentsSync(): void {
    const s = this.store, now = this.clock.totalSeconds, budget = Math.min(s.count, 512);
    for (let k = 0; k < budget; k++) {
      const i = (this.decideCursor + k) % s.count;
      if (s.state[i] === AgentState.Idle && now >= s.nextDecideAt[i]) {
        this.brain.decide(s, i, this.clock); this.syncRoutingAgent(i);
        if (s.state[i] === AgentState.Idle) this.deferDecision(i, now);
      }
    }
    this.decideCursor = (this.decideCursor + budget) % Math.max(1, s.count);
  }

  private async decideAgentsAsync(): Promise<void> {
    const s = this.store, now = this.clock.totalSeconds, budget = Math.min(s.count, 512); const agents: number[] = [], queries: POIBestQuery[] = [];
    for (let k = 0; k < budget; k++) {
      const i = (this.decideCursor + k) % s.count; if (s.state[i] !== AgentState.Idle || now < s.nextDecideAt[i]) continue;
      const plan = this.brain.plan(s, i, this.clock); if (!plan) { this.deferDecision(i, now); continue; }
      if (plan.directTarget >= 0) {
        const applied = this.brain.applyTarget(s, i, plan.directTarget); this.syncRoutingAgent(i);
        if (!applied) this.deferDecision(i, now);
        continue;
      }
      agents.push(i); queries.push({ category: plan.category, x: s.posX[i], z: s.posZ[i], wealth: s.wealth[i] });
    }
    if (queries.length > 0) {
      const results = await this.poiWorkers.findBestBatch(queries);
      for (let q = 0; q < results.length; q++) {
        const i = agents[q], applied = this.brain.applyTarget(s, i, results[q]); this.syncRoutingAgent(i);
        if (!applied) this.deferDecision(i, now);
      }
    }
    this.decideCursor = (this.decideCursor + budget) % Math.max(1, s.count);
  }

  private deferDecision(i: number, now: number): void {
    this.store.state[i] = AgentState.Idle; this.routingAgents.delete(i); this.store.nextDecideAt[i] = now + 600 + this.rng() * 1200;
  }

  /** Smooth routing bursts while skipping non-routing agents through an ordered bitset. */
  private processRoutingBudget(): void {
    const count = this.store.count; if (count <= 0 || this.routingAgents.size <= 0) return;
    const startCursor = this.routingCursor % count;
    let cursor = startCursor, processed = 0, wrapped = false;

    while (processed < this.routingBudget) {
      const id = this.routingAgents.nextAtOrAfter(cursor, count);
      if (id < 0) {
        if (wrapped || startCursor === 0) break;
        wrapped = true; cursor = 0; continue;
      }
      if (wrapped && id >= startCursor) break;
      this.beginTrip(id); processed++; cursor = id + 1;
      if (cursor >= count) {
        if (wrapped || startCursor === 0) { cursor = 0; break; }
        wrapped = true; cursor = 0;
      }
    }

    // If the full population-equivalent scan was exhausted, the legacy cursor also lands back on
    // its starting position. When the budget is exhausted, continue immediately after the last ID.
    this.routingCursor = processed >= this.routingBudget ? cursor % count : startCursor;
  }

  private processParallelActivityExits(now: number): void {
    const s = this.store, exits = this.agentWorkers.drainActivityExits();
    for (let n = 0; n < exits.length; n++) {
      const i = exits[n];
      if (i < 0 || i >= s.count || s.activityExit[i] === 0) continue;
      s.activityExit[i] = 0; if (s.state[i] !== AgentState.Engaged || s.goalPOI[i] < 0) continue;
      const poi = this.city.poi.get(s.goalPOI[i]); if (poi.maxStock > 0 && poi.stock > 0) poi.stock -= 1;
      this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = now;
    }
  }

  private busWaitKey(stopId: number, routeId: number): string { return `${stopId}:${routeId}`; }

  private enqueueBusWait(agent: number): void {
    const s = this.store, stopId = s.boardStop[agent], routeId = s.busRoute[agent];
    if (stopId < 0 || routeId < 0) return;
    const key = this.busWaitKey(stopId, routeId);
    let q = this.busWaitQueues.get(key); if (!q) { q = { ids: [], head: 0 }; this.busWaitQueues.set(key, q); }
    q.ids.push(agent);
  }

  private collectBoarders(stop: { id: number }, routeId: number, freeSeats: number): number[] {
    const s = this.store, out: number[] = [], key = this.busWaitKey(stop.id, routeId), q = this.busWaitQueues.get(key);
    if (!q || freeSeats <= 0) return out;
    while (q.head < q.ids.length && out.length < freeSeats) {
      const i = q.ids[q.head++];
      if (s.state[i] !== AgentState.WaitingBus || s.boardStop[i] !== stop.id || s.busRoute[i] !== routeId) continue;
      this.bus.setAlight(i, s.alightStop[i]); s.state[i] = AgentState.OnBus; s.waiting[i] = 0; this.walkingAgents.delete(i); out.push(i);
    }
    if (q.head >= q.ids.length) this.busWaitQueues.delete(key);
    else if (q.head > 1024 && q.head * 2 > q.ids.length) { q.ids = q.ids.slice(q.head); q.head = 0; }
    return out;
  }

  private onBusAlight(agent: number, stop: { x: number; z: number }): void {
    const s = this.store; s.posX[agent] = stop.x; s.posZ[agent] = stop.z; s.boardStop[agent] = -1; s.alightStop[agent] = -1; s.busRoute[agent] = -1;
    this.assignWalkPath(agent, s.goalX[agent], s.goalZ[agent]); s.state[agent] = AgentState.Traveling; this.walkingAgents.add(agent);
  }

  private computePedBlocks(): void {
    for (let i = 0; i < this.pedBlockedNodes.length; i++) this.pedBlock[this.pedBlockedNodes[i]] = 0;
    for (let i = 0; i < this.vehBlockedNodes.length; i++) this.vehBlock[this.vehBlockedNodes[i]] = 0;
    this.pedBlockedNodes.length = 0; this.vehBlockedNodes.length = 0;

    const s = this.store, net = this.city.net;
    this.walkingAgents.forEachAscending(s.count, (i) => {
      const roadNode = this.pedCrossingRoadNode[i]; if (roadNode < 0) return;
      const rn = net.nodes[roadNode];
      if (rn && (s.posX[i] - rn.x) ** 2 + (s.posZ[i] - rn.z) ** 2 < 16 * 16 && this.pedBlock[roadNode] === 0) {
        this.pedBlock[roadNode] = 1; this.pedBlockedNodes.push(roadNode);
      }
    });
    const vs = this.vehicles;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving || vs.speed[v] < 1) continue;
      const to = vs.toNode[v], from = vs.fromNode[v], nt = net.nodes[to], nf = net.nodes[from];
      if (nt && (vs.posX[v] - nt.x) ** 2 + (vs.posZ[v] - nt.z) ** 2 < 100 && this.vehBlock[to] === 0) { this.vehBlock[to] = 1; this.vehBlockedNodes.push(to); }
      if (nf && (vs.posX[v] - nf.x) ** 2 + (vs.posZ[v] - nf.z) ** 2 < 100 && this.vehBlock[from] === 0) { this.vehBlock[from] = 1; this.vehBlockedNodes.push(from); }
    }
  }

  private storeUsable(id: number): boolean { const p = this.city.poi.get(id); if (p.occupancy >= p.capacity) return false; if (p.maxStock > 0 && p.stock <= 0) return false; return true; }

  private reserveGoal(i: number): boolean {
    const s = this.store, poi = this.city.poi, g = s.goalPOI[i]; if (g < 0) return false;
    if (this.storeUsable(g) && poi.reserve(g)) { s.goalCategory[i] = poi.get(g).category; return true; }
    const cat = poi.get(g).category;
    if (cat === POICategory.Food || cat === POICategory.Retail || cat === POICategory.Leisure) {
      const alt = poi.findBest(cat, s.posX[i], s.posZ[i], s.wealth[i]);
      if (alt >= 0 && this.storeUsable(alt) && poi.reserve(alt)) { s.goalPOI[i] = alt; const p = poi.get(alt); s.goalCategory[i] = p.category; s.goalX[i] = p.x; s.goalZ[i] = p.z; return true; }
    }
    return false;
  }

  private beginTrip(i: number): void {
    const s = this.store; this.routingAgents.delete(i);
    try {
      if (!this.reserveGoal(i)) { s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = this.clock.totalSeconds + 120 + this.rng() * 300; return; }
      const tripDist = Math.hypot(s.goalX[i] - s.posX[i], s.goalZ[i] - s.posZ[i]); const far = tripDist >= this.driveThreshold || (tripDist >= 90 && s.energy[i] < 0.4);
      if (far && s.ownsCar[i] && s.car[i] >= 0) {
        const v = s.car[i]; if (this.vehicles.state[v] === VehicleState.Parked) {
          const destLot = this.city.poi.findNearestFree(POICategory.Parking, s.goalX[i], s.goalZ[i]);
          if (destLot >= 0 && this.city.poi.reserve(destLot)) { s.destParkPOI[i] = destLot; s.destParkSlot[i] = this.city.takeSlot(destLot); const dCar = Math.hypot(s.posX[i] - this.vehicles.posX[v], s.posZ[i] - this.vehicles.posZ[v]); if (dCar < 25) this.startDriving(i); else { this.assignWalkPath(i, this.vehicles.posX[v], this.vehicles.posZ[v]); s.state[i] = AgentState.ToVehicle; } return; }
        }
      }
      if (far) {
        const board = this.bus.nearestStop(s.posX[i], s.posZ[i], 350), alight = this.bus.nearestStop(s.goalX[i], s.goalZ[i], 350), route = this.bus.sharedRoute(board, alight);
        if (route >= 0) { s.boardStop[i] = board; s.alightStop[i] = alight; s.busRoute[i] = route; const bs = this.bus.stopById(board); this.assignWalkPath(i, bs.x, bs.z); s.state[i] = AgentState.ToBusStop; return; }
      }
      this.assignWalkPath(i, s.goalX[i], s.goalZ[i]);
      if (s.pathHandle[i] <= 0 && tripDist > 300) { this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = this.clock.totalSeconds + 300 + this.rng() * 600; return; }
      s.state[i] = AgentState.Traveling;
    } finally {
      this.syncWalkingAgent(i); this.syncRoutingAgent(i);
    }
  }

  private startDriving(i: number): void {
    const s = this.store, v = s.car[i], lot = this.city.poi.get(s.destParkPOI[i]), origin = this.vehicles.parkPOI[v];
    try {
      if (this.traffic.dispatch(v, this.vehicles.posX[v], this.vehicles.posZ[v], lot.x, lot.z)) { if (origin >= 0) { this.city.poi.release(origin); this.city.giveSlot(origin, this.vehicles.parkSlot[v]); } this.vehicles.parkSlot[v] = -1; s.state[i] = AgentState.Driving; }
      else { this.city.poi.release(s.destParkPOI[i]); this.city.giveSlot(s.destParkPOI[i], s.destParkSlot[i]); s.destParkPOI[i] = -1; s.destParkSlot[i] = -1; this.assignWalkPath(i, s.goalX[i], s.goalZ[i]); s.state[i] = AgentState.Traveling; }
    } finally { this.syncWalkingAgent(i); }
  }

  private assignWalkPath(i: number, tx: number, tz: number): void {
    const s = this.store, startNode = this.sidewalk.nearestNode(s.posX[i], s.posZ[i]), goalNode = this.sidewalk.nearestNode(tx, tz);
    if (startNode < 0 || goalNode < 0 || startNode === goalNode) { this.walkPaths[i] = EMPTY_PATH; s.pathHandle[i] = -1; }
    else { const path = this.walkAstar.findPath(startNode, goalNode); if (path.length < 2) { this.walkPaths[i] = EMPTY_PATH; s.pathHandle[i] = -1; } else { this.walkPaths[i] = Int32Array.from(path); s.pathHandle[i] = 1; } }
    s.pathCursor[i] = 0; s.waiting[i] = 0; this.refreshPedCrossing(i);
  }

  private refreshPedCrossing(i: number): void {
    this.pedCrossingRoadNode[i] = -1; this.pedCrossingAxis[i] = 255;
    const s = this.store, path = this.walkPaths[i];
    if (s.pathHandle[i] <= 0 || path.length < 2) return;
    const cur = s.pathCursor[i]; if (cur + 1 >= path.length) return;
    const edge = this.sidewalk.edgeBetween(path[cur], path[cur + 1]); if (!edge || !edge.crossing) return;
    const node = this.sidewalk.nodes[path[cur]]; if (!node || node.roadNode < 0) return;
    this.pedCrossingRoadNode[i] = node.roadNode; this.pedCrossingAxis[i] = edge.axis;
  }

  private clearPedCrossing(i: number): void { this.pedCrossingRoadNode[i] = -1; this.pedCrossingAxis[i] = 255; }

  private handleArrivedVehicles(): void {
    const vs = this.vehicles, s = this.store;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Arrived || vs.isBus[v] || vs.isTruck[v]) continue;
      const driver = vs.driver[v]; let lotId = driver >= 0 ? s.destParkPOI[driver] : -1, slot = driver >= 0 ? s.destParkSlot[driver] : -1;
      if (lotId < 0) { lotId = this.city.poi.findNearestFree(POICategory.Parking, vs.posX[v], vs.posZ[v]); if (lotId >= 0) { this.city.poi.reserve(lotId); slot = this.city.takeSlot(lotId); } }
      vs.state[v] = VehicleState.Parked; vs.parkPOI[v] = lotId; vs.parkSlot[v] = slot; vs.speed[v] = 0;
      if (lotId >= 0) { const px = slot >= 0 ? this.city.slotX(lotId, slot) : this.city.poi.get(lotId).x, pz = slot >= 0 ? this.city.slotZ(lotId, slot) : this.city.poi.get(lotId).z; vs.posX[v] = px; vs.posZ[v] = pz; vs.heading[v] = 0; }
      if (driver >= 0) { s.posX[driver] = vs.posX[v]; s.posZ[driver] = vs.posZ[v]; s.destParkPOI[driver] = -1; s.destParkSlot[driver] = -1; this.assignWalkPath(driver, s.goalX[driver], s.goalZ[driver]); s.state[driver] = AgentState.Traveling; this.walkingAgents.add(driver); }
    }
  }

  private buildTravelerIndex(): void {
    if (this.workerPedStep) return;
    this.grid.clear(); const s = this.store;
    this.walkingAgents.forEachAscending(s.count, (i) => this.grid.insert(i, s.posX[i], s.posZ[i]));
  }

  private walkStep(i: number, dt: number, deferMovement: boolean): void {
    const s = this.store, sw = this.sidewalk, path = this.walkPaths[i], hasPath = s.pathHandle[i] > 0 && path.length >= 2;
    try {
      if (deferMovement) this.pedWorkers.include(i);
      let finalX: number, finalZ: number;
      if (s.state[i] === AgentState.ToVehicle && s.car[i] >= 0) { finalX = this.vehicles.posX[s.car[i]]; finalZ = this.vehicles.posZ[s.car[i]]; }
      else if (s.state[i] === AgentState.ToBusStop && s.boardStop[i] >= 0) { const bs = this.bus.stopById(s.boardStop[i]); finalX = bs.x; finalZ = bs.z; }
      else { finalX = s.goalX[i]; finalZ = s.goalZ[i]; }
      if (!hasPath && s.state[i] === AgentState.Traveling) {
        const dg = Math.hypot(finalX - s.posX[i], finalZ - s.posZ[i]);
        if (dg > 300) { if (s.goalPOI[i] >= 0) this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.waiting[i] = 0; this.clearPedCrossing(i); s.nextDecideAt[i] = this.clock.totalSeconds + 300 + this.rng() * 600; return; }
      }
      let tx = finalX, tz = finalZ, arriving = !hasPath;
      if (hasPath) {
        const cur = s.pathCursor[i];
        if (cur < path.length) {
          const node = sw.nodes[path[cur]]; tx = node.x; tz = node.z;
          const crossingRoadNode = this.pedCrossingRoadNode[i];
          if (crossingRoadNode >= 0) {
            const nearCurb = Math.hypot(s.posX[i] - node.x, s.posZ[i] - node.z) < 3;
            const signalized = this.signals.modeOf(crossingRoadNode) !== null;
            const redPed = signalized && !this.signals.pedWalk(crossingRoadNode, this.pedCrossingAxis[i] as 0 | 1);
            const carInside = this.vehBlock[crossingRoadNode] === 1;
            if (nearCurb && (redPed || carInside)) { s.waiting[i] = 1; s.velX[i] = 0; s.velZ[i] = 0; return; }
          }
          s.waiting[i] = 0;
          if (Math.hypot(s.posX[i] - node.x, s.posZ[i] - node.z) < 2.5) {
            s.pathCursor[i] = cur + 1; this.refreshPedCrossing(i); if (cur + 1 >= path.length) arriving = true;
          }
        } else arriving = true;
      }
      if (arriving) { tx = finalX; tz = finalZ; }
      const dx = tx - s.posX[i], dz = tz - s.posZ[i], d2 = dx * dx + dz * dz;
      if (arriving && d2 < 9) {
        this.clearPedCrossing(i);
        if (s.state[i] === AgentState.ToVehicle) { s.velX[i] = 0; s.velZ[i] = 0; s.waiting[i] = 0; s.pathHandle[i] = -1; this.walkPaths[i] = EMPTY_PATH; this.startDriving(i); return; }
        if (s.state[i] === AgentState.ToBusStop) {
          s.velX[i] = 0; s.velZ[i] = 0; s.waiting[i] = 0; s.pathHandle[i] = -1; this.walkPaths[i] = EMPTY_PATH;
          s.state[i] = AgentState.WaitingBus; this.enqueueBusWait(i); return;
        }
        s.state[i] = AgentState.Engaged; s.velX[i] = 0; s.velZ[i] = 0; s.waiting[i] = 0; s.pathHandle[i] = -1; this.walkPaths[i] = EMPTY_PATH; const p = this.city.poi.get(s.goalPOI[i]); if (p) { s.goalCategory[i] = p.category; s.dwellUntil[i] = this.computeDwellUntil(p.category); } return;
      }

      const inv = d2 > 1e-4 ? 1 / Math.sqrt(d2) : 0; let desX = dx * inv, desZ = dz * inv;
      if (deferMovement) { this.pedWorkers.queue(i, desX, desZ); return; }

      let sepX = 0, sepZ = 0, nn = 0;
      this.grid.queryNeighbors(s.posX[i], s.posZ[i], 2, (j) => { if (j === i) return; const ddx = s.posX[i] - s.posX[j], ddz = s.posZ[i] - s.posZ[j], dd = ddx * ddx + ddz * ddz; if (dd > 0 && dd < 4) { const w = 1 / Math.sqrt(dd); sepX += ddx * w; sepZ += ddz * w; nn++; } });
      if (nn > 0) { desX += (sepX / nn) * 0.6; desZ += (sepZ / nn) * 0.6; }
      const mag = Math.hypot(desX, desZ) || 1, sp = s.maxSpeed[i]; s.velX[i] = (desX / mag) * sp; s.velZ[i] = (desZ / mag) * sp; s.posX[i] += s.velX[i] * dt; s.posZ[i] += s.velZ[i] * dt; s.heading[i] = Math.atan2(s.velZ[i], s.velX[i]); s.energy[i] = Math.max(0, s.energy[i] - (1 / (2.5 * 3600)) * dt);
    } finally { this.syncWalkingAgent(i); }
  }

  private computeDwellUntil(cat: POICategory): number {
    const now = this.clock.totalSeconds, hour = this.clock.hour, H = 3600;
    switch (cat) {
      case POICategory.Home: { if (hour >= 22 || hour < 6) { const sec = now % 86400, wake = (6 + Math.random() * 2) * H; return sec < wake ? now + (wake - sec) : now + (24 * H - sec) + wake; } return now + (1 + Math.random() * 2) * H; }
      case POICategory.Work: return now + (3 + Math.random() * 3) * H;
      case POICategory.Food: return now + (0.4 + Math.random() * 0.5) * H;
      case POICategory.Leisure: return now + (1 + Math.random() * 1.5) * H;
      case POICategory.Retail: return now + (0.4 + Math.random() * 0.6) * H;
      default: return now + 0.5 * H;
    }
  }

  private activity(i: number, now: number, dt: number): void {
    const s = this.store, poi = this.city.poi.get(s.goalPOI[i]); if (!poi) { s.state[i] = AgentState.Idle; s.goalCategory[i] = 255; return; }
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
    if (now >= s.dwellUntil[i] || critical) { if (poi.maxStock > 0 && poi.stock > 0) poi.stock -= 1; this.city.poi.release(s.goalPOI[i]); s.goalPOI[i] = -1; s.goalCategory[i] = 255; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = now; }
  }

  stats() {
    let driving = 0, parked = 0;
    for (let v = 0; v < this.vehicles.count; v++) { if (this.vehicles.isBus[v] || this.vehicles.isTruck[v]) continue; this.vehicles.state[v] === VehicleState.Driving ? driving++ : parked++; }
    let stores = 0, empty = 0; for (const p of this.city.poi.all()) { if (p.maxStock > 0) { stores++; if (p.stock <= 0) empty++; } }
    return { agents: this.store.count, buildings: this.city.buildings.length, nodes: this.city.net.nodes.length, pois: this.city.poi.size, vehiclesDriving: driving,
      vehiclesTotal: this.vehicles.count - this.bus.busCount - this.logistics.truckCount, parkingLots: this.city.parkingLots.length, signals: this.signals.count,
      buses: this.bus.busCount, busStops: this.bus.stops.length, busRoutes: this.bus.routes.length, trucks: this.logistics.truckCount, gates: this.city.gateNodes.length, stores, storesEmpty: empty };
  }

  activitySnapshot() {
    const s = this.store; let traveling = 0, home = 0, work = 0, food = 0, leisure = 0, idle = 0, driving = 0, onbus = 0;
    for (let i = 0; i < s.count; i++) {
      const st = s.state[i]; if (st === AgentState.Driving) { driving++; continue; } if (st === AgentState.OnBus) { onbus++; continue; }
      if (st === AgentState.Traveling || st === AgentState.Routing || st === AgentState.ToVehicle || st === AgentState.ToBusStop || st === AgentState.WaitingBus) { traveling++; continue; }
      if (st === AgentState.Engaged) { const g = s.goalPOI[i], cat = g >= 0 ? this.city.poi.get(g).category : -1; if (cat === POICategory.Home) home++; else if (cat === POICategory.Work) work++; else if (cat === POICategory.Food) food++; else if (cat === POICategory.Leisure || cat === POICategory.Retail) leisure++; else idle++; continue; }
      idle++;
    }
    return { traveling, home, work, food, leisure, idle, driving, onbus };
  }
}
