import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';
import type { RailPassengerPoint3D, RailPassengerStationAccess } from './RailPassengerStationAccess';

type AnyRail = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };
type Route = {
  entrance: RailPassengerPoint3D;
  stairTop: RailPassengerPoint3D;
  bridgeMid: RailPassengerPoint3D;
  platform: RailPassengerPoint3D;
};

const proto = RailRenderer.prototype as unknown as AnyRail;
const previousBuild = proto.buildPlatformAccess as (
  smooth: AnySmooth,
  distance: number,
  offset: number,
  direction: -1 | 1,
  y: number,
  stairs: StaticPart[],
) => void;
const previousAccesses = proto.passengerStationAccesses as (
  stationId: number,
  lineId: number,
  direction: 1 | -1,
) => RailPassengerStationAccess[];
const generated = new WeakMap<object, Set<string>>();

function stationIndex(self: AnyRail, lineId: number, stationId: number): number {
  return self.rail.lines[lineId]?.stationIds.indexOf(stationId) ?? -1;
}

function nearestStation(self: AnyRail, smooth: AnySmooth, distance: number): number {
  let best = -1, delta = Infinity;
  for (let i = 0; i < smooth.stationDistances.length; i++) {
    const d = Math.abs((smooth.stationDistances[i] ?? 0) - distance);
    if (d < delta) { delta = d; best = i; }
  }
  if (best < 0) return -1;
  const id = smooth.line.stationIds[best];
  return delta <= (self.platformLength(id) as number) * 0.5 + 8 ? best : -1;
}

function isLowestLevel(self: AnyRail, stationId: number, lineId: number): boolean {
  const station = self.rail.stations[stationId];
  if (!station || station.lineIds.length <= 1) return false;
  const ys = (station.lineIds as number[])
    .filter((id) => stationIndex(self, id, stationId) >= 0)
    .map((id) => self.lineTrackY(id) as number);
  return ys.length > 1 && (self.lineTrackY(lineId) as number) <= Math.min(...ys) + 0.25;
}

function point(self: AnyRail, smooth: AnySmooth, d: number, offset: number, y: number): RailPassengerPoint3D | null {
  const p = self.offsetPoint(
    smooth,
    THREE.MathUtils.clamp(d, 0, smooth.length as number),
    offset,
  ) as { x: number; z: number } | null;
  return p ? { x: p.x, y, z: p.z } : null;
}

/**
 * 最下層ホームから地上へのアクセス。
 *
 * 道路上では高度を一切下げない。
 * まずホーム高さの水平通路で道路外側まで逃がし、
 * 道路外側に出てから線路方向に階段を降ろす。
 */
function route(
  self: AnyRail,
  smooth: AnySmooth,
  centerD: number,
  offset: number,
  platformY: number,
): Route | null {
  const side = offset >= 0 ? 1 : -1;
  const platformD = THREE.MathUtils.clamp(centerD + side * 4, 0, smooth.length as number);
  const platform = point(self, smooth, platformD, offset, platformY);
  if (!platform) return null;

  const heading = self.sampleSmooth(smooth, platformD)?.heading ?? 0;
  const roadHalf = self.roadHalfWidthAt(platform.x, platform.z, heading) as number;

  // 階段幅を含めても車道へはみ出さないよう、道路端から十分外へ出す。
  const sidewalkOffset = side * Math.max(Math.abs(offset) + 3.8, roadHalf + 3.6);
  const stairTop = point(self, smooth, platformD, sidewalkOffset, platformY);
  if (!stairTop) return null;

  // 地上階段は道路と平行に、道路外だけで高低差を処理する。
  const stairRun = Math.max(18, platformY * 2.45);
  const entranceD = THREE.MathUtils.clamp(platformD + side * stairRun, 0, smooth.length as number);
  const entrance = point(self, smooth, entranceD, sidewalkOffset, 0);
  if (!entrance) return null;

  const bridgeMid = {
    x: (stairTop.x + platform.x) * 0.5,
    y: platformY,
    z: (stairTop.z + platform.z) * 0.5,
  };
  return { entrance, stairTop, bridgeMid, platform };
}

function flight(self: AnyRail, a: RailPassengerPoint3D, b: RailPassengerPoint3D, stairs: StaticPart[]): void {
  const dx = b.x - a.x, dz = b.z - a.z;
  const horizontal = Math.hypot(dx, dz), rise = Math.abs(b.y - a.y);
  if (horizontal < 0.08 && rise < 0.08) return;
  const heading = horizontal > 0.01 ? Math.atan2(dz, dx) : 0;
  const steps = Math.max(5, Math.min(36, Math.ceil(Math.max(rise / 0.23, horizontal / 0.72))));
  const depth = Math.max(0.46, horizontal / Math.max(1, steps - 1) * 1.1);
  for (let i = 0; i < steps; i++) {
    const t = steps <= 1 ? 1 : i / (steps - 1);
    stairs.push({
      matrix: self.matrix(
        THREE.MathUtils.lerp(a.x, b.x, t),
        THREE.MathUtils.lerp(a.y, b.y, t) - 0.09,
        THREE.MathUtils.lerp(a.z, b.z, t),
        depth,
        0.18,
        1.45,
        -heading,
      ),
    });
  }
}

function bridge(self: AnyRail, a: RailPassengerPoint3D, b: RailPassengerPoint3D, stairs: StaticPart[]): void {
  const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  if (length < 0.1) return;
  stairs.push({
    matrix: self.matrix(
      (a.x + b.x) * 0.5,
      a.y - 0.12,
      (a.z + b.z) * 0.5,
      length,
      0.24,
      1.9,
      -Math.atan2(dz, dx),
    ),
  });
}

function once(stairs: StaticPart[], key: string): boolean {
  let set = generated.get(stairs);
  if (!set) {
    set = new Set<string>();
    generated.set(stairs, set);
  }
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

proto.buildPlatformAccess = function groundStairs(
  this: AnyRail,
  smooth: AnySmooth,
  distance: number,
  offset: number,
  direction: -1 | 1,
  y: number,
  stairs: StaticPart[],
): void {
  const i = nearestStation(this, smooth, distance);
  const stationId = i >= 0 ? smooth.line.stationIds[i] : -1;
  const lineId = smooth.line.id as number;
  if (stationId < 0 || !isLowestLevel(this, stationId, lineId)) {
    previousBuild.call(this, smooth, distance, offset, direction, y, stairs);
    return;
  }

  const side = offset >= 0 ? 1 : -1;
  if (!once(stairs, `${stationId}:${lineId}:${side}`)) return;
  const r = route(this, smooth, smooth.stationDistances[i] ?? distance, offset, y + 0.60);
  if (!r) return;

  // 道路外だけで上り下りし、道路上はホーム高さの水平通路だけにする。
  flight(this, r.entrance, r.stairTop, stairs);
  bridge(this, r.stairTop, r.platform, stairs);
};

proto.passengerStationAccesses = function groundPassengerAccess(
  this: AnyRail,
  stationId: number,
  lineId: number,
  direction: 1 | -1,
): RailPassengerStationAccess[] {
  const old = previousAccesses.call(this, stationId, lineId, direction);
  if (!isLowestLevel(this, stationId, lineId) || !old.length) return old;

  const smooth = this.smoothLines.get(lineId) as AnySmooth | undefined;
  const i = stationIndex(this, lineId, stationId);
  if (!smooth || i < 0) return old;
  const center = this.sampleSmooth(
    smooth,
    smooth.stationDistances[i] ?? 0,
  ) as { x: number; z: number; heading: number } | null;
  if (!center) return old;

  const wait = old[0].platformWait;
  const nx = -Math.sin(center.heading), nz = Math.cos(center.heading);
  const offset = (wait.x - center.x) * nx + (wait.z - center.z) * nz;
  const r = route(this, smooth, smooth.stationDistances[i] ?? 0, offset, wait.y);
  if (!r) return old;

  return [{
    ...old[0],
    entrance: r.entrance,
    stairTop: r.stairTop,
    concourse: r.bridgeMid,
    platformLanding: r.platform,
  }];
};
