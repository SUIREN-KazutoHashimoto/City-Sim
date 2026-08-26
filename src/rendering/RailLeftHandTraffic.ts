import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';

type TrackLane = -1 | 0 | 1;
type TrainService = 'local' | 'rapid' | 'limited';
type TrainState = 'depot' | 'dwell' | 'running' | 'signal' | 'schedule';
type TurnoutKind = 'main' | 'siding' | 'crossover-normal' | 'crossover-reverse';

interface RailLineLike {
  id: number;
  kind: 'trunk' | 'spur';
  stationIds: number[];
}

interface SmoothLineLike {
  line: RailLineLike;
  length: number;
  stationDistances: number[];
}

interface TrainRunLike {
  id: number;
  lineId: number;
  service: TrainService;
  state: TrainState;
  direction: 1 | -1;
  distance: number;
  lane: TrackLane;
  previousLane: TrackLane;
  laneChangeStationIndex: number;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  waitingSince: number;
  blocked: boolean;
  depotEnd: 0 | 1;
}

interface RoutePlanLike {
  trainId: number;
  lineId: number;
  fromIndex: number;
  toIndex: number;
  lane: TrackLane;
  firstBlockId: number;
  routeKeys: string[];
}

interface RailSignalLike {
  lineId: number;
  lane: TrackLane;
  direction: 1 | -1;
  blockId: number;
  nextBlockId: number;
}

interface TurnoutIndicatorLike {
  stationId: number;
  lineId: number;
  direction: 1 | -1;
  kind: TurnoutKind;
  lane: TrackLane;
  instanceIndex: number;
  matrix: THREE.Matrix4;
}

interface RailLeftHandRuntime {
  __citySimLeftHandRuntimeV022?: boolean;
  railTime: number;
  recoveryTrainId: number;
  rail: {
    lines: RailLineLike[];
    stations: Array<{ id?: number } | undefined>;
  };
  trainRuns: TrainRunLike[];
  smoothLines: Map<number, SmoothLineLike>;
  blockReservations: Map<number, number>;
  plannedRoutes: Map<number, RoutePlanLike>;
  railSignals: RailSignalLike[];
  turnoutIndicators: TurnoutIndicatorLike[];
  turnoutMesh: THREE.InstancedMesh | null;

  buildTrains: () => void;
  buildRailSignals: () => void;
  buildTurnoutIndicators: () => void;
  chooseRoutePlan: (run: TrainRunLike, fromIndex: number, toIndex: number) => RoutePlanLike | null;
  tryReleaseDepotTrain: (run: TrainRunLike) => void;
  trainTrackOffset: (run: TrainRunLike, smooth: SmoothLineLike, distance: number) => number;

  blockSequence: (lineId: number, fromIndex: number, toIndex: number, lane: TrackLane) => number[];
  blockAvailableFor: (trainId: number, blockId: number) => boolean;
  blockFreeIgnoringOwnReservation: (blockId: number, trainId: number) => boolean;
  stationTrackAvailable: (run: TrainRunLike, toIndex: number, lane: TrackLane) => boolean;
  routeKeysForPlan: (run: TrainRunLike, fromIndex: number, toIndex: number, lane: TrackLane) => string[];
  routesAvailableFor: (run: TrainRunLike, keys: string[]) => boolean;
  canUseCrossover: (run: TrainRunLike, fromIndex: number, toIndex: number) => boolean;
  hasCrossover: (lineId: number, stationIndex: number) => boolean;
  servicePriority: (service: TrainService) => number;
  laneValueAt: (run: TrainRunLike, smooth: SmoothLineLike, distance: number) => number;
  lineStationHasPassingLoop: (lineId: number, stationIndex: number) => boolean;
  sidingProfile: (distance: number, halfPlatform: number) => number;
  platformLength: (stationId: number) => number;
  nextBlockAfter: (blockId: number, direction: 1 | -1) => number;
  lineTrackY: (lineId: number) => number;
  sampleSmooth: (smooth: SmoothLineLike, distance: number) => { x: number; z: number; heading: number } | null;
  matrix: (x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY?: number) => THREE.Matrix4;
  crossoverStartOffset: (stationId: number) => number;
}

interface RailLeftHandPrototype extends Partial<RailLeftHandRuntime> {
  __citySimLeftHandPrototypeV022?: boolean;
}

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;
const SWITCH_CLEARANCE = 16;

let leftHandDepotRelease: ((this: RailLeftHandRuntime, run: TrainRunLike) => void) | null = null;

function leftLane(direction: 1 | -1): TrackLane {
  return (direction * -1) as TrackLane;
}

function segmentDirection(fromIndex: number, toIndex: number): 1 | -1 {
  return toIndex > fromIndex ? 1 : -1;
}

/**
 * Install the left-hand lane convention on RailRenderer.prototype before any renderer is built.
 *
 * RailRenderer's geometric offset vector (-sin(h), +cos(h)) points to the physical RIGHT side on
 * Three.js' X-Z ground plane. The original code assigned lane=direction, which therefore put normal
 * trains on the right-hand track. We keep the existing physical track/block lane numbering and map a
 * train's normal lane to -direction instead. That preserves block IDs and crossover geometry.
 */
export function prepareRailLeftHandTraffic(): void {
  const proto = RailRenderer.prototype as unknown as RailLeftHandPrototype;
  if (proto.__citySimLeftHandPrototypeV022) return;
  proto.__citySimLeftHandPrototypeV022 = true;

  const baseBuildTrains = proto.buildTrains;
  if (baseBuildTrains) {
    proto.buildTrains = function (this: RailLeftHandRuntime): void {
      baseBuildTrains.call(this);
      for (const run of this.trainRuns) {
        const line = this.rail.lines[run.lineId];
        if (line?.kind !== 'trunk') continue;
        run.lane = leftLane(run.direction);
        run.previousLane = run.lane;
        run.laneChangeStationIndex = -1;
      }
    };
  }

  const baseTrainTrackOffset = proto.trainTrackOffset;
  if (baseTrainTrackOffset) {
    proto.trainTrackOffset = function (
      this: RailLeftHandRuntime,
      run: TrainRunLike,
      smooth: SmoothLineLike,
      distance: number,
    ): number {
      if (smooth.line.kind !== 'trunk') return baseTrainTrackOffset.call(this, run, smooth, distance);

      let laneValue = this.laneValueAt(run, smooth, distance);
      // During a crossover interpolation laneValue passes through 0. Falling back to +direction
      // caused a one-frame jump back to the old right-hand track.
      if (Math.abs(laneValue) < 0.05) laneValue = leftLane(run.direction);

      let offset = MAIN_OFFSET * laneValue;
      if (run.service !== 'local') return offset;

      let profile = 0;
      for (let i = 1; i < smooth.stationDistances.length - 1; i++) {
        if (!this.lineStationHasPassingLoop(run.lineId, i)) continue;
        const stationId = smooth.line.stationIds[i];
        profile = Math.max(
          profile,
          this.sidingProfile(Math.abs(distance - smooth.stationDistances[i]), this.platformLength(stationId) / 2),
        );
      }
      const sign = laneValue >= 0 ? 1 : -1;
      offset = sign * (MAIN_OFFSET + (SIDING_OFFSET - MAIN_OFFSET) * profile);
      return offset;
    };
  }

  const baseChooseRoutePlan = proto.chooseRoutePlan;
  if (baseChooseRoutePlan) {
    // Initial build happens before RailInterlockingSafety is attached. Keep startup planning on the
    // normal left-hand track only; runtime recovery/crossover planning is installed below.
    proto.chooseRoutePlan = function (
      this: RailLeftHandRuntime,
      run: TrainRunLike,
      fromIndex: number,
      toIndex: number,
    ): RoutePlanLike | null {
      const line = this.rail.lines[run.lineId];
      if (!line) return null;
      const dir = segmentDirection(fromIndex, toIndex);
      const lane: TrackLane = line.kind === 'trunk' ? leftLane(dir) : 0;
      const sequence = this.blockSequence(run.lineId, fromIndex, toIndex, lane);
      if (!sequence.length) return null;
      const first = sequence[0];
      if (!this.blockAvailableFor(run.id, first)) return null;
      const reserved = this.blockReservations.get(first);
      if (reserved != null && reserved !== run.id) return null;
      if (!this.stationTrackAvailable(run, toIndex, lane)) return null;
      const routeKeys = this.routeKeysForPlan(run, fromIndex, toIndex, lane);
      if (!this.routesAvailableFor(run, routeKeys)) return null;
      return { trainId: run.id, lineId: run.lineId, fromIndex, toIndex, lane, firstBlockId: first, routeKeys };
    };
  }

  const baseTryReleaseDepotTrain = proto.tryReleaseDepotTrain;
  if (baseTryReleaseDepotTrain) {
    leftHandDepotRelease = function (this: RailLeftHandRuntime, run: TrainRunLike): void {
      baseTryReleaseDepotTrain.call(this, run);
      const line = this.rail.lines[run.lineId];
      if (run.state === 'depot' || line?.kind !== 'trunk') return;
      run.lane = leftLane(run.direction);
      run.previousLane = run.lane;
      run.laneChangeStationIndex = -1;
    };
    proto.tryReleaseDepotTrain = leftHandDepotRelease;
  }

  const baseBuildRailSignals = proto.buildRailSignals;
  if (baseBuildRailSignals) {
    proto.buildRailSignals = function (this: RailLeftHandRuntime): void {
      baseBuildRailSignals.call(this);
      // A trunk block's lane sign remains unchanged physically, but its normal direction reverses.
      for (const signal of this.railSignals) {
        if (this.rail.lines[signal.lineId]?.kind !== 'trunk') continue;
        signal.direction = signal.lane > 0 ? -1 : 1;
        signal.nextBlockId = this.nextBlockAfter(signal.blockId, signal.direction);
      }
    };
  }

  const baseBuildTurnoutIndicators = proto.buildTurnoutIndicators;
  if (baseBuildTurnoutIndicators) {
    proto.buildTurnoutIndicators = function (this: RailLeftHandRuntime): void {
      baseBuildTurnoutIndicators.call(this);
      if (!this.turnoutMesh) return;

      for (const indicator of this.turnoutIndicators) {
        const line = this.rail.lines[indicator.lineId];
        const smooth = this.smoothLines.get(indicator.lineId);
        if (line?.kind !== 'trunk' || !smooth) continue;
        const stationIndex = line.stationIds.indexOf(indicator.stationId);
        if (stationIndex < 0) continue;
        const stationD = smooth.stationDistances[stationIndex] ?? 0;
        const y = this.lineTrackY(indicator.lineId);

        let lane: TrackLane;
        let d: number;
        let height: number;
        let length: number;

        if (indicator.kind === 'main' || indicator.kind === 'siding') {
          lane = leftLane(indicator.direction);
          d = THREE.MathUtils.clamp(
            stationD - indicator.direction * (this.platformLength(indicator.stationId) / 2 + SWITCH_CLEARANCE + 20),
            0,
            smooth.length,
          );
          height = 0.25;
          length = 2.2;
        } else {
          lane = indicator.kind === 'crossover-normal' ? leftLane(indicator.direction) : indicator.direction;
          d = THREE.MathUtils.clamp(
            stationD + indicator.direction * (this.crossoverStartOffset(indicator.stationId) - 7),
            0,
            smooth.length,
          );
          height = 0.30;
          length = 3.0;
        }

        const p = this.sampleSmooth(smooth, d);
        if (!p) continue;
        const lateral = lane * (indicator.kind === 'siding' ? SIDING_OFFSET : MAIN_OFFSET);
        const x = p.x - Math.sin(p.heading) * lateral;
        const z = p.z + Math.cos(p.heading) * lateral;
        indicator.lane = lane;
        indicator.matrix = this.matrix(
          x,
          y + (indicator.kind === 'main' || indicator.kind === 'siding' ? 0.75 : 1.05),
          z,
          length,
          height,
          height,
          -p.heading,
        );
        this.turnoutMesh.setMatrixAt(indicator.instanceIndex, indicator.matrix);
      }
      this.turnoutMesh.instanceMatrix.needsUpdate = true;
    };
  }
}

/**
 * RailInterlockingSafety replaces chooseRoutePlan/routeKeys/tryReleaseDepotTrain on the instance.
 * Re-apply the same left-hand convention after that safety layer is installed.
 */
export function installRailLeftHandRuntime(renderer: RailRenderer): void {
  const rt = renderer as unknown as RailLeftHandRuntime;
  if (rt.__citySimLeftHandRuntimeV022) return;
  rt.__citySimLeftHandRuntimeV022 = true;

  const baseRouteKeysForPlan = rt.routeKeysForPlan.bind(rt);

  rt.routeKeysForPlan = (run, fromIndex, toIndex, lane) => {
    const keys = baseRouteKeysForPlan(run, fromIndex, toIndex, lane)
      .filter((key) => !key.startsWith(`crossover:${run.lineId}:`));
    const line = rt.rail.lines[run.lineId];
    if (line?.kind === 'trunk' && rt.hasCrossover(run.lineId, fromIndex)) {
      const side = segmentDirection(fromIndex, toIndex);
      const stationId = line.stationIds[fromIndex];
      if (lane !== leftLane(side)) keys.push(`crossover:${run.lineId}:${stationId}:${side}`);
    }
    return [...new Set(keys)];
  };

  const touchesInterval = (run: TrainRunLike, lo: number, hi: number): boolean => {
    if (run.currentStationIndex >= 0) return run.currentStationIndex >= lo && run.currentStationIndex <= hi;
    if (run.originStationIndex < 0 || run.nextStationIndex < 0) return false;
    const runLo = Math.min(run.originStationIndex, run.nextStationIndex);
    const runHi = Math.max(run.originStationIndex, run.nextStationIndex);
    return runHi >= lo && runLo <= hi;
  };

  const reverseLaneSafe = (
    run: TrainRunLike,
    fromIndex: number,
    toIndex: number,
    lane: TrackLane,
  ): boolean => {
    const sequence = rt.blockSequence(run.lineId, fromIndex, toIndex, lane);
    if (!sequence.length) return false;
    for (const blockId of sequence) {
      if (!rt.blockFreeIgnoringOwnReservation(blockId, run.id)) return false;
      const reserved = rt.blockReservations.get(blockId);
      if (reserved != null && reserved !== run.id) return false;
    }

    const line = rt.rail.lines[run.lineId];
    const lo = Math.max(0, Math.min(fromIndex, toIndex) - 1);
    const hi = Math.min((line?.stationIds.length ?? 1) - 1, Math.max(fromIndex, toIndex) + 1);
    for (const other of rt.trainRuns) {
      if (other.id === run.id || other.state === 'depot' || other.lineId !== run.lineId) continue;
      if (other.lane !== lane && other.previousLane !== lane) continue;
      if (touchesInterval(other, lo, hi)) return false;
    }
    return true;
  };

  rt.chooseRoutePlan = (run, fromIndex, toIndex) => {
    const line = rt.rail.lines[run.lineId];
    if (!line) return null;
    const dir = segmentDirection(fromIndex, toIndex);
    const normal: TrackLane = line.kind === 'trunk' ? leftLane(dir) : 0;
    const candidates: TrackLane[] = [normal];

    if (
      line.kind === 'trunk'
      && run.id === rt.recoveryTrainId
      && rt.canUseCrossover(run, fromIndex, toIndex)
    ) {
      const reverse = (normal * -1) as TrackLane;
      if (reverseLaneSafe(run, fromIndex, toIndex, reverse)) candidates.push(reverse);
    }

    let best: RoutePlanLike | null = null;
    let bestScore = -Infinity;
    for (const lane of candidates) {
      const sequence = rt.blockSequence(run.lineId, fromIndex, toIndex, lane);
      if (!sequence.length) continue;
      const first = sequence[0];
      if (!rt.blockAvailableFor(run.id, first)) continue;
      const reserved = rt.blockReservations.get(first);
      if (reserved != null && reserved !== run.id) continue;
      if (!rt.stationTrackAvailable(run, toIndex, lane)) continue;
      const routeKeys = rt.routeKeysForPlan(run, fromIndex, toIndex, lane);
      if (!rt.routesAvailableFor(run, routeKeys)) continue;

      let clear = 0;
      for (const blockId of sequence) {
        if (!rt.blockFreeIgnoringOwnReservation(blockId, run.id)) break;
        clear++;
      }
      const score = clear + (lane === normal ? 0.35 : 0) + rt.servicePriority(run.service) * 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = { trainId: run.id, lineId: run.lineId, fromIndex, toIndex, lane, firstBlockId: first, routeKeys };
      }
    }
    return best;
  };

  if (leftHandDepotRelease) {
    rt.tryReleaseDepotTrain = (run) => {
      const line = rt.rail.lines[run.lineId];
      if (!line) return;
      const stationIndex = run.depotEnd === 0 ? 0 : line.stationIds.length - 1;
      const direction: 1 | -1 = run.depotEnd === 0 ? 1 : -1;
      const lane: TrackLane = line.kind === 'trunk' ? leftLane(direction) : 0;
      if (!rt.stationTrackAvailable(run, stationIndex, lane)) return;
      leftHandDepotRelease!.call(rt, run);
    };
  }
}
