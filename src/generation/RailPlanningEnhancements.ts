import { RailNetworkPlan, RailStationKind, type RailPoint } from './RailPlanning';
import type { RoadNetwork } from '../traffic/RoadNetwork';

type AnyRailPlan = RailNetworkPlan & Record<string, any>;

const proto = RailNetworkPlan.prototype as unknown as Record<string, any>;

/**
 * 高架鉄道は道路中心線へ逐次追従させず、計画時の直線軸を優先する。
 * 道路Nodeは駅アクセス/バス接続用として保持し、線路そのものは駅同士を直接結ぶ。
 */
proto.alignToRoadNetwork = function straightRailAlignment(this: AnyRailPlan, net: RoadNetwork): void {
  if (this.stations.length === 0 || net.nodes.length === 0) return;

  for (const station of this.stations) {
    const node = this.nearestSurfaceNode(net, station.plannedX, station.plannedZ) as number;
    station.roadNode = node;
    if (node < 0) {
      station.x = station.plannedX;
      station.z = station.plannedZ;
      continue;
    }

    if (station.kind === RailStationKind.Terminal) {
      const land = this.terminalLandPoint(station, net, node) as RailPoint;
      station.x = land.x;
      station.z = land.z;
    } else {
      // 駅本体は計画線形上に置き、道路へのアクセスだけroadNodeで持つ。
      station.x = station.plannedX;
      station.z = station.plannedZ;
    }
  }

  // 複数路線を共有する駅は乗換拠点として扱う。
  for (const station of this.stations) {
    if (station.kind === RailStationKind.Central || station.kind === RailStationKind.Terminal) continue;
    if (station.lineIds.length >= 2) {
      station.kind = RailStationKind.SubCenter;
      if (!station.name.startsWith('副都心')) station.name = `乗換${station.id + 1}駅`;
      station.influenceRadius = Math.max(station.influenceRadius, this.options.railInfluenceRadius * 1.10);
    }
  }

  for (const line of this.lines) {
    const points: RailPoint[] = [];
    for (const stationId of line.stationIds) {
      const station = this.stations[stationId];
      if (!station) continue;
      const p = { x: station.x, z: station.z };
      const last = points[points.length - 1];
      if (!last || !this.samePoint(last, p)) points.push(p);
    }

    // 幹線は原則一直線。支線も駅間を直結し、細かな道路曲線は作らない。
    line.path = this.compressCollinear(points) as RailPoint[];
    this.rebuildMetrics(line);
  }
};
