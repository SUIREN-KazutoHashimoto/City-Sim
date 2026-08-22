import { SimulationClock } from '../core/SimulationClock';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { AgentStore, AgentState, Occupation } from '../agents/AgentStore';
import { NeedSystem } from '../agents/NeedSystem';
import { UtilityBrain } from '../agents/UtilityBrain';
import { CityGenerator, CityConfig } from '../generation/CityGenerator';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { TrafficSystem } from '../traffic/TrafficSystem';
import { SignalSystem } from '../traffic/SignalSystem';
import { SidewalkNetwork } from '../traffic/SidewalkNetwork';
import { AStar } from '../traffic/AStar';
import { POICategory } from './POI';
import { makeRng } from '../core/math';

const EMPTY_PATH = new Int32Array(0);

export class World {
  readonly clock = new SimulationClock();
  readonly store: AgentStore;
  readonly vehicles: VehicleStore;
  readonly city: CityGenerator;
  readonly traffic: TrafficSystem;
  readonly signals: SignalSystem;
  readonly sidewalk: SidewalkNetwork;
  private readonly grid = new SpatialHashGrid(8);
  private readonly needs = new NeedSystem();
  private readonly brain: UtilityBrain;
  private readonly walkAstar: AStar;
  private walkPaths: Int32Array[];
  private rng = makeRng(999);
  driveThreshold = 180;
  private decideCursor = 0;

  constructor(cityCfg: CityConfig, agentCapacity: number, vehicleCapacity = 8000) {
    this.store = new AgentStore(agentCapacity);
    this.vehicles = new VehicleStore(vehicleCapacity);
    this.city = new CityGenerator(cityCfg);
    this.city.generate();
    this.brain = new UtilityBrain(this.city.poi);
    this.signals = new SignalSystem(this.city.net, cityCfg.seed ^ 0x51ed);
    this.traffic = new TrafficSystem(this.city.net, this.vehicles, this.signals);
    this.sidewalk = new SidewalkNetwork(this.city.net);
    this.walkAstar = new AStar(this.sidewalk, 'walk');
    this.walkPaths = new Array(agentCapacity).fill(EMPTY_PATH);
  }

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
    const poiReg = this.city.poi;
    if (poiReg.size === 0) return;
    for (let n = 0; n < count; n++) {
      let homeId = -1;
      for (let t = 0; t < 8; t++) { const c = Math.floor(this.rng() * poiReg.size); if (poiReg.get(c).category === POICategory.Home) { homeId = c; break; } }
      const home = homeId >= 0 ? poiReg.get(homeId) : poiReg.get(0);
      const i = this.store.spawn(home.x + (this.rng() - 0.5) * 8, home.z + (this.rng() - 0.5) * 8);
      if (i < 0) break;
      const s = this.store;
      s.homePOI[i] = homeId;
      const { occ, start, end } = this.assignOccupation();
      s.occupation[i] = occ; s.workStart[i] = start; s.workEnd[i] = end;
      const working = occ !== Occupation.Unemployed && occ !== Occupation.Retiree;
      if (working) {
        if (this.rng() < 0.5) s.workPOI[i] = poiReg.findBest(POICategory.Work, home.x, home.z, s.wealth[i]);
        else {
          const rx = this.rng() * this.city.sizeMeters, rz = this.rng() * this.city.sizeMeters;
          const far = poiReg.findBest(POICategory.Work, rx, rz, s.wealth[i]);
          s.workPOI[i] = far >= 0 ? far : poiReg.findBest(POICategory.Work, home.x, home.z, s.wealth[i]);
        }
      } else s.workPOI[i] = -1;
      let carProb = 0.35;
      if (occ === Occupation.Office || occ === Occupation.Retiree) carProb = 0.5;
      if (occ === Occupation.Student || occ === Occupation.Unemployed) carProb = 0.15;
      if (this.rng() < carProb) {
        const lot = poiReg.findNearest(POICategory.Parking, home.x, home.z, true);
        if (lot >= 0) {
          const p = poiReg.get(lot);
          const v = this.vehicles.create(i, lot, p.x + (this.rng() - 0.5) * 6, p.z + (this.rng() - 0.5) * 6);
          if (v >= 0) { s.ownsCar[i] = 1; s.car[i] = v; p.occupancy++; }
        }
      }
    }
  }

  step(dtSec: number): void {
    const s = this.store; const now = this.clock.totalSeconds;
    this.signals.update(dtSec);
    this.needs.update(s, dtSec);
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
    this.traffic.update(dtSec);
    this.buildTravelerIndex();
    for (let i = 0; i < s.count; i++) { const st = s.state[i]; if (st === AgentState.Traveling || st === AgentState.ToVehicle) this.walkStep(i, dtSec); }
    this.handleArrivedVehicles();
    for (let i = 0; i < s.count; i++) if (s.state[i] === AgentState.Engaged) this.activity(i, now);
  }

  private beginTrip(i: number): void {
    const s = this.store;
    const far = Math.hypot(s.goalX[i] - s.posX[i], s.goalZ[i] - s.posZ[i]) >= this.driveThreshold;
    if (far && s.ownsCar[i] && s.car[i] >= 0) {
      const v = s.car[i];
      const destLot = this.city.poi.findNearest(POICategory.Parking, s.goalX[i], s.goalZ[i], true);
      if (destLot >= 0 && this.vehicles.state[v] === VehicleState.Parked) {
        s.destParkPOI[i] = destLot;
        const dCar = Math.hypot(s.posX[i] - this.vehicles.posX[v], s.posZ[i] - this.vehicles.posZ[v]);
        if (dCar < 25) this.startDriving(i);
        else { this.assignWalkPath(i, this.vehicles.posX[v], this.vehicles.posZ[v]); s.state[i] = AgentState.ToVehicle; }
        return;
      }
    }
    this.assignWalkPath(i, s.goalX[i], s.goalZ[i]); s.state[i] = AgentState.Traveling;
  }
  private startDriving(i: number): void {
    const s = this.store; const v = s.car[i]; const lot = this.city.poi.get(s.destParkPOI[i]);
    if (this.vehicles.parkPOI[v] >= 0) { const from = this.city.poi.get(this.vehicles.parkPOI[v]); from.occupancy = Math.max(0, from.occupancy - 1); }
    if (this.traffic.dispatch(v, this.vehicles.posX[v], this.vehicles.posZ[v], lot.x, lot.z)) s.state[i] = AgentState.Driving;
    else { this.assignWalkPath(i, s.goalX[i], s.goalZ[i]); s.state[i] = AgentState.Traveling; }
  }
  private assignWalkPath(i: number, tx: number, tz: number): void {
    const s = this.store;
    const startNode = this.sidewalk.nearestNode(s.posX[i], s.posZ[i]), goalNode = this.sidewalk.nearestNode(tx, tz);
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
      if (vs.state[v] !== VehicleState.Arrived) continue;
      const driver = vs.driver[v];
      let lotId = driver >= 0 ? s.destParkPOI[driver] : -1;
      if (lotId < 0) lotId = this.city.poi.findNearest(POICategory.Parking, vs.posX[v], vs.posZ[v], false);
      vs.state[v] = VehicleState.Parked; vs.parkPOI[v] = lotId; vs.speed[v] = 0;
      if (lotId >= 0) { const lot = this.city.poi.get(lotId); vs.posX[v] = lot.x + (this.rng() - 0.5) * 8; vs.posZ[v] = lot.z + (this.rng() - 0.5) * 8; lot.occupancy++; }
      if (driver >= 0) { s.posX[driver] = vs.posX[v]; s.posZ[driver] = vs.posZ[v]; s.destParkPOI[driver] = -1; this.assignWalkPath(driver, s.goalX[driver], s.goalZ[driver]); s.state[driver] = AgentState.Traveling; }
    }
  }
  private buildTravelerIndex(): void {
    this.grid.clear(); const s = this.store;
    for (let i = 0; i < s.count; i++) { const st = s.state[i]; if (st === AgentState.Traveling || st === AgentState.ToVehicle) this.grid.insert(i, s.posX[i], s.posZ[i]); }
  }
  private walkStep(i: number, dt: number): void {
    const s = this.store; const sw = this.sidewalk; const path = this.walkPaths[i];
    const hasPath = s.pathHandle[i] > 0 && path.length >= 2;
    let finalX: number, finalZ: number;
    if (s.state[i] === AgentState.ToVehicle && s.car[i] >= 0) { finalX = this.vehicles.posX[s.car[i]]; finalZ = this.vehicles.posZ[s.car[i]]; }
    else { finalX = s.goalX[i]; finalZ = s.goalZ[i]; }
    let tx = finalX, tz = finalZ; let arriving = !hasPath;
    if (hasPath) {
      const cur = s.pathCursor[i];
      if (cur < path.length) {
        const node = sw.nodes[path[cur]]; tx = node.x; tz = node.z;
        if (cur + 1 < path.length) {
          const e = sw.edgeBetween(path[cur], path[cur + 1]);
          if (e && e.crossing && this.signals.modeOf(node.roadNode) !== null) {
            if (!this.signals.pedWalk(node.roadNode, e.axis)) {
              if (Math.hypot(s.posX[i] - node.x, s.posZ[i] - node.z) < 3) { s.waiting[i] = 1; s.velX[i] = 0; s.velZ[i] = 0; return; }
            }
          }
        }
        s.waiting[i] = 0;
        if (Math.hypot(s.posX[i] - node.x, s.posZ[i] - node.z) < 2.5) { s.pathCursor[i] = cur + 1; if (cur + 1 >= path.length) arriving = true; }
      } else arriving = true;
    }
    if (arriving) { tx = finalX; tz = finalZ; }
    const dx = tx - s.posX[i], dz = tz - s.posZ[i], d2 = dx * dx + dz * dz;
    if (arriving && d2 < 9) {
      if (s.state[i] === AgentState.ToVehicle) { s.velX[i] = 0; s.velZ[i] = 0; s.waiting[i] = 0; s.pathHandle[i] = -1; this.walkPaths[i] = EMPTY_PATH; this.startDriving(i); return; }
      s.state[i] = AgentState.Engaged; s.velX[i] = 0; s.velZ[i] = 0; s.waiting[i] = 0; s.pathHandle[i] = -1; this.walkPaths[i] = EMPTY_PATH;
      const p = this.city.poi.get(s.goalPOI[i]); if (p) { p.occupancy++; s.dwellUntil[i] = this.computeDwellUntil(p.category); }
      return;
    }
    const inv = d2 > 1e-4 ? 1 / Math.sqrt(d2) : 0;
    let desX = dx * inv, desZ = dz * inv;
    let sepX = 0, sepZ = 0, nn = 0;
    this.grid.queryNeighbors(s.posX[i], s.posZ[i], 2, (j) => {
      if (j === i) return;
      const ddx = s.posX[i] - s.posX[j], ddz = s.posZ[i] - s.posZ[j], dd = ddx * ddx + ddz * ddz;
      if (dd > 0 && dd < 4) { const w = 1 / Math.sqrt(dd); sepX += ddx * w; sepZ += ddz * w; nn++; }
    });
    if (nn > 0) { desX += (sepX / nn) * 0.6; desZ += (sepZ / nn) * 0.6; }
    const mag = Math.hypot(desX, desZ) || 1; const sp = s.maxSpeed[i];
    s.velX[i] = (desX / mag) * sp; s.velZ[i] = (desZ / mag) * sp;
    s.posX[i] += s.velX[i] * dt; s.posZ[i] += s.velZ[i] * dt;
    s.heading[i] = Math.atan2(s.velZ[i], s.velX[i]);
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
  private activity(i: number, now: number): void {
    const s = this.store; const poi = this.city.poi.get(s.goalPOI[i]);
    if (!poi) { s.state[i] = AgentState.Idle; return; }
    const dt = this.clock.fixedStep; const rec = (perSec: number) => perSec * dt;
    switch (poi.category) {
      case POICategory.Home: s.energy[i] = Math.min(1, s.energy[i] + rec(1 / 1800)); s.hygiene[i] = Math.min(1, s.hygiene[i] + rec(1 / 1200)); s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 6000)); break;
      case POICategory.Food: s.hunger[i] = Math.min(1, s.hunger[i] + rec(1 / 600)); break;
      case POICategory.Work: s.wealth[i] = Math.min(1, s.wealth[i] + rec(1 / 20000)); break;
      case POICategory.Leisure: s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 1800)); s.social[i] = Math.min(1, s.social[i] + rec(1 / 2400)); break;
      case POICategory.Retail: s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 4000)); break;
      default: s.fun[i] = Math.min(1, s.fun[i] + rec(1 / 3000));
    }
    const critical = (poi.category !== POICategory.Food && s.hunger[i] < 0.05) || (poi.category !== POICategory.Home && s.energy[i] < 0.05);
    if (now >= s.dwellUntil[i] || critical) { poi.occupancy = Math.max(0, poi.occupancy - 1); s.goalPOI[i] = -1; s.state[i] = AgentState.Idle; s.nextDecideAt[i] = now; }
  }
  stats() {
    let driving = 0, parked = 0;
    for (let v = 0; v < this.vehicles.count; v++) this.vehicles.state[v] === VehicleState.Driving ? driving++ : parked++;
    return { agents: this.store.count, buildings: this.city.buildings.length, nodes: this.city.net.nodes.length, pois: this.city.poi.size, vehiclesDriving: driving, vehiclesTotal: this.vehicles.count, parkingLots: this.city.parkingLots.length, signals: this.signals.count };
  }
  activitySnapshot() {
    const s = this.store;
    let traveling = 0, home = 0, work = 0, food = 0, leisure = 0, idle = 0, driving = 0;
    for (let i = 0; i < s.count; i++) {
      const st = s.state[i];
      if (st === AgentState.Driving) { driving++; continue; }
      if (st === AgentState.Traveling || st === AgentState.Routing || st === AgentState.ToVehicle) { traveling++; continue; }
      if (st === AgentState.Engaged) {
        const g = s.goalPOI[i]; const cat = g >= 0 ? this.city.poi.get(g).category : -1;
        if (cat === POICategory.Home) home++;
        else if (cat === POICategory.Work) work++;
        else if (cat === POICategory.Food) food++;
        else if (cat === POICategory.Leisure || cat === POICategory.Retail) leisure++;
        else idle++;
        continue;
      }
      idle++;
    }
    return { traveling, home, work, food, leisure, idle, driving };
  }
}
