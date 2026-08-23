import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer, type TrainService } from './RailRenderer';

export interface RailBoardingTrainSnapshot {
  trainId: number;
  lineId: number;
  stationId: number;
  direction: 1 | -1;
  service: TrainService;
  capacity: number;
  stopsAhead: number[];
  x: number;
  z: number;
}

export interface RailPassengerTrainPosition {
  id: number;
  x: number;
  z: number;
  heading: number;
}

declare module './RailRenderer' {
  interface RailRenderer {
    boardingTrains(): RailBoardingTrainSnapshot[];
    passengerTrainPosition(id: number): RailPassengerTrainPosition | null;
  }
}

type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;
const proto = RailRenderer.prototype as unknown as AnyRail;

proto.boardingTrains = function boardingTrains(this: AnyRail): RailBoardingTrainSnapshot[] {
  const out: RailBoardingTrainSnapshot[] = [];
  for (const run of this.trainRuns as AnyRun[]) {
    if (run.state === 'depot' || run.state === 'running' || run.currentStationIndex < 0) continue;
    const line = this.rail.lines[run.lineId];
    if (!line || line.stationIds.length < 2) continue;
    const currentIndex = run.currentStationIndex as number;
    const stationId = line.stationIds[currentIndex] ?? -1;
    if (stationId < 0) continue;

    const station = this.rail.stations[stationId];
    const scheduledStop = station?.kind === RailStationKind.Terminal || this.shouldStop(run, currentIndex);
    // 通過列車が信号で駅位置に止められているだけの場合は乗降扱いにしない。
    if (!scheduledStop) continue;

    let direction = run.direction as 1 | -1;
    const last = line.stationIds.length - 1;
    if (currentIndex === last && direction > 0) direction = -1;
    else if (currentIndex === 0 && direction < 0) direction = 1;

    const stopsAhead: number[] = [];
    for (let i = currentIndex + direction; i >= 0 && i <= last; i += direction) {
      const sid = line.stationIds[i] ?? -1;
      if (sid < 0) continue;
      const target = this.rail.stations[sid];
      if (target?.kind === RailStationKind.Terminal || this.shouldStop(run, i)) stopsAhead.push(sid);
    }
    if (!stopsAhead.length) continue;

    out.push({
      trainId: run.id,
      lineId: run.lineId,
      stationId,
      direction,
      service: run.service,
      capacity: Math.max(80, run.carCount * 120),
      stopsAhead,
      x: run.x,
      z: run.z,
    });
  }
  return out;
};

proto.passengerTrainPosition = function passengerTrainPosition(this: RailRenderer, id: number): RailPassengerTrainPosition | null {
  const status = this.trainStatus(id);
  if (!status || status.state === 'depot') return null;
  return { id: status.id, x: status.x, z: status.z, heading: status.heading };
};
