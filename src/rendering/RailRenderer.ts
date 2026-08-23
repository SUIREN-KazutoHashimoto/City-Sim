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
type RouteMode = 'main' | 'siding';

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

interface PhysicalBlock {
  id: number;
  lineId: number;
  segmentIndex: number;
  direction: -1 | 0 | 1;
  keys: Set<string>;
  conflicts: Set<number>;
}

interface RouteReservation {
  ownerTrainId: number;
  lineId: number;
  route: string;
}

interface TurnoutIndicator {
  stationId: number;
  lineId: number;
  direction: 1 | -1;
  mode: 'junction' | RouteMode;
  instanceIndex: number;
  matrix: THREE.Matrix4;
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
  scheduledDepartureAt: number;
  delaySeconds: number;
}

export interface RailTimetableRow {
  trainId: number;
  lineName: string;
  serviceLabel: string;
  directionLabel: string;
  currentStationName: string;
  nextStationName: string;
  stateLabel: string;
  scheduledDepartureAt: number;
  delaySeconds: number;
  speedKmh: number;
}

export class RailRenderer {
  static readonly TRACK_Y = 8.2;
  private static readonly TRAIN_WIDTH = 2.86;
  private static readonly CAR_LENGTH = 10.2;
  private static readonly CAR_GAP = 0.72;
  private static readonly BOGIE_HALF = 3.55;
  private static readonly ACCEL = 0.82;
  private static readonly BRAKE = 1.24;
  private static readonly MAIN_OFFSET = 1.72;
  private static readonly SIDING_OFFSET = 8.0;
  private static readonly PLATFORM_CLEARANCE = 0.48;
  private static readonly SWITCH_CLEARANCE = 16;
  private static readonly SWITCH_APPROACH = 52;
  private static readonly BLOCK_SAMPLE = 14;
  private static readonly BLOCK_QUANTIZE = 9;
  private static readonly DEADLOCK_WATCH_SECONDS = 70;

  private readonly smoothLines = new Map<number, SmoothLine>();
  private readonly trainRuns: TrainRun[] = [];
  private readonly trainInstanceToRun: number[] = [];
  private readonly railSignals: RailSignal[] = [];
  private readonly physicalBlocks: PhysicalBlock[] = [];
  private readonly blockIdByKey = new Map<string, number>();
  private readonly blockOccupancy = new Map<number, number>();
  private readonly blockReservations = new Map<number, number>();
  private readonly routeReservations = new Map<string, RouteReservation>();
  private readonly turnoutIndicators: TurnoutIndicator[] = [];
  private readonly timetable = new RailTimetable();
  private readonly d = new THREE.Object3D();

  private railTime = 0;
  private lastProgressAt = 0;
  private recoveryTrainId = -1;
  private timetablePanel: HTMLDivElement | null = null;
  private timetableVisible = false;
  private lastTimetableDraw = -Infinity;

  private trainBody: THREE.InstancedMesh | null = null;
  private trainCabin: THREE.InstancedMesh | null = null;
  private trainStripe: THREE.InstancedMesh | null = null;
  private signalRed: THREE.InstancedMesh | null = null;
  private signalYellow: THREE.InstancedMesh | null = null;
  private signalGreen: THREE.InstancedMesh | null = null;
  private turnoutMesh: THREE.InstancedMesh | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rail: RailNetworkPlan,
    private readonly roads?: RoadNetwork,
  ) {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyT') this.toggleTimetable();
      });
    }
  }

  build(): void {
    if (this.rail.lines.length === 0) return;
    for (const line of this.rail.lines.filter((l) => l.kind === 'trunk')) this.smoothLines.set(line.id, this.makeSmoothLine(line));
    for (const line of this.rail.lines.filter((l) => l.kind !== 'trunk')) this.smoothLines.set(line.id, this.makeSmoothLine(line));

    this.buildPhysicalBlocks();
    this.buildTrackGeometry();
    this.buildStations();
    this.buildTrains();
    this.buildRailSignals();
    this.buildTurnoutIndicators();
    this.buildTimetablePanel();
    this.rebuildDispatchReservations();
    this.updateTrainMeshes();
    this.updateSignals();
    this.updateTurnoutIndicators();
    this.drawTimetable(true);
  }

  update(realDt = 1 / 60, timeScale = 1, paused = false): void {
    if (!this.trainBody || this.trainRuns.length === 0) return;
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
    this.updateTurnoutIndicators();
    this.drawTimetable(false);
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
    const stateLabel = this.actualStateLabel(run);
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
      scheduledDepartureAt: run.scheduledDepartureAt,
      delaySeconds: Math.max(0, this.railTime - run.scheduledDepartureAt),
    };
  }

  timetableRows(): RailTimetableRow[] {
    return this.trainRuns.map((run) => {
      const line = this.rail.lines[run.lineId];
      const currentId = run.currentStationIndex >= 0 ? line?.stationIds[run.currentStationIndex] ?? -1 : -1;
      const nextId = run.nextStationIndex >= 0 ? line?.stationIds[run.nextStationIndex] ?? -1 : -1;
      return {
        trainId: run.id,
        lineName: line?.name ?? `L${run.lineId}`,
        serviceLabel: this.serviceLabel(run.service),
        directionLabel: run.direction > 0 ? '下り' : '上り',
        currentStationName: currentId >= 0 ? this.rail.stations[currentId]?.name ?? '—' : '走行中',
        nextStationName: nextId >= 0 ? this.rail.stations[nextId]?.name ?? '—' : '—',
        stateLabel: this.actualStateLabel(run),
        scheduledDepartureAt: run.scheduledDepartureAt,
        delaySeconds: Math.max(0, this.railTime - run.scheduledDepartureAt),
        speedKmh: run.speed * 3.6,
      };
    });
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

  private actualStateLabel(run: TrainRun): string {
    if (run.state === 'dwell') return '停車中';
    if (run.state === 'schedule') return 'ダイヤ待ち';
    if (run.state === 'signal') return '信号待ち';
    if (run.speed < 0.45) return '停止中';
    if (run.speed < 2.0) return '徐行中';
    return '走行中';
  }

  private stepOperations(dt: number): void {
    this.railTime += dt;
    this.rebuildDispatchReservations();
    let progressed = false;
    for (const run of this.dispatchOrder()) {
      const before = run.distance;
      this.stepTrain(run, dt);
      if (Math.abs(run.distance - before) > 0.02) progressed = true;
    }
    if (progressed) {
      this.lastProgressAt = this.railTime;
      this.recoveryTrainId = -1;
    } else if (this.railTime - this.lastProgressAt > RailRenderer.DEADLOCK_WATCH_SECONDS) {
      this.recoveryTrainId = this.oldestWaitingTrain();
      this.lastProgressAt = this.railTime;
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

  private oldestWaitingTrain(): number {
    const waiting = this.trainRuns.filter((r) => r.currentStationIndex >= 0 && (r.state === 'signal' || r.state === 'schedule'));
    waiting.sort((a, b) => {
      const at = this.isAtTerminal(a) ? 1 : 0, bt = this.isAtTerminal(b) ? 1 : 0;
      if (at !== bt) return bt - at;
      const aw = a.waitingSince >= 0 ? a.waitingSince : this.railTime;
      const bw = b.waitingSince >= 0 ? b.waitingSince : this.railTime;
      if (aw !== bw) return aw - bw;
      return this.servicePriority(b.service) - this.servicePriority(a.service);
    });
    return waiting[0]?.id ?? -1;
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

      let reversed = false;
      if ((run.direction > 0 && run.currentStationIndex >= lastStation) || (run.direction < 0 && run.currentStationIndex <= 0)) {
        run.direction = run.direction > 0 ? -1 : 1;
        reversed = true;
      }
      if (reversed) {
        run.scheduledDepartureAt = this.timetable.nextTerminalDeparture(
          Math.max(this.railTime, run.scheduledDepartureAt), run.lineId, run.direction, run.service, run.trainOrdinal,
        );
      }

      const next = run.currentStationIndex + run.direction;
      if (next < 0 || next > lastStation) return;
      if (this.railTime + 1e-6 < run.scheduledDepartureAt) {
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
      && !this.canEnterBlock(run, boundaryIndex, following);

    let brakeDistance = boundaryRemaining;
    if (!scheduledStop && !signalStop) {
      const stopIndex = this.nextScheduledStopIndex(run, boundaryIndex);
      brakeDistance = stopIndex >= 0
        ? Math.abs(this.stationDistanceForRun(run, smooth, stopIndex) - run.distance)
        : Infinity;
    }

    const brakingTarget = Number.isFinite(brakeDistance)
      ? Math.sqrt(Math.max(0, 2 * RailRenderer.BRAKE * Math.max(0, brakeDistance - 0.30)))
      : run.cruiseSpeed;
    const targetSpeed = Math.min(run.cruiseSpeed, brakingTarget);
    if (run.speed < targetSpeed) run.speed = Math.min(targetSpeed, run.speed + RailRenderer.ACCEL * dt);
    else run.speed = Math.max(targetSpeed, run.speed - RailRenderer.BRAKE * dt);

    const move = Math.min(boundaryRemaining, Math.max(0.08, run.speed) * dt);
    run.distance += run.direction * move;
    if (boundaryRemaining > 0.34 && move < boundaryRemaining - 0.02) return;

    run.distance = boundaryDistance;
    const stationId = smooth.line.stationIds[boundaryIndex];
    if (scheduledStop) {
      this.stopAtStation(run, boundaryIndex, stationId);
      return;
    }
    if (following < 0 || following > lastStation) {
      this.stopAtStation(run, boundaryIndex, stationId);
      return;
    }
    if (!this.canEnterBlock(run, boundaryIndex, following)) {
      run.speed = 0;
      run.currentStationIndex = boundaryIndex;
      run.originStationIndex = -1;
      run.nextStationIndex = -1;
      run.state = 'signal';
      run.dwellRemaining = 0;
      if (run.waitingSince < 0) run.waitingSince = this.railTime;
      return;
    }
    run.originStationIndex = boundaryIndex;
    run.nextStationIndex = following;
  }

  private stopAtStation(run: TrainRun, stationIndex: number, stationId: number): void {
    const dwell = this.dwellSeconds(run, stationId);
    run.speed = 0;
    run.currentStationIndex = stationIndex;
    run.originStationIndex = -1;
    run.nextStationIndex = -1;
    run.state = 'dwell';
    run.dwellRemaining = dwell;
    run.scheduledDepartureAt = this.railTime + dwell;
    run.waitingSince = -1;
  }

  private canEnterBlock(run: TrainRun, fromIndex: number, toIndex: number): boolean {
    const blockId = this.blockIdFor(run.lineId, fromIndex, toIndex);
    if (blockId < 0 || !this.blockAvailableFor(run.id, blockId)) return false;
    const reserved = this.blockReservations.get(blockId);
    if (reserved != null && reserved !== run.id) return false;
    if (!this.terminalAvailable(run, toIndex)) return false;
    if (!this.routesAvailableFor(run, fromIndex, toIndex)) return false;
    if (!this.stationTrackAvailable(run, toIndex)) return false;
    return true;
  }

  private stationTrackAvailable(run: TrainRun, toIndex: number): boolean {
    const line = this.rail.lines[run.lineId]; if (!line) return false;
    const stationId = line.stationIds[toIndex];
    const targetTrack = this.trackMode(run, toIndex);
    for (const other of this.trainRuns) {
      if (other.id === run.id || other.currentStationIndex < 0) continue;
      const otherLine = this.rail.lines[other.lineId]; if (!otherLine) continue;
      const otherStationId = otherLine.stationIds[other.currentStationIndex];
      if (otherStationId !== stationId) continue;
      if (other.lineId !== run.lineId) {
        if (this.rail.stations[stationId]?.lineIds.length > 1) return false;
        continue;
      }
      if (line.kind !== 'trunk') return false;
      const otherTrack = this.trackMode(other, other.currentStationIndex);
      if (targetTrack === otherTrack && run.direction === other.direction) return false;
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

  private rebuildDispatchReservations(): void {
    this.blockOccupancy.clear();
    this.blockReservations.clear();
    this.routeReservations.clear();

    for (const run of this.trainRuns) {
      if (run.state !== 'running' || run.originStationIndex < 0 || run.nextStationIndex < 0) continue;
      const blockId = this.blockIdFor(run.lineId, run.originStationIndex, run.nextStationIndex);
      if (blockId >= 0) this.blockOccupancy.set(blockId, run.id);
      this.reserveRoutes(run, this.routeKeysForSegment(run, run.originStationIndex, run.nextStationIndex));
    }

    for (const run of this.dispatchOrder()) {
      const seg = this.upcomingSegment(run); if (!seg) continue;
      if (run.currentStationIndex >= 0 && this.railTime + 1e-6 < run.scheduledDepartureAt) continue;
      const blockId = this.blockIdFor(run.lineId, seg.from, seg.to);
      if (blockId < 0 || !this.blockAvailableFor(run.id, blockId)) continue;
      if (!this.terminalAvailable(run, seg.to) || !this.stationTrackAvailable(run, seg.to)) continue;
      const routeKeys = this.routeKeysForSegment(run, seg.from, seg.to);
      if (!this.reserveRoutes(run, routeKeys)) continue;
      this.blockReservations.set(blockId, run.id);
    }
  }

  private upcomingSegment(run: TrainRun): { from: number; to: number } | null {
    const line = this.rail.lines[run.lineId]; if (!line || line.stationIds.length < 2) return null;
    let from = run.currentStationIndex >= 0 ? run.currentStationIndex : run.nextStationIndex;
    if (from < 0) return null;
    let dir = run.direction;
    const last = line.stationIds.length - 1;
    if (from === last && dir > 0) dir = -1;
    else if (from === 0 && dir < 0) dir = 1;
    const to = from + dir;
    return to >= 0 && to <= last ? { from, to } : null;
  }

  private blockAvailableFor(trainId: number, blockId: number): boolean {
    const block = this.physicalBlocks[blockId]; if (!block) return false;
    for (const conflictId of block.conflicts) {
      const occupiedBy = this.blockOccupancy.get(conflictId);
      if (occupiedBy != null && occupiedBy !== trainId) return false;
      const reservedBy = this.blockReservations.get(conflictId);
      if (reservedBy != null && reservedBy !== trainId) return false;
    }
    return true;
  }

  private routesAvailableFor(run: TrainRun, fromIndex: number, toIndex: number): boolean {
    for (const key of this.routeKeysForSegment(run, fromIndex, toIndex)) {
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
    const route = `${this.trackMode(run, run.currentStationIndex >= 0 ? run.currentStationIndex : run.nextStationIndex)}:${run.direction}`;
    for (const key of keys) this.routeReservations.set(key, { ownerTrainId: run.id, lineId: run.lineId, route });
    return true;
  }

  private routeKeysForSegment(run: TrainRun, fromIndex: number, toIndex: number): string[] {
    const line = this.rail.lines[run.lineId]; if (!line) return [];
    const keys: string[] = [];
    for (const index of [fromIndex, toIndex]) {
      const stationId = line.stationIds[index], station = this.rail.stations[stationId];
      if (!station) continue;
      if (station.lineIds.length > 1) keys.push(`junction:${stationId}`);
      if (this.lineStationHasPassingLoop(run.lineId, index)) keys.push(`turnout:${run.lineId}:${stationId}:${run.direction}`);
      if (station.kind === RailStationKind.Terminal) keys.push(`terminal:${stationId}`);
    }
    return [...new Set(keys)];
  }

  private buildPhysicalBlocks(): void {
    this.physicalBlocks.length = 0;
    this.blockIdByKey.clear();
    for (const smooth of this.smoothLines.values()) {
      const dirs: (-1 | 0 | 1)[] = smooth.line.kind === 'trunk' ? [-1, 1] : [0];
      for (let segmentIndex = 0; segmentIndex < smooth.stationDistances.length - 1; segmentIndex++) {
        for (const direction of dirs) {
          const start = smooth.stationDistances[segmentIndex], end = smooth.stationDistances[segmentIndex + 1];
          const lo = Math.min(start, end), hi = Math.max(start, end);
          const keys = new Set<string>();
          for (let d = lo + 3; d <= hi - 3; d += RailRenderer.BLOCK_SAMPLE) {
            const p = this.sampleSmooth(smooth, d); if (!p) continue;
            const offset = smooth.line.kind === 'trunk' ? RailRenderer.MAIN_OFFSET * direction : 0;
            const x = p.x - Math.sin(p.heading) * offset;
            const z = p.z + Math.cos(p.heading) * offset;
            keys.add(this.trackCellKey(x, z));
          }
          const id = this.physicalBlocks.length;
          const block: PhysicalBlock = { id, lineId: smooth.line.id, segmentIndex, direction, keys, conflicts: new Set([id]) };
          this.physicalBlocks.push(block);
          this.blockIdByKey.set(this.blockKey(smooth.line.id, segmentIndex, direction), id);
        }
      }
    }

    for (let i = 0; i < this.physicalBlocks.length; i++) for (let j = i + 1; j < this.physicalBlocks.length; j++) {
      const a = this.physicalBlocks[i], b = this.physicalBlocks[j];
      if (a.lineId === b.lineId) continue;
      const small = a.keys.size <= b.keys.size ? a.keys : b.keys;
      const large = small === a.keys ? b.keys : a.keys;
      let overlap = 0;
      for (const key of small) if (large.has(key) && ++overlap >= 2) break;
      if (overlap >= 2) { a.conflicts.add(b.id); b.conflicts.add(a.id); }
    }
  }

  private blockIdFor(lineId: number, fromIndex: number, toIndex: number): number {
    const line = this.rail.lines[lineId]; if (!line) return -1;
    const segment = Math.min(fromIndex, toIndex);
    const direction: -1 | 0 | 1 = line.kind === 'trunk' ? (toIndex > fromIndex ? 1 : -1) : 0;
    return this.blockIdByKey.get(this.blockKey(lineId, segment, direction)) ?? -1;
  }

  private blockKey(lineId: number, segment: number, direction: -1 | 0 | 1): string { return `${lineId}:${segment}:${direction}`; }
  private trackCellKey(x: number, z: number): string { const q = RailRenderer.BLOCK_QUANTIZE; return `${Math.round(x / q)},${Math.round(z / q)}`; }

  private buildTrackGeometry(): void {
    const ballast: StaticPart[] = [], rails: StaticPart[] = [], sleepers: StaticPart[] = [], supports: StaticPart[] = [];
    for (const smooth of this.smoothLines.values()) {
      if (smooth.line.kind === 'trunk') {
        for (const side of [-1, 1]) this.pushOffsetTrack(smooth, side * RailRenderer.MAIN_OFFSET, ballast, rails, sleepers);
      } else this.pushOffsetTrack(smooth, 0, ballast, rails, sleepers);
      for (let s = 36; s < smooth.length; s += 72) {
        const p = this.sampleSmooth(smooth, s); if (!p) continue;
        supports.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y * 0.5, p.z, 0.68, RailRenderer.TRACK_Y, 0.68) });
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), ballast);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), rails);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x54504a, roughness: 0.98 }), sleepers);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x8a8f92, roughness: 0.88 }), supports);
  }

  private pushOffsetTrack(smooth: SmoothLine, offset: number, ballast: StaticPart[], rails: StaticPart[], sleepers: StaticPart[]): void {
    let prev: { x: number; z: number } | null = null;
    for (let s = 0; s <= smooth.length + 0.01; s = Math.min(smooth.length, s + 5.5)) {
      const p = this.offsetPoint(smooth, s, offset); if (!p) break;
      if (prev) this.pushTrackSegment(prev, p, ballast, rails, 3.5);
      prev = p;
      if (s >= smooth.length) break;
    }
    for (let s = 0; s <= smooth.length; s += 8.5) {
      const p = this.offsetPoint(smooth, s, offset); if (!p) continue;
      sleepers.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y + 0.17, p.z, 0.18, 0.12, 3.0, -p.heading) });
    }
  }

  private buildStations(): void {
    const platforms: StaticPart[] = [], roofs: StaticPart[] = [], signs: StaticPart[] = [], columns: StaticPart[] = [], stairs: StaticPart[] = [];
    const sidingBallast: StaticPart[] = [], sidingRails: StaticPart[] = [];
    for (const line of this.rail.lines) {
      const smooth = this.smoothLines.get(line.id); if (!smooth) continue;
      for (let i = 0; i < line.stationIds.length; i++) {
        const stationId = line.stationIds[i], station = this.rail.stations[stationId]; if (!station) continue;
        if (line.kind === 'spur' && this.stationHasTrunk(stationId)) continue;
        const center = smooth.stationDistances[i] ?? 0;
        const length = this.platformLength(stationId);
        const width = station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter ? 4.2 : 3.8;
        if (this.lineStationHasPassingLoop(line.id, i)) {
          this.buildSidings(smooth, center, length, sidingBallast, sidingRails);
          const island = (RailRenderer.MAIN_OFFSET + RailRenderer.SIDING_OFFSET) * 0.5;
          this.buildPlatformRibbon(smooth, center, length, island, width, true, stationId, platforms, roofs, signs, columns, stairs);
          this.buildPlatformRibbon(smooth, center, length, -island, width, false, stationId, platforms, roofs, signs, columns, stairs);
        } else if (line.kind === 'trunk') {
          const offset = RailRenderer.MAIN_OFFSET + RailRenderer.TRAIN_WIDTH / 2 + RailRenderer.PLATFORM_CLEARANCE + width / 2;
          this.buildPlatformRibbon(smooth, center, length, offset, width, true, stationId, platforms, roofs, signs, columns, stairs);
          this.buildPlatformRibbon(smooth, center, length, -offset, width, false, stationId, platforms, roofs, signs, columns, stairs);
        } else {
          const side = ((stationId + line.id) & 1) === 0 ? 1 : -1;
          const offset = side * (RailRenderer.TRAIN_WIDTH / 2 + RailRenderer.PLATFORM_CLEARANCE + width / 2);
          this.buildPlatformRibbon(smooth, center, length, offset, width, true, stationId, platforms, roofs, signs, columns, stairs);
        }
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xc9c7bf, roughness: 0.86 }), platforms);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x6f7d88, roughness: 0.58, metalness: 0.18 }), roofs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x2f6fa3, roughness: 0.52 }), signs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777d82, roughness: 0.9 }), columns);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xa9a69e, roughness: 0.92 }), stairs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), sidingBallast);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), sidingRails);
  }

  private buildSidings(smooth: SmoothLine, center: number, platformLength: number, ballast: StaticPart[], rails: StaticPart[]): void {
    const half = platformLength * 0.5;
    const start = Math.max(0, center - half - RailRenderer.SWITCH_CLEARANCE - RailRenderer.SWITCH_APPROACH);
    const end = Math.min(smooth.length, center + half + RailRenderer.SWITCH_CLEARANCE + RailRenderer.SWITCH_APPROACH);
    for (const side of [-1, 1]) {
      let prev: RailPoint | null = null;
      for (let s = start; s <= end + 0.01; s = Math.min(end, s + 4.5)) {
        const p = this.sampleSmooth(smooth, s); if (!p) break;
        const profile = this.sidingProfile(Math.abs(s - center), half);
        const off = side * (RailRenderer.MAIN_OFFSET + (RailRenderer.SIDING_OFFSET - RailRenderer.MAIN_OFFSET) * profile);
        const q = { x: p.x - Math.sin(p.heading) * off, z: p.z + Math.cos(p.heading) * off };
        if (prev) this.pushTrackSegment(prev, q, ballast, rails, 3.35);
        prev = q;
        if (s >= end) break;
      }
    }
  }

  private sidingProfile(distance: number, halfPlatform: number): number {
    const full = halfPlatform + RailRenderer.SWITCH_CLEARANCE;
    const outer = full + RailRenderer.SWITCH_APPROACH;
    if (distance <= full) return 1;
    if (distance >= outer) return 0;
    const t = THREE.MathUtils.clamp((outer - distance) / RailRenderer.SWITCH_APPROACH, 0, 1);
    return t * t * (3 - 2 * t);
  }

  private buildPlatformRibbon(
    smooth: SmoothLine, center: number, length: number, offset: number, width: number, includeSign: boolean, stationId: number,
    platforms: StaticPart[], roofs: StaticPart[], signs: StaticPart[], columns: StaticPart[], stairs: StaticPart[],
  ): void {
    const start = Math.max(0, center - length / 2), end = Math.min(smooth.length, center + length / 2);
    for (let s = start; s < end - 0.01; s += 7.2) {
      const e = Math.min(end, s + 7.2);
      const a = this.offsetPoint(smooth, s, offset), b = this.offsetPoint(smooth, e, offset); if (!a || !b) continue;
      this.pushRibbonSegment(a, b, RailRenderer.TRACK_Y + 0.38, 0.38, width, platforms);
      if (Math.abs((s + e) * 0.5 - center) < length * 0.36) this.pushRibbonSegment(a, b, RailRenderer.TRACK_Y + 3.25, 0.18, width * 0.78, roofs);
    }
    for (let s = start + 6; s <= end - 5; s += 16) {
      const p = this.offsetPoint(smooth, s, offset); if (p) columns.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y * 0.5, p.z, 0.5, RailRenderer.TRACK_Y, 0.5) });
    }
    if (includeSign) {
      const p = this.offsetPoint(smooth, center, offset); if (p) signs.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y + 4.05, p.z, 4.6, 1.25, 0.22, -p.heading) });
    }
    this.buildPlatformAccess(smooth, start + 3, offset, -1, stairs);
    this.buildPlatformAccess(smooth, end - 3, offset, 1, stairs);
  }

  private buildPlatformAccess(smooth: SmoothLine, distance: number, offset: number, direction: -1 | 1, stairs: StaticPart[]): void {
    const anchor = this.offsetPoint(smooth, distance, offset); if (!anchor) return;
    const side = offset >= 0 ? 1 : -1;
    const roadHalf = this.roadHalfWidthAt(anchor.x, anchor.z, anchor.heading);
    const outerAbs = Math.max(Math.abs(offset) + 3.3, roadHalf + 3.2);
    const outer = this.offsetPoint(smooth, distance, side * outerAbs); if (!outer) return;
    const concourseY = 5.3;
    this.pushRibbonSegment(anchor, outer, concourseY, 0.28, 2.6, stairs);
    const steps = 12, run = 15.5;
    for (let i = 0; i < steps; i++) {
      const t = i / Math.max(1, steps - 1), along = direction * t * run;
      const x = outer.x + Math.cos(outer.heading) * along, z = outer.z + Math.sin(outer.heading) * along;
      const top = concourseY - t * (concourseY - 0.45);
      stairs.push({ matrix: this.matrix(x, Math.max(0.30, top * 0.5), z, 1.25, Math.max(0.45, top), 2.6, -outer.heading) });
    }
  }

  private roadHalfWidthAt(x: number, z: number, heading: number): number {
    if (!this.roads) return 7;
    const nodeId = this.roads.nearestNode(x, z); if (nodeId < 0) return 7;
    const node = this.roads.nodes[nodeId]; let best = Infinity, lanes = 2;
    for (const edgeId of node.edges) {
      const edge = this.roads.edges[edgeId]; if (!edge) continue;
      const a = this.roads.nodes[edge.from], b = this.roads.nodes[edge.to]; if (!a || !b) continue;
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz; if (len2 < 0.01) continue;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
      const qx = a.x + dx * t, qz = a.z + dz * t;
      const alignment = Math.abs(Math.cos(Math.atan2(dz, dx) - heading));
      const score = (x - qx) ** 2 + (z - qz) ** 2 + (1 - alignment) * 2500;
      if (score < best) { best = score; lanes = Math.max(1, edge.lanes); }
    }
    return roadWidth(lanes) * 0.5;
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
      for (let i = 0; i < services.length; i++) {
        const service = services[i], maxStation = line.stationIds.length - 1;
        const stationIndex = Math.min(maxStation, Math.round((i * maxStation) / Math.max(1, services.length - 1)));
        let direction: 1 | -1 = (i & 1) === 0 ? 1 : -1;
        if (stationIndex <= 0) direction = 1; else if (stationIndex >= maxStation) direction = -1;
        const carCount = service === 'limited' || service === 'rapid' ? 5 : line.kind === 'trunk' ? 4 : 3;
        const initialDwell = 4 + i * 3;
        let scheduledDepartureAt = initialDwell;
        if (this.rail.stations[line.stationIds[stationIndex]]?.kind === RailStationKind.Terminal) {
          scheduledDepartureAt = this.timetable.nextTerminalDeparture(initialDwell, line.id, direction, service, i);
        }
        const run: TrainRun = {
          id: this.trainRuns.length, lineId: line.id, service, carCount,
          cruiseSpeed: service === 'limited' ? 31 : service === 'rapid' ? 27 : line.kind === 'trunk' ? 21.5 : 17,
          direction, speed: 0, distance: 0, currentStationIndex: stationIndex, originStationIndex: -1, nextStationIndex: -1,
          dwellRemaining: initialDwell, scheduledDepartureAt, waitingSince: -1, trainOrdinal: i, state: 'dwell', x: 0, z: 0, heading: 0,
        };
        run.distance = this.stationDistanceForRun(run, smooth, stationIndex);
        this.trainRuns.push(run);
      }
    }
    if (this.trainRuns.length === 0) return;
    let cap = 0; for (const run of this.trainRuns) cap += run.carCount;
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.trainBody = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.18, vertexColors: true }), cap);
    this.trainStripe = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.10, vertexColors: true }), cap);
    this.trainCabin = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.22, vertexColors: true }), cap);
    let idx = 0;
    for (const run of this.trainRuns) for (let c = 0; c < run.carCount; c++) {
      this.trainInstanceToRun[idx] = run.id;
      const route = this.trainRouteColor(run.lineId);
      this.trainBody.setColorAt(idx, new THREE.Color(run.service === 'local' ? 0xdfe5e8 : 0xf5f7f9));
      this.trainStripe.setColorAt(idx, route);
      this.trainCabin.setColorAt(idx, route.clone().lerp(new THREE.Color(0x102235), 0.72));
      idx++;
    }
    for (const mesh of [this.trainBody, this.trainStripe, this.trainCabin]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(this.rail.sizeMeters / 2, RailRenderer.TRACK_Y, this.rail.sizeMeters / 2), Math.max(20_000, this.rail.sizeMeters * 2));
      this.scene.add(mesh);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
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
      const center = this.consistPose(run, smooth); if (center) { run.x = center.x; run.z = center.z; run.heading = center.heading; }
    }
    this.trainBody.count = instance; this.trainCabin.count = instance; this.trainStripe.count = instance;
    this.trainBody.instanceMatrix.needsUpdate = true; this.trainCabin.instanceMatrix.needsUpdate = true; this.trainStripe.instanceMatrix.needsUpdate = true;
  }

  private carPose(run: TrainRun, smooth: SmoothLine, carIndex: number): { x: number; z: number; heading: number } | null {
    const spacing = RailRenderer.CAR_LENGTH + RailRenderer.CAR_GAP;
    const center = run.distance + ((run.carCount - 1) * 0.5 - carIndex) * spacing;
    const a = this.sampleTrainTrack(run, smooth, center - RailRenderer.BOGIE_HALF);
    const b = this.sampleTrainTrack(run, smooth, center + RailRenderer.BOGIE_HALF); if (!a || !b) return null;
    let heading = Math.atan2(b.z - a.z, b.x - a.x); if (run.direction < 0) heading = this.wrapAngle(heading + Math.PI);
    return { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5, heading };
  }

  private consistPose(run: TrainRun, smooth: SmoothLine): { x: number; z: number; heading: number } | null {
    const a = this.sampleTrainTrack(run, smooth, run.distance - RailRenderer.BOGIE_HALF);
    const b = this.sampleTrainTrack(run, smooth, run.distance + RailRenderer.BOGIE_HALF); if (!a || !b) return null;
    let heading = Math.atan2(b.z - a.z, b.x - a.x); if (run.direction < 0) heading = this.wrapAngle(heading + Math.PI);
    return { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5, heading };
  }

  private sampleTrainTrack(run: TrainRun, smooth: SmoothLine, distance: number): { x: number; z: number; heading: number } | null {
    const p = this.sampleSmooth(smooth, THREE.MathUtils.clamp(distance, 0, smooth.length)); if (!p) return null;
    const off = this.trainTrackOffset(run, smooth, distance);
    return { x: p.x - Math.sin(p.heading) * off, z: p.z + Math.cos(p.heading) * off, heading: p.heading };
  }

  private trainTrackOffset(run: TrainRun, smooth: SmoothLine, distance: number): number {
    if (smooth.line.kind !== 'trunk') return 0;
    const base = RailRenderer.MAIN_OFFSET * run.direction;
    if (run.service !== 'local') return base;
    let profile = 0;
    for (let i = 1; i < smooth.stationDistances.length - 1; i++) {
      if (!this.lineStationHasPassingLoop(run.lineId, i)) continue;
      profile = Math.max(profile, this.sidingProfile(Math.abs(distance - smooth.stationDistances[i]), this.platformLength(smooth.line.stationIds[i]) / 2));
    }
    return run.direction * (RailRenderer.MAIN_OFFSET + (RailRenderer.SIDING_OFFSET - RailRenderer.MAIN_OFFSET) * profile);
  }

  private trackMode(run: TrainRun, stationIndex: number): RouteMode {
    return run.service === 'local' && this.lineStationHasPassingLoop(run.lineId, stationIndex) ? 'siding' : 'main';
  }

  private buildRailSignals(): void {
    const poles: StaticPart[] = [], heads: StaticPart[] = [];
    for (const line of this.rail.lines) {
      const smooth = this.smoothLines.get(line.id); if (!smooth) continue;
      for (let i = 0; i < line.stationIds.length; i++) for (const dir of [-1, 1] as const) {
        const next = i + dir; if (next < 0 || next >= line.stationIds.length) continue;
        const stationId = line.stationIds[i], edge = this.platformLength(stationId) / 2 + RailRenderer.SWITCH_CLEARANCE + 7;
        const d = THREE.MathUtils.clamp((smooth.stationDistances[i] ?? 0) + dir * edge, 0, smooth.length);
        const p = this.sampleSmooth(smooth, d); if (!p) continue;
        const trackOffset = line.kind === 'trunk' ? RailRenderer.MAIN_OFFSET * dir : 0;
        const sideOffset = trackOffset + (dir > 0 ? -2.4 : 2.4);
        const x = p.x - Math.sin(p.heading) * sideOffset, z = p.z + Math.cos(p.heading) * sideOffset;
        poles.push({ matrix: this.matrix(x, RailRenderer.TRACK_Y + 1.65, z, 0.18, 3.3, 0.18) });
        heads.push({ matrix: this.matrix(x, RailRenderer.TRACK_Y + 3.45, z, 0.76, 2.05, 0.52, -p.heading) });
        this.railSignals.push({ lineId: line.id, stationIndex: i, direction: dir, instanceIndex: this.railSignals.length, x, z });
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
    for (const mesh of [this.signalRed, this.signalYellow, this.signalGreen]) { mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; this.scene.add(mesh); }
  }

  private updateSignals(): void {
    if (!this.signalRed || !this.signalYellow || !this.signalGreen) return;
    for (const s of this.railSignals) {
      const aspect = this.signalAspect(s);
      this.setSignalLamp(this.signalRed, s, 0, aspect === 'red');
      this.setSignalLamp(this.signalYellow, s, 1, aspect === 'yellow');
      this.setSignalLamp(this.signalGreen, s, 2, aspect === 'green');
    }
    this.signalRed.instanceMatrix.needsUpdate = true; this.signalYellow.instanceMatrix.needsUpdate = true; this.signalGreen.instanceMatrix.needsUpdate = true;
  }

  private signalAspect(signal: RailSignal): SignalAspect {
    const to = signal.stationIndex + signal.direction;
    const blockId = this.blockIdFor(signal.lineId, signal.stationIndex, to); if (blockId < 0) return 'red';
    const block = this.physicalBlocks[blockId]; if (!block) return 'red';
    for (const id of block.conflicts) if (this.blockOccupancy.has(id)) return 'red';
    for (const id of block.conflicts) {
      const owner = this.blockReservations.get(id); if (owner == null) continue;
      const run = this.trainRuns[owner];
      if (!run || run.lineId !== signal.lineId || run.direction !== signal.direction) return 'red';
    }
    const line = this.rail.lines[signal.lineId]; if (!line) return 'red';
    const stationId = line.stationIds[to];
    const junction = this.routeReservations.get(`junction:${stationId}`);
    if (junction && junction.lineId !== signal.lineId) return 'red';
    const next = to + signal.direction;
    if (next >= 0 && next < line.stationIds.length) {
      const nextBlock = this.blockIdFor(signal.lineId, to, next);
      const nb = this.physicalBlocks[nextBlock];
      if (nb && [...nb.conflicts].some((id) => this.blockOccupancy.has(id) || this.blockReservations.has(id))) return 'yellow';
    }
    return 'green';
  }

  private setSignalLamp(mesh: THREE.InstancedMesh, signal: RailSignal, lamp: 0 | 1 | 2, on: boolean): void {
    const y = RailRenderer.TRACK_Y + 4.02 - lamp * 0.58, size = on ? 0.30 : 0.105;
    mesh.setMatrixAt(signal.instanceIndex, this.matrix(signal.x, y, signal.z, size, size, size));
  }

  private buildTurnoutIndicators(): void {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const indicators: TurnoutIndicator[] = [];
    for (const station of this.rail.stations) {
      if (station.lineIds.length > 1) {
        for (const lineId of station.lineIds) {
          const line = this.rail.lines[lineId], smooth = this.smoothLines.get(lineId); if (!line || !smooth) continue;
          const idx = line.stationIds.indexOf(station.id); if (idx < 0) continue;
          const dir: 1 | -1 = idx < line.stationIds.length - 1 ? 1 : -1;
          const d = THREE.MathUtils.clamp((smooth.stationDistances[idx] ?? 0) + dir * (this.platformLength(station.id) / 2 + 28), 0, smooth.length);
          const p = this.sampleSmooth(smooth, d); if (!p) continue;
          const m = this.matrix(p.x, RailRenderer.TRACK_Y + 1.15, p.z, 3.2, 0.34, 0.34, -p.heading);
          indicators.push({ stationId: station.id, lineId, direction: dir, mode: 'junction', instanceIndex: indicators.length, matrix: m });
        }
      }
      for (const lineId of station.lineIds) {
        const line = this.rail.lines[lineId]; if (!line || line.kind !== 'trunk') continue;
        const idx = line.stationIds.indexOf(station.id); if (!this.lineStationHasPassingLoop(lineId, idx)) continue;
        const smooth = this.smoothLines.get(lineId); if (!smooth) continue;
        for (const dir of [-1, 1] as const) {
          const d = THREE.MathUtils.clamp((smooth.stationDistances[idx] ?? 0) - dir * (this.platformLength(station.id) / 2 + RailRenderer.SWITCH_CLEARANCE + 20), 0, smooth.length);
          const p = this.sampleSmooth(smooth, d); if (!p) continue;
          for (const mode of ['main', 'siding'] as const) {
            const off = dir * (mode === 'main' ? RailRenderer.MAIN_OFFSET : RailRenderer.SIDING_OFFSET);
            const x = p.x - Math.sin(p.heading) * off, z = p.z + Math.cos(p.heading) * off;
            indicators.push({ stationId: station.id, lineId, direction: dir, mode, instanceIndex: indicators.length, matrix: this.matrix(x, RailRenderer.TRACK_Y + 0.75, z, 2.2, 0.25, 0.25, -p.heading) });
          }
        }
      }
    }
    this.turnoutIndicators.push(...indicators);
    if (!indicators.length) return;
    this.turnoutMesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }), indicators.length);
    indicators.forEach((v, i) => { this.turnoutMesh!.setMatrixAt(i, v.matrix); this.turnoutMesh!.setColorAt(i, new THREE.Color(0xd6a83a)); });
    this.turnoutMesh.instanceMatrix.needsUpdate = true; if (this.turnoutMesh.instanceColor) this.turnoutMesh.instanceColor.needsUpdate = true;
    this.turnoutMesh.frustumCulled = false; this.scene.add(this.turnoutMesh);
  }

  private updateTurnoutIndicators(): void {
    if (!this.turnoutMesh) return;
    for (const v of this.turnoutIndicators) {
      let active = false, locked = false;
      if (v.mode === 'junction') {
        const r = this.routeReservations.get(`junction:${v.stationId}`);
        locked = !!r; active = !!r && r.lineId === v.lineId;
      } else {
        const r = this.routeReservations.get(`turnout:${v.lineId}:${v.stationId}:${v.direction}`);
        locked = !!r; active = !!r && r.route.startsWith(v.mode);
      }
      const color = !locked ? 0xd6a83a : active ? 0x35ef72 : 0xe84b4b;
      this.turnoutMesh.setColorAt(v.instanceIndex, new THREE.Color(color));
    }
    if (this.turnoutMesh.instanceColor) this.turnoutMesh.instanceColor.needsUpdate = true;
  }

  private shouldStop(run: TrainRun, stationIndex: number): boolean {
    if (run.service === 'local') return true;
    const line = this.rail.lines[run.lineId], station = this.rail.stations[line.stationIds[stationIndex]]; if (!station) return true;
    if (station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter || station.kind === RailStationKind.Terminal) return true;
    return stationIndex % (run.service === 'rapid' ? 2 : 3) === 0;
  }

  private nextScheduledStopIndex(run: TrainRun, fromIndex: number): number {
    const line = this.rail.lines[run.lineId]; if (!line) return -1;
    for (let i = fromIndex; i >= 0 && i < line.stationIds.length; i += run.direction) if (this.shouldStop(run, i)) return i;
    return -1;
  }

  private dwellSeconds(run: TrainRun, stationId: number): number {
    const station = this.rail.stations[stationId];
    if (run.service === 'limited') return station?.kind === RailStationKind.Terminal ? 18 : station?.kind === RailStationKind.Central ? 14 : 8;
    if (run.service === 'rapid') return station?.kind === RailStationKind.Terminal ? 19 : station?.kind === RailStationKind.Central ? 18 : 10;
    return station?.kind === RailStationKind.Terminal ? 22 : station?.kind === RailStationKind.Central ? 24 : station?.kind === RailStationKind.SubCenter ? 20 : 14;
  }

  private stationDistanceForRun(run: TrainRun, smooth: SmoothLine, stationIndex: number): number {
    const raw = smooth.stationDistances[stationIndex] ?? 0, half = this.consistLength(run) * 0.46;
    if (stationIndex === 0) return Math.min(smooth.length, raw + half);
    if (stationIndex === smooth.stationDistances.length - 1) return Math.max(0, raw - half);
    return raw;
  }

  private consistLength(run: TrainRun): number { return run.carCount * RailRenderer.CAR_LENGTH + Math.max(0, run.carCount - 1) * RailRenderer.CAR_GAP; }
  private isAtTerminal(run: TrainRun): boolean {
    if (run.currentStationIndex < 0) return false;
    const line = this.rail.lines[run.lineId]; return !!line && this.rail.stations[line.stationIds[run.currentStationIndex]]?.kind === RailStationKind.Terminal;
  }

  private lineStationHasPassingLoop(lineId: number, stationIndex: number): boolean {
    const line = this.rail.lines[lineId]; return !!line && line.kind === 'trunk' && stationIndex > 0 && stationIndex < line.stationIds.length - 1;
  }

  private stationHasTrunk(stationId: number): boolean {
    return !!this.rail.stations[stationId]?.lineIds.some((id) => this.rail.lines[id]?.kind === 'trunk');
  }

  private platformLength(stationId: number): number {
    const kind = this.rail.stations[stationId]?.kind;
    return kind === RailStationKind.Central ? 82 : kind === RailStationKind.SubCenter ? 72 : kind === RailStationKind.Terminal ? 64 : 58;
  }

  private trainRouteColor(lineId: number): THREE.Color {
    const palette = [0x2276c9, 0x7656c8, 0x00a5b8, 0xc45da4, 0x4477cc, 0x8a5cc2, 0x2d9bb3];
    return new THREE.Color(palette[Math.abs(lineId) % palette.length]);
  }

  private buildTimetablePanel(): void {
    if (typeof document === 'undefined' || this.timetablePanel) return;
    const el = document.createElement('div');
    el.style.cssText = ['position:fixed', 'right:8px', 'bottom:8px', 'z-index:18', 'display:none', 'width:620px', 'max-height:46vh', 'overflow:auto', 'padding:9px 11px', 'background:rgba(9,13,19,.94)', 'border:1px solid #3d526c', 'border-radius:8px', 'color:#dce6f4', 'font:11px/1.45 ui-monospace,monospace', 'box-shadow:0 6px 22px rgba(0,0,0,.45)'].join(';');
    document.body.appendChild(el); this.timetablePanel = el;
  }

  private toggleTimetable(): void {
    this.timetableVisible = !this.timetableVisible;
    if (this.timetablePanel) this.timetablePanel.style.display = this.timetableVisible ? 'block' : 'none';
    this.drawTimetable(true);
  }

  private drawTimetable(force: boolean): void {
    if (!this.timetablePanel || !this.timetableVisible) return;
    if (!force && this.railTime - this.lastTimetableDraw < 0.5) return;
    this.lastTimetableDraw = this.railTime;
    const rows = this.timetableRows().sort((a, b) => a.lineName.localeCompare(b.lineName) || a.trainId - b.trainId);
    const body = rows.map((r) => {
      const dep = this.formatRailTime(r.scheduledDepartureAt), delay = r.delaySeconds > 1 ? `+${Math.round(r.delaySeconds)}s` : '定刻';
      return `<tr><td>${r.lineName}</td><td>${r.serviceLabel}</td><td>${r.directionLabel}</td><td>#${r.trainId}</td><td>${r.currentStationName}</td><td>→ ${r.nextStationName}</td><td>${r.stateLabel}</td><td>${dep}</td><td>${delay}</td><td>${Math.round(r.speedKmh)}</td></tr>`;
    }).join('');
    this.timetablePanel.innerHTML = `<div style="font-weight:700;font-size:13px;margin-bottom:5px">🚆 鉄道ダイヤ <span style="font-weight:400;opacity:.65">[T=表示/非表示] 運転時刻 ${this.formatRailTime(this.railTime)}</span></div><table style="width:100%;border-collapse:collapse;white-space:nowrap"><thead style="color:#91a9c4"><tr><th>路線</th><th>種別</th><th>方向</th><th>列車</th><th>現在</th><th>次</th><th>状態</th><th>発車予定</th><th>遅れ</th><th>km/h</th></tr></thead><tbody>${body}</tbody></table>`;
    for (const cell of this.timetablePanel.querySelectorAll('td,th')) (cell as HTMLElement).style.cssText = 'padding:2px 5px;border-bottom:1px solid rgba(120,145,175,.15);text-align:left';
  }

  private formatRailTime(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  private makeSmoothLine(line: RailLine): SmoothLine {
    const src = this.sharedStationSafePath(line), path: RailPoint[] = [];
    const push = (p: RailPoint): void => { const last = path[path.length - 1]; if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 0.08) path.push({ x: p.x, z: p.z }); };
    if (src.length) push(src[0]);
    for (let i = 1; i < src.length - 1; i++) {
      const prev = src[i - 1], p = src[i], next = src[i + 1];
      const ax = p.x - prev.x, az = p.z - prev.z, bx = next.x - p.x, bz = next.z - p.z;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz); if (la < 1 || lb < 1) { push(p); continue; }
      const uaX = ax / la, uaZ = az / la, ubX = bx / lb, ubZ = bz / lb;
      const dot = THREE.MathUtils.clamp(uaX * ubX + uaZ * ubZ, -1, 1); if (dot > 0.992) { push(p); continue; }
      const radius = Math.min(22, la * 0.28, lb * 0.28); if (radius < 2.5) { push(p); continue; }
      const entry = { x: p.x - uaX * radius, z: p.z - uaZ * radius }, exit = { x: p.x + ubX * radius, z: p.z + ubZ * radius };
      push(entry); const steps = Math.max(8, Math.ceil(radius / 2.5));
      for (let k = 1; k <= steps; k++) { const t = k / steps, u = 1 - t; push({ x: u * u * entry.x + 2 * u * t * p.x + t * t * exit.x, z: u * u * entry.z + 2 * u * t * p.z + t * t * exit.z }); }
    }
    if (src.length > 1) push(src[src.length - 1]);
    const cumulative = new Array(path.length).fill(0); let length = 0;
    for (let i = 1; i < path.length; i++) { length += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z); cumulative[i] = length; }
    const stationDistances = line.stationIds.map((sid) => { const s = this.rail.stations[sid]; return s ? this.nearestDistanceOnPath(path, cumulative, s.x, s.z) : 0; });
    return { line, path, cumulative, length, stationDistances };
  }

  private sharedStationSafePath(line: RailLine): RailPoint[] {
    if (line.kind !== 'spur' || line.path.length < 2) return line.path;
    const out = line.path.map((p) => ({ x: p.x, z: p.z }));
    for (const stationId of line.stationIds) {
      const station = this.rail.stations[stationId]; if (!station || !this.stationHasTrunk(stationId)) continue;
      const trunkId = station.lineIds.find((id) => this.rail.lines[id]?.kind === 'trunk'); if (trunkId == null) continue;
      const trunk = this.smoothLines.get(trunkId); if (!trunk) continue;
      const idx = this.rail.lines[trunkId].stationIds.indexOf(stationId), td = trunk.stationDistances[idx];
      const tp = this.sampleSmooth(trunk, td); if (!tp) continue;
      const protect = this.platformLength(stationId) * 0.5 + RailRenderer.SWITCH_CLEARANCE + RailRenderer.SWITCH_APPROACH;
      for (const p of out) {
        const dx = p.x - station.x, dz = p.z - station.z;
        const along = dx * Math.cos(tp.heading) + dz * Math.sin(tp.heading), lateral = -dx * Math.sin(tp.heading) + dz * Math.cos(tp.heading);
        if (Math.abs(along) > protect) continue;
        const u = THREE.MathUtils.clamp((protect - Math.abs(along)) / RailRenderer.SWITCH_APPROACH, 0, 1), pull = u * u * (3 - 2 * u), newLat = lateral * (1 - pull);
        p.x = station.x + Math.cos(tp.heading) * along - Math.sin(tp.heading) * newLat;
        p.z = station.z + Math.sin(tp.heading) * along + Math.cos(tp.heading) * newLat;
      }
    }
    return out;
  }

  private nearestDistanceOnPath(path: RailPoint[], cumulative: number[], x: number, z: number): number {
    let best = Infinity, along = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz; if (len2 < 0.01) continue;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1), qx = a.x + dx * t, qz = a.z + dz * t, d2 = (x - qx) ** 2 + (z - qz) ** 2;
      if (d2 < best) { best = d2; along = cumulative[i - 1] + Math.sqrt(len2) * t; }
    }
    return along;
  }

  private sampleSmooth(smooth: SmoothLine, distance: number): { x: number; z: number; heading: number } | null {
    if (smooth.path.length < 2 || smooth.length <= 0) return null;
    const d = THREE.MathUtils.clamp(distance, 0, smooth.length), p = this.sampleSmoothPosition(smooth, d); if (!p) return null;
    const a = this.sampleSmoothPosition(smooth, Math.max(0, d - 2.2)), b = this.sampleSmoothPosition(smooth, Math.min(smooth.length, d + 2.2));
    const heading = a && b && Math.hypot(b.x - a.x, b.z - a.z) > 0.01 ? Math.atan2(b.z - a.z, b.x - a.x) : 0;
    return { x: p.x, z: p.z, heading };
  }

  private sampleSmoothPosition(smooth: SmoothLine, distance: number): RailPoint | null {
    const d = THREE.MathUtils.clamp(distance, 0, smooth.length); let hi = 1;
    while (hi < smooth.cumulative.length && smooth.cumulative[hi] < d) hi++;
    hi = Math.min(hi, smooth.path.length - 1); const lo = Math.max(0, hi - 1), a = smooth.path[lo], b = smooth.path[hi], start = smooth.cumulative[lo], end = smooth.cumulative[hi];
    const t = end > start ? (d - start) / (end - start) : 0;
    return { x: THREE.MathUtils.lerp(a.x, b.x, t), z: THREE.MathUtils.lerp(a.z, b.z, t) };
  }

  private offsetPoint(smooth: SmoothLine, distance: number, offset: number): { x: number; z: number; heading: number } | null {
    const p = this.sampleSmooth(smooth, distance); if (!p) return null;
    return { x: p.x - Math.sin(p.heading) * offset, z: p.z + Math.cos(p.heading) * offset, heading: p.heading };
  }

  private pushTrackSegment(a: RailPoint, b: RailPoint, ballast: StaticPart[], rails: StaticPart[], width: number): void {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz); if (len < 0.35) return;
    const px = -dz / len, pz = dx / len, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, angle = -Math.atan2(dz, dx);
    ballast.push({ matrix: this.matrix(mx, RailRenderer.TRACK_Y, mz, len + 0.22, 0.32, width, angle) });
    for (const side of [-1, 1]) rails.push({ matrix: this.matrix(mx + px * 0.82 * side, RailRenderer.TRACK_Y + 0.28, mz + pz * 0.82 * side, len + 0.16, 0.15, 0.13, angle) });
  }

  private pushRibbonSegment(a: { x: number; z: number }, b: { x: number; z: number }, y: number, height: number, width: number, parts: StaticPart[]): void {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz); if (len < 0.2) return;
    parts.push({ matrix: this.matrix((a.x + b.x) / 2, y, (a.z + b.z) / 2, len + 0.18, height, width, -Math.atan2(dz, dx)) });
  }

  private pose(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, heading: number, sx: number, sy: number, sz: number): void {
    this.d.position.set(x, y, z); this.d.rotation.set(0, -heading, 0); this.d.scale.set(sx, sy, sz); this.d.updateMatrix(); mesh.setMatrixAt(index, this.d.matrix);
  }

  private matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0): THREE.Matrix4 {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)), new THREE.Vector3(sx, sy, sz));
  }

  private addStatic(geometry: THREE.BufferGeometry, material: THREE.Material, parts: StaticPart[]): THREE.InstancedMesh | null {
    if (!parts.length) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, parts.length); parts.forEach((p, i) => mesh.setMatrixAt(i, p.matrix)); mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh); return mesh;
  }

  private wrapAngle(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }
}
