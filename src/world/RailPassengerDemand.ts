import { Occupation } from '../agents/AgentStore';
import type { RailLine, RailNetworkPlan, RailStation } from '../generation/RailPlanning';
import { POICategory, type POI } from './POI';
import { World } from './World';

/**
 * 鉄道導入前の人口生成は、非自動車世帯の勤務先を自宅近傍へ強く寄せる。
 * そのままだと列車が存在しても通勤鉄道需要がほぼ発生しないため、
 * 駅徒歩圏の非自動車就業者の一部を「別駅勢圏への通勤」に再配置する。
 *
 * 重要: populate() は起動時の同期処理なので、AgentごとにPOI.findBest()を呼ばない。
 * Work POIを一度だけ駅別に索引化し、その後は配列参照だけで通勤ODを作る。
 */
type AnyWorld = any;
const proto: AnyWorld = World.prototype as any;
const originalPopulate = proto.populate as (count: number) => void;

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function validPoint(value: { x: number; z: number } | null | undefined): value is { x: number; z: number } {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.z);
}

function stationById(rail: RailNetworkPlan, id: number): RailStation | null {
  const direct = rail.stations[id];
  if (direct?.id === id && validPoint(direct)) return direct;
  const found = rail.stations.find((station) => station?.id === id);
  return found && validPoint(found) ? found : null;
}

function poiById(world: AnyWorld, id: number): POI | null {
  if (!Number.isInteger(id) || id < 0 || id >= world.city.poi.size) return null;
  const poi = world.city.poi.get(id) as POI | undefined;
  return poi && validPoint(poi) ? poi : null;
}

function nearestStation(rail: RailNetworkPlan, x: number, z: number, maxDistance = 500): RailStation | null {
  let best: RailStation | null = null, bestD2 = maxDistance * maxDistance;
  for (const station of rail.stations) {
    if (!validPoint(station)) continue;
    const dx = station.x - x, dz = station.z - z, d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = station; }
  }
  return best;
}

function lineById(rail: RailNetworkPlan, id: number): RailLine | undefined {
  return rail.lines.find((line) => line.id === id);
}

function destinationStations(rail: RailNetworkPlan, origin: RailStation): RailStation[] {
  const ids = new Set<number>();
  for (const lineId of origin.lineIds) {
    const line = lineById(rail, lineId); if (!line) continue;
    const originIndex = line.stationIds.indexOf(origin.id); if (originIndex < 0) continue;
    for (let i = 0; i < line.stationIds.length; i++) {
      // 待ち時間込みでも鉄道が明確に有利になる距離を作るため、原則4駅以上離す。
      if (Math.abs(i - originIndex) < 4) continue;
      const station = stationById(rail, line.stationIds[i]);
      if (station) ids.add(station.id);
    }
  }
  const out: RailStation[] = [];
  for (const id of ids) {
    const station = stationById(rail, id);
    if (station) out.push(station);
  }
  return out;
}

function buildDestinationIndex(rail: RailNetworkPlan): Map<number, RailStation[]> {
  const index = new Map<number, RailStation[]>();
  for (const station of rail.stations) {
    if (!validPoint(station)) continue;
    const destinations = destinationStations(rail, station);
    if (destinations.length) index.set(station.id, destinations);
  }
  return index;
}

function buildWorkIndex(world: AnyWorld, rail: RailNetworkPlan): Map<number, number[]> {
  const index = new Map<number, number[]>();
  const pois = world.city.poi.all() as POI[];
  for (const poi of pois) {
    if (!poi || poi.category !== POICategory.Work || poi.capacity <= 0 || !validPoint(poi)) continue;
    const station = nearestStation(rail, poi.x, poi.z, 500); if (!station) continue;
    const list = index.get(station.id);
    if (list) list.push(poi.id); else index.set(station.id, [poi.id]);
  }
  return index;
}

function chooseWork(
  world: AnyWorld,
  pool: number[],
  home: POI,
  agent: number,
  assigned: Int32Array,
): number {
  if (!pool.length) return -1;
  const start = Math.floor(hash01(agent * 3253 + 193) * pool.length) % pool.length;
  for (let n = 0; n < pool.length; n++) {
    const id = pool[(start + n) % pool.length];
    const work = poiById(world, id); if (!work || work.capacity <= 0) continue;
    if (assigned[id] >= work.capacity) continue;
    const dx = work.x - home.x, dz = work.z - home.z;
    if (dx * dx + dz * dz < 1450 * 1450) continue;
    return id;
  }
  return -1;
}

proto.populate = function populateWithRailCommuters(this: AnyWorld, count: number): void {
  originalPopulate.call(this, count);
  const rail = this.city.planning.rail as RailNetworkPlan | undefined;
  if (!rail?.stations?.length || !rail.lines?.length) return;

  // 高コストなPOI検索をAgentループの外へ出す。
  const destinationIndex = buildDestinationIndex(rail);
  const workIndex = buildWorkIndex(this, rail);
  if (!destinationIndex.size || !workIndex.size) return;

  const s = this.store;
  const assigned = new Int32Array(this.city.poi.size);
  for (let i = 0; i < s.count; i++) {
    const workId = s.workPOI[i];
    if (workId >= 0 && workId < assigned.length) assigned[workId]++;
  }

  let eligible = 0, reassigned = 0;
  for (let i = 0; i < s.count; i++) {
    if (s.ownsCar[i]) continue;
    const occupation = s.occupation[i] as Occupation;
    if (occupation === Occupation.Unemployed || occupation === Occupation.Retiree) continue;
    if (hash01(i * 7919 + 41) >= 0.80) continue;

    const home = poiById(this, s.homePOI[i]); if (!home) continue;
    const origin = nearestStation(rail, home.x, home.z, 500); if (!origin) continue;
    const destinations = destinationIndex.get(origin.id); if (!destinations?.length) continue;
    eligible++;

    const start = Math.floor(hash01(i * 1543 + 73) * destinations.length) % destinations.length;
    for (let n = 0; n < destinations.length; n++) {
      const destination = destinations[(start + n) % destinations.length];
      if (!validPoint(destination)) continue;
      const dx = destination.x - home.x, dz = destination.z - home.z;
      if (dx * dx + dz * dz < 1600 * 1600) continue;
      const pool = workIndex.get(destination.id); if (!pool?.length) continue;
      const workId = chooseWork(this, pool, home, i + n * 100003, assigned); if (workId < 0) continue;

      const oldWorkId = s.workPOI[i];
      if (oldWorkId >= 0 && oldWorkId < assigned.length && assigned[oldWorkId] > 0) assigned[oldWorkId]--;
      s.workPOI[i] = workId;
      assigned[workId]++;
      reassigned++;
      break;
    }
  }

  console.info('[City-Sim] rail commuter demand', {
    eligible,
    reassigned,
    stationsWithWork: workIndex.size,
  });
};
