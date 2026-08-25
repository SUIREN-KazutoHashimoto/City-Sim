import { World } from './World';
import { POICategory, type POIRegistry } from './POI';
import { FacilityType } from '../generation/SpecialFacilityPlanner';
import type { RailNetworkPlan, RailStation } from '../generation/RailPlanning';

export type ExternalVisitorPurpose = 'shopping' | 'tourism' | 'hotel';

interface VisitorGroup {
  id: number;
  count: number;
  purpose: ExternalVisitorPurpose;
  stationId: number;
  currentPoi: number;
  currentReserved: number;
  hotelPoi: number;
  hotelReserved: number;
  nextMoveAt: number;
  leaveAt: number;
  wealth: number;
}

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

let latestSystem: ExternalVisitorSystem | null = null;

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

/**
 * Lightweight non-resident demand model fed by external rail services.
 * Visitors intentionally do not enter AgentStore: they have no Home POI and must be able to leave
 * the city without consuming permanent resident capacity. Instead, compact visitor groups reserve
 * real Retail/Food/Leisure/Hotel POI capacity and consume retail stock while they are in town.
 */
export class ExternalVisitorSystem {
  private readonly poi: POIRegistry;
  private readonly rail: RailNetworkPlan;
  private readonly hotelPois: number[] = [];
  private readonly groups: VisitorGroup[] = [];
  private nextGroupId = 1;
  private eventSerial = 1;
  private waitingOutbound = 0;
  private arrivedToday = 0;
  private departedToday = 0;
  private statsDay = -1;
  private lastAdvanceAt = -Infinity;
  private readonly maxActiveVisitors = 7000;

  constructor(city: VisitorCity) {
    this.poi = city.poi;
    this.rail = city.planning.rail;
    for (const facility of city.facilities) {
      if (facility.type !== FacilityType.Hotel) continue;
      const hotelPoi = this.poi.poisInBuilding(facility.buildingId)
        .find((p) => p.category === POICategory.Leisure && p.capacity > 0);
      if (hotelPoi) this.hotelPois.push(hotelPoi.id);
    }
  }

  /** Called when an external-connection train stops at a major city station. */
  exchangeAtStation(stationId: number, trainCapacity: number, timeSeconds: number, trainId: number): { arrived: number; boarded: number } {
    this.advanceTo(timeSeconds, true);
    const station = this.station(stationId); if (!station) return { arrived: 0, boarded: 0 };
    const seats = Math.max(80, Math.floor(trainCapacity));

    // Returning visitors board first. A through intercity train can unload inbound visitors and take
    // outbound visitors in the same station call, which matches the intended external connection.
    const boarded = Math.min(this.waitingOutbound, Math.floor(seats * 0.62));
    this.waitingOutbound -= boarded;
    this.departedToday += boarded;

    const active = this.activeCount();
    const headroom = Math.max(0, this.maxActiveVisitors - active);
    if (headroom <= 0) return { arrived: 0, boarded };

    const hour = ((timeSeconds % 86400) + 86400) % 86400 / 3600;
    const demand = hour >= 9 && hour < 17 ? 0.58
      : hour >= 17 && hour < 21 ? 0.46
        : hour >= 6 && hour < 9 ? 0.38 : 0.18;
    const jitter = 0.82 + hash01(trainId * 92821 + this.eventSerial * 131 + Math.floor(timeSeconds / 300)) * 0.36;
    let arriving = Math.min(headroom, Math.max(0, Math.floor(seats * demand * jitter)));
    const requested = arriving;

    while (arriving > 0) {
      const salt = this.eventSerial++;
      const groupSize = Math.min(arriving, 10 + Math.floor(hash01(salt * 193 + trainId * 17) * 19));
      const purpose = this.pickPurpose(hour, salt);
      this.createGroup(station, groupSize, purpose, timeSeconds, salt);
      arriving -= groupSize;
    }
    this.arrivedToday += requested;
    return { arrived: requested, boarded };
  }

  /** Progress visitor stays without creating per-frame resident-agent work. */
  advanceTo(timeSeconds: number, force = false): void {
    if (!Number.isFinite(timeSeconds)) return;
    this.resetDailyCounters(timeSeconds);
    if (!force && timeSeconds - this.lastAdvanceAt < 30) return;
    this.lastAdvanceAt = timeSeconds;

    for (let i = this.groups.length - 1; i >= 0; i--) {
      const group = this.groups[i];
      if (timeSeconds >= group.leaveAt) {
        this.releaseCurrent(group);
        this.releaseHotel(group);
        this.waitingOutbound += group.count;
        this.groups.splice(i, 1);
        continue;
      }
      if (timeSeconds < group.nextMoveAt) continue;
      this.releaseCurrent(group);
      this.chooseAndReserveVisit(group, timeSeconds);
      const salt = group.id * 977 + Math.floor(timeSeconds / 60);
      group.nextMoveAt = timeSeconds + (45 + hash01(salt) * 90) * 60;
    }
  }

  stats(): ExternalVisitorStats {
    let active = 0, shopping = 0, tourism = 0, hotel = 0, hotelGuests = 0;
    for (const group of this.groups) {
      active += group.count;
      if (group.purpose === 'shopping') shopping += group.count;
      else if (group.purpose === 'tourism') tourism += group.count;
      else hotel += group.count;
      hotelGuests += group.hotelReserved;
    }
    return {
      active, shopping, tourism, hotel, hotelGuests,
      waitingOutbound: this.waitingOutbound,
      arrivedToday: this.arrivedToday,
      departedToday: this.departedToday,
      groups: this.groups.length,
    };
  }

  private createGroup(station: RailStation, count: number, requestedPurpose: ExternalVisitorPurpose, now: number, salt: number): void {
    let purpose = requestedPurpose;
    const wealth = 0.28 + hash01(salt * 541 + 23) * 0.68;
    const durationHours = purpose === 'shopping'
      ? 2.0 + hash01(salt * 31 + 5) * 3.2
      : purpose === 'tourism'
        ? 4.0 + hash01(salt * 43 + 7) * 4.5
        : 14 + hash01(salt * 59 + 11) * 10;

    const group: VisitorGroup = {
      id: this.nextGroupId++, count, purpose, stationId: station.id,
      currentPoi: -1, currentReserved: 0, hotelPoi: -1, hotelReserved: 0,
      nextMoveAt: now, leaveAt: now + durationHours * 3600, wealth,
    };

    if (purpose === 'hotel') {
      const hotel = this.reserveHotel(station, count, wealth, salt);
      if (hotel.id >= 0 && hotel.reserved > 0) {
        group.hotelPoi = hotel.id;
        group.hotelReserved = hotel.reserved;
      } else {
        purpose = 'tourism';
        group.purpose = purpose;
        group.leaveAt = now + (5 + hash01(salt * 71 + 13) * 3) * 3600;
      }
    }

    this.chooseAndReserveVisit(group, now);
    group.nextMoveAt = now + (50 + hash01(salt * 89 + 17) * 80) * 60;
    this.groups.push(group);
  }

  private pickPurpose(hour: number, salt: number): ExternalVisitorPurpose {
    const r = hash01(salt * 811 + 97);
    const hotelShare = this.hotelPois.length === 0 ? 0 : hour >= 16 || hour < 8 ? 0.34 : 0.14;
    const shoppingShare = hour >= 10 && hour < 20 ? 0.48 : 0.30;
    if (r < hotelShare) return 'hotel';
    if (r < hotelShare + shoppingShare) return 'shopping';
    return 'tourism';
  }

  private chooseAndReserveVisit(group: VisitorGroup, now: number): void {
    const station = this.station(group.stationId); if (!station) return;
    const anchor = group.currentPoi >= 0 ? this.poi.get(group.currentPoi) : station;
    const salt = group.id * 1009 + Math.floor(now / 300);
    let category: POICategory;
    const r = hash01(salt);
    if (group.purpose === 'shopping') category = r < 0.64 ? POICategory.Retail : r < 0.84 ? POICategory.Food : POICategory.Leisure;
    else if (group.purpose === 'tourism') category = r < 0.62 ? POICategory.Leisure : r < 0.82 ? POICategory.Food : POICategory.Retail;
    else category = r < 0.46 ? POICategory.Leisure : r < 0.76 ? POICategory.Food : POICategory.Retail;

    let id = -1;
    for (let attempt = 0; attempt < 4 && id < 0; attempt++) {
      const a = salt + attempt * 131;
      const x = anchor.x + (hash01(a * 17 + 3) - 0.5) * 1600;
      const z = anchor.z + (hash01(a * 23 + 5) - 0.5) * 1600;
      id = this.poi.findBest(category, x, z, group.wealth);
    }
    if (id < 0) return;
    group.currentPoi = id;
    group.currentReserved = this.reserveAmount(id, group.count);
    if (category === POICategory.Retail) {
      const p = this.poi.get(id);
      if (p.stock > 0) p.stock = Math.max(0, p.stock - Math.max(1, Math.round(group.count * (0.45 + group.wealth * 0.55))));
    }
  }

  private reserveHotel(station: RailStation, count: number, wealth: number, salt: number): { id: number; reserved: number } {
    let best = -1, bestScore = Infinity;
    for (const id of this.hotelPois) {
      const p = this.poi.get(id); if (!p || p.capacity <= 0 || p.occupancy >= p.capacity) continue;
      const dx = p.x - station.x, dz = p.z - station.z;
      const score = dx * dx + dz * dz + Math.abs(p.priceTier - wealth) * 600 * 600 + hash01(id * 31 + salt) * 50_000;
      if (score < bestScore) { bestScore = score; best = id; }
    }
    return best >= 0 ? { id: best, reserved: this.reserveAmount(best, count) } : { id: -1, reserved: 0 };
  }

  private reserveAmount(id: number, requested: number): number {
    let reserved = 0;
    for (; reserved < requested; reserved++) if (!this.poi.reserve(id)) break;
    return reserved;
  }

  private releaseAmount(id: number, amount: number): void {
    for (let i = 0; i < amount; i++) this.poi.release(id);
  }

  private releaseCurrent(group: VisitorGroup): void {
    if (group.currentPoi >= 0 && group.currentReserved > 0) this.releaseAmount(group.currentPoi, group.currentReserved);
    group.currentPoi = -1; group.currentReserved = 0;
  }

  private releaseHotel(group: VisitorGroup): void {
    if (group.hotelPoi >= 0 && group.hotelReserved > 0) this.releaseAmount(group.hotelPoi, group.hotelReserved);
    group.hotelPoi = -1; group.hotelReserved = 0;
  }

  private activeCount(): number {
    let total = 0; for (const group of this.groups) total += group.count; return total;
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

// Capture the generated city after the normal population pipeline. This deliberately wraps rather
// than replaces population generation, so rail-commuter patches can compose around it safely.
type AnyWorld = World & { city: VisitorCity };
const worldProto = World.prototype as unknown as { populate: (count: number) => void };
const originalPopulate = worldProto.populate;
worldProto.populate = function populateWithExternalVisitorModel(this: AnyWorld, count: number): void {
  originalPopulate.call(this, count);
  latestSystem = new ExternalVisitorSystem(this.city);
};
