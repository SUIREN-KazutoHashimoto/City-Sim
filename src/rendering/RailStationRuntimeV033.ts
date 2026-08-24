import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';
import './RailStationOperationsTuning';

type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };

const TIMETABLE_QUANTUM = 15;
const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 10.4;

function quantizeUp(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return seconds;
  return Math.ceil((seconds - 1e-6) / TIMETABLE_QUANTUM) * TIMETABLE_QUANTUM;
}

// Keep the class-level value aligned for any base methods that still read it dynamically.
const ctor = RailRenderer as unknown as { SIDING_OFFSET: number };
ctor.SIDING_OFFSET = SIDING_OFFSET;

const proto = RailRenderer.prototype as unknown as AnyRail;
if (!proto.__citySimStationRuntimeV033) {
  proto.__citySimStationRuntimeV033 = true;

  const baseDwell = proto.dwellSeconds as ((run: AnyRun, stationId: number) => number) | undefined;
  if (baseDwell) {
    proto.dwellSeconds = function quantizedDwell(this: AnyRail, run: AnyRun, stationId: number): number {
      const raw = baseDwell.call(this, run, stationId);
      if (run.deadhead) return raw;
      return Math.max(TIMETABLE_QUANTUM, quantizeUp(Math.max(0, raw)));
    };
  }

  const baseEnter = proto.enterPlannedRoute as ((run: AnyRun, plan: unknown) => void) | undefined;
  if (baseEnter) {
    proto.enterPlannedRoute = function quantizedArrival(this: AnyRail, run: AnyRun, plan: unknown): void {
      baseEnter.call(this, run, plan);
      if (run.scheduledArrivalAt > 0) run.scheduledArrivalAt = quantizeUp(run.scheduledArrivalAt);
    };
  }

  const baseStop = proto.stopAtStation as ((run: AnyRun, stationIndex: number, stationId: number) => void) | undefined;
  if (baseStop) {
    proto.stopAtStation = function quantizedStationStop(this: AnyRail, run: AnyRun, stationIndex: number, stationId: number): void {
      baseStop.call(this, run, stationIndex, stationId);
      if (run.scheduledArrivalAt > 0) run.scheduledArrivalAt = quantizeUp(run.scheduledArrivalAt);
      if (run.scheduledDepartureAt > 0) run.scheduledDepartureAt = quantizeUp(run.scheduledDepartureAt);
    };
  }

  const baseRelease = proto.tryReleaseDepotTrain as ((run: AnyRun) => void) | undefined;
  if (baseRelease) {
    proto.tryReleaseDepotTrain = function quantizedDepotRelease(this: AnyRail, run: AnyRun): void {
      baseRelease.call(this, run);
      if (run.state !== 'depot' && run.scheduledDepartureAt > 0) run.scheduledDepartureAt = quantizeUp(run.scheduledDepartureAt);
    };
  }

  // The island-platform architecture already uses 10.4 m for the outside/siding track. Force the
  // actual siding rail geometry to use that same value instead of relying on a mutable private static
  // field. This removes the old 8.0 m geometry path that placed the outside track inside the platform.
  proto.buildSidings = function alignedBuildSidings(
    this: AnyRail,
    smooth: AnySmooth,
    center: number,
    platformLength: number,
    y: number,
    ballast: StaticPart[],
    rails: StaticPart[],
  ): void {
    const half = platformLength * 0.5;
    const switchClearance = 16;
    const switchApproach = 52;
    const start = Math.max(0, center - half - switchClearance - switchApproach);
    const end = Math.min(smooth.length, center + half + switchClearance + switchApproach);

    for (const side of [-1, 1] as const) {
      let prev: { x: number; z: number } | null = null;
      for (let s = start; s <= end + 0.01;) {
        const p = this.sampleSmooth(smooth, s) as { x: number; z: number; heading: number } | null;
        if (!p) break;
        const profile = this.sidingProfile(Math.abs(s - center), half) as number;
        const off = side * (MAIN_OFFSET + (SIDING_OFFSET - MAIN_OFFSET) * profile);
        const q = {
          x: p.x - Math.sin(p.heading) * off,
          z: p.z + Math.cos(p.heading) * off,
        };
        if (prev) this.pushTrackSegment(prev, q, y, ballast, rails, 3.35);
        prev = q;
        if (s >= end - 1e-6) break;
        s = Math.min(end, s + 4.5);
      }
    }
  };

  // Force local trains onto the exact same 10.4 m siding profile used by the rail and island
  // platform geometry. The previous implementation could still resolve to the legacy 8.0 m value,
  // which makes a 3.08 m-wide train occupy roughly half of the 4.0-4.4 m island platform.
  const baseTrainTrackOffset = proto.trainTrackOffset as ((run: AnyRun, smooth: AnySmooth, distance: number) => number) | undefined;
  if (baseTrainTrackOffset) {
    proto.trainTrackOffset = function alignedSidingTrainTrackOffset(
      this: AnyRail,
      run: AnyRun,
      smooth: AnySmooth,
      distance: number,
    ): number {
      const base = baseTrainTrackOffset.call(this, run, smooth, distance);
      if (smooth.line?.kind !== 'trunk' || run.service !== 'local') return base;

      let profile = 0;
      const stationDistances = smooth.stationDistances as number[];
      const stationIds = smooth.line.stationIds as number[];
      for (let i = 1; i < stationDistances.length - 1; i++) {
        if (!this.lineStationHasPassingLoop(run.lineId, i)) continue;
        const stationId = stationIds[i];
        const half = (this.platformLength(stationId) as number) * 0.5;
        profile = Math.max(profile, this.sidingProfile(Math.abs(distance - stationDistances[i]), half) as number);
      }
      if (profile <= 0.0001) return base;

      let laneValue = this.laneValueAt(run, smooth, distance) as number;
      if (Math.abs(laneValue) < 0.05) laneValue = run.direction as number;
      const sign = laneValue >= 0 ? 1 : -1;
      return sign * (MAIN_OFFSET + (SIDING_OFFSET - MAIN_OFFSET) * profile);
    };
  }
}
