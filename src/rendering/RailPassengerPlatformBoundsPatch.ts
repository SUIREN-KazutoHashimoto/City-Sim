import { RailRenderer } from './RailRenderer';
import './RailPassengerStationAccess';
import type { RailPassengerStationAccess } from './RailPassengerStationAccess';

type AnySmooth = { stationDistances: number[]; length: number };
type AnyRail = {
  rail: {
    lines: Array<{ id: number; stationIds: number[] }>;
  };
  smoothLines: Map<number, AnySmooth>;
  platformLength(stationId: number): number;
  offsetPoint(
    smooth: AnySmooth,
    distance: number,
    offset: number,
  ): { x: number; z: number; heading: number } | null;
};

type AccessMethod = (
  this: AnyRail,
  stationId: number,
  lineId: number,
  direction: 1 | -1,
) => RailPassengerStationAccess[];

type AccessProvider = {
  passengerStationAccesses: AccessMethod;
  __passengerPlatformBoundsPatched?: boolean;
};

function lineFor(self: AnyRail, lineId: number): { id: number; stationIds: number[] } | null {
  const direct = self.rail.lines[lineId];
  if (direct?.id === lineId) return direct;
  return self.rail.lines.find((line) => line?.id === lineId) ?? null;
}

function boundAccessToRenderedPlatform(
  self: AnyRail,
  stationId: number,
  lineId: number,
  access: RailPassengerStationAccess,
): RailPassengerStationAccess {
  const line = lineFor(self, lineId);
  const smooth = self.smoothLines.get(lineId);
  if (!line || !smooth) return access;
  const stationIndex = line.stationIds.indexOf(stationId);
  if (stationIndex < 0) return access;

  const center = Math.max(0, Math.min(smooth.length, smooth.stationDistances[stationIndex] ?? 0));
  const platformLength = Math.max(4, self.platformLength(stationId));
  const safetyMargin = Math.min(6, platformLength * 0.08);
  let start = Math.max(0, center - platformLength * 0.5 + safetyMargin);
  let end = Math.min(smooth.length, center + platformLength * 0.5 - safetyMargin);

  // Terminal/edge stations have an asymmetric physical platform because the track itself ends.
  // Keep the passenger distribution inside the actually drawable interval rather than around the
  // nominal station centre, which may be exactly at the end of the smooth line.
  if (end - start < 2) {
    start = Math.max(0, center - 1);
    end = Math.min(smooth.length, center + 1);
  }
  if (end <= start) return access;

  const centerTrack = self.offsetPoint(smooth, center, 0);
  const unitOffsetTrack = self.offsetPoint(smooth, center, 1);
  if (!centerTrack || !unitOffsetTrack) return access;
  const ox = unitOffsetTrack.x - centerTrack.x;
  const oz = unitOffsetTrack.z - centerTrack.z;
  const denom = ox * ox + oz * oz;
  if (denom < 1e-6) return access;

  const platformOffset = ((access.platformWait.x - centerTrack.x) * ox
    + (access.platformWait.z - centerTrack.z) * oz) / denom;
  const waitDistance = (start + end) * 0.5;
  const wait = self.offsetPoint(smooth, waitDistance, platformOffset);
  if (!wait) return access;

  return {
    ...access,
    heading: wait.heading,
    platformWait: { x: wait.x, y: access.platformWait.y, z: wait.z },
    waitSpan: end - start,
  };
}

const proto = RailRenderer.prototype as unknown as AccessProvider;
if (!proto.__passengerPlatformBoundsPatched && proto.passengerStationAccesses) {
  proto.__passengerPlatformBoundsPatched = true;
  const original = proto.passengerStationAccesses;
  proto.passengerStationAccesses = function boundedPassengerStationAccesses(
    this: AnyRail,
    stationId: number,
    lineId: number,
    direction: 1 | -1,
  ): RailPassengerStationAccess[] {
    return original.call(this, stationId, lineId, direction)
      .map((access) => boundAccessToRenderedPlatform(this, stationId, lineId, access));
  };
}
