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
  x: number;
  y: number;
  z: number;
  heading: number;
};
type StationLevel = { y: number; lineIds: number[] };

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
const generatedByParts = new WeakMap<object, Set<string>>();

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

function stationIndexForLine(self: AnyRail, stationId: number, lineId: number): number {
  const line = self.rail.lines[lineId];
  return line ? line.stationIds.indexOf(stationId) : -1;
}

function stationLevels(self: AnyRail, stationId: number): StationLevel[] {
  const station = self.rail.stations[stationId];
  if (!station) return [];
  const lines = [...new Set(station.lineIds as number[])]
    .filter((lineId) => {
      const line = self.rail.lines[lineId];
      return !!line && !!self.smoothLines.get(lineId) && line.stationIds.includes(stationId);
    })
    .sort((a, b) => (self.lineTrackY(a) as number) - (self.lineTrackY(b) as number) || a - b);
  const levels: StationLevel[] = [];
  for (const lineId of lines) {
    const y = self.lineTrackY(lineId) as number;
    const last = levels[levels.length - 1];
    if (last && Math.abs(last.y - y) <= LEVEL_EPSILON) last.lineIds.push(lineId);
    else levels.push({ y, lineIds: [lineId] });
  }
  return levels;
}

function levelIndexForLine(levels: StationLevel[], lineId: number): number {
  return levels.findIndex((level) => level.lineIds.includes(lineId));
}

function chooseOffset(offsets: number[], sideHint: number): number | null {
  if (!offsets.length) return null;
  if (offsets.length === 1) return offsets[0];
  return sideHint < 0 ? Math.min(...offsets) : Math.max(...offsets);
}

function coreNodeForLine(self: AnyRail, stationId: number, lineId: number, sideHint: number): PlatformNode | null {
  const line = self.rail.lines[lineId];
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  const stationIndex = stationIndexForLine(self, stationId, lineId);
  if (!line || !smooth || stationIndex < 0) return null;
  const offset = chooseOffset(platformOffsets(self, lineId, stationIndex), sideHint);
  if (offset == null) return null;
  const distance = THREE.MathUtils.clamp(smooth.stationDistances[stationIndex] ?? 0, 0, smooth.length as number);
  const p = self.offsetPoint(smooth, distance, offset) as { x: number; z: number; heading: number } | null;
  if (!p) return null;
  return {
    lineId,
    stationId,
    offset,
    distance,
    x: p.x,
    y: (self.lineTrackY(lineId) as number) + 0.60,
    z: p.z,
    heading: p.heading,
  };
}

function nearestCoreInLevel(self: AnyRail, stationId: number, level: StationLevel, sideHint: number, x: number, z: number): PlatformNode | null {
  let best: PlatformNode | null = null;
  let bestD = Infinity;
  for (const lineId of level.lineIds) {
    const node = coreNodeForLine(self, stationId, lineId, sideHint);
    if (!node) continue;
    const d = Math.hypot(node.x - x, node.z - z);
    if (d < bestD) { bestD = d; best = node; }
  }
  return best;
}

function hierarchyForTarget(self: AnyRail, stationId: number, targetLineId: number, sideHint: number): PlatformNode[] {
  const levels = stationLevels(self, stationId);
  const targetLevel = levelIndexForLine(levels, targetLineId);
  const target = coreNodeForLine(self, stationId, targetLineId, sideHint);
  if (!target || targetLevel < 0) return target ? [target] : [];
  const descending: PlatformNode[] = [target];
  let child = target;
  for (let levelIndex = targetLevel - 1; levelIndex >= 0; levelIndex--) {
    const parent = nearestCoreInLevel(self, stationId, levels[levelIndex], sideHint, child.x, child.z);
    if (!parent) continue;
    descending.push(parent);
    child = parent;
  }
  return descending.reverse();
}

function groundEntrance(self: AnyRail, ground: PlatformNode): RailPassengerPoint3D | null {
  const smooth = self.smoothLines.get(ground.lineId) as AnySmooth | undefined;
  if (!smooth) return null;
  const side = ground.offset >= 0 ? 1 : -1;
  const roadHalf = self.roadHalfWidthAt(ground.x, ground.z, ground.heading) as number;
  const outerAbs = Math.max(Math.abs(ground.offset) + 3.3, roadHalf + 3.2);
  const outer = self.offsetPoint(smooth, ground.distance, side * outerAbs) as { x: number; z: number; heading: number } | null;
  if (!outer) return null;
  const run = Math.max(12, ground.y * 1.75);
  const alongSign = side > 0 ? 1 : -1;
  return {
    x: outer.x + Math.cos(outer.heading) * alongSign * run,
    y: 0,
    z: outer.z + Math.sin(outer.heading) * alongSign * run,
  };
}

function makeStackedAccess(self: AnyRail, stationId: number, lineId: number, direction: 1 | -1): RailPassengerStationAccess | null {
  const stationIndex = stationIndexForLine(self, stationId, lineId);
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  if (!smooth || stationIndex < 0) return null;
  const offset = platformOffsetForDirection(self, lineId, stationIndex, direction);
  if (offset == null) return null;
  const sideHint = offset >= 0 ? 1 : -1;
  const chain = hierarchyForTarget(self, stationId, lineId, sideHint);
  if (!chain.length) return null;
  const entrance = groundEntrance(self, chain[0]);
  if (!entrance) return null;
  const target = chain[chain.length - 1];
  const wait = self.offsetPoint(smooth, smooth.stationDistances[stationIndex] ?? target.distance, target.offset) as { x: number; z: number; heading: number } | null;
  if (!wait) return null;
  const lowest = chain[0];
  const middle = chain.length >= 3 ? chain[chain.length - 2] : lowest;
  const landing = target;
  const length = self.platformLength(stationId) as number;
  return {
    stationId,
    lineId,
    direction,
    heading: wait.heading,
    entrance,
    stairTop: { x: lowest.x, y: lowest.y, z: lowest.z },
    concourse: { x: middle.x, y: middle.y, z: middle.z },
    platformLanding: { x: landing.x, y: landing.y, z: landing.z },
    platformWait: { x: wait.x, y: landing.y, z: wait.z },
    waitSpan: Math.max(8, length * 0.46),
  };
}

function makeLegacyAccess(
  self: AnyRail,
  stationId: number,
  lineId: number,
  direction: 1 | -1,
  distance: number,
  offset: number,
  groundDirection: -1 | 1,
): RailPassengerStationAccess | null {
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  const stationIndex = stationIndexForLine(self, stationId, lineId);
  if (!smooth || stationIndex < 0) return null;
  const anchor = self.offsetPoint(smooth, distance, offset) as { x: number; z: number; heading: number } | null;
  if (!anchor) return null;
  const side = offset >= 0 ? 1 : -1;
  const roadHalf = self.roadHalfWidthAt(anchor.x, anchor.z, anchor.heading) as number;
  const outerAbs = Math.max(Math.abs(offset) + 3.3, roadHalf + 3.2);
  const outer = self.offsetPoint(smooth, distance, side * outerAbs) as { x: number; z: number; heading: number } | null;
  if (!outer) return null;
  const y = self.lineTrackY(lineId) as number;
  const concourseY = Math.max(4.4, y - 2.9);
  const platformY = y + 0.60;
  const groundRun = Math.max(15.5, concourseY * 2.6);
  const center = smooth.stationDistances[stationIndex] ?? distance;
  const landingDistance = THREE.MathUtils.clamp(distance - groundDirection * UPPER_STAIR_RUN, 0, smooth.length as number);
  const landing = self.offsetPoint(smooth, landingDistance, offset) as { x: number; z: number; heading: number } | null;
  const wait = self.offsetPoint(smooth, center, offset) as { x: number; z: number; heading: number } | null;
  if (!landing || !wait) return null;
  return {
    stationId,
    lineId,
    direction,
    heading: wait.heading,
    entrance: {
      x: outer.x + Math.cos(outer.heading) * groundDirection * groundRun,
      y: 0,
      z: outer.z + Math.sin(outer.heading) * groundDirection * groundRun,
    },
    stairTop: { x: outer.x, y: concourseY, z: outer.z },
    concourse: { x: anchor.x, y: concourseY, z: anchor.z },
    platformLanding: { x: landing.x, y: platformY, z: landing.z },
    platformWait: { x: wait.x, y: platformY, z: wait.z },
    waitSpan: Math.max(8, (self.platformLength(stationId) as number) * 0.46),
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
  const levels = stationLevels(this, stationId);
  if (levels.length > 1) {
    const access = makeStackedAccess(this, stationId, lineId, direction);
    return access ? [access] : [];
  }

  const smooth = this.smoothLines.get(lineId) as AnySmooth | undefined;
  const offset = platformOffsetForDirection(this, lineId, stationIndex, direction);
  if (!smooth || offset == null) return [];
  const center = smooth.stationDistances[stationIndex] ?? 0;
  const length = this.platformLength(stationId) as number;
  const start = Math.max(0, center - length * 0.5);
  const end = Math.min(smooth.length as number, center + length * 0.5);
  const out: RailPassengerStationAccess[] = [];
  const a = makeLegacyAccess(this, stationId, lineId, direction, start + 3, offset, -1);
  const b = makeLegacyAccess(this, stationId, lineId, direction, end - 3, offset, 1);
  if (a) out.push(a);
  if (b) out.push(b);
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

function addUpperSteps(self: AnyRail, smooth: AnySmooth, distance: number, offset: number, direction: -1 | 1, y: number, stairs: StaticPart[]): void {
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

function addStairFlight(self: AnyRail, from: RailPassengerPoint3D, to: RailPassengerPoint3D, stairs: StaticPart[]): void {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  const rise = Math.abs(to.y - from.y);
  if (horizontal < 0.15 && rise < 0.15) return;
  const heading = horizontal > 0.01 ? Math.atan2(dz, dx) : 0;
  const steps = Math.max(6, Math.min(40, Math.ceil(Math.max(rise / 0.22, horizontal / 0.75))));
  const depth = Math.max(0.48, horizontal / Math.max(1, steps - 1) * 1.14);
  for (let i = 0; i < steps; i++) {
    const t = steps <= 1 ? 1 : i / (steps - 1);
    const x = THREE.MathUtils.lerp(from.x, to.x, t);
    const z = THREE.MathUtils.lerp(from.z, to.z, t);
    const yy = THREE.MathUtils.lerp(from.y, to.y, t);
    stairs.push({ matrix: self.matrix(x, yy - 0.09, z, depth, 0.18, 1.55, -heading) });
  }
}

function markOnce(stairs: StaticPart[], key: string): boolean {
  let keys = generatedByParts.get(stairs);
  if (!keys) { keys = new Set<string>(); generatedByParts.set(stairs, keys); }
  if (keys.has(key)) return false;
  keys.add(key);
  return true;
}

// 単一路線駅は従来の地上アクセスを維持する。
// 複数路線駅は、ホーム端同士を直接結ばず駅中央の共通階段コアだけを生成する。
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
      addUpperSteps(this, smooth, distance, offset, direction, y, stairs);
      return;
    }

    const stationId = smooth.line.stationIds[stationIndex];
    const lineId = smooth.line.id as number;
    const levels = stationLevels(this, stationId);
    if (levels.length <= 1) {
      originalBuildPlatformAccess.call(this, smooth, distance, offset, direction, y, stairs);
      addUpperSteps(this, smooth, distance, offset, direction, y, stairs);
      return;
    }

    const levelIndex = levelIndexForLine(levels, lineId);
    if (levelIndex < 0) return;
    const sideHint = offset >= 0 ? 1 : -1;
    const current = coreNodeForLine(this, stationId, lineId, sideHint);
    if (!current) return;
    const actualSide = current.offset >= 0 ? 1 : -1;
    const key = `station:${stationId}:level:${levelIndex}:side:${actualSide}`;
    if (!markOnce(stairs, key)) return;

    if (levelIndex === 0) {
      const entrance = groundEntrance(this, current);
      if (entrance) addStairFlight(this, entrance, current, stairs);
      return;
    }

    const parent = nearestCoreInLevel(this, stationId, levels[levelIndex - 1], actualSide, current.x, current.z);
    if (!parent) return;
    addStairFlight(this, parent, current, stairs);
  };
}
