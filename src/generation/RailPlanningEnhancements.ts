import { AStar } from '../traffic/AStar';
import type { RoadNetwork } from '../traffic/RoadNetwork';
import { DEFAULT_RAIL_PLANNING, RailNetworkPlan, RailStationKind, type RailPoint } from './RailPlanning';

declare module './RailPlanning' {
  interface RailStation {
    influenceRadius: number;
  }
}

// 直線主体の複数路線で都市をカバーするため、標準幹線は3路線。
DEFAULT_RAIL_PLANNING.railTrunkLines = Math.max(3, DEFAULT_RAIL_PLANNING.railTrunkLines);
// 駅間を従来の1.5倍に広げ、幹線・支線の既存比率はそのまま維持する。
DEFAULT_RAIL_PLANNING.railStationSpacing *= 1.5;

type AnyRailPlan = RailNetworkPlan & Record<string, any>;

interface RailStationOpenSpace {
  x: number;
  z: number;
  width: number;
  depth: number;
}

let stationOpenSpaces: readonly RailStationOpenSpace[] = [];

/** Provide already-generated parks/open spaces before rail alignment is finalized. */
export function setRailStationOpenSpaces(spaces: readonly RailStationOpenSpace[]): void {
  stationOpenSpaces = spaces;
}

const proto = RailNetworkPlan.prototype as unknown as Record<string, any>;

function insideStationOpenSpace(x: number, z: number): boolean {
  for (const space of stationOpenSpaces) {
    const margin = Math.max(14, Math.min(24, Math.min(space.width, space.depth) * 0.12));
    if (Math.abs(x - space.x) <= space.width * 0.5 + margin && Math.abs(z - space.z) <= space.depth * 0.5 + margin) return true;
  }
  return false;
}

/**
 * Keep the railway itself on the road A* corridor. Station metadata may remain at a planned
 * off-road/open-space position, but it must never pull the running line away from the road.
 * Platform architecture is allowed to stay straight independently in RailStationArchitecture.
 */
proto.alignToRoadNetwork = function corridorRailAlignment(this: AnyRailPlan, net: RoadNetwork): void {
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
    } else if (insideStationOpenSpace(station.plannedX, station.plannedZ)) {
      // Keep the station's planned civic/open-space location as metadata and access context.
      // The actual running line below is still constructed exclusively from road nodes.
      station.x = station.plannedX;
      station.z = station.plannedZ;
    } else {
      station.x = net.nodes[node].x;
      station.z = net.nodes[node].z;
    }
  }

  for (const station of this.stations) {
    if (station.kind === RailStationKind.Central || station.kind === RailStationKind.Terminal) continue;
    if (station.lineIds.length >= 2) {
      station.kind = RailStationKind.SubCenter;
      if (!station.name.startsWith('副都心')) station.name = `乗換${station.id + 1}駅`;
      station.influenceRadius = Math.max(station.influenceRadius, this.options.railInfluenceRadius * 1.10);
    }
  }

  const astar = new AStar(net, 'drive');
  for (const line of this.lines) {
    const points: RailPoint[] = [];

    for (let i = 0; i < line.stationIds.length - 1; i++) {
      const a = this.stations[line.stationIds[i]], b = this.stations[line.stationIds[i + 1]];
      if (!a || !b) continue;

      let segment: RailPoint[] = [];
      if (a.roadNode >= 0 && b.roadNode >= 0) {
        const nodes = astar.findPath(a.roadNode, b.roadNode);
        if (nodes.length >= 2) segment = nodes.map((id) => ({ x: net.nodes[id].x, z: net.nodes[id].z }));
      }

      // When A* cannot produce a route, still prefer the two road connection nodes. Only a station
      // without any road node at all falls back to its own coordinate.
      if (segment.length < 2) {
        const ax = a.roadNode >= 0 ? net.nodes[a.roadNode].x : a.x;
        const az = a.roadNode >= 0 ? net.nodes[a.roadNode].z : a.z;
        const bx = b.roadNode >= 0 ? net.nodes[b.roadNode].x : b.x;
        const bz = b.roadNode >= 0 ? net.nodes[b.roadNode].z : b.z;
        segment = [{ x: ax, z: az }, { x: bx, z: bz }];
      }

      if (points.length && segment.length && this.samePoint(points[points.length - 1], segment[0])) segment = segment.slice(1);
      points.push(...segment);
    }

    // Only remove exactly/near-collinear road nodes. Do not chord across the road corridor and do not
    // insert station points into the running line.
    line.path = this.compressCollinear(points) as RailPoint[];
    this.rebuildMetrics(line);
  }
};