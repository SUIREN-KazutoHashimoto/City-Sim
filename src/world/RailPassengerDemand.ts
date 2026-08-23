import { Occupation } from '../agents/AgentStore';
import type { RailLine, RailNetworkPlan, RailStation } from '../generation/RailPlanning';
import { POICategory } from './POI';
import { World } from './World';

/**
 * 鉄道導入前の人口生成は、非自動車世帯の勤務先を自宅近傍へ強く寄せる。
 * そのままだと列車が存在しても通勤鉄道需要がほぼ発生しないため、
 * 駅徒歩圏の非自動車就業者の一部を「別駅勢圏への通勤」に再配置する。
 *
 * 強制的に列車へ乗せるのではなく、既存のRailPassengerIntegrationの
 * 交通手段選択に、実際に競争力のあるODを供給するための需要生成レイヤー。
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

function nearestStation(rail: RailNetworkPlan, x: number, z: number, maxDistance = 500): RailStation | null {
  let best: RailStation | null = null, bestD = maxDistance;
  for (const station of rail.stations) {
    const d = Math.hypot(station.x - x, station.z - z);
    if (d < bestD) { bestD = d; best = station; }
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
      // 待ち時間込みでも鉄道が明確に有利になる距離を作るため、原則3駅以上離す。
      if (Math.abs(i - originIndex) < 3) continue;
      const station = rail.stations[line.stationIds[i]]; if (station) ids.add(station.id);
    }
  }
  return [...ids].map((id) => rail.stations[id]).filter((station): station is RailStation => !!station);
}

function workNearStation(world: AnyWorld, station: RailStation, agent: number): number {
  const s = world.store;
  for (let attempt = 0; attempt < 6; attempt++) {
    const angle = hash01(agent * 31 + attempt * 997) * Math.PI * 2;
    const radius = 60 + hash01(agent * 131 + attempt * 17) * 300;
    const x = station.x + Math.cos(angle) * radius;
    const z = station.z + Math.sin(angle) * radius;
    const candidate = world.city.poi.findBest(POICategory.Work, x, z, s.wealth[agent]);
    if (candidate < 0) continue;
    const work = world.city.poi.get(candidate);
    if (work.capacity <= 0) continue;
    if (Math.hypot(work.x - station.x, work.z - station.z) > 500) continue;
    return candidate;
  }
  return -1;
}

proto.populate = function populateWithRailCommuters(this: AnyWorld, count: number): void {
  originalPopulate.call(this, count);
  const rail = this.city.planning.rail as RailNetworkPlan;
  if (!rail?.stations.length) return;

  const s = this.store;
  for (let i = 0; i < s.count; i++) {
    if (s.ownsCar[i]) continue;
    const occupation = s.occupation[i] as Occupation;
    if (occupation === Occupation.Unemployed || occupation === Occupation.Retiree) continue;
    if (s.homePOI[i] < 0) continue;
    // 駅徒歩圏の非自動車就業者の約80%を都市内鉄道通勤候補にする。
    if (hash01(i * 7919 + 41) >= 0.80) continue;

    const home = this.city.poi.get(s.homePOI[i]);
    const origin = nearestStation(rail, home.x, home.z); if (!origin) continue;
    const candidates = destinationStations(rail, origin); if (!candidates.length) continue;

    const start = Math.floor(hash01(i * 1543 + 73) * candidates.length) % candidates.length;
    for (let n = 0; n < candidates.length; n++) {
      const destination = candidates[(start + n) % candidates.length];
      if (Math.hypot(destination.x - home.x, destination.z - home.z) < 1250) continue;
      const workId = workNearStation(this, destination, i + n * 100003); if (workId < 0) continue;
      const work = this.city.poi.get(workId);
      if (Math.hypot(work.x - home.x, work.z - home.z) < 1100) continue;
      s.workPOI[i] = workId;
      break;
    }
  }
};
