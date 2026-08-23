import * as THREE from 'three';
import { RailLine, RailNetworkPlan, RailPoint, RailStationKind } from '../generation/RailPlanning';
import { RoadNetwork, roadWidth } from '../traffic/RoadNetwork';

interface StaticPart { matrix: THREE.Matrix4; }
interface SmoothLine {
  line: RailLine;
  path: RailPoint[];
  cumulative: number[];
  length: number;
  stationDistances: number[];
}

type TrainState = 'dwell' | 'running' | 'signal';
export type TrainService = 'local' | 'rapid' | 'limited';

interface TrainRun {
  id: number;
  lineId: number;
  service: TrainService;
  carCount: number;
  cruiseSpeed: number;
  direction: 1 | -1;
  speed: number;
  /** 線路上の編成中心距離。描画も運行もこの1値を共有する。 */
  distance: number;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  dwellRemaining: number;
  state: TrainState;
  /** 追跡は先頭車ではなく編成中心を使い、折返し時のカメラ/車両テレポートを防ぐ。 */
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
 * City Generator v2 Phase 4 railway renderer + lightweight operations.
 *
 * - short articulated cars: every car uses front/rear bogie points on the actual track;
 * - railway operations advance every render frame instead of following asynchronous World batches;
 * - local/rapid/limited services share one block system; locals use passing loops;
 * - turnouts and shared-line junctions are kept outside the platform zone;
 * - railway block signals are rendered and updated from occupancy;
 * - station platforms follow curves and station access lands outside the roadway.
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
  /** ポイントはホーム端からこの距離以上離す。 */
  private static readonly SWITCH_CLEARANCE = 14;
  private static readonly SWITCH_APPROACH = 48;

  private readonly smoothLines = new Map<number, SmoothLine>();
  private readonly trainRuns: TrainRun[] = [];
  private readonly trainInstanceToRun: number[] = [];
  private readonly railSignals: RailSignal[] = [];
  private readonly d = new THREE.Object3D();
  private trainBody: THREE.InstancedMesh | null = null;
  private trainCabin: THREE.InstancedMesh | null = null;
  private trainStripe: THREE.InstancedMesh | null = null;
  private signalLamp: THREE.InstancedMesh | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rail: RailNetworkPlan,
    private readonly roads?: RoadNetwork,
  ) {}

  build(): void {
    if (this.rail.lines.length === 0) return;
    // 幹線を先に作る。支線の共有駅アプローチは幹線線形を参照してホーム外で分岐させる。
    for (const line of this.rail.lines.filter((l) => l.kind === 'trunk')) this.smoothLines.set(line.id, this.makeSmoothLine(line));
    for (const line of this.rail.lines.filter((l) => l.kind !== 'trunk')) this.smoothLines.set(line.id, this.makeSmoothLine(line));

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
   * 鉄道は軽量なので非同期World batchを待たず、描画フレームごとに直接運行を進める。
   */
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
    const stateLabel = run.state === 'dwell' ? '停車中' : run.state === 'signal' ? '信号待ち' : '走行中';
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
      // 編成中心を追跡基準にして、カメラだけ進行方向先頭の運転台前面へ置く。
      firstPersonForwardOffset: consistLength * 0.5 + 0.45,
    };
  }

  private serviceLabel(service: TrainService): string {
    if (service === 'limited') return '特急';
    if (service === 'rapid') return '快速';
    return '普通';
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
        // 車両の物理並びは変えず、停車完了後に向きだけ反転する。
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

    // 快速/特急は通過駅で速度を落とさず次閉塞へ進む。
    run.originStationIndex = boundaryIndex;
    run.nextStationIndex = following;
  }

  /** One inter-station section is one block. Local uses loop; rapid/limited use the through track. */
  private canEnterBlock(run: TrainRun, fromIndex: number, toIndex: number): boolean {
    const segment = Math.min(fromIndex, toIndex);
    const targetHasLoop = this.lineStationHasPassingLoop(run.lineId, toIndex);
    for (const other of this.trainRuns) {
      if (other.id === run.id || other.lineId !== run.lineId) continue;
      if (other.state === 'running' && other.originStationIndex >= 0 && other.nextStationIndex >= 0
        && Math.min(other.originStationIndex, other.nextStationIndex) === segment) return false;
      if (other.currentStationIndex !== toIndex) continue;
      if (!targetHasLoop) return false;

      const runLoop = run.service === 'local';
      const otherLoop = other.service === 'local';
      // 待避線と本線は同時使用可能。
      if (runLoop !== otherLoop) continue;
      // 普通同士でも上下方向が違えば左右別待避線なので交換可能。
      if (runLoop && otherLoop && other.direction !== run.direction) continue;
      // 快速/特急は同じ本線を使うため同駅同時進入不可。
      return false;
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
    // 中央・副都心・終端は種別に関係なく停車。
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

  /**
   * 車両の線路上の並び順はdirectionで反転させない。
   * 終端折返しでは同じ場所にいる各車両が180度向きを変えるだけなので、車両インスタンスが反対端へテレポートしない。
   */
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
    // 普通のみ待避線へ。快速/特急は常に本線。
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
        // 幹線と共有する支線駅は幹線ホームを共用し、ホームを二重生成しない。
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
    const loopHalf = halfPlatform + RailRenderer.SWITCH_CLEARANCE + RailRenderer.SWITCH_APPROACH;
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

  private buildPlatformAccess(
    smooth: SmoothLine,
    anchorDistance: number,
    lateralOffset: number,
    direction: -1 | 1,
    stairs: StaticPart[],
  ): void {
    const anchor = this.offsetPoint(smooth, anchorDistance, lateralOffset); if (!anchor) return;
    const side = lateralOffset >= 0 ? 1 : -1;
    const roadHalf = this.roadHalfWidthAt(anchor.x, anchor.z, anchor.heading);
    const outerAbs = Math.max(Math.abs(lateralOffset) + 3.4, roadHalf + 3.2);
    const outer = this.offsetPoint(smooth, anchorDistance, side * outerAbs); if (!outer) return;

    const concourseY = 5.3;
    const platformY = RailRenderer.TRACK_Y + 0.40;
    const shaftHeight = Math.max(1.0, platformY - concourseY);
    stairs.push({ matrix: this.matrix(
      anchor.x,
      concourseY + shaftHeight * 0.5,
      anchor.z,
      2.4,
      shaftHeight,
      2.4,
      -anchor.heading,
    ) });
    this.pushRibbonSegment(anchor, outer, concourseY, 0.28, 2.6, stairs);

    const steps = 12, run = 15.5;
    for (let i = 0; i < steps; i++) {
      const t = i / Math.max(1, steps - 1);
      const along = direction * t * run;
      const x = outer.x + Math.cos(outer.heading) * along;
      const z = outer.z + Math.sin(outer.heading) * along;
      const top = concourseY - t * (concourseY - 0.45);
      stairs.push({ matrix: this.matrix(
        x,
        Math.max(0.30, top * 0.5),
        z,
        1.25,
        Math.max(0.45, top),
        2.6,
        -outer.heading,
      ) });
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

  private stationHasTrunk(stationId: number): boolean {
    const station = this.rail.stations[stationId];
    return !!station && station.lineIds.some((id) => this.rail.lines[id]?.kind === 'trunk');
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
      const services: TrainService[] = [];
      const locals = line.kind === 'trunk' ? (smooth.length > 4500 ? 2 : 1) : 1;
      for (let i = 0; i < locals; i++) services.push('local');
      if (line.kind === 'trunk' && line.stationIds.length >= 5) services.push('rapid');
      if (line.kind === 'trunk' && line.stationIds.length >= 7) services.push('limited');

      for (let i = 0; i < services.length; i++) {
        const service = services[i];
        const maxStation = line.stationIds.length - 1;
        const stationIndex = Math.min(maxStation, Math.round((i * maxStation) / Math.max(1, services.length - 1)));
        let direction: 1 | -1 = (i & 1) === 0 ? 1 : -1;
        if (stationIndex <= 0) direction = 1; else if (stationIndex >= maxStation) direction = -1;
        const carCount = service === 'local' ? (line.kind === 'trunk' ? 4 : 3) : 5;
        const cruiseSpeed = service === 'limited' ? 31.0 : service === 'rapid' ? 27.0 : line.kind === 'trunk' ? 21.5 : 17.0;
        const id = this.trainRuns.length;
        const run: TrainRun = {
          id, lineId: line.id, service, carCount, cruiseSpeed,
          direction, speed: 0, distance: 0,
          currentStationIndex: stationIndex, originStationIndex: -1, nextStationIndex: -1,
          dwellRemaining: 5 + i * 3, state: 'dwell', x: 0, z: 0, heading: 0,
        };
        run.distance = this.stationDistanceForRun(run, smooth, stationIndex);
        this.trainRuns.push(run);
      }
    }
    if (this.trainRuns.length === 0) return;

    let cap = 0; for (const run of this.trainRuns) cap += run.carCount;
    this.trainBody = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.18, vertexColors: true }),
      cap,
    );
    this.trainStripe = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.10, vertexColors: true }),
      cap,
    );
    this.trainCabin = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.22, vertexColors: true }),
      cap,
    );

    let idx = 0;
    for (const run of this.trainRuns) for (let c = 0; c < run.carCount; c++) {
      this.trainInstanceToRun[idx] = run.id;
      const route = this.trainRouteColor(run.lineId);
      const body = new THREE.Color(run.service === 'limited' ? 0xf7f8fa : run.service === 'rapid' ? 0xf2f5f7 : 0xdfe5e8);
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
    const palette = [0x2276c9, 0x7658c9, 0x169bb0, 0xc15d9c, 0x4777c9, 0x8c65cf, 0x2e9caf];
    return new THREE.Color(palette[Math.abs(lineId) % palette.length]);
  }

  private buildRailSignals(): void {
    const poles: StaticPart[] = [], lampMatrices: THREE.Matrix4[] = [];
    for (const line of this.rail.lines) {
      const smooth = this.smoothLines.get(line.id); if (!smooth) continue;
      for (let i = 0; i < line.stationIds.length; i++) {
        for (const dir of [-1, 1] as const) {
          const next = i + dir; if (next < 0 || next >= line.stationIds.length) continue;
          const stationId = line.stationIds[i], edge = this.platformLength(stationId) / 2 + RailRenderer.SWITCH_CLEARANCE + 6;
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

  /** Convert road-grid polylines into quadratic corner fillets. Shared spur junctions are moved outside platforms first. */
  private makeSmoothLine(line: RailLine): SmoothLine {
    const src = this.sourcePathForLine(line), path: RailPoint[] = [];
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

  /**
   * 支線が幹線駅を共有する場合、駅中心～ホーム外までは幹線の接線に沿わせる。
   * 分岐点をホーム外へ移すことで駅中央のポイント集中を避ける。
   */
  private sourcePathForLine(line: RailLine): RailPoint[] {
    let src = line.path.map((p) => ({ x: p.x, z: p.z }));
    if (line.kind !== 'spur' || src.length < 2) return src;
    src = this.clearSharedEndpoint(src, line, true);
    src = this.clearSharedEndpoint(src, line, false);
    return src;
  }

  private clearSharedEndpoint(src: RailPoint[], line: RailLine, atStart: boolean): RailPoint[] {
    if (src.length < 2) return src;
    const stationIndex = atStart ? 0 : line.stationIds.length - 1;
    const stationId = line.stationIds[stationIndex];
    if (!this.stationHasTrunk(stationId)) return src;
    const station = this.rail.stations[stationId]; if (!station) return src;

    const neighbor = atStart ? src[1] : src[src.length - 2];
    const bx = neighbor.x - station.x, bz = neighbor.z - station.z;
    const bl = Math.hypot(bx, bz) || 1;
    const tangent = this.sharedTrunkDirection(stationId, bx / bl, bz / bl); if (!tangent) return src;
    const clear = this.platformLength(stationId) * 0.5 + RailRenderer.SWITCH_CLEARANCE + RailRenderer.SWITCH_APPROACH * 0.55;
    const junction = { x: station.x + tangent.x * clear, z: station.z + tangent.z * clear };
    const stationPoint = { x: station.x, z: station.z };

    if (atStart) {
      let first = 1;
      while (first < src.length - 1 && Math.hypot(src[first].x - station.x, src[first].z - station.z) < clear * 0.72) first++;
      return [stationPoint, junction, ...src.slice(first)];
    }
    let last = src.length - 2;
    while (last > 0 && Math.hypot(src[last].x - station.x, src[last].z - station.z) < clear * 0.72) last--;
    return [...src.slice(0, last + 1), junction, stationPoint];
  }

  private sharedTrunkDirection(stationId: number, preferredX: number, preferredZ: number): { x: number; z: number } | null {
    const station = this.rail.stations[stationId]; if (!station) return null;
    let best: { x: number; z: number } | null = null, bestScore = -Infinity;
    for (const lineId of station.lineIds) {
      const trunk = this.rail.lines[lineId]; if (!trunk || trunk.kind !== 'trunk') continue;
      for (let i = 1; i < trunk.path.length; i++) {
        const a = trunk.path[i - 1], b = trunk.path[i];
        const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz; if (len2 < 0.01) continue;
        const t = THREE.MathUtils.clamp(((station.x - a.x) * dx + (station.z - a.z) * dz) / len2, 0, 1);
        const qx = a.x + dx * t, qz = a.z + dz * t;
        const distancePenalty = Math.hypot(qx - station.x, qz - station.z);
        const len = Math.sqrt(len2), ux = dx / len, uz = dz / len;
        for (const sign of [-1, 1]) {
          const tx = ux * sign, tz = uz * sign;
          const score = tx * preferredX + tz * preferredZ - distancePenalty * 0.02;
          if (score > bestScore) { bestScore = score; best = { x: tx, z: tz }; }
        }
      }
    }
    return best;
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
