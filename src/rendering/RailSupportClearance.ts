import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { roadWidth, type RoadEdge, type RoadNetwork } from '../traffic/RoadNetwork';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };

type RoadHit = {
  edge: RoadEdge;
  qx: number;
  qz: number;
  dx: number;
  dz: number;
  distance: number;
  halfWidth: number;
};

const TRACK_SUPPORT_COLOR = 0x8a8f92;
const STATION_COLUMN_COLOR = 0x777d82;
const SUPPORT_MARGIN = 1.6;
const TRACK_SUPPORT_SPACING = 72;
const STATION_FRAME_SPACING = 24;

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

function nearbyEdges(roads: RoadNetwork, x: number, z: number): RoadEdge[] {
  const nodeId = roads.nearestNode(x, z);
  if (nodeId < 0) return [];
  const edgeIds = new Set<number>();
  const first = roads.nodes[nodeId];
  for (const id of first.edges) {
    edgeIds.add(id);
    const edge = roads.edges[id];
    const next = roads.nodes[edge.to];
    if (!next) continue;
    for (const nextId of next.edges) edgeIds.add(nextId);
  }
  return [...edgeIds].map((id) => roads.edges[id]).filter((edge): edge is RoadEdge => !!edge);
}

function roadHit(roads: RoadNetwork | undefined, x: number, z: number): RoadHit | null {
  if (!roads) return null;
  let best: RoadHit | null = null;
  for (const edge of nearbyEdges(roads, x, z)) {
    const a = roads.nodes[edge.from], b = roads.nodes[edge.to];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 0.01) continue;
    const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
    const qx = a.x + dx * t, qz = a.z + dz * t;
    const distance = Math.hypot(x - qx, z - qz);
    const halfWidth = roadWidth(Math.max(1, edge.lanes)) * 0.5;
    if (!best || distance - halfWidth < best.distance - best.halfWidth) {
      const len = Math.sqrt(len2);
      best = { edge, qx, qz, dx: dx / len, dz: dz / len, distance, halfWidth };
    }
  }
  return best;
}

function roadOccupied(roads: RoadNetwork | undefined, x: number, z: number, margin = SUPPORT_MARGIN): boolean {
  if (!roads) return false;
  for (const edge of nearbyEdges(roads, x, z)) {
    const a = roads.nodes[edge.from], b = roads.nodes[edge.to];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 0.01) continue;
    const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
    const qx = a.x + dx * t, qz = a.z + dz * t;
    if (Math.hypot(x - qx, z - qz) <= roadWidth(Math.max(1, edge.lanes)) * 0.5 + margin) return true;
  }
  return false;
}

function findClearLeg(
  roads: RoadNetwork | undefined,
  hit: RoadHit,
  side: -1 | 1,
  extra = 0,
): { x: number; z: number } {
  const nx = -hit.dz, nz = hit.dx;
  let offset = hit.halfWidth + SUPPORT_MARGIN + extra;
  for (let tries = 0; tries < 12; tries++, offset += 1.8) {
    const x = hit.qx + nx * side * offset;
    const z = hit.qz + nz * side * offset;
    if (!roadOccupied(roads, x, z, 0.9)) return { x, z };
  }
  return {
    x: hit.qx + nx * side * offset,
    z: hit.qz + nz * side * offset,
  };
}

function pushColumn(self: AnyRail, x: number, z: number, y: number, columns: StaticPart[]): void {
  columns.push({ matrix: self.matrix(x, y * 0.5, z, 0.72, y, 0.72) });
}

function pushBeam(
  self: AnyRail,
  a: { x: number; z: number },
  b: { x: number; z: number },
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

function addPortalAt(
  self: AnyRail,
  x: number,
  z: number,
  y: number,
  columns: StaticPart[],
  beams: StaticPart[],
  extra = 0,
): boolean {
  const roads = self.roads as RoadNetwork | undefined;
  const hit = roadHit(roads, x, z);
  if (!hit || hit.distance > hit.halfWidth + SUPPORT_MARGIN + 1.0) return false;
  const left = findClearLeg(roads, hit, -1, extra);
  const right = findClearLeg(roads, hit, 1, extra);
  pushColumn(self, left.x, left.z, y, columns);
  pushColumn(self, right.x, right.z, y, columns);
  pushBeam(self, left, right, y - 0.34, beams, 0.86);
  return true;
}

function buildRoadAwareTrackSupports(self: AnyRail): void {
  const columns: StaticPart[] = [];
  const beams: StaticPart[] = [];
  for (const smooth of self.smoothLines.values() as Iterable<AnySmooth>) {
    const y = self.lineTrackY(smooth.line.id) as number;
    for (let s = TRACK_SUPPORT_SPACING * 0.5; s < smooth.length; s += TRACK_SUPPORT_SPACING) {
      const p = self.sampleSmooth(smooth, s);
      if (!p) continue;
      if (addPortalAt(self, p.x, p.z, y, columns, beams)) continue;
      if (roadOccupied(self.roads as RoadNetwork | undefined, p.x, p.z, 0.8)) continue;
      pushColumn(self, p.x, p.z, y, columns);
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
    return (1.72 + 8.0) * 0.5 + width * 0.5 + 0.8;
  }
  if (line.kind === 'trunk') {
    return 1.72 + 2.86 * 0.5 + 0.48 + width + 0.8;
  }
  return 2.86 * 0.5 + 0.48 + width + 1.2;
}

function buildRoadAwareStationSupports(self: AnyRail): void {
  const columns: StaticPart[] = [];
  const beams: StaticPart[] = [];
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
      const half = stationStructureHalf(self, line, stationId, i);
      for (let s = start; s <= end; s += STATION_FRAME_SPACING) {
        const p = self.sampleSmooth(smooth, s);
        if (!p) continue;
        if (addPortalAt(self, p.x, p.z, y, columns, beams, Math.max(0, half - 5.5))) continue;

        const left = self.offsetPoint(smooth, s, -half);
        const right = self.offsetPoint(smooth, s, half);
        if (!left || !right) continue;
        const leftBlocked = roadOccupied(self.roads as RoadNetwork | undefined, left.x, left.z, 0.9);
        const rightBlocked = roadOccupied(self.roads as RoadNetwork | undefined, right.x, right.z, 0.9);
        if (!leftBlocked) pushColumn(self, left.x, left.z, y, columns);
        if (!rightBlocked) pushColumn(self, right.x, right.z, y, columns);
        if (!leftBlocked && !rightBlocked) pushBeam(self, left, right, y - 0.34, beams, 0.92);
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
