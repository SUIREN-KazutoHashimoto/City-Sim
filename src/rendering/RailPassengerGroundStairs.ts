import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';
import type { RailPassengerPoint3D, RailPassengerStationAccess } from './RailPassengerStationAccess';

type AnyRail = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };
type Route = { entrance: RailPassengerPoint3D; outerTop: RailPassengerPoint3D; innerTop: RailPassengerPoint3D; platform: RailPassengerPoint3D };

const proto = RailRenderer.prototype as unknown as AnyRail;
const previousBuild = proto.buildPlatformAccess as (smooth: AnySmooth, distance: number, offset: number, direction: -1 | 1, y: number, stairs: StaticPart[]) => void;
const previousAccesses = proto.passengerStationAccesses as (stationId: number, lineId: number, direction: 1 | -1) => RailPassengerStationAccess[];
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
  const p = self.offsetPoint(smooth, THREE.MathUtils.clamp(d, 0, smooth.length as number), offset) as { x: number; z: number } | null;
  return p ? { x: p.x, y, z: p.z } : null;
}

function route(self: AnyRail, smooth: AnySmooth, centerD: number, offset: number, platformY: number): Route | null {
  const side = offset >= 0 ? 1 : -1;
  const clearY = THREE.MathUtils.clamp(platformY - 3.2, 4.6, 5.3);
  const upperRun = Math.max(8, (platformY - clearY) * 2.7);
  const platformD = centerD + side * 4;
  const innerD = centerD - side * upperRun;
  const platform = point(self, smooth, platformD, offset, platformY);
  const innerTop = point(self, smooth, innerD, offset, clearY);
  if (!platform || !innerTop) return null;
  const heading = self.sampleSmooth(smooth, innerD)?.heading ?? 0;
  const roadHalf = self.roadHalfWidthAt(innerTop.x, innerTop.z, heading) as number;
  const sidewalkOffset = side * Math.max(Math.abs(offset) + 3.6, roadHalf + 3.0);
  const outerTop = point(self, smooth, innerD, sidewalkOffset, clearY);
  const entrance = point(self, smooth, innerD + side * Math.max(11, clearY * 2.35), sidewalkOffset, 0);
  return outerTop && entrance ? { entrance, outerTop, innerTop, platform } : null;
}

function flight(self: AnyRail, a: RailPassengerPoint3D, b: RailPassengerPoint3D, stairs: StaticPart[]): void {
  const dx = b.x - a.x, dz = b.z - a.z, horizontal = Math.hypot(dx, dz), rise = Math.abs(b.y - a.y);
  const heading = horizontal > 0.01 ? Math.atan2(dz, dx) : 0;
  const steps = Math.max(5, Math.min(28, Math.ceil(Math.max(rise / 0.23, horizontal / 0.72))));
  const depth = Math.max(0.46, horizontal / Math.max(1, steps - 1) * 1.1);
  for (let i = 0; i < steps; i++) {
    const t = steps <= 1 ? 1 : i / (steps - 1);
    stairs.push({ matrix: self.matrix(THREE.MathUtils.lerp(a.x, b.x, t), THREE.MathUtils.lerp(a.y, b.y, t) - 0.09, THREE.MathUtils.lerp(a.z, b.z, t), depth, 0.18, 1.45, -heading) });
  }
}

function bridge(self: AnyRail, a: RailPassengerPoint3D, b: RailPassengerPoint3D, stairs: StaticPart[]): void {
  const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  if (length < 0.1) return;
  stairs.push({ matrix: self.matrix((a.x + b.x) * 0.5, a.y - 0.12, (a.z + b.z) * 0.5, length, 0.24, 1.9, -Math.atan2(dz, dx)) });
}

function once(stairs: StaticPart[], key: string): boolean {
  let set = generated.get(stairs); if (!set) { set = new Set<string>(); generated.set(stairs, set); }
  if (set.has(key)) return false; set.add(key); return true;
}

proto.buildPlatformAccess = function groundStairs(this: AnyRail, smooth: AnySmooth, distance: number, offset: number, direction: -1 | 1, y: number, stairs: StaticPart[]): void {
  const i = nearestStation(this, smooth, distance);
  const stationId = i >= 0 ? smooth.line.stationIds[i] : -1;
  const lineId = smooth.line.id as number;
  if (stationId < 0 || !isLowestLevel(this, stationId, lineId)) { previousBuild.call(this, smooth, distance, offset, direction, y, stairs); return; }
  const side = offset >= 0 ? 1 : -1;
  if (!once(stairs, `${stationId}:${lineId}:${side}`)) return;
  const r = route(this, smooth, smooth.stationDistances[i] ?? distance, offset, y + 0.60);
  if (!r) return;
  flight(this, r.entrance, r.outerTop, stairs);
  bridge(this, r.outerTop, r.innerTop, stairs);
  flight(this, r.innerTop, r.platform, stairs);
};

proto.passengerStationAccesses = function groundPassengerAccess(this: AnyRail, stationId: number, lineId: number, direction: 1 | -1): RailPassengerStationAccess[] {
  const old = previousAccesses.call(this, stationId, lineId, direction);
  if (!isLowestLevel(this, stationId, lineId) || !old.length) return old;
  const smooth = this.smoothLines.get(lineId) as AnySmooth | undefined;
  const i = stationIndex(this, lineId, stationId);
  if (!smooth || i < 0) return old;
  const center = this.sampleSmooth(smooth, smooth.stationDistances[i] ?? 0) as { x: number; z: number; heading: number } | null;
  if (!center) return old;
  const wait = old[0].platformWait;
  const nx = -Math.sin(center.heading), nz = Math.cos(center.heading);
  const offset = (wait.x - center.x) * nx + (wait.z - center.z) * nz;
  const r = route(this, smooth, smooth.stationDistances[i] ?? 0, offset, old[0].platformWait.y);
  if (!r) return old;
  return [{ ...old[0], entrance: r.entrance, stairTop: r.outerTop, concourse: r.innerTop, platformLanding: r.platform }];
};
