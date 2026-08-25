import { AgentState, Occupation, type AgentStore } from '../agents/AgentStore';
import { FacilityType } from '../generation/SpecialFacilityPlanner';
import type { RailNetworkPlan, RailStation } from '../generation/RailPlanning';
import { POICategory, type POIRegistry } from './POI';
import { World } from './World';

export type ExternalVisitorPurpose = 'shopping' | 'tourism' | 'hotel';

export interface ExternalVisitorStats {
  active: number;
  shopping: number;
  tourism: number;
  hotel: number;
  hotelGuests: number;
  waitingOutbound: number;
  arrivedToday: number;
  departedToday: number;
  groups: number;
}

interface VisitorCity {
  poi: POIRegistry;
  facilities: Array<{ type: FacilityType; buildingId: number }>;
  planning: { rail: RailNetworkPlan };
}

type PurposeCode = 0 | 1 | 2 | 3;

const PURPOSE_NONE: PurposeCode = 0;
const PURPOSE_SHOPPING: PurposeCode = 1;
const PURPOSE_TOURISM: PurposeCode = 2;
const PURPOSE_HOTEL: PurposeCode = 3;
const INACTIVE_AGENT_STATE = 1 as AgentState;
const PHASE1_VISITORS_PER_TRAIN = 20;
const MAX_ACTIVE_VISITORS = 7000;
const INACTIVE_COORD = -1_000_000;

let latestSystem: ExternalVisitorSystem | null = null;

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function purposeCode(purpose: ExternalVisitorPurpose): PurposeCode {
  if (purpose === 'shopping') return PURPOSE_SHOPPING;
  if (purpose === 'tourism') return PURPOSE_TOURISM;
  return PURPOSE_HOTEL;
}

function resetReusedVisitor(store: AgentStore, id: number, x: number, z: number, salt: number): void {
  const r = (offset: number): number => hash01(Math.imul(id + 1, 7919) ^ Math.imul(salt + offset, 3571));
  store.posX[id] = x; store.posZ[id] = z; store.velX[id] = 0; store.velZ[id] = 0; store.heading[id] = 0;
  store.maxSpeed[id] = 1.2 + r(1) * 0.6;
  store.energy[id] = 0.62 + r(2) * 0.30;
  store.hunger[id] = 0.55 + r(3) * 0.35;
  store.social[id] = 0.45 + r(4) * 0.45;
  store.hygiene[id] = 0.72 + r(5) * 0.25;
  store.fun[id] = 0.38 + r(6) * 0.42;
  store.wealth[id] = 0.28 + r(7) * 0.68;
  store.age[id] = 18 + Math.floor(r(8) * 58);
  store.occupation[id] = Occupation.Unemployed;
  store.workStart[id] = 0; store.workEnd[id] = 0; store.extrovert[id] = 0.35 + r(9) * 0.60;
  store.state[id] = AgentState.Idle;
  store.homePOI[id] = -1; store.workPOI[id] = -1; store.goalPOI[id] = -1; store.goalCategory[id] = 255;
  store.goalX[id] = x; store.goalZ[id] = z;
  store.pathHandle[id] = -1; store.pathCursor[id] = 0; store.waiting[id] = 0;
  store.dwellUntil[id] = 0; store.nextDecideAt[id] = Number.POSITIVE_INFINITY; store.activityExit[id] = 0;
  store.ownsCar[id] = 0; store.car[id] = -1; store.destParkPOI[id] = -1; store.destParkSlot[id] = -1;
  store.boardStop[id] = -1; store.alightStop[id] = -1; store.busRoute[id] = -1;
}

/**
 * External visitors are ordinary AgentStore pedestrians while they are in the city.
 * There is deliberately no tourist renderer, tourist movement implementation, or station-only
 * proxy. The sidecar below only owns visitor lifecycle metadata: purpose, expiry and outbound wait.
 * Movement, routing, collision avoidance, buses, rail integration and rendering remain resident code.
 */
export class ExternalVisitorSystem {
  private readonly store: AgentStore;
  private readonly poi: POIRegistry;
  private readonly rail: RailNetworkPlan;
  private readonly residentCount: number;
  private readonly hotelPois: number[] = [];
  private readonly exitPoisByStation = new Map<number, number[]>();

  private readonly active: Uint8Array;
  private readonly purpose: Uint8Array;
  private readonly stationId: Int32Array;
  private readonly leaveAt: Float64Array;
  private readonly returning: Uint8Array;
  private readonly outboundQueued: Uint8Array;
  private readonly exitPoi: Int32Array;
  private readonly hotelPoi: Int32Array;
  private readonly freeSlots: number[] = [];
  private readonly waitingOutboundIds: number[] = [];

  private activeVisitors = 0;
  private eventSerial = 1;
  private arrivedToday = 0;
  private departedToday = 0;
  private statsDay = -1;
  private lastAdvanceAt = -Infinity;

  constructor(world: World & { city: VisitorCity }) {
    this.store = world.store;
    this.poi = world.city.poi;
    this.rail = world.city.planning.rail;
    this.residentCount = this.store.count;

    const capacity = this.store.capacity;
    this.active = new Uint8Array(capacity);
    this.purpose = new Uint8Array(capacity);
    this.stationId = new Int32Array(capacity); this.stationId.fill(-1);
    this.leaveAt = new Float64Array(capacity);
    this.returning = new Uint8Array(capacity);
    this.outboundQueued = new Uint8Array(capacity);
    this.exitPoi = new Int32Array(capacity); this.exitPoi.fill(-1);
    this.hotelPoi = new Int32Array(capacity); this.hotelPoi.fill(-1);

    for (const facility of world.city.facilities) {
      if (facility.type !== FacilityType.Hotel) continue;
      const hotel = this.poi.poisInBuilding(facility.buildingId)
        .find((p) => p.category === POICategory.Leisure && p.capacity > 0);
      if (hotel) this.hotelPois.push(hotel.id);
    }
    latestSystem = this;
  }

  /** Called once when an external high-speed train exchanges passengers at Central. */
  exchangeAtStation(stationId: number, trainCapacity: number, timeSeconds: number, trainId: number): { arrived: number; boarded: number } {
    this.advanceTo(timeSeconds, true);
    const station = this.station(stationId); if (!station) return { arrived: 0, boarded: 0 };
    const seats = Math.max(80, Math.floor(trainCapacity));

    // Returners board first. They remain normal visible AgentStore pedestrians until this point.
    const boardLimit = Math.min(this.waitingOutboundIds.length, Math.floor(seats * 0.62));
    let boarded = 0;
    for (let n = 0; n < boardLimit; n++) {
      const id = this.waitingOutboundIds.shift();
      if (id == null || !this.active[id] || !this.outboundQueued[id]) continue;
      this.outboundQueued[id] = 0;
      this.deactivateVisitor(id);
      boarded++;
    }
    this.departedToday += boarded;

    const reusable = this.freeSlots.length;
    const appendable = Math.max(0, this.store.capacity - this.store.count);
    const headroom = Math.min(MAX_ACTIVE_VISITORS - this.activeVisitors, reusable + appendable);
    if (headroom <= 0) return { arrived: 0, boarded };

    const hour = ((timeSeconds % 86400) + 86400) % 86400 / 3600;
    const demand = hour >= 9 && hour < 17 ? 0.58
      : hour >= 17 && hour < 21 ? 0.46
        : hour >= 6 && hour < 9 ? 0.38 : 0.18;
    const jitter = 0.82 + hash01(trainId * 92821 + this.eventSerial * 131 + Math.floor(timeSeconds / 300)) * 0.36;
    const requested = Math.min(
      PHASE1_VISITORS_PER_TRAIN,
      headroom,
      Math.max(0, Math.floor(seats * demand * jitter)),
    );

    let arrived = 0;
    for (let n = 0; n < requested; n++) {
      const salt = this.eventSerial++;
      const purpose = this.pickPurpose(hour, salt);
      if (this.spawnVisitor(station, purpose, timeSeconds, salt) < 0) break;
      arrived++;
    }
    this.arrivedToday += arrived;
    return { arrived, boarded };
  }

  /**
   * Only lifecycle bookkeeping happens here. Visitor movement itself is advanced by World exactly
   * like a resident because visitor agents use the same AgentState transitions and stores.
   */
  advanceTo(timeSeconds: number, force = false): void {
    if (!Number.isFinite(timeSeconds)) return;
    this.resetDailyCounters(timeSeconds);
    if (!force && timeSeconds - this.lastAdvanceAt < 30) return;
    this.lastAdvanceAt = timeSeconds;

    for (let id = this.residentCount; id < this.store.count; id++) {
      if (!this.active[id]) continue;
      const state = this.store.state[id] as AgentState;

      if (this.outboundQueued[id]) {
        this.store.nextDecideAt[id] = Number.POSITIVE_INFINITY;
        continue;
      }

      if (!this.returning[id] && timeSeconds >= this.leaveAt[id]) this.returning[id] = 1;

      if (this.returning[id]) {
        if (state === AgentState.Engaged) {
          if (this.store.goalPOI[id] === this.exitPoi[id]) this.queueOutbound(id);
          else {
            this.releaseEngagedGoal(id);
            this.routeToExit(id);
          }
        } else if (state === AgentState.Idle) {
          this.routeToExit(id);
        } else if (state === AgentState.WaitingTrain) {
          this.queueOutbound(id);
        }
        continue;
      }

      // Keep the visitor on the resident program. The first purpose-specific destination is seeded
      // at arrival, then UtilityBrain is free to choose food/retail/leisure exactly as for residents.
      // If a visitor is idling because a resident action could not find a target, let the normal
      // decision scheduler retry; we only constrain the return phase.
    }
  }

  stats(): ExternalVisitorStats {
    let shopping = 0, tourism = 0, hotel = 0, hotelGuests = 0;
    for (let id = this.residentCount; id < this.store.count; id++) {
      if (!this.active[id]) continue;
      const p = this.purpose[id] as PurposeCode;
      if (p === PURPOSE_SHOPPING) shopping++;
      else if (p === PURPOSE_TOURISM) tourism++;
      else if (p === PURPOSE_HOTEL) {
        hotel++;
        if (this.hotelPoi[id] >= 0) hotelGuests++;
      }
    }
    return {
      active: this.activeVisitors,
      shopping,
      tourism,
      hotel,
      hotelGuests,
      waitingOutbound: this.waitingOutboundIds.length,
      arrivedToday: this.arrivedToday,
      departedToday: this.departedToday,
      groups: this.activeVisitors,
    };
  }

  private spawnVisitor(station: RailStation, visitorPurpose: ExternalVisitorPurpose, now: number, salt: number): number {
    const jitterX = (hash01(salt * 31 + 7) - 0.5) * 8;
    const jitterZ = (hash01(salt * 43 + 11) - 0.5) * 8;
    const x = station.x + jitterX, z = station.z + jitterZ;

    let id = this.freeSlots.pop() ?? -1;
    if (id >= 0) resetReusedVisitor(this.store, id, x, z, salt);
    else {
      id = this.store.spawn(x, z);
      if (id < 0) return -1;
      resetReusedVisitor(this.store, id, x, z, salt);
    }

    const code = purposeCode(visitorPurpose);
    this.active[id] = 1;
    this.purpose[id] = code;
    this.stationId[id] = station.id;
    this.returning[id] = 0;
    this.outboundQueued[id] = 0;
    this.exitPoi[id] = this.pickExitPoi(station, id);
    this.hotelPoi[id] = -1;

    const durationHours = visitorPurpose === 'shopping'
      ? 2.0 + hash01(salt * 53 + 13) * 3.2
      : visitorPurpose === 'tourism'
        ? 4.0 + hash01(salt * 59 + 17) * 4.5
        : 14 + hash01(salt * 61 + 19) * 10;
    this.leaveAt[id] = now + durationHours * 3600;

    this.store.occupation[id] = Occupation.Unemployed;
    this.store.workPOI[id] = -1;
    this.store.ownsCar[id] = 0;
    this.store.car[id] = -1;

    let initialTarget = -1;
    if (visitorPurpose === 'hotel') {
      const hotel = this.pickHotel(station, this.store.wealth[id], salt);
      if (hotel >= 0) {
        this.hotelPoi[id] = hotel;
        // Treat the hotel as this temporary resident's home anchor. UtilityBrain can therefore use
        // its normal sleep/routine-home action without any visitor-specific movement code.
        this.store.homePOI[id] = hotel;
        initialTarget = hotel;
      }
    }
    if (initialTarget < 0) initialTarget = this.pickVisitPoi(station, visitorPurpose, this.store.wealth[id], salt);

    if (initialTarget >= 0) this.assignGoal(id, initialTarget);
    else {
      this.store.state[id] = AgentState.Idle;
      this.store.nextDecideAt[id] = now + 30;
    }

    this.activeVisitors++;
    return id;
  }

  private assignGoal(id: number, poiId: number): boolean {
    if (poiId < 0 || poiId >= this.poi.size) return false;
    const p = this.poi.get(poiId);
    this.store.goalPOI[id] = poiId;
    this.store.goalCategory[id] = p.category;
    this.store.goalX[id] = p.x;
    this.store.goalZ[id] = p.z;
    this.store.pathHandle[id] = -1;
    this.store.pathCursor[id] = 0;
    this.store.waiting[id] = 0;
    this.store.state[id] = AgentState.Routing;
    this.store.nextDecideAt[id] = Number.POSITIVE_INFINITY;
    return true;
  }

  private routeToExit(id: number): void {
    const station = this.station(this.stationId[id]);
    if (!station) {
      this.queueOutbound(id);
      return;
    }
    let exit = this.exitPoi[id];
    if (exit < 0) {
      exit = this.pickExitPoi(station, id);
      this.exitPoi[id] = exit;
    }
    if (exit >= 0 && this.assignGoal(id, exit)) return;

    // The generated city normally always has a station-adjacent POI. If not, keeping the visitor
    // at the station as WaitingTrain is safer than inventing a second movement implementation.
    this.store.posX[id] = station.x;
    this.store.posZ[id] = station.z;
    this.queueOutbound(id);
  }

  private queueOutbound(id: number): void {
    if (!this.active[id] || this.outboundQueued[id]) return;
    this.releaseEngagedGoal(id);
    this.store.goalPOI[id] = -1;
    this.store.goalCategory[id] = 255;
    this.store.pathHandle[id] = -1;
    this.store.pathCursor[id] = 0;
    this.store.velX[id] = 0;
    this.store.velZ[id] = 0;
    this.store.waiting[id] = 1;
    this.store.state[id] = AgentState.WaitingTrain;
    this.store.nextDecideAt[id] = Number.POSITIVE_INFINITY;
    this.outboundQueued[id] = 1;
    this.waitingOutboundIds.push(id);
  }

  private releaseEngagedGoal(id: number): void {
    if (this.store.state[id] !== AgentState.Engaged) return;
    const goal = this.store.goalPOI[id];
    if (goal >= 0 && goal < this.poi.size) this.poi.release(goal);
    this.store.goalPOI[id] = -1;
    this.store.goalCategory[id] = 255;
  }

  private deactivateVisitor(id: number): void {
    if (!this.active[id]) return;
    this.releaseEngagedGoal(id);
    this.active[id] = 0;
    this.purpose[id] = PURPOSE_NONE;
    this.stationId[id] = -1;
    this.leaveAt[id] = 0;
    this.returning[id] = 0;
    this.outboundQueued[id] = 0;
    this.exitPoi[id] = -1;
    this.hotelPoi[id] = -1;

    this.store.state[id] = INACTIVE_AGENT_STATE;
    this.store.posX[id] = INACTIVE_COORD;
    this.store.posZ[id] = INACTIVE_COORD;
    this.store.velX[id] = 0;
    this.store.velZ[id] = 0;
    this.store.goalPOI[id] = -1;
    this.store.goalCategory[id] = 255;
    this.store.pathHandle[id] = -1;
    this.store.waiting[id] = 0;
    this.store.homePOI[id] = -1;
    this.store.workPOI[id] = -1;
    this.store.nextDecideAt[id] = Number.POSITIVE_INFINITY;
    this.activeVisitors = Math.max(0, this.activeVisitors - 1);
    this.freeSlots.push(id);
  }

  private pickPurpose(hour: number, salt: number): ExternalVisitorPurpose {
    const r = hash01(salt * 811 + 97);
    const hotelShare = this.hotelPois.length === 0 ? 0 : hour >= 16 || hour < 8 ? 0.34 : 0.14;
    const shoppingShare = hour >= 10 && hour < 20 ? 0.48 : 0.30;
    if (r < hotelShare) return 'hotel';
    if (r < hotelShare + shoppingShare) return 'shopping';
    return 'tourism';
  }

  private pickVisitPoi(station: RailStation, purpose: ExternalVisitorPurpose, wealth: number, salt: number): number {
    let category: POICategory;
    const r = hash01(salt * 101 + 29);
    if (purpose === 'shopping') category = r < 0.72 ? POICategory.Retail : r < 0.88 ? POICategory.Food : POICategory.Leisure;
    else if (purpose === 'tourism') category = r < 0.68 ? POICategory.Leisure : r < 0.86 ? POICategory.Food : POICategory.Retail;
    else category = r < 0.50 ? POICategory.Leisure : r < 0.78 ? POICategory.Food : POICategory.Retail;

    for (let attempt = 0; attempt < 6; attempt++) {
      const a = salt + attempt * 131;
      const x = station.x + (hash01(a * 17 + 3) - 0.5) * 2200;
      const z = station.z + (hash01(a * 23 + 5) - 0.5) * 2200;
      const id = this.poi.findBest(category, x, z, wealth);
      if (id >= 0) return id;
    }
    return -1;
  }

  private pickHotel(station: RailStation, wealth: number, salt: number): number {
    let best = -1, bestScore = Infinity;
    for (const id of this.hotelPois) {
      const p = this.poi.get(id);
      if (!p || p.capacity <= 0 || p.occupancy >= p.capacity) continue;
      const dx = p.x - station.x, dz = p.z - station.z;
      const score = dx * dx + dz * dz + Math.abs(p.priceTier - wealth) * 600 * 600 + hash01(id * 31 + salt) * 50_000;
      if (score < bestScore) { bestScore = score; best = id; }
    }
    return best;
  }

  private pickExitPoi(station: RailStation, agent: number): number {
    let choices = this.exitPoisByStation.get(station.id);
    if (!choices) {
      const ranked: Array<{ id: number; score: number }> = [];
      for (const p of this.poi.all()) {
        if (!p || p.capacity <= 0 || p.category === POICategory.Home) continue;
        const dx = p.x - station.x, dz = p.z - station.z;
        const preferred = p.category === POICategory.Food || p.category === POICategory.Retail || p.category === POICategory.Leisure;
        ranked.push({ id: p.id, score: dx * dx + dz * dz + (preferred ? 0 : 250_000) });
      }
      ranked.sort((a, b) => a.score - b.score);
      choices = ranked.slice(0, 12).map((item) => item.id);
      this.exitPoisByStation.set(station.id, choices);
    }
    if (!choices.length) return -1;
    return choices[Math.floor(hash01(agent * 1237 + station.id * 97) * choices.length) % choices.length];
  }

  private station(id: number): RailStation | null {
    const direct = this.rail.stations[id];
    if (direct?.id === id) return direct;
    return this.rail.stations.find((s) => s.id === id) ?? null;
  }

  private resetDailyCounters(timeSeconds: number): void {
    const day = Math.floor(timeSeconds / 86400);
    if (day === this.statsDay) return;
    this.statsDay = day;
    this.arrivedToday = 0;
    this.departedToday = 0;
  }
}

export function latestExternalVisitorSystem(): ExternalVisitorSystem | null {
  return latestSystem;
}

// Create the sidecar after resident population has finished. This is the only lifecycle hook: the
// visitor system does not wrap World.step, World.walkStep, EnhancedRenderer, or any worker path.
type AnyWorld = World & { city: VisitorCity };
const worldProto = World.prototype as unknown as { populate: (count: number) => void };
const originalPopulate = worldProto.populate;
worldProto.populate = function populateWithExternalVisitorModel(this: AnyWorld, count: number): void {
  originalPopulate.call(this, count);
  latestSystem = new ExternalVisitorSystem(this);
};
