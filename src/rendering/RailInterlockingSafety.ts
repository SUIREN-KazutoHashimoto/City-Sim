import { RailRenderer } from './RailRenderer';

type TrackLane = -1 | 0 | 1;
type TrainService = 'local' | 'rapid' | 'limited';
type TrainState = 'depot' | 'dwell' | 'running' | 'signal' | 'schedule';

interface SafetyTrainRun {
  id: number;
  lineId: number;
  service: TrainService;
  state: TrainState;
  direction: 1 | -1;
  distance: number;
  speed: number;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  lane: TrackLane;
  previousLane: TrackLane;
  laneChangeStationIndex: number;
  waitingSince: number;
  scheduledDepartureAt: number;
  depotEnd: 0 | 1;
}

interface SafetyLine {
  id: number;
  kind: 'trunk' | 'spur';
  stationIds: number[];
}

interface SafetySmoothLine {
  line: SafetyLine;
  length: number;
  stationDistances: number[];
}

interface SafetyRoutePlan {
  trainId: number;
  lineId: number;
  fromIndex: number;
  toIndex: number;
  lane: TrackLane;
  firstBlockId: number;
  routeKeys: string[];
}

interface SafetyRouteReservation {
  ownerTrainId: number;
  lineId: number;
  route: string;
}

interface SafetyControl {
  caution: boolean;
  redDistance: number;
}

interface RailSafetyRuntime {
  __citySimRailInterlockingV016?: boolean;
  railTime: number;
  recoveryTrainId: number;
  rail: { lines: SafetyLine[]; stations: Array<{ kind?: unknown } | undefined> };
  trainRuns: SafetyTrainRun[];
  smoothLines: Map<number, SafetySmoothLine>;
  routeReservations: Map<string, SafetyRouteReservation>;
  blockReservations: Map<number, number>;
  plannedRoutes: Map<number, SafetyRoutePlan>;

  platformKey: (run: SafetyTrainRun, stationIndex: number, lane: TrackLane) => string;
  stationTrackAvailable: (run: SafetyTrainRun, toIndex: number, lane: TrackLane) => boolean;
  routeKeysForPlan: (run: SafetyTrainRun, fromIndex: number, toIndex: number, lane: TrackLane) => string[];
  routesAvailableFor: (run: SafetyTrainRun, keys: string[]) => boolean;
  chooseRoutePlan: (run: SafetyTrainRun, fromIndex: number, toIndex: number) => SafetyRoutePlan | null;
  sectionControl: (run: SafetyTrainRun) => SafetyControl;
  tryReleaseDepotTrain: (run: SafetyTrainRun) => void;

  blockSequence: (lineId: number, fromIndex: number, toIndex: number, lane: TrackLane) => number[];
  blockAvailableFor: (trainId: number, blockId: number) => boolean;
  blockFreeIgnoringOwnReservation: (blockId: number, trainId: number) => boolean;
  canUseCrossover: (run: SafetyTrainRun, fromIndex: number, toIndex: number) => boolean;
  hasCrossover: (lineId: number, stationIndex: number) => boolean;
  servicePriority: (service: TrainService) => number;
  consistLength: (run: SafetyTrainRun) => number;
  stationDistanceForRun: (run: SafetyTrainRun, smooth: SafetySmoothLine, stationIndex: number) => number;
  crossoverStartOffset: (stationId: number) => number;
}

const CROSSOVER_BLOCK_PREFIX = 'crossover-block:';
const CROSSOVER_LENGTH = 46;
const PLATFORM_SAFETY_METERS = 4;

/**
 * Install the stricter station/crossover interlocking on the existing RailRenderer runtime.
 *
 * RailRenderer already exposes its operational internals to RailFrameScheduler through a narrow
 * runtime interface. Keep the safety correction isolated the same way so the very large renderer
 * stays visually unchanged while route ownership becomes stricter.
 */
export function installRailInterlockingSafety(renderer: RailRenderer): void {
  const rt = renderer as unknown as RailSafetyRuntime;
  if (rt.__citySimRailInterlockingV016) return;
  rt.__citySimRailInterlockingV016 = true;

  const basePlatformKey = rt.platformKey.bind(rt);
  const baseStationTrackAvailable = rt.stationTrackAvailable.bind(rt);
  const baseRouteKeysForPlan = rt.routeKeysForPlan.bind(rt);
  const baseRoutesAvailableFor = rt.routesAvailableFor.bind(rt);
  const baseSectionControl = rt.sectionControl.bind(rt);
  const baseTryReleaseDepotTrain = rt.tryReleaseDepotTrain.bind(rt);

  const segmentDirection = (fromIndex: number, toIndex: number): 1 | -1 => toIndex > fromIndex ? 1 : -1;

  const crossoverBlockKey = (lineId: number, stationId: number, side: 1 | -1): string =>
    `${CROSSOVER_BLOCK_PREFIX}${lineId}:${stationId}:${side}`;

  const targetPlatformOwner = (key: string): SafetyTrainRun | null => {
    // A train physically stopped in the platform always owns it.
    let stopped: SafetyTrainRun | null = null;
    for (const other of rt.trainRuns) {
      if (other.state === 'depot' || other.currentStationIndex < 0) continue;
      if (basePlatformKey(other, other.currentStationIndex, other.lane) !== key) continue;
      if (!stopped || other.id < stopped.id) stopped = other;
    }
    if (stopped) return stopped;

    // If multiple legacy/seeded trains are already committed to the same platform, let the nearest
    // one keep the route and force the others to wait outside the station.
    let best: SafetyTrainRun | null = null;
    let bestRemaining = Infinity;
    for (const other of rt.trainRuns) {
      if (other.state !== 'running' || other.nextStationIndex < 0) continue;
      if (basePlatformKey(other, other.nextStationIndex, other.lane) !== key) continue;
      const smooth = rt.smoothLines.get(other.lineId); if (!smooth) continue;
      const target = rt.stationDistanceForRun(other, smooth, other.nextStationIndex);
      const remaining = Math.abs(target - other.distance);
      if (remaining < bestRemaining - 1e-6 || (Math.abs(remaining - bestRemaining) <= 1e-6 && other.id < (best?.id ?? Infinity))) {
        best = other; bestRemaining = remaining;
      }
    }
    return best;
  };

  const parseCrossoverBlock = (key: string): { lineId: number; stationId: number; side: 1 | -1 } | null => {
    if (!key.startsWith(CROSSOVER_BLOCK_PREFIX)) return null;
    const parts = key.slice(CROSSOVER_BLOCK_PREFIX.length).split(':');
    if (parts.length !== 3) return null;
    const lineId = Number(parts[0]), stationId = Number(parts[1]), sideValue = Number(parts[2]);
    if (!Number.isInteger(lineId) || !Number.isInteger(stationId) || (sideValue !== -1 && sideValue !== 1)) return null;
    return { lineId, stationId, side: sideValue as 1 | -1 };
  };

  const committedCrossoverOwner = (key: string): SafetyTrainRun | null => {
    const parsed = parseCrossoverBlock(key); if (!parsed) return null;
    const line = rt.rail.lines[parsed.lineId]; if (!line) return null;
    const stationIndex = line.stationIds.indexOf(parsed.stationId); if (stationIndex < 0) return null;
    const smooth = rt.smoothLines.get(parsed.lineId); if (!smooth) return null;
    const stationD = smooth.stationDistances[stationIndex] ?? 0;
    const clearAt = rt.crossoverStartOffset(parsed.stationId) + CROSSOVER_LENGTH + 2;

    let owner: SafetyTrainRun | null = null;
    let ownerProgress = -Infinity;
    for (const run of rt.trainRuns) {
      if (run.state !== 'running' || run.lineId !== parsed.lineId) continue;
      if (run.originStationIndex !== stationIndex || run.nextStationIndex < 0) continue;
      if (segmentDirection(run.originStationIndex, run.nextStationIndex) !== parsed.side) continue;
      const half = rt.consistLength(run) * 0.5;
      const along = (run.distance - stationD) * parsed.side;
      const rear = along - half;
      if (rear > clearAt) continue;
      if (along > ownerProgress || (Math.abs(along - ownerProgress) <= 1e-6 && run.id < (owner?.id ?? Infinity))) {
        owner = run; ownerProgress = along;
      }
    }
    return owner;
  };

  rt.stationTrackAvailable = (run, toIndex, lane) => {
    const key = basePlatformKey(run, toIndex, lane);
    const owner = targetPlatformOwner(key);
    if (owner && owner.id !== run.id) return false;
    return baseStationTrackAvailable(run, toIndex, lane);
  };

  rt.routeKeysForPlan = (run, fromIndex, toIndex, lane) => {
    // Remove the old direction-derived crossover key and rebuild it from the actual segment
    // direction. This matters at terminals, where dispatch planning happens before stepTrain flips
    // run.direction for the return working.
    const keys = baseRouteKeysForPlan(run, fromIndex, toIndex, lane)
      .filter((key) => !key.startsWith(`crossover:${run.lineId}:`));
    const line = rt.rail.lines[run.lineId];
    if (line?.kind === 'trunk' && rt.hasCrossover(run.lineId, fromIndex)) {
      const side = segmentDirection(fromIndex, toIndex);
      const stationId = line.stationIds[fromIndex];
      // Every movement through the switch area, straight or diverging, owns the same physical block.
      keys.push(crossoverBlockKey(run.lineId, stationId, side));
      if (lane !== side) keys.push(`crossover:${run.lineId}:${stationId}:${side}`);
    }
    return [...new Set(keys)];
  };

  rt.routesAvailableFor = (run, keys) => {
    if (!baseRoutesAvailableFor(run, keys)) return false;
    for (const key of keys) {
      const owner = committedCrossoverOwner(key);
      if (owner && owner.id !== run.id) return false;
    }
    return true;
  };

  rt.chooseRoutePlan = (run, fromIndex, toIndex) => {
    const line = rt.rail.lines[run.lineId]; if (!line) return null;
    const dir = segmentDirection(fromIndex, toIndex);
    const normal: TrackLane = line.kind === 'trunk' ? dir : 0;
    const candidates: TrackLane[] = [normal];
    if (line.kind === 'trunk' && rt.canUseCrossover(run, fromIndex, toIndex)) candidates.push((normal * -1) as TrackLane);

    let best: SafetyRoutePlan | null = null;
    let bestScore = -Infinity;
    for (const lane of candidates) {
      const sequence = rt.blockSequence(run.lineId, fromIndex, toIndex, lane); if (!sequence.length) continue;
      const first = sequence[0];
      if (!rt.blockAvailableFor(run.id, first)) continue;
      const reserved = rt.blockReservations.get(first); if (reserved != null && reserved !== run.id) continue;
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

  rt.sectionControl = (run) => {
    const control = baseSectionControl(run);
    if (run.state !== 'running' || run.nextStationIndex < 0) return control;

    const key = basePlatformKey(run, run.nextStationIndex, run.lane);
    const owner = targetPlatformOwner(key);
    if (!owner || owner.id === run.id) return control;

    const smooth = rt.smoothLines.get(run.lineId); if (!smooth) return control;
    const target = rt.stationDistanceForRun(run, smooth, run.nextStationIndex);
    const ownHalf = rt.consistLength(run) * 0.5;
    const ownerHalf = owner.currentStationIndex === run.nextStationIndex ? rt.consistLength(owner) * 0.5 : 2;
    const stopCenter = target - run.direction * (ownHalf + ownerHalf + PLATFORM_SAFETY_METERS);
    const stationRed = Math.max(0, (stopCenter - run.distance) * run.direction);
    if (stationRed >= control.redDistance) return control;
    return { caution: false, redDistance: stationRed };
  };

  rt.tryReleaseDepotTrain = (run) => {
    const line = rt.rail.lines[run.lineId]; if (!line) return;
    const stationIndex = run.depotEnd === 0 ? 0 : line.stationIds.length - 1;
    const direction: 1 | -1 = run.depotEnd === 0 ? 1 : -1;
    const lane: TrackLane = line.kind === 'trunk' ? direction : 0;
    const probe = { ...run, direction, lane };
    const key = basePlatformKey(probe, stationIndex, lane);
    const owner = targetPlatformOwner(key);
    if (owner && owner.id !== run.id) return;
    baseTryReleaseDepotTrain(run);
  };
}
