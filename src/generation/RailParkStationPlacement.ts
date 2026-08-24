import { CityPlanning, DistrictType } from './CityPlanning';
import { RailNetworkPlan, RailStationKind } from './RailPlanning';
import type { RoadNetwork } from '../traffic/RoadNetwork';

type AnyRailPlan = Record<string, any>;
type DistrictAt = (x: number, z: number) => DistrictType;

declare module './RailPlanning' {
  interface RailStation {
    /** 公園に囲まれた駅は、道路中心への強制スナップを解除する。 */
    parkOffRoad?: boolean;
  }
}

const railProto = RailNetworkPlan.prototype as unknown as Record<string, any>;
const planningProto = CityPlanning.prototype as unknown as Record<string, any>;
const enhancedAlign = railProto.alignToRoadNetwork as (net: RoadNetwork) => void;
const originalTerminalLandPoint = railProto.terminalLandPoint as (
  station: Record<string, any>,
  net: RoadNetwork,
  roadNode: number,
) => { x: number; z: number };
const originalPlanningSample = planningProto.sample as (x: number, z: number) => Record<string, any>;

/**
 * RailNetworkPlan は CityPlanning そのものを保持しないため、CityPlanning.sample() が
 * 最初に呼ばれた時点で「地区だけを再評価する」軽量コールバックを Rail 側へ渡す。
 * originalPlanningSample を直接呼ぶことで wrapper の再帰は避ける。
 */
planningProto.sample = function sampleWithRailDistrictBridge(this: CityPlanning & Record<string, any>, x: number, z: number): Record<string, any> {
  const result = originalPlanningSample.call(this, x, z);
  const rail = this.rail as AnyRailPlan | undefined;
  if (rail && typeof rail.__districtAt !== 'function') {
    rail.__districtAt = (px: number, pz: number): DistrictType =>
      (originalPlanningSample.call(this, px, pz) as { district: DistrictType }).district;
  }
  return result;
};

function parkSurroundingScore(districtAt: DistrictAt, x: number, z: number): number {
  let park = 0;
  let total = 0;
  for (const radius of [72, 126]) {
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      const district = districtAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
      if (district === DistrictType.Park) park++;
      total++;
    }
  }
  return total > 0 ? park / total : 0;
}

/**
 * 公園の中央に近い駅だけ道路上固定を解除する。
 * 駅そのものは TOD 影響で Park 判定から外れやすいため、駅位置ではなく周囲2リングを評価する。
 */
function markParkStations(self: AnyRailPlan): void {
  const districtAt = self.__districtAt as DistrictAt | undefined;
  if (!districtAt) return;
  for (const station of self.stations) {
    // 終端駅は既に道路外配置。中央駅・乗換駅は既存の運行/駅構造を優先して固定を維持する。
    if (station.kind === RailStationKind.Terminal || station.kind === RailStationKind.Central || station.lineIds.length >= 2) {
      station.parkOffRoad = false;
      continue;
    }
    station.parkOffRoad = parkSurroundingScore(districtAt, station.plannedX, station.plannedZ) >= 0.375;
  }
}

/**
 * 既存 RailPlanningEnhancements の終端駅S字アプローチを再利用するため、
 * align 中だけ parkOffRoad 駅を「仮の終端駅」として扱う。
 * terminalLandPoint は計画位置を返すよう差し替え、align 完了後に元の駅種別へ戻す。
 * これにより道路Nodeは保持したまま、駅本体と線路だけを公園内へ置ける。
 */
railProto.alignToRoadNetwork = function parkAwareRailAlignment(this: AnyRailPlan, net: RoadNetwork): void {
  markParkStations(this);
  const redirected = this.stations.filter((station: Record<string, any>) => station.parkOffRoad && station.kind !== RailStationKind.Terminal);
  if (!redirected.length) {
    enhancedAlign.call(this, net);
    return;
  }

  const originalKinds = new Map<number, RailStationKind>();
  for (const station of redirected) {
    originalKinds.set(station.id, station.kind);
    station.kind = RailStationKind.Terminal;
  }

  const previousTerminalLandPoint = this.terminalLandPoint;
  this.terminalLandPoint = function parkStationLandPoint(station: Record<string, any>, network: RoadNetwork, roadNode: number): { x: number; z: number } {
    if (originalKinds.has(station.id)) return { x: station.plannedX, z: station.plannedZ };
    return originalTerminalLandPoint.call(this, station, network, roadNode);
  };

  try {
    enhancedAlign.call(this, net);
  } finally {
    this.terminalLandPoint = previousTerminalLandPoint;
    for (const station of redirected) {
      const kind = originalKinds.get(station.id);
      if (kind != null) station.kind = kind;
    }
  }
};
