import { clamp, makeRng } from '../core/math';
import { AStar } from '../traffic/AStar';
import { RoadClass, RoadNetwork } from '../traffic/RoadNetwork';

export interface RailPlanningOptions {
  railEnabled: boolean;
  railTrunkLines: number;
  railStationSpacing: number;
  railInfluenceRadius: number;
  railSubCenterSpurs: boolean;
}

export const DEFAULT_RAIL_PLANNING: RailPlanningOptions = {
  railEnabled: true,
  railTrunkLines: 2,
  railStationSpacing: 525,
  railInfluenceRadius: 900,
  railSubCenterSpurs: true,
};

export enum RailStationKind {
  Central = 0,
  SubCenter = 1,
  Local = 2,
  Terminal = 3,
}

export const RAIL_STATION_KIND_LABEL: Record<RailStationKind, string> = {
  [RailStationKind.Central]: '中央駅',
  [RailStationKind.SubCenter]: '副都心駅',
  [RailStationKind.Local]: '一般駅',
  [RailStationKind.Terminal]: '終端駅',
};

export interface RailPoint { x: number; z: number; }

export interface RailStation {
  id: number;
  name: string;
  /** TOD計算に使う計画上の駅位置。道路スナップ後も変えない。 */
  plannedX: number;
  plannedZ: number;
  /** 実際の高架駅位置。終端駅は道路接続点から土地側へ引き込む。 */
  x: number;
  z: number;
  kind: RailStationKind;
  lineIds: number[];
  /** 鉄道が道路網へ接続するNode。終端駅では駅本体ではなくアプローチ線の接続点。 */
  roadNode: number;
  busStopId: number;
}

export interface RailLine {
  id: number;
  name: string;
  kind: 'trunk' | 'spur';
  stationIds: number[];
  /** 描画・列車走行用。道路スナップ後は道路A*＋終端専用アプローチ線。 */
  path: RailPoint[];
  cumulative: number[];
  length: number;
}

export interface RailInfluenceSample {
  stationId: number;
  distance: number;
  influence: number;
}

interface RailCenter { x: number; z: number; strength: number; }
interface RailContext { cbd: RailCenter; subCenters: RailCenter[]; }

/**
 * City Generator v2 Phase 4用の鉄道計画。
 * 生成時はCBDを貫く幹線＋副都心支線を作り、都市道路完成後に幹線道路へA*スナップする。
 * 終端駅だけは道路上を避け、道路接続点から土地側へ短い専用線で引き込む。
 */
export class RailNetworkPlan {
  readonly options: RailPlanningOptions;
  readonly stations: RailStation[] = [];
  readonly lines: RailLine[] = [];

  constructor(
    readonly sizeMeters: number,
    seed: number,
    context: RailContext,
    options?: Partial<RailPlanningOptions>,
  ) {
    this.options = { ...DEFAULT_RAIL_PLANNING, ...options };
    if (this.options.railEnabled) this.build(seed, context);
  }

  influenceAt(x: number, z: number): RailInfluenceSample {
    let stationId = -1, distance = Infinity, influence = 0;
    for (const s of this.stations) {
      const d = Math.hypot(x - s.plannedX, z - s.plannedZ);
      if (d >= s.influenceRadius) continue;
      const u = clamp(1 - d / Math.max(1, s.influenceRadius), 0, 1);
      const kindStrength = s.kind === RailStationKind.Central ? 1
        : s.kind === RailStationKind.SubCenter ? 0.92
          : s.kind === RailStationKind.Local ? 0.72 : 0.60;
      const score = u * u * (3 - 2 * u) * kindStrength;
      if (score > influence) { stationId = s.id; distance = d; influence = score; }
    }
    return { stationId, distance, influence };
  }

  /**
   * 線路を道路中心線へ寄せる。高架描画前提なので道路交通とは別レイヤーのまま。
   * 通過駅は道路Nodeへスナップするが、終端駅は道路接続点を保持したまま土地側へ退避させる。
   */
  alignToRoadNetwork(net: RoadNetwork): void {
    if (this.stations.length === 0 || net.nodes.length === 0) return;
    for (const station of this.stations) {
      const node = this.nearestSurfaceNode(net, station.plannedX, station.plannedZ);
      station.roadNode = node;
      if (node < 0) continue;
      if (station.kind === RailStationKind.Terminal) {
        const land = this.terminalLandPoint(station, net, node);
        station.x = land.x;
        station.z = land.z;
      } else {
        station.x = net.nodes[node].x;
        station.z = net.nodes[node].z;
      }
    }

    const astar = new AStar(net, 'drive');
    for (const line of this.lines) {
      const points: RailPoint[] = [];
      for (let i = 0; i < line.stationIds.length - 1; i++) {
        const a = this.stations[line.stationIds[i]], b = this.stations[line.stationIds[i + 1]];
        let segment: RailPoint[] = [];
        if (a.roadNode >= 0 && b.roadNode >= 0) {
          const nodes = astar.findPath(a.roadNode, b.roadNode);
          if (nodes.length >= 2) segment = nodes.map((id) => ({ x: net.nodes[id].x, z: net.nodes[id].z }));
        }
        if (segment.length < 2) {
          const ax = a.roadNode >= 0 ? net.nodes[a.roadNode].x : a.x;
          const az = a.roadNode >= 0 ? net.nodes[a.roadNode].z : a.z;
          const bx = b.roadNode >= 0 ? net.nodes[b.roadNode].x : b.x;
          const bz = b.roadNode >= 0 ? net.nodes[b.roadNode].z : b.z;
          segment = [{ x: ax, z: az }, { x: bx, z: bz }];
        }
        if (a.kind === RailStationKind.Terminal && !this.samePoint(segment[0], a)) {
          segment.unshift({ x: a.x, z: a.z });
        }
        if (b.kind === RailStationKind.Terminal && !this.samePoint(segment[segment.length - 1], b)) {
          segment.push({ x: b.x, z: b.z });
        }
        if (points.length && segment.length && this.samePoint(points[points.length - 1], segment[0])) segment.shift();
        points.push(...segment);
      }
      line.path = this.compressCollinear(points);
      this.rebuildMetrics(line);
    }
  }

  majorStations(): RailStation[] {
    return this.stations.filter((s) => s.kind === RailStationKind.Central || s.kind === RailStationKind.SubCenter);
  }

  private build(seed: number, context: RailContext): void {
    const rng = makeRng(seed ^ 0x74a19d3b);
    const trunks = Math.max(1, Math.min(3, Math.round(this.options.railTrunkLines)));
    const baseAngle = context.subCenters.length
      ? Math.atan2(context.subCenters[0].z - context.cbd.z, context.subCenters[0].x - context.cbd.x)
      : rng() * Math.PI;

    for (let i = 0; i < trunks; i++) {
      const angle = baseAngle + i * (Math.PI / trunks);
      this.buildTrunk(context.cbd.x, context.cbd.z, angle, i);
    }

    if (this.options.railSubCenterSpurs) {
      for (let i = 0; i < context.subCenters.length; i++) this.buildSubCenterSpur(context.subCenters[i], i);
    } else {
      for (let i = 0; i < context.subCenters.length; i++) this.promoteNearestStation(context.subCenters[i], i);
    }

    for (const s of this.stations) {
      if (s.kind === RailStationKind.Local) s.name = `第${s.id + 1}駅`;
      else if (s.kind === RailStationKind.Terminal && !s.name.startsWith('終端')) s.name = `終端${s.id + 1}駅`;
    }
  }

  private buildTrunk(cx: number, cz: number, angle: number, index: number): void {
    const dx = Math.cos(angle), dz = Math.sin(angle), margin = Math.min(220, this.sizeMeters * 0.025);
    const pos = this.rayExtent(cx, cz, dx, dz, margin), neg = this.rayExtent(cx, cz, -dx, -dz, margin);
    const spacing = Math.max(260, this.options.railStationSpacing);
    const ts: number[] = [0];
    for (let t = spacing; t < pos - spacing * 0.30; t += spacing) ts.push(t);
    for (let t = spacing; t < neg - spacing * 0.30; t += spacing) ts.push(-t);
    if (pos > spacing * 0.55) ts.push(pos * 0.965);
    if (neg > spacing * 0.55) ts.push(-neg * 0.965);
    ts.sort((a, b) => a - b);

    const stationIds: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i], endpoint = i === 0 || i === ts.length - 1;
      const kind = Math.abs(t) < 1 ? RailStationKind.Central : endpoint ? RailStationKind.Terminal : RailStationKind.Local;
      const name = kind === RailStationKind.Central ? '中央駅' : kind === RailStationKind.Terminal ? `終端${this.stations.length + 1}駅` : '';
      const id = this.ensureStation(cx + dx * t, cz + dz * t, kind, name);
      if (stationIds[stationIds.length - 1] !== id) stationIds.push(id);
    }
    if (stationIds.length >= 2) this.addLine(`都市幹線${index + 1}`, 'trunk', stationIds);
  }

  private buildSubCenterSpur(center: RailCenter, subIndex: number): void {
    if (this.stations.length === 0) return;
    let nearest = this.stations[0], best = Infinity;
    for (const s of this.stations) {
      const d = Math.hypot(s.plannedX - center.x, s.plannedZ - center.z);
      if (d < best) { best = d; nearest = s; }
    }
    if (best < Math.max(180, this.options.railStationSpacing * 0.34)) {
      if (nearest.kind !== RailStationKind.Central) nearest.kind = RailStationKind.SubCenter;
      if (nearest.kind === RailStationKind.SubCenter) nearest.name = `副都心${subIndex + 1}駅`;
      nearest.influenceRadius = Math.max(nearest.influenceRadius, this.options.railInfluenceRadius * 1.15);
      return;
    }

    const dx = center.x - nearest.plannedX, dz = center.z - nearest.plannedZ, length = Math.hypot(dx, dz);
    const stationIds = [nearest.id];
    const spacing = Math.max(280, this.options.railStationSpacing * 0.90);
    const intermediate = Math.max(0, Math.floor(length / spacing) - 1);
    for (let i = 1; i <= intermediate; i++) {
      const t = i / (intermediate + 1);
      stationIds.push(this.ensureStation(nearest.plannedX + dx * t, nearest.plannedZ + dz * t, RailStationKind.Local, ''));
    }
    stationIds.push(this.ensureStation(center.x, center.z, RailStationKind.SubCenter, `副都心${subIndex + 1}駅`));
    this.addLine(`副都心支線${subIndex + 1}`, 'spur', stationIds);
  }

  private promoteNearestStation(center: RailCenter, subIndex: number): void {
    let bestId = -1, best = Infinity;
    for (const s of this.stations) {
      const d = Math.hypot(s.plannedX - center.x, s.plannedZ - center.z);
      if (d < best) { best = d; bestId = s.id; }
    }
    if (bestId < 0) return;
    const s = this.stations[bestId];
    if (s.kind !== RailStationKind.Central) { s.kind = RailStationKind.SubCenter; s.name = `副都心${subIndex + 1}駅`; }
    s.influenceRadius = Math.max(s.influenceRadius, this.options.railInfluenceRadius * 1.15);
  }

  private ensureStation(x: number, z: number, kind: RailStationKind, name: string): number {
    for (const s of this.stations) {
      if (Math.hypot(s.plannedX - x, s.plannedZ - z) > 120) continue;
      if (this.kindRank(kind) > this.kindRank(s.kind) && s.kind !== RailStationKind.Central) s.kind = kind;
      if (name && s.kind !== RailStationKind.Central) s.name = name;
      s.influenceRadius = Math.max(s.influenceRadius, this.radiusForKind(s.kind));
      return s.id;
    }
    const id = this.stations.length;
    this.stations.push({
      id, name: name || `第${id + 1}駅`, plannedX: x, plannedZ: z, x, z, kind,
      lineIds: [], influenceRadius: this.radiusForKind(kind), roadNode: -1, busStopId: -1,
    });
    return id;
  }

  private addLine(name: string, kind: 'trunk' | 'spur', stationIds: number[]): void {
    const clean = stationIds.filter((id, i) => i === 0 || id !== stationIds[i - 1]);
    if (clean.length < 2) return;
    const id = this.lines.length;
    const line: RailLine = {
      id, name, kind, stationIds: clean,
      path: clean.map((sid) => ({ x: this.stations[sid].x, z: this.stations[sid].z })), cumulative: [], length: 0,
    };
    this.rebuildMetrics(line); this.lines.push(line);
    for (const sid of clean) if (!this.stations[sid].lineIds.includes(id)) this.stations[sid].lineIds.push(id);
  }

  private rebuildMetrics(line: RailLine): void {
    line.cumulative = new Array(line.path.length).fill(0); let total = 0;
    for (let i = 1; i < line.path.length; i++) {
      total += Math.hypot(line.path[i].x - line.path[i - 1].x, line.path[i].z - line.path[i - 1].z);
      line.cumulative[i] = total;
    }
    line.length = total;
  }

  private terminalLandPoint(station: RailStation, net: RoadNetwork, roadNode: number): RailPoint {
    const base = net.nodes[roadNode];
    let tx = 1, tz = 0;
    for (const lineId of station.lineIds) {
      const line = this.lines[lineId]; if (!line) continue;
      const index = line.stationIds.indexOf(station.id); if (index < 0) continue;
      const neighborIndex = index === 0 ? 1 : index === line.stationIds.length - 1 ? index - 1 : -1;
      if (neighborIndex < 0) continue;
      const neighbor = this.stations[line.stationIds[neighborIndex]]; if (!neighbor) continue;
      const dx = station.plannedX - neighbor.plannedX, dz = station.plannedZ - neighbor.plannedZ, len = Math.hypot(dx, dz);
      if (len > 1) { tx = dx / len; tz = dz / len; break; }
    }
    const nx = -tz, nz = tx;
    const side = ((station.id + station.lineIds[0]) & 1) === 0 ? 1 : -1;
    const candidate = (sign: number): RailPoint => ({
      x: clamp(base.x + tx * 18 + nx * 64 * sign, 24, this.sizeMeters - 24),
      z: clamp(base.z + tz * 18 + nz * 64 * sign, 24, this.sizeMeters - 24),
    });
    const a = candidate(side), b = candidate(-side);
    return this.roadClearanceScore(a, net, roadNode) >= this.roadClearanceScore(b, net, roadNode) ? a : b;
  }

  private roadClearanceScore(point: RailPoint, net: RoadNetwork, ignoredNode: number): number {
    let best = Infinity;
    for (const node of net.nodes) {
      if (node.id === ignoredNode) continue;
      const d2 = (node.x - point.x) ** 2 + (node.z - point.z) ** 2;
      if (d2 < best) best = d2;
    }
    const edge = Math.min(point.x, point.z, this.sizeMeters - point.x, this.sizeMeters - point.z);
    return Math.sqrt(best) + Math.min(50, edge) * 0.25;
  }

  private nearestSurfaceNode(net: RoadNetwork, x: number, z: number): number {
    let best = -1, bestD = Infinity;
    for (const n of net.nodes) {
      let surface = false, major = false;
      for (const eid of n.edges) {
        const rc = net.edges[eid].roadClass;
        if (rc === RoadClass.Highway || rc === RoadClass.Path) continue;
        surface = true; if (rc === RoadClass.Arterial || rc === RoadClass.Collector) major = true;
      }
      if (!surface) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2 - (major ? 1600 : 0);
      if (d < bestD) { bestD = d; best = n.id; }
    }
    return best;
  }

  private compressCollinear(points: RailPoint[]): RailPoint[] {
    if (points.length <= 2) return points.slice();
    const out: RailPoint[] = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const a = out[out.length - 1], b = points[i], c = points[i + 1];
      const x1 = b.x - a.x, z1 = b.z - a.z, x2 = c.x - b.x, z2 = c.z - b.z;
      const cross = Math.abs(x1 * z2 - z1 * x2), scale = Math.max(1, Math.hypot(x1, z1) * Math.hypot(x2, z2));
      if (cross / scale > 0.015) out.push(b);
    }
    out.push(points[points.length - 1]); return out;
  }

  private rayExtent(cx: number, cz: number, dx: number, dz: number, margin: number): number {
    const min = margin, max = this.sizeMeters - margin; const candidates: number[] = [];
    if (dx > 1e-6) candidates.push((max - cx) / dx);
    else if (dx < -1e-6) candidates.push((min - cx) / dx);
    if (dz > 1e-6) candidates.push((max - cz) / dz);
    else if (dz < -1e-6) candidates.push((min - cz) / dz);
    return Math.max(0, Math.min(...candidates.filter((t) => t >= 0)));
  }

  private radiusForKind(kind: RailStationKind): number {
    const r = Math.max(300, this.options.railInfluenceRadius);
    if (kind === RailStationKind.Central) return r * 1.35;
    if (kind === RailStationKind.SubCenter) return r * 1.15;
    if (kind === RailStationKind.Terminal) return r * 0.78;
    return r * 0.88;
  }

  private kindRank(kind: RailStationKind): number {
    if (kind === RailStationKind.Central) return 4;
    if (kind === RailStationKind.SubCenter) return 3;
    if (kind === RailStationKind.Terminal) return 2;
    return 1;
  }

  private samePoint(a: RailPoint, b: RailPoint): boolean { return Math.abs(a.x - b.x) < 0.1 && Math.abs(a.z - b.z) < 0.1; }
}
