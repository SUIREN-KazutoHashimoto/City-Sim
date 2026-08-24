import { RailRenderer } from './RailRenderer';
import './RailStationOperationsTuning';

type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;

const TIMETABLE_QUANTUM = 15;
const SIDING_OFFSET = 10.4;

function quantizeUp(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return seconds;
  return Math.ceil((seconds - 1e-6) / TIMETABLE_QUANTUM) * TIMETABLE_QUANTUM;
}

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
}
