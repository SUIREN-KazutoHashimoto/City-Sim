import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';
import './RailStationArchitecture';

type TrainService = 'local' | 'rapid' | 'limited';
type TrainState = 'depot' | 'dwell' | 'running' | 'signal' | 'schedule';
type TrackLane = -1 | 0 | 1;

interface PointXZ { x: number; z: number; }
interface RailLineLike { id: number; kind: 'trunk' | 'spur'; stationIds: number[]; path?: PointXZ[]; }
interface StationLike { id: number; x: number; z: number; kind: RailStationKind; }
interface SmoothLineLike { line: RailLineLike; path: PointXZ[]; length: number; stationDistances: number[]; }
interface TrainRunLike {
  id: number;
  lineId: number;
  service: TrainService;
  state: TrainState;
  direction: 1 | -1;
  lane: TrackLane;
  speed: number;
  cruiseSpeed: number;
  distance: number;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  dwellRemaining: number;
  scheduledDepartureAt: number;
  scheduledArrivalAt: number;
  waitingSince: number;
  retireAtTerminal: boolean;
  reserve: boolean;
  depotEnd: 0 | 1;
  blocked: boolean;
  deadhead?: boolean;
}
interface StaticPartLike { matrix: THREE.Matrix4; }

interface RailRuntime {
  rail: { lines: RailLineLike[]; stations: StationLike[] };
  trainRuns: TrainRunLike[];
  railTime: number;
  serviceOpen: () => boolean;
  consistLength: (run: TrainRunLike) => number;
  curveSpeedLimit: (smooth: SmoothLineLike, distance: number) => number;
  lineStationHasPassingLoop: (lineId: number, stationIndex: number) => boolean;
  sidingProfile: (distance: number, halfLength: number) => number;
  laneTransitionActive: (run: TrainRunLike) => boolean;
  platformLength: (stationId: number) => number;
  stationDistanceForRun: (run: TrainRunLike, smooth: SmoothLineLike, stationIndex: number) => number;
  sharedStationSafePath: (line: RailLineLike) => PointXZ[];
  buildPlatformRibbon: (
    smooth: SmoothLineLike, center: number, length: number, offset: number, width: number, includeSign: boolean, y: number,
    platforms: StaticPartLike[], roofs: StaticPartLike[], signs: StaticPartLike[], columns: StaticPartLike[], stairs: StaticPartLike[],
  ) => void;
  updateServicePlan: () => void;
  tryReleaseDepotTrain: (run: TrainRunLike) => void;
  enterPlannedRoute: (run: TrainRunLike, plan: unknown) => void;
  shouldStop: (run: TrainRunLike, stationIndex: number) => boolean;
  dwellSeconds: (run: TrainRunLike, stationId: number) => number;
  actualStateLabel: (run: TrainRunLike) => string;
  parkInDepot: (run: TrainRunLike, terminalIndex: number) => void;
  trackSpeedLimit: (run: TrainRunLike, smooth: SmoothLineLike, distance: number) => number;
}
interface RailPrototype extends Partial<RailRuntime> { __citySimStationOpsV031?: boolean; }
interface RailConstructorMutable { SIDING_OFFSET: number; TURNOUT_SPEED: number; SIDING_SPEED: number; }

const TERMINAL_PLATFORM_LENGTH = 270;
const SIDING_OFFSET = 10.0;
const TURNOUT_SPEED = 50 / 3.6;
const SIDING_SPEED = 70 / 3.6;
const APPROACH_BRAKE = 4.2 / 3.6;
const TURNOUT_APPROACH_OFFSET = 48;
const APPROACH_MARGIN = 6;
const STATION_STRAIGHTEN_SPAN = 108;
const STATION_CHORD_MAX_OFFSET = 86;

function dist(a: PointXZ, b: PointXZ): number { return Math.hypot(a.x - b.x, a.z - b.z); }

function terminalIndex(rt: RailRuntime, run: TrainRunLike, stationIndex: number): boolean {
  const line = rt.rail.lines[run.lineId];
  if (!line) return false;
  const stationId = line.stationIds[stationIndex] ?? -1;
  return stationId >= 0 && rt.rail.stations[stationId]?.kind === RailStationKind.Terminal
    && (stationIndex === 0 || stationIndex === line.stationIds.length - 1);
}

function projectToSegment(point: PointXZ, a: PointXZ, b: PointXZ): PointXZ | null {
  const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
  if (len2 < 1) return null;
  const t = THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / len2, 0.12, 0.88);
  return { x: a.x + dx * t, z: a.z + dz * t };
}

/**
 * Stations sit inside a reserved civic/open-space envelope, so the station approach does not need to
 * follow every road-node kink. Replace roughly 100 m on each side of a non-terminal station with one
 * straight chord, while retaining the road-aligned route outside the station area.
 */
function straightenStationApproaches(rt: RailRuntime, line: RailLineLike, input: PointXZ[]): PointXZ[] {
  if (input.length < 5) return input.map((p) => ({ x: p.x, z: p.z }));
  const out = input.map((p) => ({ x: p.x, z: p.z }));

  for (const stationId of line.stationIds) {
    const station = rt.rail.stations[stationId];
    if (!station || station.kind === RailStationKind.Terminal || out.length < 5) continue;

    let nearest = 1, nearestD = Infinity;
    for (let i = 1; i < out.length - 1; i++) {
      const d = (out[i].x - station.x) ** 2 + (out[i].z - station.z) ** 2;
      if (d < nearestD) { nearestD = d; nearest = i; }
    }

    let left = nearest, travelled = 0;
    while (left > 0 && travelled < STATION_STRAIGHTEN_SPAN) {
      travelled += dist(out[left], out[left - 1]); left--;
    }
    let right = nearest; travelled = 0;
    while (right < out.length - 1 && travelled < STATION_STRAIGHTEN_SPAN) {
      travelled += dist(out[right], out[right + 1]); right++;
    }
    if (left >= nearest || right <= nearest || right - left < 2) continue;

    const projected = projectToSegment(station, out[left], out[right]);
    if (!projected || dist(projected, station) > STATION_CHORD_MAX_OFFSET) continue;
    out.splice(left + 1, right - left - 1, projected);
  }
  return out;
}

function movePartY(parts: StaticPartLike[], start: number, delta: number): void {
  for (let i = start; i < parts.length; i++) parts[i].matrix.elements[13] += delta;
}

function correctedPassingLoopLimit(
  rt: RailRuntime,
  run: TrainRunLike,
  smooth: SmoothLineLike,
  distance: number,
  curve: number,
): number | null {
  let best: number | null = null;
  for (let i = 1; i < smooth.stationDistances.length - 1; i++) {
    if (!rt.lineStationHasPassingLoop(run.lineId, i)) continue;
    const stationDistance = smooth.stationDistances[i];
    const half = rt.platformLength(smooth.line.stationIds[i]) * 0.5;
    const profile = rt.sidingProfile(Math.abs(distance - stationDistance), half);
    if (profile >= 0.96) return Math.min(curve, SIDING_SPEED);
    if (profile > 0.04) return Math.min(curve, TURNOUT_SPEED);

    const signedRemaining = (stationDistance - distance) * run.direction;
    if (signedRemaining <= 0) continue;
    const remainingToTurnout = signedRemaining - (half + TURNOUT_APPROACH_OFFSET);
    if (remainingToTurnout < 0) continue;
    const brakingRoom = Math.max(0, remainingToTurnout - APPROACH_MARGIN);
    const approachLimit = Math.sqrt(TURNOUT_SPEED * TURNOUT_SPEED + 2 * APPROACH_BRAKE * brakingRoom);
    const corrected = Math.min(curve, approachLimit);
    best = best == null ? corrected : Math.min(best, corrected);
  }
  return best;
}

/** Prepare station geometry, approach speed and non-revenue depot operation before RailRenderer.build(). */
export function prepareRailStationOperationsTuning(): void {
  const proto = RailRenderer.prototype as unknown as RailPrototype;
  if (proto.__citySimStationOpsV031) return;
  proto.__citySimStationOpsV031 = true;

  const ctor = RailRenderer as unknown as RailConstructorMutable;
  ctor.SIDING_OFFSET = SIDING_OFFSET;
  ctor.TURNOUT_SPEED = TURNOUT_SPEED;
  ctor.SIDING_SPEED = SIDING_SPEED;

  const basePlatformLength = proto.platformLength;
  if (basePlatformLength) {
    proto.platformLength = function (this: RailRuntime, stationId: number): number {
      const base = basePlatformLength.call(this, stationId);
      return this.rail.stations[stationId]?.kind === RailStationKind.Terminal ? Math.max(TERMINAL_PLATFORM_LENGTH, base) : base;
    };
  }

  const baseStationDistance = proto.stationDistanceForRun;
  if (baseStationDistance) {
    proto.stationDistanceForRun = function (this: RailRuntime, run: TrainRunLike, smooth: SmoothLineLike, stationIndex: number): number {
      if (!terminalIndex(this, run, stationIndex)) return baseStationDistance.call(this, run, smooth, stationIndex);
      const raw = smooth.stationDistances[stationIndex] ?? 0;
      const inward = this.consistLength(run) * 0.5 + 5.0;
      if (stationIndex === 0) return Math.min(smooth.length, raw + inward);
      return Math.max(0, raw - inward);
    };
  }

  const baseSafePath = proto.sharedStationSafePath;
  if (baseSafePath) {
    proto.sharedStationSafePath = function (this: RailRuntime, line: RailLineLike): PointXZ[] {
      return straightenStationApproaches(this, line, baseSafePath.call(this, line));
    };
  }

  // RailStationArchitecture now owns the canopy. Keep the legacy platform slab/columns/sign path,
  // but drop its old canopy pieces so old and new roof-generation rules cannot overlap.
  const basePlatformRibbon = proto.buildPlatformRibbon;
  if (basePlatformRibbon) {
    proto.buildPlatformRibbon = function (
      this: RailRuntime,
      smooth: SmoothLineLike, center: number, length: number, offset: number, width: number, includeSign: boolean, y: number,
      platforms: StaticPartLike[], roofs: StaticPartLike[], signs: StaticPartLike[], columns: StaticPartLike[], stairs: StaticPartLike[],
    ): void {
      const roofStart = roofs.length, signStart = signs.length;
      basePlatformRibbon.call(this, smooth, center, length, offset, width, includeSign, y, platforms, roofs, signs, columns, stairs);
      roofs.splice(roofStart);
      movePartY(signs, signStart, 0.55);
    };
  }

  const baseTrackSpeed = proto.trackSpeedLimit;
  if (baseTrackSpeed) {
    proto.trackSpeedLimit = function (this: RailRuntime, run: TrainRunLike, smooth: SmoothLineLike, distance: number): number {
      let limit = baseTrackSpeed.call(this, run, smooth, distance);
      if (run.service !== 'local' || smooth.line.kind !== 'trunk' || this.laneTransitionActive(run)) return limit;
      const curve = this.curveSpeedLimit(smooth, distance);
      const corrected = correctedPassingLoopLimit(this, run, smooth, distance, curve);
      if (corrected != null) limit = Math.max(limit, corrected);
      return Math.min(run.cruiseSpeed, curve, limit);
    } as RailRuntime['trackSpeedLimit'];
  }

  const baseUpdateServicePlan = proto.updateServicePlan;
  if (baseUpdateServicePlan) {
    proto.updateServicePlan = function (this: RailRuntime): void {
      baseUpdateServicePlan.call(this);
      const open = this.serviceOpen();
      for (const run of this.trainRuns) {
        if (run.state === 'depot') continue;
        if (!open || run.retireAtTerminal) run.deadhead = true;
      }
    };
  }

  const baseRelease = proto.tryReleaseDepotTrain;
  if (baseRelease) {
    proto.tryReleaseDepotTrain = function (this: RailRuntime, run: TrainRunLike): void {
      const wasDepot = run.state === 'depot';
      baseRelease.call(this, run);
      if (wasDepot && run.state !== 'depot') run.deadhead = true;
    };
  }

  const baseEnter = proto.enterPlannedRoute;
  if (baseEnter) {
    proto.enterPlannedRoute = function (this: RailRuntime, run: TrainRunLike, plan: unknown): void {
      const deadhead = run.deadhead === true;
      baseEnter.call(this, run, plan);
      if (deadhead && this.serviceOpen() && !run.retireAtTerminal) run.deadhead = false;
    };
  }

  const baseShouldStop = proto.shouldStop;
  if (baseShouldStop) {
    proto.shouldStop = function (this: RailRuntime, run: TrainRunLike, stationIndex: number): boolean {
      if (!run.deadhead) return baseShouldStop.call(this, run, stationIndex);
      const line = this.rail.lines[run.lineId];
      return !!line && (stationIndex === 0 || stationIndex === line.stationIds.length - 1);
    };
  }

  const baseDwell = proto.dwellSeconds;
  if (baseDwell) {
    proto.dwellSeconds = function (this: RailRuntime, run: TrainRunLike, stationId: number): number {
      if (!run.deadhead) return baseDwell.call(this, run, stationId);
      return this.rail.stations[stationId]?.kind === RailStationKind.Terminal ? 5 : 0;
    };
  }

  const baseLabel = proto.actualStateLabel;
  if (baseLabel) {
    proto.actualStateLabel = function (this: RailRuntime, run: TrainRunLike): string {
      if (!run.deadhead) return baseLabel.call(this, run);
      if (run.state === 'depot') return '車両基地';
      if (run.state === 'signal' || run.blocked) return '回送・信号待ち';
      if (run.state === 'dwell') return run.retireAtTerminal ? '回送・入庫待ち' : '回送・出庫待ち';
      if (run.state === 'schedule') return '回送・発車待ち';
      return '回送';
    };
  }

  const basePark = proto.parkInDepot;
  if (basePark) {
    proto.parkInDepot = function (this: RailRuntime, run: TrainRunLike, terminalIndexValue: number): void {
      basePark.call(this, run, terminalIndexValue);
      run.deadhead = false;
    };
  }
}

prepareRailStationOperationsTuning();
