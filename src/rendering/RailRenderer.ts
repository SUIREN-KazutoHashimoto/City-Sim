import * as THREE from 'three';
import { RailLine, RailNetworkPlan, RailPoint, RailStationKind } from '../generation/RailPlanning';
import { RoadNetwork, roadWidth } from '../traffic/RoadNetwork';
import { RailTimetable } from './RailTimetable';

interface StaticPart { matrix: THREE.Matrix4; }
interface SmoothLine {
  line: RailLine;
  path: RailPoint[];
  cumulative: number[];
  length: number;
  stationDistances: number[];
}

type TrainState = 'dwell' | 'running' | 'signal' | 'schedule';
export type TrainService = 'local' | 'rapid' | 'limited';
type SignalAspect = 'red' | 'yellow' | 'green';

interface TrainRun {
  id: number;
  lineId: number;
  service: TrainService;
  carCount: number;
  cruiseSpeed: number;
  direction: 1 | -1;
  speed: number;
  distance: number;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  dwellRemaining: number;
  scheduledDepartureAt: number;
  waitingSince: number;
  trainOrdinal: number;
  state: TrainState;
  x: number;
  z: number;
  heading: number;
}

interface RailSignal {
  lineId: number;
  stationIndex: number;
  direction: 1 | -1;
  instanceIndex: number;
  x: number;
  z: number;
}

interface LineBlock {
  id: number;
  lineId: number;
  segmentIndex: number;
  keys: Set<string>;
  conflicts: Set<number>;
}

interface RouteReservation {
  ownerTrainId: number;
  lineId: number;
  route: string;
}

interface UpcomingSegment {
  fromIndex: number;
  toIndex: number;
}

export interface TrainStatusSnapshot {
  id: number;
  lineId: number;
  lineName: string;
  service: TrainService;
  serviceLabel: string;
  carCount: number;
  consistLength: number;
  state: TrainState;
  stateLabel: string;
  x: number;
  z: number;
  heading: number;
  speed: number;
  cruiseSpeed: number;
  direction: 1 | -1;
  currentStationId: number;
  currentStationName: string;
  nextStationId: number;
  nextStationName: string;
  dwellRemaining: number;
  waitingForBlock: boolean;
  passingLoop: boolean;
  firstPersonForwardOffset: number;
}

/**
 * Railway renderer + lightweight timetable/interlocking.
 *
 * - physical blocks are shared across overlapping lines;
 * - a repeating directional timetable keeps opposing trains out of single-track sections;
 * - only the immediate next block/route is reserved, preventing circular multi-resource holds;
 * - limited > rapid > local is used for dispatch order, while starvation protection keeps locals moving;
 * - junction/turnout routes are locked before a train may enter;
 * - trains are advanced every render frame for smooth motion.
 */
export class RailRenderer {
  static readonly TRACK_Y = 8.2;
  private static readonly TRAIN_WIDTH = 2.86;
  private static readonly CAR_LENGTH = 10.2;
  private static readonly CAR_GAP = 0.72;
  private static readonly BOGIE_HALF = 3.55;
  private static readonly ACCEL = 0.82;
  private static readonly BRAKE = 1.24;
  private static readonly SIDING_OFFSET = 8.0;
  private static readonly PLATFORM_CLEARANCE = 0.45;
  private static readonly SWITCH_CLEARANCE = 14;
  private static readonly SWITCH_APPROACH = 48;
  private static readonly BLOCK_SAMPLE = 14;
  private static readonly BLOCK_QUANTIZE = 11;
  private static readonly DEADLOCK_WATCH_SECONDS = 45;
  private static readonly RECOVERY_HOLD_SECONDS = 40;

  private readonly smoothLines = new Map<number, SmoothLine>();
  private readonly trainRuns: TrainRun[] = [];
  private readonly trainInstanceToRun: number[] = [];
  private readonly railSignals: RailSignal[] = [];
  private readonly lineBlocks: LineBlock[] = [];
  private readonly blockIdBySegment = new Map<string, number>();
  private readonly blockOccupancy = new Map<number, number>();
  private readonly blockReservations = new Map<number, number>();
  private readonly routeReservations = new Map<string, RouteReservation>();
  private readonly turnoutState = new Map<number, string>();
  private readonly timetable = new RailTimetable();
  private readonly d = new THREE.Object3D();

  private railTime = 0;
  private lastProgressAt = 0;
  private recoveryTrainId = -1;
  private recoveryUntil = 0;

  private trainBody: THREE.InstancedMesh | null = null;
  private trainCabin: THREE.InstancedMesh | null = null;
  private trainStripe: THREE.InstancedMesh | null = null;
  private signalRed: THREE.InstancedMesh | null = null;
  private signalYellow: THREE.InstancedMesh | null = null;
  private signalGreen: THREE.InstancedMesh | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rail: RailNetworkPlan,
    private readonly roads?: RoadNetwork,
  ) {}

  build(): void {
    if (this.rail.lines.length === 0) return;
    for (const line of this.rail.lines.filter((l) => l.kind === 'trunk')) this.smoothLines.set(line.id, this.makeSmoothLine(line));
    for (const line of this.rail.lines.filter((l) => l.kind !== 'trunk')) this.smoothLines.set(line.id, this.makeSmoothLine(line));
    this.buildPhysicalBlocks();

    const ballast: StaticPart[] = [], rails: StaticPart[] = [], sleepers: StaticPart[] = [], supports: StaticPart[] = [];
    for (const smooth of this.smoothLines.values()) {
      for (let i = 1; i < smooth.path.length; i++) this.pushTrackSegment(smooth.path[i - 1], smooth.path[i], ballast, rails);
      for (let s = 0; s <= smooth.length; s += 8.5) {
        const p = this.sampleSmooth(smooth, s); if (!p) continue;
        sleepers.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y + 0.17, p.z, 0.18, 0.12, 3.1, -p.heading) });
      }
      for (let s = 36; s < smooth.length; s += 72) {
        const p = this.sampleSmooth(smooth, s); if (!p) continue;
        supports.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y * 0.5, p.z, 0.62, RailRenderer.TRACK_Y, 0.62) });
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), ballast);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), rails);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x54504a, roughness: 0.98 }), sleepers);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x8a8f92, roughness: 0.88 }), supports);

    this.buildStations();
    this.buildTrains();
    this.buildRailSignals();
    this.rebuildDispatchReservations();
    this.updateTrainMeshes();
    this.updateSignals();
  }

  update(realDt = 1 / 60, timeScale = 1, paused = false): void {
    if (!this.trainBody || !this.trainCabin || !this.trainStripe || this.trainRuns.length === 0) return;
    const frameDt = THREE.MathUtils.clamp(realDt, 0, 0.05);
    const scale = Number.isFinite(timeScale) ? Math.max(0, timeScale) : 0;
    if (!paused && frameDt > 0 && scale > 0) {
      let remaining = Math.min(frameDt * scale, 180);
      while (remaining > 1e-5) {
        const dt = Math.min(0.5, remaining);
        this.stepOperations(dt);
        remaining -= dt;
      }
    }
    this.rebuildDispatchReservations();
    this.updateTrainMeshes();
    this.updateSignals();
  }

  get trainCount(): number { return this.trainRuns.length; }
  get waitingTrainCount(): number { return this.trainRuns.filter((r) => r.state === 'signal').length; }
  get signalCount(): number { return this.railSignals.length; }
  get trainHitMesh(): THREE.InstancedMesh | null { return this.trainBody; }
  trainIdFromInstance(instanceId: number): number { return this.trainInstanceToRun[instanceId] ?? -1; }

  trainStatus(id: number): TrainStatusSnapshot | null {
    const run = this.trainRuns[id]; if (!run) return null;
    if (!Number.isFinite(run.x) || !Number.isFinite(run.z) || !Number.isFinite(run.heading)) return null;
    const line = this.rail.lines[run.lineId]; if (!line) return null;
    const currentStationId = run.currentStationIndex >= 0 ? line.stationIds[run.currentStationIndex] ?? -1 : -1;
    const nextStationId = run.nextStationIndex >= 0 ? line.stationIds[run.nextStationIndex] ?? -1 : -1;
    const currentStation = currentStationId >= 0 ? this.rail.stations[currentStationId] : null;
    const nextStation = nextStationId >= 0 ? this.rail.stations[nextStationId] : null;
    const stateLabel = run.state === 'dwell' ? '停車中'
      : run.state === 'schedule' ? 'ダイヤ待ち'
        : run.state === 'signal' ? '信号待ち' : '走行中';
    const loopIndex = run.currentStationIndex >= 0 ? run.currentStationIndex : run.nextStationIndex;
    const consistLength = this.consistLength(run);
    return {
      id: run.id, lineId: run.lineId, lineName: line.name,
      service: run.service, serviceLabel: this.serviceLabel(run.service), carCount: run.carCount, consistLength,
      state: run.state, stateLabel, x: run.x, z: run.z, heading: run.heading,
      speed: run.speed, cruiseSpeed: run.cruiseSpeed, direction: run.direction,
      currentStationId, currentStationName: currentStation?.name ?? '—',
      nextStationId, nextStationName: nextStation?.name ?? '—',
      dwellRemaining: Math.max(0, run.dwellRemaining), waitingForBlock: run.state === 'signal',
      passingLoop: loopIndex >= 0 && this.lineStationHasPassingLoop(run.lineId, loopIndex),
      firstPersonForwardOffset: consistLength * 0.5 + 0.45,
    };
  }

  private serviceLabel(service: TrainService): string {
    if (service === 'limited') return '特急';
    if (service === 'rapid') return '快速';
    return '普通';
  }

  private servicePriority(service: TrainService): number {
    if (service === 'limited') return 3;
    if (service === 'rapid') return 2;
    return 1;
  }

  private stepOperations(dt: number): void {
    this.railTime += dt;
    this.rebuildDispatchReservations();
    const ordered = this.dispatchOrder();
    let progressed = false;
    for (const run of ordered) {
      const before = run.distance;
      this.stepTrain(run, dt);
      if (Math.abs(run.distance - before) > 0.02) progressed = true;
    }
    if (progressed) {
      this.lastProgressAt = this.railTime;
      if (this.recoveryTrainId >= 0 && this.railTime >= this.recoveryUntil) this.recoveryTrainId = -1;
    } else if (this.railTime - this.lastProgressAt >= RailRenderer.DEADLOCK_WATCH_SECONDS) {
      this.activateRecoveryGrant();
    }
  }

  private dispatchOrder(): TrainRun[] {
    return this.trainRuns.slice().sort((a, b) => {
      if (a.id === this.recoveryTrainId && b.id !== this.recoveryTrainId) return -1;
      if (b.id === this.recoveryTrainId && a.id !== this.recoveryTrainId) return 1;
      const ak = this.timetable.dispatchKey(a.scheduledDepartureAt, a.waitingSince, a.service, this.isAtTerminal(a), this.railTime);
      const bk = this.timetable.dispatchKey(b.scheduledDepartureAt, b.waitingSince, b.service, this.isAtTerminal(b), this.railTime);
      if (Math.abs(ak - bk) > 1e-6) return ak - bk;
      const p = this.servicePriority(b.service) - this.servicePriority(a.service);
      return p !== 0 ? p : a.id - b.id;
    });
  }

  private activateRecoveryGrant(): void {
    const waiting = this.trainRuns.filter((r) => r.currentStationIndex >= 0 && (r.state === 'signal' || r.state === 'schedule'));
    if (waiting.length === 0) { this.lastProgressAt = this.railTime; return; }
    waiting.sort((a, b) => {
      const at = this.isAtTerminal(a) ? 1 : 0, bt = this.isAtTerminal(b) ? 1 : 0;
      if (at !== bt) return bt - at;
      const aw = a.waitingSince >= 0 ? a.waitingSince : this.railTime;
      const bw = b.waitingSince >= 0 ? b.waitingSince : this.railTime;
      if (aw !== bw) return aw - bw;
      const p = this.servicePriority(b.service) - this.servicePriority(a.service);
      return p !== 0 ? p : a.id - b.id;
    });
    this.recoveryTrainId = waiting[0].id;
    this.recoveryUntil = this.railTime + RailRenderer.RECOVERY_HOLD_SECONDS;
    this.lastProgressAt = this.railTime;
  }

  private stepTrain(run: TrainRun, dt: number): void {
    const smooth = this.smoothLines.get(run.lineId); if (!smooth || smooth.stationDistances.length < 2) return;
    const lastStation = smooth.line.stationIds.length - 1;

    if (run.currentStationIndex >= 0) {
      run.speed = 0;
      if (run.dwellRemaining > 0) {
        run.dwellRemaining = Math.max(0, run.dwellRemaining - dt);
        run.state = 'dwell';
        return;
      }

      let reversedAtTerminal = false;
      if ((run.direction > 0 && run.currentStationIndex >= lastStation) || (run.direction < 0 && run.currentStationIndex <= 0)) {
        run.direction = run.direction > 0 ? -1 : 1;
        reversedAtTerminal = true;
      }
      if (reversedAtTerminal) {
        run.scheduledDepartureAt = this.timetable.nextTerminalDeparture(
          Math.max(this.railTime, run.scheduledDepartureAt), run.lineId, run.direction, run.service, run.trainOrdinal,
        );
      }

      const next = run.currentStationIndex + run.direction;
      if (next < 0 || next > lastStation) return;

      if (!this.timetableDepartureAllowed(run, run.currentStationIndex, next)) {
        if (run.waitingSince < 0) run.waitingSince = this.railTime;
        run.state = 'schedule';
        return;
      }
      if (!this.canEnterBlock(run, run.currentStationIndex, next)) {
        if (run.waitingSince < 0) run.waitingSince = this.railTime;
        run.state = 'signal';
        return;
      }

      run.originStationIndex = run.currentStationIndex;
      run.nextStationIndex = next;
      run.currentStationIndex = -1;
      run.waitingSince = -1;
      run.state = 'running';
    }

    if (run.state !== 'running' || run.nextStationIndex < 0) return;
    const boundaryIndex = run.nextStationIndex;
    const boundaryDistance = this.stationDistanceForRun(run, smooth, boundaryIndex);
    const boundaryRemaining = Math.abs(boundaryDistance - run.distance);
    const following = boundaryIndex + run.direction;
    const scheduledStop = this.shouldStop(run, boundaryIndex);
    const signalStop = !scheduledStop && following >= 0 && following <= lastStation
      && (!this.timetableDepartureAllowed(run, boundaryIndex, following) || !this.canEnterBlock(run, boundaryIndex, following));

    let brakeDistance = boundaryRemaining;
    if (!scheduledStop && !signalStop) {
      const stopIndex = this.nextScheduledStopIndex(run, boundaryIndex);
      if (stopIndex >= 0) brakeDistance = Math.abs(this.stationDistanceForRun(run, smooth, stopIndex) - run.distance);
      else brakeDistance = Infinity;
    }

    const brakingTarget = Number.isFinite(brakeDistance)
      ? Math.sqrt(Math.max(0, 2 * RailRenderer.BRAKE * Math.max(0, brakeDistance - 0.30)))
      : run.cruiseSpeed;
    const targetSpeed = Math.min(run.cruiseSpeed, brakingTarget);
    if (run.speed < targetSpeed) run.speed = Math.min(targetSpeed, run.speed + RailRenderer.ACCEL * dt);
    else run.speed = Math.max(targetSpeed, run.speed - RailRenderer.BRAKE * dt);

    const move = Math.min(boundaryRemaining, Math.max(0.10, run.speed) * dt);
    run.distance += run.direction * move;
    if (boundaryRemaining > 0.36 && move < boundaryRemaining - 0.02) return;

    run.distance = boundaryDistance;
    const stationId = smooth.line.stationIds[boundaryIndex];
    if (scheduledStop) {
      const dwell = this.dwellSeconds(run, stationId);
      run.speed = 0;
      run.currentStationIndex = boundaryIndex;
      run.originStationIndex = -1;
      run.nextStationIndex = -1;
      run.state = 'dwell';
      run.dwellRemaining = dwell;
      run.scheduledDepartureAt = this.railTime + dwell;
      run.waitingSince = -1;
      return;
    }
    if (following < 0 || following > lastStation) {
      const dwell = this.dwellSeconds(run, stationId);
      run.speed = 0;
      run.currentStationIndex = boundaryIndex;
      run.originStationIndex = -1;
      run.nextStationIndex = -1;
      run.state = 'dwell';
      run.dwellRemaining = dwell;
      run.scheduledDepartureAt = this.railTime + dwell;
      run.waitingSince = -1;
      return;
    }
    if (!this.timetableDepartureAllowed(run, boundaryIndex, following) || !this.canEnterBlock(run, boundaryIndex, following)) {
      run.speed = 0;
      run.currentStationIndex = boundaryIndex;
      run.originStationIndex = -1;
      run.nextStationIndex = -1;
      run.state = this.timetableDepartureAllowed(run, boundaryIndex, following) ? 'signal' : 'schedule';
      run.dwellRemaining = 0;
      run.scheduledDepartureAt = Math.max(run.scheduledDepartureAt, this.railTime);
      if (run.waitingSince < 0) run.waitingSince = this.railTime;
      return;
    }
    run.originStationIndex = boundaryIndex;
    run.nextStationIndex = following;
  }

  private timetableDepartureAllowed(run: TrainRun, fromIndex: number, toIndex: number): boolean {
    if (this.railTime + 1e-6 < run.scheduledDepartureAt) return false;
    if (!this.timetable.directionWindowOpen(this.railTime, run.lineId, run.direction)) return false;
    const remain = this.timetable.secondsUntilWindowClose(this.railTime, run.lineId, run.direction);
    const required = this.estimatedBlockTravelSeconds(run, fromIndex, toIndex) + 5;
    return remain >= Math.min(58, required);
  }

  private estimatedBlockTravelSeconds(run: TrainRun, fromIndex: number, toIndex: number): number {
    const smooth = this.smoothLines.get(run.lineId); if (!smooth) return 30;
    const a = smooth.stationDistances[fromIndex] ?? 0, b = smooth.stationDistances[toIndex] ?? a;
    const distance = Math.abs(b - a);
    const effective = Math.max(8, run.cruiseSpeed * 0.82);
    return Math.max(12, distance / effective);
  }

  private canEnterBlock(run: TrainRun, fromIndex: number, toIndex: number): boolean {
    const blockId = this.blockIdFor(run.lineId, fromIndex, toIndex);
    if (blockId < 0 || !this.blockAvailableFor(run.id, blockId)) return false;
    const reservation = this.blockReservations.get(blockId);
    if (reservation != null && reservation !== run.id) return false;
    if (!this.terminalAvailable(run, toIndex)) return false;
    if (!this.routesAvailableFor(run, fromIndex, toIndex)) return false;
    if (!this.stationTrackAvailable(run, toIndex)) return false;
    return true;
  }

  private stationTrackAvailable(run: TrainRun, toIndex: number): boolean {
    const line = this.rail.lines[run.lineId]; if (!line) return false;
    const targetStationId = line.stationIds[toIndex];
    const targetHasLoop = this.lineStationHasPassingLoop(run.lineId, toIndex);
    for (const other of this.trainRuns) {
      if (other.id === run.id || other.currentStationIndex < 0) continue;
      const otherLine = this.rail.lines[other.lineId]; if (!otherLine) continue;
      const otherStationId = otherLine.stationIds[other.currentStationIndex];
      if (otherStationId !== targetStationId) continue;

      if (other.lineId !== run.lineId) {
        if (this.rail.stations[targetStationId]?.lineIds.length > 1) return false;
        continue;
      }
      if (!targetHasLoop) return false;
      const runLoop = run.service === 'local';
      const otherLoop = other.service === 'local';
      if (runLoop !== otherLoop) continue;
      if (runLoop && otherLoop && other.direction !== run.direction) continue;
      return false;
    }
    return true;
  }

  private terminalAvailable(run: TrainRun, toIndex: number): boolean {
    const line = this.rail.lines[run.lineId]; if (!line) return false;
    const stationId = line.stationIds[toIndex], station = this.rail.stations[stationId];
    if (!station || station.kind !== RailStationKind.Terminal) return true;
    return !this.trainRuns.some((other) => {
      if (other.id === run.id || other.currentStationIndex < 0) return false;
      const otherLine = this.rail.lines[other.lineId]; if (!otherLine) return false;
      return otherLine.stationIds[other.currentStationIndex] === stationId;
    });
  }

  /**
   * 予約は「次の1閉塞＋その進路」だけ。
   * 多段先行予約をやめることで循環待ちを構造的に抑える。
   */
  private rebuildDispatchReservations(): void {
    this.blockOccupancy.clear();
    this.blockReservations.clear();
    this.routeReservations.clear();
    this.turnoutState.clear();

    for (const run of this.trainRuns) {
      if (run.state !== 'running' || run.originStationIndex < 0 || run.nextStationIndex < 0) continue;
      const blockId = this.blockIdFor(run.lineId, run.originStationIndex, run.nextStationIndex);
      if (blockId >= 0 && !this.blockOccupancy.has(blockId)) this.blockOccupancy.set(blockId, run.id);
    }

    for (const run of this.dispatchOrder()) {
      const segments = this.upcomingSegments(run, 1);
      const seg = segments[0]; if (!seg) continue;
      if (run.currentStationIndex >= 0 && !this.timetableDepartureAllowed(run, seg.fromIndex, seg.toIndex)) continue;
      const blockId = this.blockIdFor(run.lineId, seg.fromIndex, seg.toIndex);
      if (blockId < 0 || !this.blockAvailableFor(run.id, blockId)) continue;
      if (!this.terminalAvailable(run, seg.toIndex)) continue;
      if (!this.stationTrackAvailable(run, seg.toIndex)) continue;
      const routeKeys = this.routeKeysForSegment(run, seg.fromIndex, seg.toIndex);
      if (!this.reserveRoutes(run, routeKeys)) continue;
      this.blockReservations.set(blockId, run.id);
    }
  }

  private isAtTerminal(run: TrainRun): boolean {
    if (run.currentStationIndex < 0) return false;
    const line = this.rail.lines[run.lineId]; if (!line) return false;
    const station = this.rail.stations[line.stationIds[run.currentStationIndex]];
    return station?.kind === RailStationKind.Terminal;
  }

  private upcomingSegments(run: TrainRun, count: number): UpcomingSegment[] {
    const line = this.rail.lines[run.lineId]; if (!line || line.stationIds.length < 2 || count <= 0) return [];
    const last = line.stationIds.length - 1;
    const out: UpcomingSegment[] = [];
    let from: number;
    let dir: 1 | -1 = run.direction;
    if (run.currentStationIndex >= 0) {
      from = run.currentStationIndex;
      if (from === last && dir > 0) dir = -1;
      else if (from === 0 && dir < 0) dir = 1;
    } else if (run.nextStationIndex >= 0) {
      from = run.nextStationIndex;
      if ((from === last && dir > 0) || (from === 0 && dir < 0)) return out;
    } else return out;

    for (let i = 0; i < count; i++) {
      const to = from + dir;
      if (to < 0 || to > last) break;
      out.push({ fromIndex: from, toIndex: to });
      const station = this.rail.stations[line.stationIds[to]];
      if (station?.kind === RailStationKind.Terminal) break;
      from = to;
    }
    return out;
  }

  private blockAvailableFor(trainId: number, blockId: number): boolean {
    const block = this.lineBlocks[blockId]; if (!block) return false;
    for (const conflictId of block.conflicts) {
      const occupiedBy = this.blockOccupancy.get(conflictId);
      if (occupiedBy != null && occupiedBy !== trainId) return false;
      const reservedBy = this.blockReservations.get(conflictId);
      if (reservedBy != null && reservedBy !== trainId) return false;
    }
    return true;
  }

  private routesAvailableFor(run: TrainRun, fromIndex: number, toIndex: number): boolean {
    const keys = this.routeKeysForSegment(run, fromIndex, toIndex);
    for (const key of keys) {
      const r = this.routeReservations.get(key);
      if (r && r.ownerTrainId !== run.id) return false;
    }
    return true;
  }

  private reserveRoutes(run: TrainRun, keys: string[]): boolean {
    for (const key of keys) {
      const current = this.routeReservations.get(key);
      if (current && current.ownerTrainId !== run.id) return false;
    }
    const route = this.routeName(run);
    for (const key of keys) {
      this.routeReservations.set(key, { ownerTrainId: run.id, lineId: run.lineId, route });
      if (key.startsWith('junction:')) {
        const stationId = Number(key.slice('junction:'.length));
        if (Number.isFinite(stationId)) this.turnoutState.set(stationId, route);
      }
    }
    return true;
  }

  private routeName(run: TrainRun): string {
    if (run.service === 'local') return `L${run.lineId}:loop:${run.direction}`;
    return `L${run.lineId}:main:${run.service}`;
  }

  private routeKeysForSegment(run: TrainRun, fromIndex: number, toIndex: number): string[] {
    const line = this.rail.lines[run.lineId]; if (!line) return [];
    const keys: string[] = [];
    for (const index of [fromIndex, toIndex]) {
      const stationId = line.stationIds[index], station = this.rail.stations[stationId];
      if (!station) continue;
      if (station.lineIds.length > 1) keys.push(`junction:${stationId}`);
      if (this.lineStationHasPassingLoop(run.lineId, index)) {
        if (run.service === 'local') keys.push(`station:${run.lineId}:${stationId}:loop:${run.direction}`);
        else keys.push(`station:${run.lineId}:${stationId}:main`);
      }
      if (station.kind === RailStationKind.Terminal) keys.push(`terminal:${stationId}`);
    }
    return [...new Set(keys)];
  }

  private buildPhysicalBlocks(): void {
    this.lineBlocks.length = 0;
    this.blockIdBySegment.clear();
    for (const smooth of this.smoothLines.values()) {
      for (let segmentIndex = 0; segmentIndex < smooth.stationDistances.length - 1; segmentIndex++) {
        const start = smooth.stationDistances[segmentIndex], end = smooth.stationDistances[segmentIndex + 1];
        const lo = Math.min(start, end), hi = Math.max(start, end);
        const keys = new Set<string>();
        for (let d = lo + 3; d <= hi - 3; d += RailRenderer.BLOCK_SAMPLE) {
          const p = this.sampleSmooth(smooth, d); if (!p) continue;
          keys.add(this.trackCellKey(p.x, p.z));
        }
        if (keys.size === 0) {
          const p = this.sampleSmooth(smooth, (lo + hi) * 0.5);
          if (p) keys.add(this.trackCellKey(p.x, p.z));
        }
        const id = this.lineBlocks.length;
        this.lineBlocks.push({ id, lineId: smooth.line.id, segmentIndex, keys, conflicts: new Set([id]) });
        this.blockIdBySegment.set(this.segmentKey(smooth.line.id, segmentIndex), id);
      }
    }

    for (let i = 0; i < this.lineBlocks.length; i++) for (let j = i + 1; j < this.lineBlocks.length; j++) {
      const a = this.lineBlocks[i], b = this.lineBlocks[j];
      if (a.lineId === b.lineId) continue;
      const small = a.keys.size <= b.keys.size ? a.keys : b.keys;
      const large = small === a.keys ? b.keys : a.keys;
      let overlap = 0;
      for (const key of small) if (large.has(key) && ++overlap >= 3) break;
      if (overlap >= 3) this.addBlockConflict(a.id, b.id);
    }

    for (const station of this.rail.stations) {
      if (station.lineIds.length < 2) continue;
      const adjacent: number[] = [];
      for (const lineId of station.lineIds) {
        const line = this.rail.lines[lineId]; if (!line) continue;
        const idx = line.stationIds.indexOf(station.id); if (idx < 0) continue;
        if (idx > 0) { const id = this.blockIdFor(lineId, idx - 1, idx); if (id >= 0) adjacent.push(id); }
        if (idx < line.stationIds.length - 1) { const id = this.blockIdFor(lineId, idx, idx + 1); if (id >= 0) adjacent.push(id); }
      }
      for (let i = 0; i < adjacent.length; i++) for (let j = i + 1; j < adjacent.length; j++) {
        if (this.lineBlocks[adjacent[i]]?.lineId !== this.lineBlocks[adjacent[j]]?.lineId) this.addBlockConflict(adjacent[i], adjacent[j]);
      }
    }
  }

  private addBlockConflict(a: number, b: number): void {
    this.lineBlocks[a]?.conflicts.add(b);
    this.lineBlocks[b]?.conflicts.add(a);
  }

  private trackCellKey(x: number, z: number): string {
    const q = RailRenderer.BLOCK_QUANTIZE;
    return `${Math.round(x / q)},${Math.round(z / q)}`;
  }

  private segmentKey(lineId: number, segmentIndex: number): string { return `${lineId}:${segmentIndex}`; }

  private blockIdFor(lineId: number, fromIndex: number, toIndex: number): number {
    const segmentIndex = Math.min(fromIndex, toIndex);
    return this.blockIdBySegment.get(this.segmentKey(lineId, segmentIndex)) ?? -1;
  }

  private shouldStop(run: TrainRun, stationIndex: number): boolean {
    if (run.service === 'local') return true;
    const line = this.rail.lines[run.lineId], station = this.rail.stations[line.stationIds[stationIndex]];
    if (!station) return true;
    if (station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter || station.kind === RailStationKind.Terminal) return true;
    const interval = run.service === 'rapid' ? 2 : 3;
    return stationIndex % interval === 0;
  }

  private nextScheduledStopIndex(run: TrainRun, fromIndex: number): number {
    const line = this.rail.lines[run.lineId]; if (!line) return -1;
    for (let i = fromIndex; i >= 0 && i < line.stationIds.length; i += run.direction) if (this.shouldStop(run, i)) return i;
    return -1;
  }

  private dwellSeconds(run: TrainRun, stationId: number): number {
    const station = this.rail.stations[stationId];
    if (run.service === 'limited') {
      if (station?.kind === RailStationKind.Central) return 14;
      if (station?.kind === RailStationKind.SubCenter) return 11;
      if (station?.kind === RailStationKind.Terminal) return 18;
      return 8;
    }
    if (run.service === 'rapid') {
      if (station?.kind === RailStationKind.Central) return 18;
      if (station?.kind === RailStationKind.SubCenter) return 14;
      if (station?.kind === RailStationKind.Terminal) return 19;
      return 10;
    }
    if (station?.kind === RailStationKind.Central) return 24;
    if (station?.kind === RailStationKind.SubCenter) return 20;
    if (station?.kind === RailStationKind.Terminal) return 22;
    return 14;
  }

  private stationDistanceForRun(run: TrainRun, smooth: SmoothLine, stationIndex: number): number {
    const raw = smooth.stationDistances[stationIndex] ?? 0;
    const half = this.consistLength(run) * 0.46;
    if (stationIndex === 0) return Math.min(smooth.length, raw + half);
    if (stationIndex === smooth.stationDistances.length - 1) return Math.max(0, raw - half);
    return raw;
  }

  private consistLength(run: TrainRun): number {
    return run.carCount * RailRenderer.CAR_LENGTH + Math.max(0, run.carCount - 1) * RailRenderer.CAR_GAP;
  }

  private updateTrainMeshes(): void {
    if (!this.trainBody || !this.trainCabin || !this.trainStripe) return;
    let instance = 0;
    for (const run of this.trainRuns) {
      const smooth = this.smoothLines.get(run.lineId); if (!smooth) continue;
      for (let car = 0; car < run.carCount; car++) {
        const pose = this.carPose(run, smooth, car); if (!pose) continue;
        this.pose(this.trainBody, instance, pose.x, RailRenderer.TRACK_Y + 1.80, pose.z, pose.heading, RailRenderer.CAR_LENGTH, 3.05, RailRenderer.TRAIN_WIDTH);
        this.pose(this.trainStripe, instance, pose.x, RailRenderer.TRACK_Y + 2.12, pose.z, pose.heading, RailRenderer.CAR_LENGTH * 0.97, 0.34, RailRenderer.TRAIN_WIDTH + 0.05);
        this.pose(this.trainCabin, instance, pose.x, RailRenderer.TRACK_Y + 3.14, pose.z, pose.heading, RailRenderer.CAR_LENGTH * 0.78, 0.62, 2.40);
        instance++;
      }
      const centerPose = this.consistPose(run, smooth);
      if (centerPose) { run.x = centerPose.x; run.z = centerPose.z; run.heading = centerPose.heading; }
    }
    this.trainBody.count = instance; this.trainCabin.count = instance; this.trainStripe.count = instance;
    this.trainBody.instanceMatrix.needsUpdate = true;
    this.trainCabin.instanceMatrix.needsUpdate = true;
    this.trainStripe.instanceMatrix.needsUpdate = true;
  }

  private carPose(run: TrainRun, smooth: SmoothLine, carIndex: number): { x: number; z: number; heading: number } | null {
    const spacing = RailRenderer.CAR_LENGTH + RailRenderer.CAR_GAP;
    const along = ((run.carCount - 1) * 0.5 - carIndex) * spacing;
    const center = run.distance + along;
    const forwardPath = this.sampleTrainTrack(run, smooth, center + RailRenderer.BOGIE_HALF);
    const rearPath = this.sampleTrainTrack(run, smooth, center - RailRenderer.BOGIE_HALF);
    if (!forwardPath || !rearPath) return null;
    const dx = forwardPath.x - rearPath.x, dz = forwardPath.z - rearPath.z;
    let heading = Math.hypot(dx, dz) > 0.01 ? Math.atan2(dz, dx) : forwardPath.heading;
    if (run.direction < 0) heading = this.wrapAngle(heading + Math.PI);
    return { x: (forwardPath.x + rearPath.x) * 0.5, z: (forwardPath.z + rearPath.z) * 0.5, heading };
  }

  private consistPose(run: TrainRun, smooth: SmoothLine): { x: number; z: number; heading: number } | null {
    const a = this.sampleTrainTrack(run, smooth, run.distance - RailRenderer.BOGIE_HALF);
    const b = this.sampleTrainTrack(run, smooth, run.distance + RailRenderer.BOGIE_HALF);
    if (!a || !b) return null;
    let heading = Math.atan2(b.z - a.z, b.x - a.x);
    if (run.direction < 0) heading = this.wrapAngle(heading + Math.PI);
    return { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5, heading };
  }

  private sampleTrainTrack(run: TrainRun, smooth: SmoothLine, distance: number): { x: number; z: number; heading: number } | null {
    const p = this.sampleSmooth(smooth, THREE.MathUtils.clamp(distance, 0, smooth.length)); if (!p) return null;
    const off = this.trainTrackOffsetAt(run, smooth, distance);
    return { x: p.x - Math.sin(p.heading) * off, z: p.z + Math.cos(p.heading) * off, heading: p.heading };
  }

  private trainTrackOffsetAt(run: TrainRun, smooth: SmoothLine, distance: number): number {
    if (smooth.line.kind !== 'trunk' || run.service !== 'local') return 0;
    let bestProfile = 0;
    for (let i = 0; i < smooth.stationDistances.length; i++) {
      if (!this.lineStationHasPassingLoop(run.lineId, i)) continue;
      const stationId = smooth.line.stationIds[i], half = this.platformLength(stationId) / 2;
      bestProfile = Math.max(bestProfile, this.loopProfile(Math.abs(distance - smooth.stationDistances[i]), half));
    }
    return RailRenderer.SIDING_OFFSET * run.direction * bestProfile;
  }

  private buildStations(): void {
    const platforms: StaticPart[] = [], roofs: StaticPart[] = [], signs: StaticPart[] = [], columns: StaticPart[] = [], stairs: StaticPart[] = [];
    const loopBallast: StaticPart[] = [], loopRails: StaticPart[] = [];
    for (const line of this.rail.lines) {
      const smooth = this.smoothLines.get(line.id); if (!smooth) continue;
      for (let stationIndex = 0; stationIndex < line.stationIds.length; stationIndex++) {
        const stationId = line.stationIds[stationIndex], station = this.rail.stations[stationId]; if (!station) continue;
        if (line.kind === 'spur' && this.stationHasTrunk(stationId)) continue;
        const centerDistance = smooth.stationDistances[stationIndex] ?? 0;
        const length = this.platformLength(stationId);
        const passing = this.lineStationHasPassingLoop(line.id, stationIndex);
        const width = station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter ? 4.2 : 3.8;
        if (passing) {
          this.buildPassingLoop(smooth, centerDistance, length, loopBallast, loopRails);
          const islandOffset = RailRenderer.SIDING_OFFSET * 0.5;
          this.buildPlatformRibbon(smooth, centerDistance, length, islandOffset, width, true, stationId, platforms, roofs, signs, columns, stairs);
          this.buildPlatformRibbon(smooth, centerDistance, length, -islandOffset, width, false, stationId, platforms, roofs, signs, columns, stairs);
        } else {
          const side = ((stationId + line.id) & 1) === 0 ? 1 : -1;
          const offset = side * (RailRenderer.TRAIN_WIDTH / 2 + RailRenderer.PLATFORM_CLEARANCE + width / 2);
          this.buildPlatformRibbon(smooth, centerDistance, length, offset, width, true, stationId, platforms, roofs, signs, columns, stairs);
        }
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xc9c7bf, roughness: 0.86 }), platforms);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x6f7d88, roughness: 0.58, metalness: 0.18 }), roofs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x2f6fa3, roughness: 0.52 }), signs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777d82, roughness: 0.9 }), columns);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xa9a69e, roughness: 0.92 }), stairs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), loopBallast);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), loopRails);
  }

  private buildPassingLoop(smooth: SmoothLine, centerDistance: number, platformLength: number, ballast: StaticPart[], rails: StaticPart[]): void {
    const halfPlatform = platformLength / 2;
    const fullUntil = halfPlatform + RailRenderer.SWITCH_CLEARANCE;
    const loopHalf = fullUntil + RailRenderer.SWITCH_APPROACH;
    const start = Math.max(0, centerDistance - loopHalf), end = Math.min(smooth.length, centerDistance + loopHalf);
    for (const side of [-1, 1]) {
      let prev: RailPoint | null = null;
      for (let s = start; s <= end + 0.01; s = Math.min(end, s + 4.8)) {
        const p = this.sampleSmooth(smooth, s); if (!p) break;
        const profile = this.loopProfile(Math.abs(s - centerDistance), halfPlatform);
        const off = RailRenderer.SIDING_OFFSET * side * profile;
        const q = { x: p.x - Math.sin(p.heading) * off, z: p.z + Math.cos(p.heading) * off };
        if (prev) this.pushTrackSegment(prev, q, ballast, rails, 3.35);
        prev = q;
        if (s >= end) break;
      }
    }
  }

  private loopProfile(distanceFromStation: number, platformHalf: number): number {
    const fullUntil = platformHalf + RailRenderer.SWITCH_CLEARANCE;
    const loopHalf = fullUntil + RailRenderer.SWITCH_APPROACH;
    if (distanceFromStation <= fullUntil) return 1;
    if (distanceFromStation >= loopHalf) return 0;
    const t = THREE.MathUtils.clamp((loopHalf - distanceFromStation) / RailRenderer.SWITCH_APPROACH, 0, 1);
    return t * t * (3 - 2 * t);
  }

  private buildPlatformRibbon(
    smooth: SmoothLine,
    centerDistance: number,
    length: number,
    lateralOffset: number,
    width: number,
    includeSign: boolean,
    stationId: number,
    platforms: StaticPart[],
    roofs: StaticPart[],
    signs: StaticPart[],
    columns: StaticPart[],
    stairs: StaticPart[],
  ): void {
    const start = Math.max(0, centerDistance - length / 2), end = Math.min(smooth.length, centerDistance + length / 2);
    for (let s = start; s < end - 0.01; s += 7.2) {
      const e = Math.min(end, s + 7.2);
      const a = this.offsetPoint(smooth, s, lateralOffset), b = this.offsetPoint(smooth, e, lateralOffset); if (!a || !b) continue;
      this.pushRibbonSegment(a, b, RailRenderer.TRACK_Y + 0.38, 0.38, width, platforms);
      const mid = (s + e) * 0.5;
      if (Math.abs(mid - centerDistance) <= length * 0.36) this.pushRibbonSegment(a, b, RailRenderer.TRACK_Y + 3.25, 0.18, width * 0.78, roofs);
    }
    for (let s = start + 6; s <= end - 5; s += 16) {
      const p = this.offsetPoint(smooth, s, lateralOffset); if (!p) continue;
      columns.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y * 0.5, p.z, 0.5, RailRenderer.TRACK_Y, 0.5) });
    }
    if (includeSign) {
      const p = this.offsetPoint(smooth, centerDistance, lateralOffset); if (p) {
        const station = this.rail.stations[stationId], major = station?.kind === RailStationKind.Central || station?.kind === RailStationKind.SubCenter;
        signs.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y + 4.05, p.z, major ? 5.5 : 3.8, 1.25, 0.22, -p.heading) });
      }
    }
    this.buildPlatformAccess(smooth, start + 3, lateralOffset, -1, stairs);
    this.buildPlatformAccess(smooth, end - 3, lateralOffset, 1, stairs);
  }

  private buildPlatformAccess(smooth: SmoothLine, anchorDistance: number, lateralOffset: number, direction: -1 | 1, stairs: StaticPart[]): void {
    const anchor = this.offsetPoint(smooth, anchorDistance, lateralOffset); if (!anchor) return;
    const side = lateralOffset >= 0 ? 1 : -1;
    const roadHalf = this.roadHalfWidthAt(anchor.x, anchor.z, anchor.heading);
    const outerAbs = Math.max(Math.abs(lateralOffset) + 3.4, roadHalf + 3.2);
    const outer = this.offsetPoint(smooth, anchorDistance, side * outerAbs); if (!outer) return;
    const concourseY = 5.3;
    const platformY = RailRenderer.TRACK_Y + 0.40;
    const shaftHeight = Math.max(1.0, platformY - concourseY);
    stairs.push({ matrix: this.matrix(anchor.x, concourseY + shaftHeight * 0.5, anchor.z, 2.4, shaftHeight, 2.4, -anchor.heading) });
    this.pushRibbonSegment(anchor, outer, concourseY, 0.28, 2.6, stairs);
    const steps = 12, run = 15.5;
    for (let i = 0; i < steps; i++) {
      const t = i / Math.max(1, steps - 1);
      const along = direction * t * run;
      const x = outer.x + Math.cos(outer.heading) * along;
      const z = outer.z + Math.sin(outer.heading) * along;
      const top = concourseY - t * (concourseY - 0.45);
      stairs.push({ matrix: this.matrix(x, Math.max(0.30, top * 0.5), z, 1.25, Math.max(0.45, top), 2.6, -outer.heading) });
    }
  }

  private roadHalfWidthAt(x: number, z: number, heading: number): number {
    const roads = this.roads; if (!roads) return 7.0;
    const nodeId = roads.nearestNode(x, z); if (nodeId < 0) return 7.0;
    const node = roads.nodes[nodeId];
    let bestScore = Infinity, bestLanes = 2;
    for (const edgeId of node.edges) {
      const edge = roads.edges[edgeId], a = roads.nodes[edge.from], b = roads.nodes[edge.to];
      if (!edge || !a || !b) continue;
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz; if (len2 < 0.01) continue;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
      const qx = a.x + dx * t, qz = a.z + dz * t;
      const d2 = (x - qx) ** 2 + (z - qz) ** 2;
      const edgeHeading = Math.atan2(dz, dx);
      const alignment = Math.abs(Math.cos(edgeHeading - heading));
      const score = d2 + (1 - alignment) * 2500;
      if (score < bestScore) { bestScore = score; bestLanes = Math.max(1, edge.lanes); }
    }
    return roadWidth(bestLanes) * 0.5;
  }

  private pushRibbonSegment(a: { x: number; z: number }, b: { x: number; z: number }, y: number, height: number, width: number, parts: StaticPart[]): void {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz); if (len < 0.2) return;
    parts.push({ matrix: this.matrix((a.x + b.x) / 2, y, (a.z + b.z) / 2, len + 0.18, height, width, -Math.atan2(dz, dx)) });
  }

  private offsetPoint(smooth: SmoothLine, distance: number, lateralOffset: number): { x: number; z: number; heading: number } | null {
    const p = this.sampleSmooth(smooth, distance); if (!p) return null;
    return { x: p.x - Math.sin(p.heading) * lateralOffset, z: p.z + Math.cos(p.heading) * lateralOffset, heading: p.heading };
  }

  private lineStationHasPassingLoop(lineId: number, stationIndex: number): boolean {
    const line = this.rail.lines[lineId]; if (!line || line.kind !== 'trunk') return false;
    if (stationIndex <= 0 || stationIndex >= line.stationIds.length - 1) return false;
    const station = this.rail.stations[line.stationIds[stationIndex]];
    return !!station && station.kind !== RailStationKind.Terminal;
  }

  private stationHasTrunk(stationId: number): boolean {
    const station = this.rail.stations[stationId];
    return !!station && station.lineIds.some((lineId) => this.rail.lines[lineId]?.kind === 'trunk');
  }

  private platformLength(stationId: number): number {
    const station = this.rail.stations[stationId]; if (!station) return 58;
    if (station.kind === RailStationKind.Central) return 82;
    if (station.kind === RailStationKind.SubCenter) return 72;
    if (station.kind === RailStationKind.Terminal) return 64;
    return 58;
  }

  private buildTrains(): void {
    for (const line of this.rail.lines) {
      const smooth = this.smoothLines.get(line.id); if (!smooth || smooth.length < 300 || line.stationIds.length < 2) continue;
      const services: TrainService[] = [];
      if (line.kind === 'trunk') {
        services.push('local');
        if (smooth.length > 4500) services.push('local');
        if (line.stationIds.length >= 5) services.push('rapid');
        if (line.stationIds.length >= 7) services.push('limited');
      } else services.push('local');
      const total = services.length;
      for (let i = 0; i < total; i++) {
        const service = services[i];
        const maxStation = line.stationIds.length - 1;
        const stationIndex = Math.min(maxStation, Math.round((i * maxStation) / Math.max(1, total - 1)));
        let direction: 1 | -1 = (i & 1) === 0 ? 1 : -1;
        if (stationIndex <= 0) direction = 1; else if (stationIndex >= maxStation) direction = -1;
        const carCount = service === 'limited' ? 5 : service === 'rapid' ? 5 : line.kind === 'trunk' ? 4 : 3;
        const id = this.trainRuns.length;
        const initialDwell = 4 + i * 3;
        const station = this.rail.stations[line.stationIds[stationIndex]];
        let scheduledDepartureAt = initialDwell;
        if (station?.kind === RailStationKind.Terminal) {
          scheduledDepartureAt = this.timetable.nextTerminalDeparture(initialDwell, line.id, direction, service, i);
        }
        const run: TrainRun = {
          id, lineId: line.id, service, carCount,
          cruiseSpeed: service === 'limited' ? 31.0 : service === 'rapid' ? 27.0 : line.kind === 'trunk' ? 21.5 : 17.0,
          direction, speed: 0, distance: 0,
          currentStationIndex: stationIndex, originStationIndex: -1, nextStationIndex: -1,
          dwellRemaining: initialDwell, scheduledDepartureAt, waitingSince: -1, trainOrdinal: i,
          state: 'dwell', x: 0, z: 0, heading: 0,
        };
        run.distance = this.stationDistanceForRun(run, smooth, stationIndex);
        this.trainRuns.push(run);
      }
    }
    if (this.trainRuns.length === 0) return;
    let cap = 0; for (const run of this.trainRuns) cap += run.carCount;
    this.trainBody = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.18, vertexColors: true }), cap);
    this.trainStripe = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.10, vertexColors: true }), cap);
    this.trainCabin = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.22, vertexColors: true }), cap);
    let idx = 0;
    for (const run of this.trainRuns) for (let c = 0; c < run.carCount; c++) {
      this.trainInstanceToRun[idx] = run.id;
      const route = this.trainRouteColor(run.lineId);
      const body = new THREE.Color(run.service === 'local' ? 0xdfe5e8 : 0xf5f7f9);
      const glass = route.clone().lerp(new THREE.Color(0x102235), 0.72);
      this.trainBody.setColorAt(idx, body);
      this.trainStripe.setColorAt(idx, route);
      this.trainCabin.setColorAt(idx, glass);
      idx++;
    }
    if (this.trainBody.instanceColor) this.trainBody.instanceColor.needsUpdate = true;
    if (this.trainStripe.instanceColor) this.trainStripe.instanceColor.needsUpdate = true;
    if (this.trainCabin.instanceColor) this.trainCabin.instanceColor.needsUpdate = true;
    const hitSphere = new THREE.Sphere(new THREE.Vector3(this.rail.sizeMeters / 2, RailRenderer.TRACK_Y, this.rail.sizeMeters / 2), Math.max(20_000, this.rail.sizeMeters * 2));
    const meshes = [this.trainBody, this.trainStripe, this.trainCabin] as THREE.InstancedMesh[];
    for (const mesh of meshes) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.boundingSphere = hitSphere.clone(); this.scene.add(mesh);
    }
  }

  private trainRouteColor(lineId: number): THREE.Color {
    const palette = [0x2276c9, 0x7656c8, 0x00a5b8, 0xc45da4, 0x4477cc, 0x8a5cc2, 0x2d9bb3];
    return new THREE.Color(palette[Math.abs(lineId) % palette.length]);
  }

  private buildRailSignals(): void {
    const poles: StaticPart[] = [], heads: StaticPart[] = [];
    for (const line of this.rail.lines) {
      const smooth = this.smoothLines.get(line.id); if (!smooth) continue;
      for (let i = 0; i < line.stationIds.length; i++) {
        for (const dir of [-1, 1] as const) {
          const next = i + dir; if (next < 0 || next >= line.stationIds.length) continue;
          const stationId = line.stationIds[i], edge = this.platformLength(stationId) / 2 + RailRenderer.SWITCH_CLEARANCE + 5;
          const d = THREE.MathUtils.clamp((smooth.stationDistances[i] ?? 0) + dir * edge, 0, smooth.length);
          const p = this.sampleSmooth(smooth, d); if (!p) continue;
          const lateral = dir > 0 ? -3.35 : 3.35;
          const x = p.x - Math.sin(p.heading) * lateral, z = p.z + Math.cos(p.heading) * lateral;
          poles.push({ matrix: this.matrix(x, RailRenderer.TRACK_Y + 1.65, z, 0.18, 3.3, 0.18) });
          heads.push({ matrix: this.matrix(x, RailRenderer.TRACK_Y + 3.45, z, 0.76, 2.05, 0.52, -p.heading) });
          this.railSignals.push({ lineId: line.id, stationIndex: i, direction: dir, instanceIndex: this.railSignals.length, x, z });
        }
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4c5156, roughness: 0.7 }), poles);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x111417, roughness: 0.75 }), heads);
    const count = this.railSignals.length; if (count === 0) return;
    const sphere = new THREE.SphereGeometry(1, 10, 8);
    this.signalRed = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0xff3030 }), count);
    this.signalYellow = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0xffd23c }), count);
    this.signalGreen = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0x39ef73 }), count);
    for (const mesh of [this.signalRed, this.signalYellow, this.signalGreen]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; this.scene.add(mesh);
    }
  }

  private updateSignals(): void {
    if (!this.signalRed || !this.signalYellow || !this.signalGreen) return;
    for (const s of this.railSignals) {
      const aspect = this.signalAspect(s);
      this.setSignalLamp(this.signalRed, s, 0, aspect === 'red');
      this.setSignalLamp(this.signalYellow, s, 1, aspect === 'yellow');
      this.setSignalLamp(this.signalGreen, s, 2, aspect === 'green');
    }
    this.signalRed.instanceMatrix.needsUpdate = true;
    this.signalYellow.instanceMatrix.needsUpdate = true;
    this.signalGreen.instanceMatrix.needsUpdate = true;
  }

  private setSignalLamp(mesh: THREE.InstancedMesh, signal: RailSignal, lamp: 0 | 1 | 2, on: boolean): void {
    const y = RailRenderer.TRACK_Y + 4.02 - lamp * 0.58;
    const size = on ? 0.30 : 0.115;
    mesh.setMatrixAt(signal.instanceIndex, this.matrix(signal.x, y, signal.z, size, size, size));
  }

  private signalAspect(signal: RailSignal): SignalAspect {
    if (!this.timetable.directionWindowOpen(this.railTime, signal.lineId, signal.direction)) return 'red';
    const remainingWindow = this.timetable.secondsUntilWindowClose(this.railTime, signal.lineId, signal.direction);
    const to = signal.stationIndex + signal.direction;
    const blockId = this.blockIdFor(signal.lineId, signal.stationIndex, to);
    if (blockId < 0) return 'red';
    const block = this.lineBlocks[blockId]; if (!block) return 'red';
    for (const conflictId of block.conflicts) if (this.blockOccupancy.has(conflictId)) return 'red';

    let reservationOwner = -1;
    for (const conflictId of block.conflicts) {
      const owner = this.blockReservations.get(conflictId);
      if (owner != null) { reservationOwner = owner; break; }
    }
    if (reservationOwner >= 0) {
      const run = this.trainRuns[reservationOwner];
      if (!run || run.lineId !== signal.lineId || run.direction !== signal.direction) return 'red';
    }

    const line = this.rail.lines[signal.lineId]; if (!line) return 'red';
    const targetStationId = line.stationIds[to];
    const turnout = this.turnoutState.get(targetStationId);
    if (turnout && !turnout.startsWith(`L${signal.lineId}:`)) return 'red';
    const junction = this.routeReservations.get(`junction:${targetStationId}`);
    if (junction && junction.lineId !== signal.lineId) return 'red';

    if (remainingWindow < 14) return 'yellow';
    const next = to + signal.direction;
    if (next >= 0 && next < line.stationIds.length) {
      const nextBlock = this.blockIdFor(signal.lineId, to, next);
      if (nextBlock >= 0) {
        const nb = this.lineBlocks[nextBlock];
        if (nb && [...nb.conflicts].some((id) => this.blockOccupancy.has(id) || this.blockReservations.has(id))) return 'yellow';
      }
    }
    return 'green';
  }

  private makeSmoothLine(line: RailLine): SmoothLine {
    const src = this.sharedStationSafePath(line), path: RailPoint[] = [];
    const push = (p: RailPoint): void => {
      const last = path[path.length - 1]; if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 0.08) path.push({ x: p.x, z: p.z });
    };
    if (src.length > 0) push(src[0]);
    for (let i = 1; i < src.length - 1; i++) {
      const prev = src[i - 1], p = src[i], next = src[i + 1];
      const ax = p.x - prev.x, az = p.z - prev.z, bx = next.x - p.x, bz = next.z - p.z;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz); if (la < 1 || lb < 1) { push(p); continue; }
      const uaX = ax / la, uaZ = az / la, ubX = bx / lb, ubZ = bz / lb;
      const dot = THREE.MathUtils.clamp(uaX * ubX + uaZ * ubZ, -1, 1);
      if (dot > 0.992) { push(p); continue; }
      const radius = Math.min(22, la * 0.28, lb * 0.28); if (radius < 2.5) { push(p); continue; }
      const entry = { x: p.x - uaX * radius, z: p.z - uaZ * radius };
      const exit = { x: p.x + ubX * radius, z: p.z + ubZ * radius };
      push(entry);
      const steps = Math.max(8, Math.ceil(radius / 2.5));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        push({ x: u * u * entry.x + 2 * u * t * p.x + t * t * exit.x, z: u * u * entry.z + 2 * u * t * p.z + t * t * exit.z });
      }
    }
    if (src.length > 1) push(src[src.length - 1]);
    const cumulative = new Array(path.length).fill(0); let length = 0;
    for (let i = 1; i < path.length; i++) { length += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z); cumulative[i] = length; }
    const stationDistances = line.stationIds.map((sid) => {
      const s = this.rail.stations[sid]; return s ? this.nearestDistanceOnPath(path, cumulative, s.x, s.z) : 0;
    });
    return { line, path, cumulative, length, stationDistances };
  }

  private sharedStationSafePath(line: RailLine): RailPoint[] {
    if (line.kind !== 'spur' || line.path.length < 2) return line.path;
    const out = line.path.map((p) => ({ x: p.x, z: p.z }));
    for (const stationId of line.stationIds) {
      const station = this.rail.stations[stationId]; if (!station || !this.stationHasTrunk(stationId)) continue;
      const trunkId = station.lineIds.find((id) => this.rail.lines[id]?.kind === 'trunk');
      if (trunkId == null) continue;
      const trunk = this.smoothLines.get(trunkId); if (!trunk) continue;
      const td = trunk.stationDistances[this.rail.lines[trunkId].stationIds.indexOf(stationId)];
      if (!Number.isFinite(td)) continue;
      const tp = this.sampleSmooth(trunk, td); if (!tp) continue;
      const protect = this.platformLength(stationId) * 0.5 + RailRenderer.SWITCH_CLEARANCE + RailRenderer.SWITCH_APPROACH;
      for (let i = 0; i < out.length; i++) {
        const dx = out[i].x - station.x, dz = out[i].z - station.z;
        const along = dx * Math.cos(tp.heading) + dz * Math.sin(tp.heading);
        const lateral = -dx * Math.sin(tp.heading) + dz * Math.cos(tp.heading);
        if (Math.abs(along) > protect) continue;
        const u = THREE.MathUtils.clamp((protect - Math.abs(along)) / Math.max(1, RailRenderer.SWITCH_APPROACH), 0, 1);
        const pull = u * u * (3 - 2 * u);
        const newLat = lateral * (1 - pull);
        out[i].x = station.x + Math.cos(tp.heading) * along - Math.sin(tp.heading) * newLat;
        out[i].z = station.z + Math.sin(tp.heading) * along + Math.cos(tp.heading) * newLat;
      }
    }
    return out;
  }

  private nearestDistanceOnPath(path: RailPoint[], cumulative: number[], x: number, z: number): number {
    let bestD = Infinity, bestAlong = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz; if (len2 < 0.01) continue;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
      const qx = a.x + dx * t, qz = a.z + dz * t, d2 = (x - qx) ** 2 + (z - qz) ** 2;
      if (d2 < bestD) { bestD = d2; bestAlong = cumulative[i - 1] + Math.sqrt(len2) * t; }
    }
    return bestAlong;
  }

  private sampleSmooth(smooth: SmoothLine, distance: number): { x: number; z: number; heading: number } | null {
    if (smooth.path.length < 2 || smooth.length <= 0) return null;
    const d = THREE.MathUtils.clamp(distance, 0, smooth.length), p = this.sampleSmoothPosition(smooth, d); if (!p) return null;
    const look = 2.2;
    const a = this.sampleSmoothPosition(smooth, Math.max(0, d - look)), b = this.sampleSmoothPosition(smooth, Math.min(smooth.length, d + look));
    const heading = a && b && Math.hypot(b.x - a.x, b.z - a.z) > 0.01 ? Math.atan2(b.z - a.z, b.x - a.x) : 0;
    return { x: p.x, z: p.z, heading };
  }

  private sampleSmoothPosition(smooth: SmoothLine, distance: number): RailPoint | null {
    if (smooth.path.length < 2 || smooth.length <= 0) return null;
    const d = THREE.MathUtils.clamp(distance, 0, smooth.length);
    let hi = 1; while (hi < smooth.cumulative.length && smooth.cumulative[hi] < d) hi++;
    hi = Math.min(hi, smooth.path.length - 1); const lo = Math.max(0, hi - 1);
    const a = smooth.path[lo], b = smooth.path[hi], start = smooth.cumulative[lo], end = smooth.cumulative[hi];
    const t = end > start ? (d - start) / (end - start) : 0;
    return { x: THREE.MathUtils.lerp(a.x, b.x, t), z: THREE.MathUtils.lerp(a.z, b.z, t) };
  }

  private pushTrackSegment(a: RailPoint, b: RailPoint, ballast: StaticPart[], rails: StaticPart[], ballastWidth = 3.8): void {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz); if (len < 0.35) return;
    const px = -dz / len, pz = dx / len, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, angle = -Math.atan2(dz, dx);
    ballast.push({ matrix: this.matrix(mx, RailRenderer.TRACK_Y, mz, len + 0.22, 0.32, ballastWidth, angle) });
    for (const side of [-1, 1]) rails.push({ matrix: this.matrix(mx + px * 0.82 * side, RailRenderer.TRACK_Y + 0.28, mz + pz * 0.82 * side, len + 0.16, 0.15, 0.13, angle) });
  }

  private pose(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, heading: number, sx: number, sy: number, sz: number): void {
    this.d.position.set(x, y, z); this.d.rotation.set(0, -heading, 0); this.d.scale.set(sx, sy, sz); this.d.updateMatrix(); mesh.setMatrixAt(index, this.d.matrix);
  }

  private matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0): THREE.Matrix4 {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)), new THREE.Vector3(sx, sy, sz));
  }

  private addStatic(geometry: THREE.BufferGeometry, material: THREE.Material, parts: StaticPart[]): THREE.InstancedMesh | null {
    if (parts.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, parts.length);
    parts.forEach((p, i) => mesh.setMatrixAt(i, p.matrix)); mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh); return mesh;
  }

  private wrapAngle(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }
}
