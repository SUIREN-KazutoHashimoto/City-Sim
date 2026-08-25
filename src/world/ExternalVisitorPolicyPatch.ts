import { ExternalVisitorSystem, latestExternalVisitorSystem } from './ExternalVisitorSystem';
import { POICategory } from './POI';
import { World } from './World';

type VisitorGroup = {
  id: number;
  count: number;
  purpose: 'shopping' | 'tourism' | 'hotel';
  stationId: number;
  currentPoi: number;
  currentReserved: number;
  leaveAt: number;
  wealth: number;
};

type VisitorBus = {
  stops?: Array<{ x: number; z: number }>;
  nearestStop(x: number, z: number, maxDist?: number): number;
  sharedRoute(boardStop: number, alightStop: number): number;
};

type AnyVisitorSystem = {
  poi: {
    get(id: number): any;
    findBest(category: POICategory, x: number, z: number, wealth: number): number;
  };
  rail: {
    stations: Array<{ id: number; x: number; z: number; lineIds: number[] }>;
  };
  groups: VisitorGroup[];
  station(id: number): { id: number; x: number; z: number; lineIds: number[] } | null;
  reserveAmount(id: number, requested: number): number;
  __visitorTransitBus?: VisitorBus;
};

type CreateGroup = (
  station: { id: number; x: number; z: number },
  count: number,
  requestedPurpose: 'shopping' | 'tourism' | 'hotel',
  now: number,
  salt: number,
) => void;
type ChooseVisit = (group: VisitorGroup, now: number) => void;

type VisitorPrototype = {
  createGroup: CreateGroup;
  chooseAndReserveVisit: ChooseVisit;
  __visitorPolicyPatched?: boolean;
};

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function nearestRailStation(
  self: AnyVisitorSystem,
  x: number,
  z: number,
  maxDistance = 720,
): { id: number; x: number; z: number; lineIds: number[] } | null {
  let best: { id: number; x: number; z: number; lineIds: number[] } | null = null;
  let bestD = maxDistance * maxDistance;
  for (const station of self.rail.stations) {
    if (!station) continue;
    const d = (station.x - x) ** 2 + (station.z - z) ** 2;
    if (d < bestD) { bestD = d; best = station; }
  }
  return best;
}

function railConnected(
  self: AnyVisitorSystem,
  a: { lineIds: number[] },
  b: { lineIds: number[] },
): boolean {
  for (const lineId of a.lineIds) if (b.lineIds.includes(lineId)) return true;
  for (const firstLine of a.lineIds) {
    for (const secondLine of b.lineIds) {
      if (firstLine === secondLine) return true;
      if (self.rail.stations.some((station) => station?.lineIds.includes(firstLine) && station.lineIds.includes(secondLine))) return true;
    }
  }
  return false;
}

function hasPublicTransit(
  self: AnyVisitorSystem,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): boolean {
  const bus = self.__visitorTransitBus;
  if (bus) {
    const board = bus.nearestStop(fromX, fromZ, 520);
    const alight = bus.nearestStop(toX, toZ, 520);
    if (board >= 0 && alight >= 0 && bus.sharedRoute(board, alight) >= 0) return true;
  }

  const fromStation = nearestRailStation(self, fromX, fromZ);
  const toStation = nearestRailStation(self, toX, toZ);
  return !!fromStation && !!toStation && fromStation.id !== toStation.id && railConnected(self, fromStation, toStation);
}

function candidatePoint(
  self: AnyVisitorSystem,
  anchor: { x: number; z: number },
  salt: number,
  attempt: number,
): { x: number; z: number } {
  const a = salt + attempt * 131;
  const stations = self.rail.stations;
  const busStops = self.__visitorTransitBus?.stops ?? [];

  if (attempt >= 4 && attempt < 7 && stations.length > 0) {
    const station = stations[Math.min(stations.length - 1, Math.floor(hash01(a * 29 + 7) * stations.length))];
    if (station) {
      return {
        x: station.x + (hash01(a * 17 + 3) - 0.5) * 520,
        z: station.z + (hash01(a * 23 + 5) - 0.5) * 520,
      };
    }
  }

  if (attempt >= 7 && busStops.length > 0) {
    const stop = busStops[Math.min(busStops.length - 1, Math.floor(hash01(a * 31 + 11) * busStops.length))];
    if (stop) {
      return {
        x: stop.x + (hash01(a * 37 + 13) - 0.5) * 420,
        z: stop.z + (hash01(a * 41 + 17) - 0.5) * 420,
      };
    }
  }

  return {
    x: anchor.x + (hash01(a * 17 + 3) - 0.5) * 1600,
    z: anchor.z + (hash01(a * 23 + 5) - 0.5) * 1600,
  };
}

const visitorProto = ExternalVisitorSystem.prototype as unknown as VisitorPrototype;
if (!visitorProto.__visitorPolicyPatched) {
  visitorProto.__visitorPolicyPatched = true;
  const originalCreateGroup = visitorProto.createGroup;

  visitorProto.chooseAndReserveVisit = function chooseTransitFriendlyVisit(this: AnyVisitorSystem, group: VisitorGroup, now: number): void {
    const station = selfStation(this, group.stationId); if (!station) return;
    const anchor = group.currentPoi >= 0 ? this.poi.get(group.currentPoi) : station;
    const salt = group.id * 1009 + Math.floor(now / 300);
    const r = hash01(salt);
    let category: POICategory;
    if (group.purpose === 'shopping') category = r < 0.64 ? POICategory.Retail : r < 0.84 ? POICategory.Food : POICategory.Leisure;
    else if (group.purpose === 'tourism') category = r < 0.62 ? POICategory.Leisure : r < 0.82 ? POICategory.Food : POICategory.Retail;
    else category = r < 0.46 ? POICategory.Leisure : r < 0.76 ? POICategory.Food : POICategory.Retail;

    const candidates = new Set<number>();
    for (let attempt = 0; attempt < 10; attempt++) {
      const point = candidatePoint(this, anchor, salt, attempt);
      const id = this.poi.findBest(category, point.x, point.z, group.wealth);
      if (id >= 0) candidates.add(id);
    }

    let id = -1;
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const poi = this.poi.get(candidate); if (!poi) continue;
      const distance = Math.hypot(poi.x - anchor.x, poi.z - anchor.z);
      const transit = hasPublicTransit(this, anchor.x, anchor.z, poi.x, poi.z);
      // Tourists intentionally prefer a transit-served destination over an equally valid walk/car-like hop.
      const mobilityRank = transit ? 0 : distance <= 280 ? 1 : 2;
      const score = mobilityRank * 1e12
        + distance * distance
        + Math.abs((poi.priceTier ?? group.wealth) - group.wealth) * 250_000;
      if (score < bestScore) { bestScore = score; id = candidate; }
    }
    if (id < 0) return;

    group.currentPoi = id;
    group.currentReserved = this.reserveAmount(id, group.count);
    if (category === POICategory.Retail) {
      const poi = this.poi.get(id);
      if (poi.stock > 0) poi.stock = Math.max(0, poi.stock - Math.max(1, Math.round(group.count * (0.45 + group.wealth * 0.55))));
    }
  };

  visitorProto.createGroup = function createGroupWithRequestedStay(
    this: AnyVisitorSystem,
    station: { id: number; x: number; z: number },
    count: number,
    requestedPurpose: 'shopping' | 'tourism' | 'hotel',
    now: number,
    salt: number,
  ): void {
    const before = this.groups.length;
    originalCreateGroup.call(this, station, count, requestedPurpose, now, salt);
    const group = this.groups[before];
    if (!group) return;

    if (group.purpose === 'shopping') {
      // 6 hours inclusive, 18 hours exclusive.
      group.leaveAt = now + (6 + hash01(salt * 31 + 5) * 12) * 3600;
    } else if (group.purpose === 'hotel') {
      // 24 hours inclusive, 96 hours exclusive.
      group.leaveAt = now + (24 + hash01(salt * 59 + 11) * 72) * 3600;
    }
  };
}

function selfStation(self: AnyVisitorSystem, id: number): { id: number; x: number; z: number; lineIds: number[] } | null {
  return self.station(id);
}

const worldProto = World.prototype as any;
if (!worldProto.__externalVisitorTransitAttached) {
  worldProto.__externalVisitorTransitAttached = true;
  const originalPopulate = worldProto.populate;
  worldProto.populate = function populateWithVisitorTransit(this: World, count: number): void {
    originalPopulate.call(this, count);
    const visitorSystem = latestExternalVisitorSystem() as unknown as AnyVisitorSystem | null;
    if (visitorSystem) visitorSystem.__visitorTransitBus = this.bus;
  };
}
