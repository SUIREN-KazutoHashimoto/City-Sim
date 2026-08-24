import type { RailRenderer } from './RailRenderer';
import { installExternalRailConnection as installStraightExternalRailConnection } from './StraightRoadExternalRailConnection';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

type Direction = 1 | -1;
type HighSpeedState = 'running' | 'dwell';

interface HighSpeedTrainRuntime {
  id: number;
  direction: Direction;
  carCount: number;
  position: number;
  speed: number;
  state: HighSpeedState;
  stoppedAtCentral: boolean;
  dwellUntil: number;
  exchanged: boolean;
}

interface MutableHighSpeedPointSource {
  __citySimLeftHandTrackV022?: boolean;
  __citySimDynamicsV023?: boolean;
  pointAt?: (s: number, offset?: number) => { x: number; z: number };
  trains?: HighSpeedTrainRuntime[];
  route?: { centralPosition: number; length: number };
  central?: { id: number };
  visitorSystem?: {
    exchangeAtStation: (stationId: number, capacity: number, now: number, seed: number) => void;
  } | null;
  consistLength?: (carCount: number) => number;
  spawn?: (direction: Direction, now: number) => void;
  stepTrain?: (train: HighSpeedTrainRuntime, dt: number, now: number) => boolean;
  updatePanel?: (force: boolean) => void;
}

interface HighSpeedInspectionAdapterInternal {
  source?: MutableHighSpeedPointSource;
}

const HSR_MAX_SPEED_MPS = 320 / 3.6;
const HSR_ACCEL_MPS2 = 1.71 / 3.6;
const HSR_BRAKE_MPS2 = 2.7 / 3.6;
const HSR_DWELL_SECONDS = 60;
const HSR_PASSENGERS_PER_CAR = 90;

function installHighSpeedDynamics(source: MutableHighSpeedPointSource): void {
  if (source.__citySimDynamicsV023) return;

  const trains = source.trains;
  const route = source.route;
  const central = source.central;
  const consistLength = source.consistLength?.bind(source);
  const baseSpawn = source.spawn?.bind(source);
  const updatePanel = source.updatePanel?.bind(source);
  if (!trains || !route || !central || !consistLength || !baseSpawn || typeof source.stepTrain !== 'function') return;

  // StraightRoadHighSpeedRail seeds an entering train with a braking-distance-derived speed. Rebase
  // that initial speed to the requested 2.7 km/h/s service-brake rate as soon as it is spawned.
  source.spawn = (direction, now) => {
    const before = trains.length;
    baseSpawn(direction, now);
    const train = trains[before] ?? trains[trains.length - 1];
    if (!train) return;
    const toCentral = Math.abs(route.centralPosition - train.position);
    train.speed = Math.min(
      HSR_MAX_SPEED_MPS,
      Math.sqrt(Math.max(0, 2 * HSR_BRAKE_MPS2 * Math.max(0, toCentral - 20))),
    );
  };

  // Replace only the HSR longitudinal-motion step. Timetable, passenger exchange, stopping pattern,
  // track position and removal at the map boundary remain exactly the same as the base system.
  source.stepTrain = (train, dt, now) => {
    if (train.state === 'dwell') {
      train.speed = 0;
      if (now + 1e-7 < train.dwellUntil) return false;
      train.state = 'running';
      train.stoppedAtCentral = true;
    }

    if (!train.stoppedAtCentral) {
      const remaining = Math.max(0, (route.centralPosition - train.position) * train.direction);
      const target = Math.min(
        HSR_MAX_SPEED_MPS,
        Math.sqrt(Math.max(0, 2 * HSR_BRAKE_MPS2 * Math.max(0, remaining - 1.5))),
      );
      train.speed = train.speed < target
        ? Math.min(target, train.speed + HSR_ACCEL_MPS2 * dt)
        : Math.max(target, train.speed - HSR_BRAKE_MPS2 * dt);

      const move = train.speed * dt;
      if (move + 0.35 >= remaining) {
        train.position = route.centralPosition;
        train.speed = 0;
        train.state = 'dwell';
        train.dwellUntil = now + HSR_DWELL_SECONDS;
        if (!train.exchanged) {
          source.visitorSystem?.exchangeAtStation(
            central.id,
            train.carCount * HSR_PASSENGERS_PER_CAR,
            now,
            1_000_000 + train.id,
          );
          train.exchanged = true;
        }
        updatePanel?.(true);
        return false;
      }
      train.position += train.direction * move;
      return false;
    }

    train.speed = Math.min(HSR_MAX_SPEED_MPS, train.speed + HSR_ACCEL_MPS2 * dt);
    train.position += train.direction * train.speed * dt;
    const half = consistLength(train.carCount) * 0.5;
    return train.direction > 0 ? train.position - half > route.length : train.position + half < 0;
  };

  source.__citySimDynamicsV023 = true;
}

/**
 * Keep the dedicated high-speed line on the Japanese left-hand track and apply its requested
 * acceleration/braking characteristics.
 *
 * StraightRoadHighSpeedRail uses a lateral basis that points to the physical right side in the X-Z
 * ground plane. The inspection adapter keeps a reference to the underlying system, so after install
 * we invert that system's pointAt offset once. Infrastructure is symmetric; all live train bodies,
 * status snapshots, hit boxes and nose geometry then use the corrected left-hand position.
 */
export function installExternalRailConnection(renderer: RailRenderer): void {
  installStraightExternalRailConnection(renderer);

  const inspection = latestHighSpeedRailInspectionSource();
  const adapter = inspection as unknown as HighSpeedInspectionAdapterInternal;
  const source = adapter?.source;
  if (!source) return;

  if (!source.__citySimLeftHandTrackV022 && typeof source.pointAt === 'function') {
    const basePointAt = source.pointAt.bind(source);
    source.pointAt = (s: number, offset = 0) => basePointAt(s, -offset);
    source.__citySimLeftHandTrackV022 = true;
  }

  installHighSpeedDynamics(source);
}
