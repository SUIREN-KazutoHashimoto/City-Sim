import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { roadWidth, type RoadNetwork } from '../traffic/RoadNetwork';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };

type RoadSegment = {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ux: number;
  uz: number;
  length: number;
  halfWidth: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

type RoadNodeZone = { x: number; z: number; radius: number };
type RoadGeometry = { segments: RoadSegment[]; nodes: RoadNodeZone[] };
type Point2 = { x: number; z: number };
type Axis2 = { x: number; z: number };

const TRACK_SUPPORT_COLOR = 0x8a8f92;
const STATION_COLUMN_COLOR = 0x777d82;
const SUPPORT_MARGIN = 1.8;
const TRACK_SUPPORT_SPACING = 72;
const STATION_FRAME_SPACING = 24;
const SUPPORT_SEARCH_STEP = 2.0;
const SUPPORT_SEARCH_MAX = 58;
const INTERSECTION_EXTRA = 4.8;

const roadCache = new WeakMap<RoadNetwork, RoadGeometry>();
const proto = RailRenderer.prototype as unknown as AnyRail;
const originalBuildTrackGeometry = proto.buildTrackGeometry as () => void;
const originalBuildStations = proto.buildStations as () => void;

function materialColor(material: THREE.Material): number | null {
  const color = (material as THREE.Material & { color?: THREE.Color }).color;
  return color ? color.getHex() : null;
}

function withoutStaticColor(self: AnyRail, blockedColor: number, build: () => void): void {
  const hadOwn = Object.prototype.hasOwnProperty.call(self, 'addStatic');
  const previous = self.addStatic as (...args: any[]) => any;
  self.addStatic = function filteredAddStatic(
    this: AnyRail,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parts: StaticPart[],
  ): any {
    if (materialColor(material) === blockedColor) return null;
    return previous.call(this, geometry, material, parts);
  };
  try {
    build();
  } finally {
    if (hadOwn) self.addStatic = previous;
    else delete self.addStatic;
  }
}

function roadGeometry(roads: RoadNetwork): RoadGeometry {
  const cached = roadCache.get(roads);
  if (cached) return cached;

  const segments: RoadSegment[] = [];
  const seen = new Set<string>();
  for (const edge of roads.edges) {
    const low = Math.min(edge.from, edge.to);
    const high = Math.max(edge.from, edge.to);
    const key = `${low}:${high}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const a = roads.nodes[edge.from], b = roads.nodes[edge.to];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.1) continue;
    const halfWidth = roadWidth(Math.max(1, edge.lanes)) * 0.5;
    segments.push({
      ax: a.x,
      az: a.z,
      bx: b.x,
      bz: b.z,
      ux: dx / length,
      uz: dz / length,
      length,
      halfWidth,
      minX: Math.min(a.x, b.x) - halfWidth,
      maxX: Math.max(a.x, b.x) + halfWidth,
      minZ: Math.min(a.z, b.z) - halfWidth,
      maxZ: Math.max(a.z, b.z) + halfWidth,
    });
  }

  const nodes: RoadNodeZone[] = roads.nodes.map((node) => {
    let maxHalf = 3.5;
    for (const edgeId of node.edges) {
      const edge = roads.edges[edgeId];
      if (!edge) continue;
      maxHalf = Math.max(maxHalf, roadWidth(Math.max(1, edge.lanes)) * 0.5);
    }
    return { x: node.x, z: node.z, radius: maxHalf + INTERSECTION_EXTRA };
  });

  const geometry = { segments, nodes };
  roadCache.set(roads, geometry);
  return geometry;
}

function distanceToSegmentSquared(x: number, z: number, segment: RoadSegment): number {
  const dx = x - segment.ax, dz = z - segment.az;
  const along = THREE.MathUtils.clamp(dx * segment.ux + dz * segment.uz, 0, segment.length);
  const qx = segment.ax + segment.ux * along;
  const qz = segment.az + segment.uz * along;
  return (x - qx) ** 2 + (z - qz) ** 2;
}

function roadOccupied(roads: RoadNetwork | undefined, x: number, z: number, margin = SUPPORT_MARGIN): boolean {
  if (!roads) return false;
  const geometry = roadGeometry(roads);

  for (const segment of geometry.segments) {
    const reach = segment.halfWidth + margin;
    if (x < segment.minX - margin || x > segment.maxX + margin || z < segment.minZ - margin || z > segment.maxZ + margin) continue;
    if (distanceToSegmentSquared(x, z, segment) <= reach * reach) return true;
  }

  for (const node of geometry.nodes) {
    const reach = node.radius + margin;
    if (Math.abs(x - node.x) > reach || Math.abs(z - node.z) > reach) continue;
    if ((x - node.x) ** 2 + (z - node.z) ** 2 <= reach * reach) return true;
  }
  return false;
}

function occupyingRoadSegments(roads: RoadNetwork | undefined, x: number, z: number): RoadSegment[] {
  if (!roads) return [];
  const out: RoadSegment[] = [];
  for (const segment of roadGeometry(roads).segments) {
    const reach = segment.halfWidth + SUPPORT_MARGIN + 1.0;
    if (x < segment.minX - SUPPORT_MARGIN - 1 || x > segment.maxX + SUPPORT_MARGIN + 1
      || z < segment.minZ - SUPPORT_MARGIN - 1 || z > segment.maxZ + SUPPORT_MARGIN + 1) continue;
    if (distanceToSegmentSquared(x, z, segment) <= reach * reach) out.push(segment);
  }
  return out;
}

function normalizedAxis(x: number, z: number): Axis2 | null {
  const length = Math.hypot(x, z);
  if (length < 0.01) return null;
  return { x: x / length, z: z / length };
}

function addAxis(axes: Axis2[], axis: Axis2 | null): void {
  if (!axis) return;
  for (const existing of axes) {
    if (Math.abs(existing.x * axis.x + existing.z * axis.z) > 0.985) return;
  }
  axes.push(axis);
}

function supportAxes(roads: RoadNetwork | undefined, x: number, z: number, heading: number): Axis2[] {
  const axes: Axis2[] = [];
  // 線路に直交する門型を第一候補にする。
  addAxis(axes, normalizedAxis(-Math.sin(heading), Math.cos(heading)));
  // 道路を直交横断している場合は線路方向へ逃がす必要がある。
  addAxis(axes, normalizedAxis(Math.cos(heading), Math.sin(heading)));
  for (const segment of occupyingRoadSegments(roads, x, z)) {
    addAxis(axes, normalizedAxis(-segment.uz, segment.ux));
  }
  return axes;
}

function findSafePair(
  roads: RoadNetwork | undefined,
  anchor: Point2,
  heading: number,
  minimumOffset: number,
): { left: Point2; right: Point2 } | null {
  let best: { left: Point2; right: Point2; offset: number } | null = null;
  for (const axis of supportAxes(roads, anchor.x, anchor.z, heading)) {
    for (let offset = Math.max(3.5, minimumOffset); offset <= SUPPORT_SEARCH_MAX; offset += SUPPORT_SEARCH_STEP) {
      const left = { x: anchor.x - axis.x * offset, z: anchor.z - axis.z * offset };
      const right = { x: anchor.x + axis.x * offset, z: anchor.z + axis.z * offset };
      if (roadOccupied(roads, left.x, left.z, 1.15) || roadOccupied(roads, right.x, right.z, 1.15)) continue;
      if (!best || offset < best.offset) best = { left, right, offset };
      break;
    }
  }
  return best ? { left: best.left, right: best.right } : null;
}

function pushColumn(self: AnyRail, x: number, z: number, y: number, columns: StaticPart[]): void {
  const roads = self.roads as RoadNetwork | undefined;
  // 最終防衛線。ここで道路上なら柱自体を出さない。
  if (roadOccupied(roads, x, z, 1.1)) return;
  columns.push({ matrix: self.matrix(x, y * 0.5, z, 0.72, y, 0.72) });
}

function pushBeam(
  self: AnyRail,
  a: Point2,
  b: Point2,
  y: number,
  beams: StaticPart[],
  width = 0.78,
): void {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.4) return;
  beams.push({
    matrix: self.matrix(
      (a.x + b.x) * 0.5,
      y,
      (a.z + b.z) * 0.5,
      length + 0.55,
      0.58,
      width,
      -Math.atan2(dz, dx),
    ),
  });
}

function buildRoadAwareTrackSupports(self: AnyRail): void {
  const columns: StaticPart[] = [];
  const beams: StaticPart[] = [];
  const roads = self.roads as RoadNetwork | undefined;

  for (const smooth of self.smoothLines.values() as Iterable<AnySmooth>) {
    const y = self.lineTrackY(smooth.line.id) as number;
    for (let s = TRACK_SUPPORT_SPACING * 0.5; s < smooth.length; s += TRACK_SUPPORT_SPACING) {
      const p = self.sampleSmooth(smooth, s);
      if (!p) continue;

      if (!roadOccupied(roads, p.x, p.z, 1.1)) {
        pushColumn(self, p.x, p.z, y, columns);
        continue;
      }

      const pair = findSafePair(roads, p, p.heading, 5.0);
      if (!pair) continue;
      pushColumn(self, pair.left.x, pair.left.z, y, columns);
      pushColumn(self, pair.right.x, pair.right.z, y, columns);
      pushBeam(self, pair.left, pair.right, y - 0.34, beams, 0.86);
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: TRACK_SUPPORT_COLOR, roughness: 0.88, metalness: 0.08 });
  self.addStatic(box, material, columns);
  self.addStatic(box, material, beams);
}

function stationStructureHalf(self: AnyRail, line: AnyRail, stationId: number, stationIndex: number): number {
  const station = self.rail.stations[stationId];
  const width = station?.kind === RailStationKind.Central || station?.kind === RailStationKind.SubCenter ? 4.2 : 3.8;
  if (line.kind === 'trunk' && self.lineStationHasPassingLoop(line.id, stationIndex)) {
    return (1.72 + 8.0) * 0.5 + width * 0.5 + 1.2;
  }
  if (line.kind === 'trunk') {
    return 1.72 + 2.86 * 0.5 + 0.48 + width + 1.2;
  }
  return 2.86 * 0.5 + 0.48 + width + 1.6;
}

function buildRoadAwareStationSupports(self: AnyRail): void {
  const columns: StaticPart[] = [];
  const beams: StaticPart[] = [];
  const roads = self.roads as RoadNetwork | undefined;

  for (const line of self.rail.lines as AnyRail[]) {
    const smooth = self.smoothLines.get(line.id) as AnySmooth | undefined;
    if (!smooth) continue;
    const y = self.lineTrackY(line.id) as number;

    for (let i = 0; i < line.stationIds.length; i++) {
      const stationId = line.stationIds[i];
      const center = smooth.stationDistances[i] ?? 0;
      const length = self.platformLength(stationId) as number;
      const start = Math.max(0, center - length * 0.5 + 9);
      const end = Math.min(smooth.length, center + length * 0.5 - 8);
      const minimumOffset = stationStructureHalf(self, line, stationId, i);

      for (let s = start; s <= end; s += STATION_FRAME_SPACING) {
        const p = self.sampleSmooth(smooth, s);
        if (!p) continue;
        const pair = findSafePair(roads, p, p.heading, minimumOffset);
        // 両側とも安全な支持位置が取れない場所には柱を置かない。
        // 前後のフレームとホーム桁で飛ばす方が道路中央柱より安全。
        if (!pair) continue;
        pushColumn(self, pair.left.x, pair.left.z, y, columns);
        pushColumn(self, pair.right.x, pair.right.z, y, columns);
        pushBeam(self, pair.left, pair.right, y - 0.34, beams, 0.94);
      }
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: STATION_COLUMN_COLOR, roughness: 0.90, metalness: 0.06 });
  self.addStatic(box, material, columns);
  self.addStatic(box, material, beams);
}

proto.buildTrackGeometry = function roadSafeTrackGeometry(this: AnyRail): void {
  withoutStaticColor(this, TRACK_SUPPORT_COLOR, () => originalBuildTrackGeometry.call(this));
  buildRoadAwareTrackSupports(this);
};

proto.buildStations = function roadSafeStations(this: AnyRail): void {
  withoutStaticColor(this, STATION_COLUMN_COLOR, () => originalBuildStations.call(this));
  buildRoadAwareStationSupports(this);
};
