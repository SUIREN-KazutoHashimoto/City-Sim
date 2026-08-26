import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';
import './RailPassengerStationAccess';
import type { RailPassengerStationAccess } from './RailPassengerStationAccess';

type AnyRail = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const MIN_SAFE_WAIT_SPAN = 8;
const MAX_TANGENT_ERROR = 0.85;

function safeSpan(self: AnyRail, access: RailPassengerStationAccess): number {
  const smooth = self.smoothLines?.get(access.lineId);
  const line = self.rail?.lines?.[access.lineId];
  if (!smooth || !line) return access.waitSpan;
  const stationIndex = line.stationIds.indexOf(access.stationId);
  if (stationIndex < 0) return access.waitSpan;
  const centerD = smooth.stationDistances[stationIndex] ?? 0;
  const center = self.sampleSmooth(smooth, centerD) as { x: number; z: number; heading: number } | null;
  if (!center) return access.waitSpan;

  const nx = -Math.sin(center.heading), nz = Math.cos(center.heading);
  const offset = (access.platformWait.x - center.x) * nx + (access.platformWait.z - center.z) * nz;
  const baseX = center.x + nx * offset;
  const baseZ = center.z + nz * offset;
  let candidate = Math.max(MIN_SAFE_WAIT_SPAN, access.waitSpan);

  while (candidate > MIN_SAFE_WAIT_SPAN + 0.01) {
    const half = candidate * 0.5;
    let maxError = 0;
    for (const sign of [-1, 1]) {
      const d = THREE.MathUtils.clamp(centerD + sign * half, 0, smooth.length as number);
      const actual = self.offsetPoint(smooth, d, offset) as { x: number; z: number } | null;
      if (!actual) continue;
      const predictedX = baseX + Math.cos(center.heading) * sign * half;
      const predictedZ = baseZ + Math.sin(center.heading) * sign * half;
      maxError = Math.max(maxError, Math.hypot(actual.x - predictedX, actual.z - predictedZ));
    }
    if (maxError <= MAX_TANGENT_ERROR) return candidate;
    candidate = Math.max(MIN_SAFE_WAIT_SPAN, candidate * 0.72);
  }
  return MIN_SAFE_WAIT_SPAN;
}

const proto = RailRenderer.prototype as unknown as AnyRail;
if (!proto.__citySimCurvedPlatformPassengerV102) {
  const previous = proto.passengerStationAccesses as AnyMethod;
  if (typeof previous === 'function') {
    proto.passengerStationAccesses = function passengerStationAccessesWithCurveSafeWait(
      this: AnyRail,
      stationId: number,
      lineId: number,
      direction: 1 | -1,
    ): RailPassengerStationAccess[] {
      const accesses = previous.call(this, stationId, lineId, direction) as RailPassengerStationAccess[];
      return accesses.map((access) => {
        const waitSpan = Math.min(access.waitSpan, safeSpan(this, access));
        return waitSpan < access.waitSpan ? { ...access, waitSpan } : access;
      });
    };
  }
  proto.__citySimCurvedPlatformPassengerV102 = true;
}
