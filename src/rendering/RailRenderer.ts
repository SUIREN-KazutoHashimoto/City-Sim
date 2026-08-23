import * as THREE from 'three';
import { RailLine, RailNetworkPlan, RailPoint, RailStationKind } from '../generation/RailPlanning';

interface StaticPart { matrix: THREE.Matrix4; }
interface SmoothLine {
  line: RailLine;
  path: RailPoint[];
  cumulative: number[];
  length: number;
  stationDistances: number[];
}

type TrainState = 'dwell' | 'running' | 'signal';
export type TrainService = 'local' | 'rapid';

interface TrainRun {
  id: number;
  lineId: number;
  service: TrainService;
  carCount: number;
  cruiseSpeed: number;
  direction: 1 | -1;
  speed: number;
  /** 運行上の編成中心距離。 */
  distance: number;
  /** 描画専用距離。SIM batchの大ジャンプを実時間で平滑化する。 */
  visualDistance: number;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  dwellRemaining: number;
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
 * City Generator v2 Phase 4.6 railway renderer + lightweight operations.
 *
 * - short articulated cars: every car uses front/rear bogie points on the actual track;
 * - render-distance smoothing hides asynchronous SIM batch jumps;
 * - local trains use passing loops, rapid trains keep the through track and overtake at stations;
 * - railway block signals are rendered and updated from occupancy;
 * - station platforms follow curves and stairs connect elevated platforms to ground.
 */
export class RailRenderer {
  static readonly TRACK_Y = 8.2;
  private static readonly TRAIN_WIDTH = 2.86;
  private static readonly CAR_LENGTH = 10.2;
  private static readonly CAR_GAP = 0.72;
  private static readonly BOGIE_HALF = 3.55;
  private static readonly ACCEL = 0.82;
  private static readonly BRAKE = 1.24;
  /** Main-to-loop track-centre spacing. Wide enough for an island platform between them. */
  private static readonly SIDING_OFFSET = 8.0;
  private static readonly PLATFORM_CLEARANCE = 0.45;
  private static readonly SWITCH_APPROACH = 36;

  private readonly smoothLines = new Map<number, SmoothLine>();
  private readonly trainRuns: TrainRun[] = [];
  private readonly trainInstanceToRun: number[] = [];
  private readonly railSignals: RailSignal[] = [];
  private readonly d = new THREE.Object3D();
  private trainBody: THREE.InstancedMesh | null = null;
  private trainCabin: THREE.InstancedMesh | null = null;
  private signalLamp: THREE.InstancedMesh | null = null;
  private lastSimSeconds = Number.NaN;

  constructor(private readonly scene: THREE.Scene, private readonly rail: RailNetworkPlan) {}

  build(): void {
    if (this.rail.lines.length === 0) return;
    for (const line of this.rail.lines) this.smoothLines.set(line.id, this.makeSmoothLine(line));

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
    this.updateTrainMeshes();
    this.updateSignals();
  }

  /**
   * simSeconds may jump by tens/hundreds of seconds because World runs async batches.
   * Operations catch up in simulation time, while visualDistance follows the new state in real time.
   */
  update(simSeconds: number, realDt = 1 / 60): void {
    if (!this.trainBody || !this.trainCabin || this.trainRuns.length === 0) return;
    if (!Number.isFinite(this.lastSimSeconds)) {
      this.lastSimSeconds = simSeconds;
      this.updateTrainMeshes(); this.updateSignals();
      return;
    }

    let remaining = simSeconds - this.lastSimSeconds;
    this.lastSimSeconds = simSeconds;
    if (remaining < 0) remaining = 0;
    remaining = Math.min(remaining, 300);
    while (remaining > 1e-4) {
      const dt = Math.min(0.35, remaining);
      this.stepOperations(dt);
      remaining -= dt;
    }

    const renderDt = THREE.MathUtils.clamp(realDt, 1 / 240, 0.1);
    const alpha = 1 - Math.exp(-renderDt * 9.5);
    const maxVisualStep = 220 * renderDt;
    for (const run of this.trainRuns) {
      const gap = run.distance - run.visualDistance;
      const step = THREE.MathUtils.clamp(gap * alpha, -maxVisualStep, maxVisualStep);
      run.visualDistance += step;
      if (Math.abs(gap) < 0.015) run.visualDistance = run.distance;
    }

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
    const line = this.rail.lines[run.lineId]; if (!line) return null;
    const currentStationId = run.currentStationIndex >= 0 ? line.stationIds[run.currentStationIndex] ?? -1 : -1;
    const nextStationId = run.nextStationIndex >= 0 ? line.stationIds[run.nextStationIndex] ?? -1 : -1;
    const currentStation = currentStationId >= 0 ? this.rail.stations[currentStationId] : null;
    const nextStation = nextStationId >= 0 ? this.rail.stations[nextStationId] : null;
    const stateLabel = run.state === 'dwell' ? '停車中' : run.state === 'signal' ? '信号待ち' : '走行中';
    const loopIndex = run.currentStationIndex >= 0 ? run.currentStationIndex : run.nextStationIndex;
    const consistLength = this.consistLength(run);
    return {
      id: run.id, lineId: run.lineId, lineName: line.name,
      service: run.service, serviceLabel: run.service === 'rapid' ? '快速' : '各停', carCount: run.carCount, consistLength,
      state: run.state, stateLabel, x: run.x, z: run.z, heading: run.heading,
      speed: run.speed, cruiseSpeed: run.cruiseSpeed, direction: run.direction,
      currentStationId, currentStationName: currentStation?.name ?? '—',
      nextStationId, nextStationName: nextStation?.name ?? '—',
      dwellRemaining: Math.max(0, run.dwellRemaining), waitingForBlock: run.state === 'signal',
      passingLoop: loopIndex >= 0 && this.lineStationHasPassingLoop(run.lineId, loopIndex),
      firstPersonForwardOffset: RailRenderer.CAR_LENGTH * 0.34,
    };
  }

  private stepOperations(dt: number): void {
    for (const run of this.trainRuns) this.stepTrain(run, dt);
  }

  private stepTrain(run: TrainRun, dt: number): void {
    const smooth = this.smoothLines.get(run.lineId); if (!smooth || smooth.stationDistances.length < 2) return;
    const lastStation = smooth.line.stationIds.length - 1;

    if (run.currentStationIndex >= 0) {
      run.speed = 0;
      if (run.dwellRemaining > 0) {
        run.dwellRemaining = Math.max(0, run.dwellRemaining - dt); run.state = 'dwell'; return;
      }
      if ((run.direction > 0 && run.currentStationIndex >= lastStation) || (run.direction < 0 && run.currentStationIndex <= 0)) {
        run.direction = run.direction > 0 ? -1 : 1;
      }
      const next = run.currentStationIndex + run.direction;
      if (next < 0 || next > lastStation) return;
      if (!this.canEnterBlock(run, run.currentStationIndex, next)) { run.state = 'signal'; return; }
      run.originStationIndex = run.currentStationIndex;
      run.nextStationIndex = next;
      run.currentStationIndex = -1;
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
      run.speed = 0; run.currentStationIndex = boundaryIndex; run.originStationIndex = -1; run.nextStationIndex = -1;
      run.state = 'dwell'; run.dwellRemaining = this.dwellSeconds(run, stationId); return;
    }

    if (following < 0 || following > lastStation) {
      run.speed = 0; run.currentStationIndex = boundaryIndex; run.originStationIndex = -1; run.nextStationIndex = -1;
      run.state = 'dwell'; run.dwellRemaining = this.dwellSeconds(run, stationId); return;
    }

    if (!this.canEnterBlock(run, boundaryIndex, following)) {
      run.speed = 0; run.currentStationIndex = boundaryIndex; run.originStationIndex = -1; run.nextStationIndex = -1;
      run.state = 'signal'; run.dwellRemaining = 0; return;
    }

    // Rapid passes a non-stop station without resetting speed.
    run.originStationIndex = boundaryIndex;
    run.nextStationIndex = following;
  }

  /** One inter-station section is one block. Passing-loop stations can host local+rapid or opposing trains simultaneously. */
  private canEnterBlock(run: TrainRun, fromIndex: number, toIndex: number): boolean {
    const segment = Math.min(fromIndex, toIndex);
    const targetHasLoop = this.lineStationHasPassingLoop(run.lineId, toIndex);
    for (const other of this.trainRuns) {
      if (other.id === run.id || other.lineId !== run.lineId) continue;
      if (other.state === 'running' && other.originStationIndex >= 0 && other.nextStationIndex >= 0
        && Math.min(other.originStationIndex, other.nextStationIndex) === segment) return false;
      if (other.currentStationIndex !== toIndex) continue;
      if (!targetHasLoop) return false;
      if (other.direction !== run.direction) continue;
      // Local uses the loop track, rapid uses the through track: same-direction overtaking is allowed at a loop station.
      if (other.service === run.service) return false;
    }
    return true;
  }

  private segmentOccupied(lineId: number, fromIndex: number, toIndex: number): boolean {
    const segment = Math.min(fromIndex, toIndex);
    return this.trainRuns.some((r) => r.lineId === lineId && r.state === 'running'
      && r.originStationIndex >= 0 && r.nextStationIndex >= 0
      && Math.min(r.originStationIndex, r.nextStationIndex) === segment);
  }

  private shouldStop(run: TrainRun, stationIndex: number): boolean {
    if (run.service === 'local') return true;
    const line = this.rail.lines[run.lineId], station = this.rail.stations[line.stationIds[stationIndex]];
    if (!station) return true;
    if (station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter || station.kind === RailStationKind.Terminal) return true;
    return stationIndex % 4 === 0;
  }

  private nextScheduledStopIndex(run: TrainRun, fromIndex: number): number {
    const line = this.rail.lines[run.lineId]; if (!line) return -1;
    for (let i = fromIndex; i >= 0 && i < line.stationIds.length; i += run.direction) if (this.shouldStop(run, i)) return i;
    return -1;
  }

  private dwellSeconds(run: TrainRun, stationId: number): number {
    const station = this.rail.stations[stationId]; if (!station) return run.service === 'rapid' ? 10 : 14;
    if (run.service === 'rapid') {
      if (station.kind === RailStationKind.Central) return 18;
      if (station.kind === RailStationKind.SubCenter) return 14;
      if (station.kind === RailStationKind.Terminal) return 18;
      return 9;
    }
    if (station.kind === RailStationKind.Central) return 24;
    if (station.kind === RailStationKind.SubCenter) return 20;
    if (station.kind === RailStationKind.Terminal) return 22;
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
    if (!this.trainBody || !this.trainCabin) return;
    let instance = 0;
    for (const run of this.trainRuns) {
      const smooth = this.smoothLines.get(run.lineId); if (!smooth) continue;
      for (let car = 0; car < run.carCount; car++) {
        const pose = this.carPose(run, smooth, car); if (!pose) continue;
        this.pose(this.trainBody, instance, pose.x, RailRenderer.TRACK_Y + 1.80, pose.z, pose.heading, RailRenderer.CAR_LENGTH, 3.05, RailRenderer.TRAIN_WIDTH);
        this.pose(this.trainCabin, instance, pose.x, RailRenderer.TRACK_Y + 3.14, pose.z, pose.heading, RailRenderer.CAR_LENGTH * 0.78, 0.62, 2.40);
        if (car === 0) { run.x = pose.x; run.z = pose.z; run.heading = pose.heading; }
        instance++;
      }
    }
    this.trainBody.count = instance; this.trainCabin.count = instance;
    this.trainBody.instanceMatrix.needsUpdate = true; this.trainCabin.instanceMatrix.needsUpdate = true;
  }

  /** Every car orientation is defined by two bogie points, not by the tangent at its centre. */
  private carPose(run: TrainRun, smooth: SmoothLine, carIndex: number): { x: number; z: number; heading: number } | null {
    const spacing = RailRenderer.CAR_LENGTH + RailRenderer.CAR_GAP;
    const along = ((run.carCount - 1) * 0.5 - carIndex) * spacing * run.direction;
    const center = run.visualDistance + along;
    const front = this.sampleTrainTrack(run, smooth, center + RailRenderer.BOGIE_HALF * run.direction);
    const rear = this.sampleTrainTrack(run, smooth, center - RailRenderer.BOGIE_HALF * run.direction);
    if (!front || !rear) return null;
    const dx = front.x - rear.x, dz = front.z - rear.z;
    const heading = Math.hypot(dx, dz) > 0.01 ? Math.atan2(dz, dx) : (run.direction > 0 ? front.heading : this.wrapAngle(front.heading + Math.PI));
    return { x: (front.x + rear.x) * 0.5, z: (front.z + rear.z) * 0.5, heading };
  }

  private sampleTrainTrack(run: TrainRun, smooth: SmoothLine, distance: number): { x: number; z: number; heading: number } | null {
    const p = this.sampleSmooth(smooth, THREE.MathUtils.clamp(distance, 0, smooth.length)); if (!p) return null;
    const off = this.trainTrackOffsetAt(run, smooth, distance);
    return { x: p.x - Math.sin(p.heading) * off, z: p.z + Math.cos(p.heading) * off, heading: p.heading };
  }

  private trainTrackOffsetAt(run: TrainRun, smooth: SmoothLine, distance: number): number {
    if (smooth.line.kind !== 'trunk' || run.service === 'rapid') return 0;
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
        const centerDistance = smooth.stationDistances[stationIndex] ?? 0;
        const length = this.platformLength(stationId);
        const passing = this.lineStationHasPassingLoop(line.id, stationIndex);
        const width = station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter ? 4.2 : 3.8;

        if (passing) {
          this.buildPassingLoop(smooth, centerDistance, length, loopBallast, loopRails);
          // Island platforms between through and loop tracks. Both rapid and local can use the same platform face.
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
    const loopHalf = halfPlatform + RailRenderer.SWITCH_APPROACH + 4;
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
    const fullUntil = platformHalf + 5;
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

    this.buildPlatformStair(smooth, start + 3, lateralOffset, -1, stairs);
    this.buildPlatformStair(smooth, end - 3, lateralOffset, 1, stairs);
  }

  /** Elevated station stairs descend longitudinally from both platform ends, never across a running track. */
  private buildPlatformStair(smooth: SmoothLine, anchorDistance: number, lateralOffset: number, direction: -1 | 1, stairs: StaticPart[]): void {
    const anchor = this.offsetPoint(smooth, anchorDistance, lateralOffset); if (!anchor) return;
    const steps = 12, run = 13.2;
    for (let i = 0; i < steps; i++) {
      const t = i / Math.max(1, steps - 1);
      const along = direction * t * run;
      const x = anchor.x + Math.cos(anchor.heading) * along;
      const z = anchor.z + Math.sin(anchor.heading) * along;
      const top = RailRenderer.TRACK_Y + 0.35 - t * (RailRenderer.TRACK_Y - 0.45);
      stairs.push({ matrix: this.matrix(x, Math.max(0.35, top * 0.5), z, 1.25, Math.max(0.45, top), 2.6, -anchor.heading) });
    }
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
      const locals = line.kind === 'trunk' ? (smooth.length > 4500 ? 2 : 1) : 1;
      const rapids = line.kind === 'trunk' && line.stationIds.length >= 6 ? 1 : 0;
      const total = locals + rapids;
      for (let i = 0; i < total; i++) {
        const service: TrainService = i >= locals ? 'rapid' : 'local';
        const maxStation = line.stationIds.length - 1;
        const stationIndex = Math.min(maxStation, Math.round((i * maxStation) / Math.max(1, total - 1)));
        let direction: 1 | -1 = (i & 1) === 0 ? 1 : -1;
        if (stationIndex <= 0) direction = 1; else if (stationIndex >= maxStation) direction = -1;
        const carCount = service === 'rapid' ? 5 : line.kind === 'trunk' ? 4 : 3;
        const id = this.trainRuns.length;
        const run: TrainRun = {
          id, lineId: line.id, service, carCount,
          cruiseSpeed: service === 'rapid' ? 27.0 : line.kind === 'trunk' ? 21.5 : 17.0,
          direction, speed: 0, distance: 0, visualDistance: 0,
          currentStationIndex: stationIndex, originStationIndex: -1, nextStationIndex: -1,
          dwellRemaining: 5 + i * 3, state: 'dwell', x: 0, z: 0, heading: 0,
        };
        run.distance = this.stationDistanceForRun(run, smooth, stationIndex); run.visualDistance = run.distance;
        this.trainRuns.push(run);
      }
    }
    if (this.trainRuns.length === 0) return;

    let cap = 0; for (const run of this.trainRuns) cap += run.carCount;
    this.trainBody = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.48, metalness: 0.12, vertexColors: true }),
      cap,
    );
    this.trainCabin = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x304d66, roughness: 0.25, metalness: 0.18 }),
      cap,
    );

    let idx = 0;
    for (const run of this.trainRuns) for (let c = 0; c < run.carCount; c++) {
      this.trainInstanceToRun[idx] = run.id;
      this.trainBody.setColorAt(idx, new THREE.Color(run.service === 'rapid' ? 0xcfdff2 : 0xe5e8eb));
      idx++;
    }
    if (this.trainBody.instanceColor) this.trainBody.instanceColor.needsUpdate = true;

    const hitSphere = new THREE.Sphere(new THREE.Vector3(this.rail.sizeMeters / 2, RailRenderer.TRACK_Y, this.rail.sizeMeters / 2), Math.max(20_000, this.rail.sizeMeters * 2));
    for (const mesh of [this.trainBody, this.trainCabin]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.boundingSphere = hitSphere.clone(); this.scene.add(mesh);
    }
  }

  private buildRailSignals(): void {
    const poles: StaticPart[] = [], lampMatrices: THREE.Matrix4[] = [];
    for (const line of this.rail.lines) {
      const smooth = this.smoothLines.get(line.id); if (!smooth) continue;
      for (let i = 0; i < line.stationIds.length; i++) {
        for (const dir of [-1, 1] as const) {
          const next = i + dir; if (next < 0 || next >= line.stationIds.length) continue;
          const stationId = line.stationIds[i], edge = this.platformLength(stationId) / 2 + 8;
          const d = THREE.MathUtils.clamp((smooth.stationDistances[i] ?? 0) + dir * edge, 0, smooth.length);
          const p = this.sampleSmooth(smooth, d); if (!p) continue;
          const lateral = dir > 0 ? -2.65 : 2.65;
          const x = p.x - Math.sin(p.heading) * lateral, z = p.z + Math.cos(p.heading) * lateral;
          poles.push({ matrix: this.matrix(x, RailRenderer.TRACK_Y + 1.45, z, 0.16, 2.9, 0.16) });
          lampMatrices.push(this.matrix(x, RailRenderer.TRACK_Y + 3.02, z, 0.55, 0.55, 0.55));
          this.railSignals.push({ lineId: line.id, stationIndex: i, direction: dir, instanceIndex: lampMatrices.length - 1 });
        }
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4c5156, roughness: 0.7 }), poles);
    if (lampMatrices.length === 0) return;
    this.signalLamp = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, emissive: 0x111111, vertexColors: true }),
      lampMatrices.length,
    );
    lampMatrices.forEach((m, i) => this.signalLamp!.setMatrixAt(i, m));
    this.signalLamp.instanceMatrix.needsUpdate = true; this.signalLamp.frustumCulled = false; this.scene.add(this.signalLamp);
  }

  private updateSignals(): void {
    if (!this.signalLamp) return;
    for (const s of this.railSignals) {
      const line = this.rail.lines[s.lineId]; if (!line) continue;
      const next = s.stationIndex + s.direction;
      const occupied = this.segmentOccupied(s.lineId, s.stationIndex, next);
      let targetOccupied = false;
      for (const run of this.trainRuns) if (run.lineId === s.lineId && run.currentStationIndex === next) { targetOccupied = true; break; }
      const color = occupied ? 0xff2d2d : targetOccupied ? 0xffc83d : 0x39e36c;
      this.signalLamp.setColorAt(s.instanceIndex, new THREE.Color(color));
    }
    if (this.signalLamp.instanceColor) this.signalLamp.instanceColor.needsUpdate = true;
  }

  /** Convert road-grid polylines into quadratic corner fillets. */
  private makeSmoothLine(line: RailLine): SmoothLine {
    const src = line.path, path: RailPoint[] = [];
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
