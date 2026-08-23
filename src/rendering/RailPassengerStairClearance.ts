import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';
import type { RailPassengerPoint3D, RailPassengerStationAccess } from './RailPassengerStationAccess';

type AnyRail = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };
type Level = { y: number; lineIds: number[] };
type PlatformSpec = {
  stationId: number;
  lineId: number;
  stationIndex: number;
  smooth: AnySmooth;
  offset: number;
  centerD: number;
  x: number;
  z: number;
  heading: number;
  y: number;
  length: number;
};
type StairConnection = {
  lower: PlatformSpec;
  upper: PlatformSpec;
  lowerStart: RailPassengerPoint3D;
  mid: RailPassengerPoint3D;
  upperEnd: RailPassengerPoint3D;
  score: number;
};

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;
const TRAIN_HALF_WIDTH = 2.86 * 0.5;
const PLATFORM_CLEARANCE = 0.48;
const LEVEL_EPSILON = 0.25;
const STAIR_HALF_RUN = 3.2;
const proto = RailRenderer.prototype as unknown as AnyRail;
const previousBuildPlatformAccess = proto.buildPlatformAccess as (
  smooth: AnySmooth,
  distance: number,
  offset: number,
  direction: -1 | 1,
  y: number,
  stairs: StaticPart[],
) => void;
const previousPassengerStationAccesses = proto.passengerStationAccesses as (
  stationId: number,
  lineId: number,
  direction: 1 | -1,
) => RailPassengerStationAccess[];
const generatedByParts = new WeakMap<object, Set<string>>();

function stationIndexForLine(self: AnyRail, stationId: number, lineId: number): number {
  const line = self.rail.lines[lineId];
  return line ? line.stationIds.indexOf(stationId) : -1;
}

function platformOffsets(self: AnyRail, lineId: number, stationIndex: number): number[] {
  const line = self.rail.lines[lineId];
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  if (!line || !smooth || stationIndex < 0) return [];
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

function stationLevels(self: AnyRail, stationId: number): Level[] {
  const station = self.rail.stations[stationId];
  if (!station) return [];
  const ids = [...new Set(station.lineIds as number[])]
    .filter((lineId) => stationIndexForLine(self, stationId, lineId) >= 0 && !!self.smoothLines.get(lineId))
    .sort((a, b) => (self.lineTrackY(a) as number) - (self.lineTrackY(b) as number) || a - b);
  const levels: Level[] = [];
  for (const lineId of ids) {
    const y = self.lineTrackY(lineId) as number;
    const last = levels[levels.length - 1];
    if (last && Math.abs(last.y - y) <= LEVEL_EPSILON) last.lineIds.push(lineId);
    else levels.push({ y, lineIds: [lineId] });
  }
  return levels;
}

function specForOffset(self: AnyRail, stationId: number, lineId: number, offset: number): PlatformSpec | null {
  const stationIndex = stationIndexForLine(self, stationId, lineId);
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  if (!smooth || stationIndex < 0) return null;
  const centerD = THREE.MathUtils.clamp(smooth.stationDistances[stationIndex] ?? 0, 0, smooth.length as number);
  const p = self.offsetPoint(smooth, centerD, offset) as { x: number; z: number; heading: number } | null;
  if (!p) return null;
  return {
    stationId,
    lineId,
    stationIndex,
    smooth,
    offset,
    centerD,
    x: p.x,
    z: p.z,
    heading: p.heading,
    y: (self.lineTrackY(lineId) as number) + 0.60,
    length: self.platformLength(stationId) as number,
  };
}

function specsForLine(self: AnyRail, stationId: number, lineId: number): PlatformSpec[] {
  const stationIndex = stationIndexForLine(self, stationId, lineId);
  if (stationIndex < 0) return [];
  return platformOffsets(self, lineId, stationIndex)
    .map((offset) => specForOffset(self, stationId, lineId, offset))
    .filter((value): value is PlatformSpec => !!value);
}

function specForDirection(self: AnyRail, stationId: number, lineId: number, direction: 1 | -1): PlatformSpec | null {
  const specs = specsForLine(self, stationId, lineId);
  if (!specs.length) return null;
  if (specs.length === 1) return specs[0];
  return direction > 0
    ? specs.reduce((best, item) => item.offset < best.offset ? item : best)
    : specs.reduce((best, item) => item.offset > best.offset ? item : best);
}

function pointAlong(spec: PlatformSpec, along: number, y = spec.y): RailPassengerPoint3D | null {
  const d = THREE.MathUtils.clamp(spec.centerD + along, 0, spec.smooth.length as number);
  const p = (RailRenderer.prototype as unknown as AnyRail).offsetPoint;
  void p;
  const sample = (spec as AnyRail).__self?.offsetPoint;
  void sample;
  return null;
}

function platformPoint(self: AnyRail, spec: PlatformSpec, along: number, y = spec.y): RailPassengerPoint3D | null {
  const d = THREE.MathUtils.clamp(spec.centerD + along, 0, spec.smooth.length as number);
  const p = self.offsetPoint(spec.smooth, d, spec.offset) as { x: number; z: number; heading: number } | null;
  return p ? { x: p.x, y, z: p.z } : null;
}

function cross(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

function connectionBetween(self: AnyRail, lower: PlatformSpec, upper: PlatformSpec): StairConnection | null {
  const ax = Math.cos(lower.heading), az = Math.sin(lower.heading);
  const bx = Math.cos(upper.heading), bz = Math.sin(upper.heading);
  const rx = upper.x - lower.x, rz = upper.z - lower.z;
  const den = cross(ax, az, bx, bz);
  let lowerAlong = 0;
  let upperAlong = 0;
  let ix = 0;
  let iz = 0;

  if (Math.abs(den) > 0.08) {
    lowerAlong = cross(rx, rz, bx, bz) / den;
    upperAlong = cross(rx, rz, ax, az) / den;
    const limitLower = Math.max(5, lower.length * 0.36);
    const limitUpper = Math.max(5, upper.length * 0.36);
    if (Math.abs(lowerAlong) > limitLower || Math.abs(upperAlong) > limitUpper) return null;
    const lx = lower.x + ax * lowerAlong, lz = lower.z + az * lowerAlong;
    const ux = upper.x + bx * upperAlong, uz = upper.z + bz * upperAlong;
    ix = (lx + ux) * 0.5;
    iz = (lz + uz) * 0.5;
  } else {
    const nx = -az, nz = ax;
    const separation = Math.abs(rx * nx + rz * nz);
    if (separation > 2.2) return null;
    lowerAlong = rx * ax + rz * az;
    const limitLower = Math.max(5, lower.length * 0.32);
    if (Math.abs(lowerAlong) > limitLower) lowerAlong = THREE.MathUtils.clamp(lowerAlong, -limitLower, limitLower);
    ix = lower.x + ax * lowerAlong * 0.5;
    iz = lower.z + az * lowerAlong * 0.5;
    upperAlong = (ix - upper.x) * bx + (iz - upper.z) * bz;
  }

  const lowerRoom = Math.max(1.35, lower.length * 0.43 - Math.abs(lowerAlong));
  const upperRoom = Math.max(1.35, upper.length * 0.43 - Math.abs(upperAlong));
  const lowerRun = Math.min(STAIR_HALF_RUN, lowerRoom);
  const upperRun = Math.min(STAIR_HALF_RUN, upperRoom);
  const lowerStart = {
    x: ix - ax * lowerRun,
    y: lower.y,
    z: iz - az * lowerRun,
  };
  const upperEnd = {
    x: ix + bx * upperRun,
    y: upper.y,
    z: iz + bz * upperRun,
  };
  const mid = { x: ix, y: (lower.y + upper.y) * 0.5, z: iz };
  const score = Math.hypot(ix - (lower.x + upper.x) * 0.5, iz - (lower.z + upper.z) * 0.5)
    + (Math.sign(lower.offset) === Math.sign(upper.offset) ? 0 : 3.0);
  return { lower, upper, lowerStart, mid, upperEnd, score };
}

function bestConnection(self: AnyRail, stationId: number, lowerLevel: Level, upper: PlatformSpec): StairConnection | null {
  let best: StairConnection | null = null;
  const preferredSide = Math.sign(upper.offset) || 1;
  for (const lineId of lowerLevel.lineIds) {
    const candidates = specsForLine(self, stationId, lineId)
      .sort((a, b) => (Math.sign(a.offset) === preferredSide ? -1 : 1) - (Math.sign(b.offset) === preferredSide ? -1 : 1));
    for (const lower of candidates) {
      const candidate = connectionBetween(self, lower, upper);
      if (candidate && (!best || candidate.score < best.score)) best = candidate;
    }
  }
  return best;
}

function connectionChain(self: AnyRail, stationId: number, target: PlatformSpec): StairConnection[] {
  const levels = stationLevels(self, stationId);
  let levelIndex = levels.findIndex((level) => level.lineIds.includes(target.lineId));
  if (levelIndex <= 0) return [];
  const reversed: StairConnection[] = [];
  let upper = target;
  while (levelIndex > 0) {
    const connection = bestConnection(self, stationId, levels[levelIndex - 1], upper);
    if (!connection) break;
    reversed.push(connection);
    upper = connection.lower;
    levelIndex--;
  }
  return reversed.reverse();
}

function groundEntrance(self: AnyRail, spec: PlatformSpec, near: RailPassengerPoint3D): RailPassengerPoint3D | null {
  const side = spec.offset >= 0 ? 1 : -1;
  const center = self.sampleSmooth(spec.smooth, spec.centerD) as { x: number; z: number; heading: number } | null;
  if (!center) return null;
  const roadHalf = self.roadHalfWidthAt(near.x, near.z, spec.heading) as number;
  const outerAbs = Math.max(Math.abs(spec.offset) + 4.0, roadHalf + 3.4);
  const outer = self.offsetPoint(spec.smooth, spec.centerD, side * outerAbs) as { x: number; z: number; heading: number } | null;
  if (!outer) return null;
  const along = Math.max(12, spec.y * 1.55);
  return {
    x: outer.x - Math.cos(outer.heading) * along,
    y: 0,
    z: outer.z - Math.sin(outer.heading) * along,
  };
}

function addFlight(self: AnyRail, from: RailPassengerPoint3D, to: RailPassengerPoint3D, stairs: StaticPart[]): void {
  const dx = to.x - from.x, dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz), rise = Math.abs(to.y - from.y);
  if (horizontal < 0.08 && rise < 0.08) return;
  const heading = horizontal > 0.01 ? Math.atan2(dz, dx) : 0;
  const steps = Math.max(5, Math.min(28, Math.ceil(Math.max(rise / 0.23, horizontal / 0.72))));
  const depth = Math.max(0.46, horizontal / Math.max(1, steps - 1) * 1.10);
  for (let i = 0; i < steps; i++) {
    const t = steps <= 1 ? 1 : i / (steps - 1);
    const x = THREE.MathUtils.lerp(from.x, to.x, t);
    const y = THREE.MathUtils.lerp(from.y, to.y, t);
    const z = THREE.MathUtils.lerp(from.z, to.z, t);
    stairs.push({ matrix: self.matrix(x, y - 0.09, z, depth, 0.18, 1.45, -heading) });
  }
}

function addLanding(self: AnyRail, point: RailPassengerPoint3D, stairs: StaticPart[]): void {
  stairs.push({ matrix: self.matrix(point.x, point.y - 0.11, point.z, 2.4, 0.20, 2.4) });
}

function nearestStationIndex(self: AnyRail, smooth: AnySmooth, distance: number): number {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < smooth.stationDistances.length; i++) {
    const delta = Math.abs((smooth.stationDistances[i] ?? 0) - distance);
    if (delta < bestD) { bestD = delta; best = i; }
  }
  if (best < 0) return -1;
  const stationId = smooth.line.stationIds[best];
  const half = (self.platformLength(stationId) as number) * 0.5 + 8;
  return bestD <= half ? best : -1;
}

function markOnce(stairs: StaticPart[], key: string): boolean {
  let keys = generatedByParts.get(stairs);
  if (!keys) { keys = new Set<string>(); generatedByParts.set(stairs, keys); }
  if (keys.has(key)) return false;
  keys.add(key);
  return true;
}

function fallbackSafeConnection(self: AnyRail, lower: PlatformSpec, upper: PlatformSpec): StairConnection {
  const lowerPoint = platformPoint(self, lower, 0) ?? { x: lower.x, y: lower.y, z: lower.z };
  const upperPoint = platformPoint(self, upper, 0) ?? { x: upper.x, y: upper.y, z: upper.z };
  const ax = Math.cos(lower.heading), az = Math.sin(lower.heading);
  const bx = Math.cos(upper.heading), bz = Math.sin(upper.heading);
  const lowerStart = { x: lowerPoint.x - ax * 2.2, y: lower.y, z: lowerPoint.z - az * 2.2 };
  const upperEnd = { x: upperPoint.x + bx * 2.2, y: upper.y, z: upperPoint.z + bz * 2.2 };
  const mid = {
    x: (lowerPoint.x + upperPoint.x) * 0.5,
    y: (lower.y + upper.y) * 0.5,
    z: (lowerPoint.z + upperPoint.z) * 0.5,
  };
  return { lower, upper, lowerStart, mid, upperEnd, score: 999 };
}

proto.buildPlatformAccess = function trainClearPlatformAccess(
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
    previousBuildPlatformAccess.call(this, smooth, distance, offset, direction, y, stairs);
    return;
  }
  const stationId = smooth.line.stationIds[stationIndex];
  const levels = stationLevels(this, stationId);
  if (levels.length <= 1) {
    previousBuildPlatformAccess.call(this, smooth, distance, offset, direction, y, stairs);
    return;
  }

  const lineId = smooth.line.id as number;
  const levelIndex = levels.findIndex((level) => level.lineIds.includes(lineId));
  const current = specForOffset(this, stationId, lineId, offset);
  if (!current || levelIndex < 0) return;
  const side = Math.sign(offset) || 1;
  const key = `safe-stair:${stationId}:${levelIndex}:${side}`;
  if (!markOnce(stairs, key)) return;

  if (levelIndex === 0) {
    const platform = platformPoint(this, current, -3.0) ?? { x: current.x, y: current.y, z: current.z };
    const entrance = groundEntrance(this, current, platform);
    if (entrance) addFlight(this, entrance, platform, stairs);
    return;
  }

  const connection = bestConnection(this, stationId, levels[levelIndex - 1], current);
  if (!connection) return;
  addFlight(this, connection.lowerStart, connection.mid, stairs);
  addLanding(this, connection.mid, stairs);
  addFlight(this, connection.mid, connection.upperEnd, stairs);
};

proto.passengerStationAccesses = function trainClearPassengerAccesses(
  this: AnyRail,
  stationId: number,
  lineId: number,
  direction: 1 | -1,
): RailPassengerStationAccess[] {
  const levels = stationLevels(this, stationId);
  if (levels.length <= 1) return previousPassengerStationAccesses.call(this, stationId, lineId, direction);
  const target = specForDirection(this, stationId, lineId, direction);
  if (!target) return [];
  const targetLevel = levels.findIndex((level) => level.lineIds.includes(lineId));
  const wait = platformPoint(this, target, 0) ?? { x: target.x, y: target.y, z: target.z };
  const chain = connectionChain(this, stationId, target);
  const length = target.length;

  if (targetLevel <= 0 || !chain.length) {
    const platform = platformPoint(this, target, -3.0) ?? wait;
    const entrance = groundEntrance(this, target, platform);
    if (!entrance) return [];
    return [{
      stationId, lineId, direction, heading: target.heading,
      entrance,
      stairTop: platform,
      concourse: platform,
      platformLanding: platform,
      platformWait: wait,
      waitSpan: Math.max(8, length * 0.46),
    }];
  }

  const first = chain[0];
  const entrance = groundEntrance(this, first.lower, first.lowerStart);
  if (!entrance) return [];
  if (chain.length === 1) {
    return [{
      stationId, lineId, direction, heading: target.heading,
      entrance,
      stairTop: first.lowerStart,
      concourse: first.mid,
      platformLanding: first.upperEnd,
      platformWait: wait,
      waitSpan: Math.max(8, length * 0.46),
    }];
  }

  const last = chain[chain.length - 1];
  const middleStart = first.upperEnd;
  const middleEnd = last.lowerStart;
  const middle = {
    x: (middleStart.x + middleEnd.x) * 0.5,
    y: middleStart.y,
    z: (middleStart.z + middleEnd.z) * 0.5,
  };
  return [{
    stationId, lineId, direction, heading: target.heading,
    entrance,
    stairTop: first.mid,
    concourse: middle,
    platformLanding: last.mid,
    platformWait: wait,
    waitSpan: Math.max(8, length * 0.46),
  }];
};
