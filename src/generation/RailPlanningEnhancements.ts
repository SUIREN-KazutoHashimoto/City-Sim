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

type AnyRailPlan = RailNetworkPlan & Record<string, any>;

const proto = RailNetworkPlan.prototype as unknown as Record<string, any>;

interface PolylineCut {
  point: RailPoint;
  segmentIndex: number;
  tangentX: number;
  tangentZ: number;
}

function pointSegmentDistance(p: RailPoint, a: RailPoint, b: RailPoint): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 0.01) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  const qx = a.x + dx * t, qz = a.z + dz * t;
  return Math.hypot(p.x - qx, p.z - qz);
}

/**
 * 道路A*の経路を「道路回廊」とみなし、その回廊を外れない範囲で折れ点を大胆に間引く。
 * 駅間単位で処理するので、道路から大きく離れずに細かなジグザグだけを消せる。
 */
function simplifyRoadCorridor(raw: RailPoint[], tolerance: number): RailPoint[] {
  if (raw.length <= 2) return raw.slice();
  const out: RailPoint[] = [raw[0]];
  let anchor = 0;

  while (anchor < raw.length - 1) {
    let best = anchor + 1;
    for (let candidate = raw.length - 1; candidate > anchor + 1; candidate--) {
      const a = raw[anchor], b = raw[candidate];
      let ok = true;
      for (let k = anchor + 1; k < candidate; k++) {
        if (pointSegmentDistance(raw[k], a, b) > tolerance) { ok = false; break; }
      }
      if (ok) { best = candidate; break; }
    }
    out.push(raw[best]);
    anchor = best;
  }
  return out;
}

function polylineLength(points: RailPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return total;
}

function cutFromStart(points: RailPoint[], requestedDistance: number): PolylineCut | null {
  if (points.length < 2) return null;
  let remaining = Math.max(0, requestedDistance);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    if (remaining <= length || i === points.length - 1) {
      const t = Math.max(0, Math.min(1, remaining / length));
      return {
        point: { x: a.x + dx * t, z: a.z + dz * t },
        segmentIndex: i,
        tangentX: dx / length,
        tangentZ: dz / length,
      };
    }
    remaining -= length;
  }
  return null;
}

function cubicBezier(a: RailPoint, b: RailPoint, c: RailPoint, d: RailPoint, t: number): RailPoint {
  const u = 1 - t, uu = u * u, tt = t * t;
  return {
    x: uu * u * a.x + 3 * uu * t * b.x + 3 * u * tt * c.x + tt * t * d.x,
    z: uu * u * a.z + 3 * uu * t * b.z + 3 * u * tt * c.z + tt * t * d.z,
  };
}

/**
 * 終端駅を道路脇の土地へ逃がす区間を、道路接続点で急折させず長いS字曲線へする。
 * 終端側と道路回廊側の接線をほぼ平行にし、横移動を200m超へ分散する。
 */
function smoothTerminalStart(raw: RailPoint[], terminal: RailPoint, desiredLength: number): RailPoint[] {
  if (raw.length < 2) return [terminal, ...raw];
  const total = polylineLength(raw);
  const approach = Math.min(desiredLength, Math.max(90, total * 0.55));
  const cut = cutFromStart(raw, approach);
  if (!cut) return [terminal, ...raw];

  const chord = Math.hypot(cut.point.x - terminal.x, cut.point.z - terminal.z);
  const handle = Math.min(100, Math.max(42, chord * 0.38));
  const p0 = terminal;
  const p1 = { x: p0.x + cut.tangentX * handle, z: p0.z + cut.tangentZ * handle };
  const p3 = cut.point;
  const p2 = { x: p3.x - cut.tangentX * handle, z: p3.z - cut.tangentZ * handle };

  const out: RailPoint[] = [p0];
  const steps = Math.max(10, Math.ceil(chord / 18));
  for (let i = 1; i <= steps; i++) out.push(cubicBezier(p0, p1, p2, p3, i / steps));
  for (let i = cut.segmentIndex; i < raw.length; i++) {
    const p = raw[i];
    const last = out[out.length - 1];
    if (Math.hypot(last.x - p.x, last.z - p.z) > 0.5) out.push(p);
  }
  return out;
}

function applyTerminalApproaches(
  raw: RailPoint[],
  startTerminal: RailPoint | null,
  endTerminal: RailPoint | null,
  desiredLength: number,
): RailPoint[] {
  let out = raw.slice();
  if (startTerminal) out = smoothTerminalStart(out, startTerminal, desiredLength);
  if (endTerminal) {
    const reversed = out.slice().reverse();
    out = smoothTerminalStart(reversed, endTerminal, desiredLength).reverse();
  }
  return out;
}

/**
 * 駅は道路沿いに置き、線路も道路A*の大まかな回廊へ沿わせる。
 * ただし道路Nodeを1個ずつ忠実に追従せず、細かな折れを長い直線へまとめる。
 * 大きな方向転換だけを残し、RailRenderer側で必要な曲線へ丸める。
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
    } else {
      // 通過駅は道路沿いへ戻す。線路の簡略化は駅間経路側で行う。
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
    const tolerance = line.kind === 'trunk' ? 38 : 28;
    const terminalApproach = line.kind === 'trunk' ? 240 : 190;

    for (let i = 0; i < line.stationIds.length - 1; i++) {
      const a = this.stations[line.stationIds[i]], b = this.stations[line.stationIds[i + 1]];
      if (!a || !b) continue;

      let raw: RailPoint[] = [];
      if (a.roadNode >= 0 && b.roadNode >= 0) {
        const nodes = astar.findPath(a.roadNode, b.roadNode);
        if (nodes.length >= 2) raw = nodes.map((id) => ({ x: net.nodes[id].x, z: net.nodes[id].z }));
      }

      if (raw.length < 2) {
        const ax = a.roadNode >= 0 ? net.nodes[a.roadNode].x : a.x;
        const az = a.roadNode >= 0 ? net.nodes[a.roadNode].z : a.z;
        const bx = b.roadNode >= 0 ? net.nodes[b.roadNode].x : b.x;
        const bz = b.roadNode >= 0 ? net.nodes[b.roadNode].z : b.z;
        raw = [{ x: ax, z: az }, { x: bx, z: bz }];
      }

      let segment = simplifyRoadCorridor(raw, tolerance);
      segment = applyTerminalApproaches(
        segment,
        a.kind === RailStationKind.Terminal ? { x: a.x, z: a.z } : null,
        b.kind === RailStationKind.Terminal ? { x: b.x, z: b.z } : null,
        terminalApproach,
      );

      if (points.length && segment.length && this.samePoint(points[points.length - 1], segment[0])) segment = segment.slice(1);
      points.push(...segment);
    }

    // 最後にほぼ一直線の折れだけもう一段削る。終端S字の曲線点は角度があるので維持される。
    line.path = this.compressCollinear(points) as RailPoint[];
    this.rebuildMetrics(line);
  }
};
