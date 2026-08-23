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

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;
const TRAIN_HALF_WIDTH = 2.86 * 0.5;
const PLATFORM_CLEARANCE = 0.48;
const UPPER_STAIR_RUN = 8.5;
const proto = RailRenderer.prototype as unknown as AnyRail;
const originalBuildPlatformAccess = proto.buildPlatformAccess as (
  smooth: AnySmooth,
  distance: number,
  offset: number,
  direction: -1 | 1,
  y: number,
  stairs: StaticPart[],
) => void;

function platformOffset(self: AnyRail, lineId: number, stationIndex: number, direction: 1 | -1): number | null {
  const line = self.rail.lines[lineId];
  const smooth = self.smoothLines.get(lineId) as AnySmooth | undefined;
  if (!line || !smooth) return null;
  const stationId = line.stationIds[stationIndex] ?? -1;
  const station = stationId >= 0 ? self.rail.stations[stationId] : null;
  if (!station) return null;
  const width = station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter ? 4.2 : 3.8;
  if (line.kind === 'trunk' && self.lineStationHasPassingLoop(lineId, stationIndex)) {
    return -direction * ((MAIN_OFFSET + SIDING_OFFSET) * 0.5);
  }
  if (line.kind === 'trunk') {
    const outer = MAIN_OFFSET + TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5;
    return -direction * outer;
  }
  const center = smooth.stationDistances[stationIndex] ?? 0;
  const track = self.sharedSpurOffset(smooth, center) as number;
  const side = track >= 0 ? 1 : -1;
  return track + side * (TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5);
}

function makeAccess(
  self: AnyRail,
  smooth: AnySmooth,
  stationId: number,
  lineId: number,
  direction: 1 | -1,
  distance: number,
  platformCenter: number,
  platformLength: number,
  offset: number,
  groundDirection: -1 | 1,
  y: number,
): RailPassengerStationAccess | null {
  const anchor = self.offsetPoint(smooth, distance, offset) as { x: number; z: number; heading: number } | null;
  if (!anchor) return null;
  const side = offset >= 0 ? 1 : -1;
  const roadHalf = self.roadHalfWidthAt(anchor.x, anchor.z, anchor.heading) as number;
  const outerAbs = Math.max(Math.abs(offset) + 3.3, roadHalf + 3.2);
  const outer = self.offsetPoint(smooth, distance, side * outerAbs) as { x: number; z: number; heading: number } | null;
  if (!outer) return null;

  const concourseY = Math.max(4.4, y - 2.9);
  const platformY = y + 0.60;
  const groundRun = Math.max(15.5, concourseY * 2.6);
  const entrance = {
    x: outer.x + Math.cos(outer.heading) * groundDirection * groundRun,
    y: 0,
    z: outer.z + Math.sin(outer.heading) * groundDirection * groundRun,
  };
  const landingDistance = THREE.MathUtils.clamp(distance - groundDirection * UPPER_STAIR_RUN, 0, smooth.length as number);
  const landing = self.offsetPoint(smooth, landingDistance, offset) as { x: number; z: number; heading: number } | null;
  const wait = self.offsetPoint(smooth, platformCenter, offset) as { x: number; z: number; heading: number } | null;
  if (!landing || !wait) return null;

  return {
    stationId,
    lineId,
    direction,
    heading: wait.heading,
    entrance,
    stairTop: { x: outer.x, y: concourseY, z: outer.z },
    concourse: { x: anchor.x, y: concourseY, z: anchor.z },
    platformLanding: { x: landing.x, y: platformY, z: landing.z },
    platformWait: { x: wait.x, y: platformY, z: wait.z },
    waitSpan: Math.max(8, platformLength * 0.46),
  };
}

proto.passengerStationAccesses = function passengerStationAccesses(
  this: AnyRail,
  stationId: number,
  lineId: number,
  direction: 1 | -1,
): RailPassengerStationAccess[] {
  const line = this.rail.lines[lineId];
  const smooth = this.smoothLines.get(lineId) as AnySmooth | undefined;
  if (!line || !smooth) return [];
  const stationIndex = line.stationIds.indexOf(stationId);
  if (stationIndex < 0) return [];
  const offset = platformOffset(this, lineId, stationIndex, direction);
  if (offset == null) return [];
  const center = smooth.stationDistances[stationIndex] ?? 0;
  const length = this.platformLength(stationId) as number;
  const start = Math.max(0, center - length * 0.5);
  const end = Math.min(smooth.length as number, center + length * 0.5);
  const y = this.lineTrackY(lineId) as number;
  const out: RailPassengerStationAccess[] = [];
  const a = makeAccess(this, smooth, stationId, lineId, direction, start + 3, center, length, offset, -1, y);
  const b = makeAccess(this, smooth, stationId, lineId, direction, end - 3, center, length, offset, 1, y);
  if (a) out.push(a);
  if (b) out.push(b);
  return out;
};

// 既存の地上階段はコンコース高さでホーム直下へ接続していた。
// 旅客導線と見た目を一致させるため、コンコースからホーム面へ上がる短い階段を追加する。
if (!proto.__railPassengerUpperStairsPatched && originalBuildPlatformAccess) {
  proto.__railPassengerUpperStairsPatched = true;
  proto.buildPlatformAccess = function patchedBuildPlatformAccess(
    this: AnyRail,
    smooth: AnySmooth,
    distance: number,
    offset: number,
    direction: -1 | 1,
    y: number,
    stairs: StaticPart[],
  ): void {
    originalBuildPlatformAccess.call(this, smooth, distance, offset, direction, y, stairs);
    const concourseY = Math.max(4.4, y - 2.9);
    const platformY = y + 0.58;
    const baseY = concourseY - 0.08;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const d = THREE.MathUtils.clamp(distance - direction * UPPER_STAIR_RUN * t, 0, smooth.length as number);
      const p = this.offsetPoint(smooth, d, offset) as { x: number; z: number; heading: number } | null;
      if (!p) continue;
      const top = THREE.MathUtils.lerp(concourseY + 0.10, platformY, t);
      const height = Math.max(0.16, top - baseY);
      stairs.push({ matrix: this.matrix(p.x, baseY + height * 0.5, p.z, 1.35, height, 2.35, -p.heading) });
    }
  };
}
