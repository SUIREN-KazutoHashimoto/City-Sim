import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';

export interface RailPassengerPoint3D {
  x: number;
  y: number;
  z: number;
}

export interface RailPassengerStationAccess {
  stationId: number;
  lineId: number;
  direction: 1 | -1;
  heading: number;
  entrance: RailPassengerPoint3D;
  stairTop: RailPassengerPoint3D;
  concourse: RailPassengerPoint3D;
  platformLanding: RailPassengerPoint3D;
  platformWait: RailPassengerPoint3D;
  waitSpan: number;
}

declare module './RailRenderer' {
  interface RailRenderer {
    passengerStationAccesses(stationId: number, lineId: number, direction: 1 | -1): RailPassengerStationAccess[];
  }
}

type AnyRail = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };
type PlatformNode = {
  lineId: number;
  stationId: number;
  offset: number;
  distance: number;
  groundDirection: -1 | 1;
  x: number;
  y: number;
  z: number;
  heading: number;
};

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;
const TRAIN_HALF_WIDTH = 2.86 * 0.5;
const PLATFORM_CLEARANCE = 0.48;
const UPPER_STAIR_RUN = 8.5;
const LEVEL_EPSILON = 0.25;
const proto = RailRenderer.prototype as unknown as AnyRail;
const originalBuildPlatformAccess = proto.buildPlatformAccess as (
  smooth: AnySmooth,
  distance: number,
  offset: number,
  direction: -1 | 1,
  y: number,
  stairs: StaticPart[],
) => void;

function platformOffsets(self: AnyRail, lineId: number, stationIndex: number): number[] {
  const line = self.rail.lines[lineId];
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  if (!line || !smooth) return [];
  const stationId = line.stationIds[stationIndex] ?? -1;
  const station = stationId >= 0 ? self.rail.stations[stationId] : null;
  if (!station) return [];
  const width = station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter ? 4.2 : 3.8;
  if (line.kind === 'trunk' && self.lineStationHasPassingLoop(lineId, stationIndex)) {
    const island = (MAIN_OFFSET + SIDING_OFFSET) * 0.5;
    return [-island, island];
  }
  if (line.kind === 'trunk') {
    const outer = MAIN_OFFSET + TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5;
    return [-outer, outer];
  }
  const center = smooth.stationDistances[stationIndex] ?? 0;
  const track = self.sharedSpurOffset(smooth, center) as number;
  const side = track >= 0 ? 1 : -1;
  return [track + side * (TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5)];
}

function platformOffsetForDirection(self: AnyRail, lineId: number, stationIndex: number, direction: 1 | -1): number | null {
  const offsets = platformOffsets(self, lineId, stationIndex);
  if (!offsets.length) return null;
  if (offsets.length === 1) return offsets[0];
  return direction > 0 ? Math.min(...offsets) : Math.max(...offsets);
}

function stationLineOrder(self: AnyRail, stationId: number): number[] {
  const station = self.rail.stations[stationId];
  if (!station) return [];
  return (station.lineIds as number[])
    .filter((lineId) => {
      const line = self.rail.lines[lineId];
      return !!line && !!self.smoothLines.get(lineId) && line.stationIds.includes(stationId);
    })
    .sort((a, b) => {
      const ay = self.lineTrackY(a) as number;
      const by = self.lineTrackY(b) as number;
      if (Math.abs(ay - by) > LEVEL_EPSILON) return ay - by;
      return a - b;
    });
}

function stationIndexForLine(self: AnyRail, stationId: number, lineId: number): number {
  const line = self.rail.lines[lineId];
  return line ? line.stationIds.indexOf(stationId) : -1;
}

function nodesForLine(self: AnyRail, stationId: number, lineId: number, forcedOffset?: number): PlatformNode[] {
  const line = self.rail.lines[lineId];
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  const stationIndex = stationIndexForLine(self, stationId, lineId);
  if (!line || !smooth || stationIndex < 0) return [];
  const center = smooth.stationDistances[stationIndex] ?? 0;
  const length = self.platformLength(stationId) as number;
  const start = Math.max(0, center - length * 0.5);
  const end = Math.min(smooth.length as number, center + length * 0.5);
  const offsets = forcedOffset == null ? platformOffsets(self, lineId, stationIndex) : [forcedOffset];
  const y = (self.lineTrackY(lineId) as number) + 0.60;
  const out: PlatformNode[] = [];
  for (const offset of offsets) {
    for (const endSpec of [
      { distance: start + 3, groundDirection: -1 as const },
      { distance: end - 3, groundDirection: 1 as const },
    ]) {
      const distance = THREE.MathUtils.clamp(endSpec.distance, 0, smooth.length as number);
      const p = self.offsetPoint(smooth, distance, offset) as { x: number; z: number; heading: number } | null;
      if (!p) continue;
      out.push({
        lineId, stationId, offset, distance, groundDirection: endSpec.groundDirection,
        x: p.x, y, z: p.z, heading: p.heading,
      });
    }
  }
  return out;
}

function nearestNode(nodes: PlatformNode[], x: number, z: number): PlatformNode | null {
  let best: PlatformNode | null = null;
  let bestD = Infinity;
  for (const node of nodes) {
    const d = Math.hypot(node.x - x, node.z - z);
    if (d < bestD) { bestD = d; best = node; }
  }
  return best;
}

function hierarchyForTarget(self: AnyRail, stationId: number, targetLineId: number, target: PlatformNode): PlatformNode[] {
  const order = stationLineOrder(self, stationId);
  const targetIndex = order.indexOf(targetLineId);
  if (targetIndex < 0) return [target];
  const descending: PlatformNode[] = [target];
  let child = target;
  for (let i = targetIndex - 1; i >= 0; i--) {
    const parent = nearestNode(nodesForLine(self, stationId, order[i]), child.x, child.z);
    if (!parent) continue;
    descending.push(parent);
    child = parent;
  }
  return descending.reverse();
}

function groundEntrance(self: AnyRail, ground: PlatformNode): { entrance: RailPassengerPoint3D; outer: RailPassengerPoint3D } | null {
  const smooth = self.smoothLines.get(ground.lineId) as AnySmooth | undefined;
  if (!smooth) return null;
  const side = ground.offset >= 0 ? 1 : -1;
  const roadHalf = self.roadHalfWidthAt(ground.x, ground.z, ground.heading) as number;
  const outerAbs = Math.max(Math.abs(ground.offset) + 3.3, roadHalf + 3.2);
  const outer = self.offsetPoint(smooth, ground.distance, side * outerAbs) as { x: number; z: number; heading: number } | null;
  if (!outer) return null;
  const lineY = self.lineTrackY(ground.lineId) as number;
  const concourseY = Math.max(4.4, lineY - 2.9);
  const run = Math.max(15.5, concourseY * 2.6);
  return {
    entrance: {
      x: outer.x + Math.cos(outer.heading) * ground.groundDirection * run,
      y: 0,
      z: outer.z + Math.sin(outer.heading) * ground.groundDirection * run,
    },
    outer: { x: outer.x, y: concourseY, z: outer.z },
  };
}

function makeAccess(self: AnyRail, stationId: number, lineId: number, direction: 1 | -1, target: PlatformNode): RailPassengerStationAccess | null {
  const chain = hierarchyForTarget(self, stationId, lineId, target);
  if (!chain.length) return null;
  const ground = chain[0];
  const groundLeg = groundEntrance(self, ground);
  if (!groundLeg) return null;
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  const stationIndex = stationIndexForLine(self, stationId, lineId);
  if (!smooth || stationIndex < 0) return null;
  const center = smooth.stationDistances[stationIndex] ?? target.distance;
  const wait = self.offsetPoint(smooth, center, target.offset) as { x: number; z: number; heading: number } | null;
  if (!wait) return null;
  const length = self.platformLength(stationId) as number;

  // 既存旅客ルートの4つの中継点へ、下層→上層のホーム接続を割り当てる。
  // 現在の都市生成は最大3段の幹線ホームなので、地上から各段を順に通る。
  const lowest = chain[0];
  const parent = chain.length >= 3 ? chain[chain.length - 2] : lowest;
  const landing = chain[chain.length - 1];
  return {
    stationId,
    lineId,
    direction,
    heading: wait.heading,
    entrance: groundLeg.entrance,
    stairTop: { x: lowest.x, y: lowest.y, z: lowest.z },
    concourse: { x: parent.x, y: parent.y, z: parent.z },
    platformLanding: { x: landing.x, y: landing.y, z: landing.z },
    platformWait: { x: wait.x, y: landing.y, z: wait.z },
    waitSpan: Math.max(8, length * 0.46),
  };
}

proto.passengerStationAccesses = function passengerStationAccesses(
  this: AnyRail,
  stationId: number,
  lineId: number,
  direction: 1 | -1,
): RailPassengerStationAccess[] {
  const stationIndex = stationIndexForLine(this, stationId, lineId);
  if (stationIndex < 0) return [];
  const offset = platformOffsetForDirection(this, lineId, stationIndex, direction);
  if (offset == null) return [];
  const targets = nodesForLine(this, stationId, lineId, offset);
  const out: RailPassengerStationAccess[] = [];
  for (const target of targets) {
    const access = makeAccess(this, stationId, lineId, direction, target);
    if (access) out.push(access);
  }
  return out;
};

function nearestStationIndex(self: AnyRail, smooth: AnySmooth, distance: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < smooth.stationDistances.length; i++) {
    const d = Math.abs((smooth.stationDistances[i] ?? 0) - distance);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return -1;
  const stationId = smooth.line.stationIds[best];
  const half = (self.platformLength(stationId) as number) * 0.5 + 8;
  return bestD <= half ? best : -1;
}

function addGroundToPlatformStairs(self: AnyRail, smooth: AnySmooth, distance: number, offset: number, direction: -1 | 1, y: number, stairs: StaticPart[]): void {
  const concourseY = Math.max(4.4, y - 2.9);
  const platformY = y + 0.58;
  const baseY = concourseY - 0.08;
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const d = THREE.MathUtils.clamp(distance - direction * UPPER_STAIR_RUN * t, 0, smooth.length as number);
    const p = self.offsetPoint(smooth, d, offset) as { x: number; z: number; heading: number } | null;
    if (!p) continue;
    const top = THREE.MathUtils.lerp(concourseY + 0.10, platformY, t);
    const height = Math.max(0.16, top - baseY);
    stairs.push({ matrix: self.matrix(p.x, baseY + height * 0.5, p.z, 1.35, height, 2.35, -p.heading) });
  }
}

function addInterLevelStairs(self: AnyRail, from: PlatformNode, to: PlatformNode, stairs: StaticPart[]): void {
  // lower -> upper の順にする。
  const lower = from.y <= to.y ? from : to;
  const upper = from.y <= to.y ? to : from;
  const dx = upper.x - lower.x;
  const dz = upper.z - lower.z;
  const horizontal = Math.hypot(dx, dz);
  const heading = horizontal > 0.01 ? Math.atan2(dz, dx) : lower.heading;
  const steps = Math.max(8, Math.min(18, Math.ceil(Math.max(horizontal, Math.abs(upper.y - lower.y) * 3) / 1.25)));
  const depth = Math.max(0.7, horizontal / Math.max(1, steps - 1) * 1.18);
  for (let i = 0; i < steps; i++) {
    const t = steps <= 1 ? 1 : i / (steps - 1);
    const x = THREE.MathUtils.lerp(lower.x, upper.x, t);
    const z = THREE.MathUtils.lerp(lower.z, upper.z, t);
    const yy = THREE.MathUtils.lerp(lower.y, upper.y, t) - 0.10;
    stairs.push({ matrix: self.matrix(x, yy, z, depth, 0.22, 1.45, -heading) });
  }
}

// 複数路線駅では各ホームから地上へ降ろさない。
// 最下層ホームだけを地上へ接続し、それより上は必ず一つ下のホームへ階段接続する。
if (!proto.__railPassengerStackedAccessPatched && originalBuildPlatformAccess) {
  proto.__railPassengerStackedAccessPatched = true;
  proto.buildPlatformAccess = function stackedPlatformAccess(
    this: AnyRail,
    smooth: AnySmooth,
    distance: number,
    offset: number,
    direction: -1 | 1,
    y: number,
    stairs: StaticPart[],
  ): void {
    const stationIndex = nearestStationIndex(this, smooth, distance);
    if (stationIndex < 0) {
      originalBuildPlatformAccess.call(this, smooth, distance, offset, direction, y, stairs);
      addGroundToPlatformStairs(this, smooth, distance, offset, direction, y, stairs);
      return;
    }
    const stationId = smooth.line.stationIds[stationIndex];
    const lineId = smooth.line.id as number;
    const order = stationLineOrder(this, stationId);
    const levelIndex = order.indexOf(lineId);
    if (levelIndex <= 0) {
      originalBuildPlatformAccess.call(this, smooth, distance, offset, direction, y, stairs);
      addGroundToPlatformStairs(this, smooth, distance, offset, direction, y, stairs);
      return;
    }

    const currentPoint = this.offsetPoint(smooth, distance, offset) as { x: number; z: number; heading: number } | null;
    if (!currentPoint) return;
    const current: PlatformNode = {
      lineId, stationId, offset, distance, groundDirection: direction,
      x: currentPoint.x, y: y + 0.60, z: currentPoint.z, heading: currentPoint.heading,
    };
    const parentLine = order[levelIndex - 1];
    const parent = nearestNode(nodesForLine(this, stationId, parentLine), current.x, current.z);
    if (!parent) return;
    addInterLevelStairs(this, parent, current, stairs);
  };
}
