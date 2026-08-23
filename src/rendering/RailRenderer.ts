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

interface TrainRun {
  id: number;
  lineId: number;
  cruiseSpeed: number;
  direction: 1 | -1;
  speed: number;
  distance: number;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  dwellRemaining: number;
  state: TrainState;
  x: number;
  z: number;
  heading: number;
}

export interface TrainStatusSnapshot {
  id: number;
  lineId: number;
  lineName: string;
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
}

/**
 * City Generator v2 Phase 4.5 railway renderer + lightweight operations.
 * - A* polyline corners are rounded with quadratic fillets.
 * - Every train stops at every station and accelerates/brakes continuously.
 * - Each inter-station section is treated as one block; a train waits at a station when occupied.
 * - Trunk stations have passing loops so opposing trains can meet without overlapping.
 */
export class RailRenderer {
  static readonly TRACK_Y = 8.2;
  private static readonly TRAIN_LENGTH = 25;
  private static readonly ACCEL = 0.78;
  private static readonly BRAKE = 1.18;
  private static readonly SIDING_OFFSET = 3.15;

  private readonly smoothLines = new Map<number, SmoothLine>();
  private readonly trainRuns: TrainRun[] = [];
  private readonly d = new THREE.Object3D();
  private trainBody: THREE.InstancedMesh | null = null;
  private trainCabin: THREE.InstancedMesh | null = null;
  private lastSimSeconds = Number.NaN;

  constructor(private readonly scene: THREE.Scene, private readonly rail: RailNetworkPlan) {}

  build(): void {
    if (this.rail.lines.length === 0) return;
    for (const line of this.rail.lines) this.smoothLines.set(line.id, this.makeSmoothLine(line));

    const ballast: StaticPart[] = [], rails: StaticPart[] = [], sleepers: StaticPart[] = [], supports: StaticPart[] = [];
    for (const smooth of this.smoothLines.values()) {
      for (let i = 1; i < smooth.path.length; i++) {
        this.pushTrackSegment(smooth.path[i - 1], smooth.path[i], ballast, rails);
      }
      const sleeperSpacing = 8.5;
      for (let s = 0; s <= smooth.length; s += sleeperSpacing) {
        const p = this.sampleSmooth(smooth, s); if (!p) continue;
        sleepers.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y + 0.17, p.z, 0.18, 0.12, 3.1, -p.heading) });
      }
      const supportSpacing = 72;
      for (let s = supportSpacing * 0.5; s < smooth.length; s += supportSpacing) {
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
    this.updateTrainMeshes();
  }

  update(simSeconds: number): void {
    if (!this.trainBody || !this.trainCabin || this.trainRuns.length === 0) return;
    if (!Number.isFinite(this.lastSimSeconds)) {
      this.lastSimSeconds = simSeconds;
      this.updateTrainMeshes();
      return;
    }
    let remaining = simSeconds - this.lastSimSeconds;
    this.lastSimSeconds = simSeconds;
    if (remaining < 0) { remaining = 0; }
    // A long browser stall must not produce a huge one-frame jump. At most five simulated minutes are caught up.
    remaining = Math.min(remaining, 300);
    while (remaining > 1e-4) {
      const dt = Math.min(0.5, remaining);
      this.stepOperations(dt);
      remaining -= dt;
    }
    this.updateTrainMeshes();
  }

  get trainCount(): number { return this.trainRuns.length; }
  get waitingTrainCount(): number { return this.trainRuns.filter((r) => r.state === 'signal').length; }
  get trainHitMesh(): THREE.InstancedMesh | null { return this.trainBody; }
  trainIdFromInstance(instanceId: number): number { return instanceId >= 0 && instanceId < this.trainRuns.length ? instanceId : -1; }

  trainStatus(id: number): TrainStatusSnapshot | null {
    const run = this.trainRuns[id]; if (!run) return null;
    const line = this.rail.lines[run.lineId]; if (!line) return null;
    const currentStationId = run.currentStationIndex >= 0 ? line.stationIds[run.currentStationIndex] ?? -1 : -1;
    const nextStationId = run.nextStationIndex >= 0 ? line.stationIds[run.nextStationIndex] ?? -1 : -1;
    const currentStation = currentStationId >= 0 ? this.rail.stations[currentStationId] : null;
    const nextStation = nextStationId >= 0 ? this.rail.stations[nextStationId] : null;
    const stateLabel = run.state === 'dwell' ? '停車中' : run.state === 'signal' ? '閉塞待ち' : '走行中';
    const loopStation = currentStationId >= 0 ? currentStationId : nextStationId;
    return {
      id: run.id, lineId: run.lineId, lineName: line.name, state: run.state, stateLabel,
      x: run.x, z: run.z, heading: run.heading, speed: run.speed, cruiseSpeed: run.cruiseSpeed, direction: run.direction,
      currentStationId, currentStationName: currentStation?.name ?? '—',
      nextStationId, nextStationName: nextStation?.name ?? '—',
      dwellRemaining: Math.max(0, run.dwellRemaining), waitingForBlock: run.state === 'signal',
      passingLoop: loopStation >= 0 && this.stationHasPassingLoop(loopStation),
    };
  }

  private stepOperations(dt: number): void {
    for (const run of this.trainRuns) {
      const smooth = this.smoothLines.get(run.lineId); if (!smooth || smooth.stationDistances.length < 2) continue;
      const lastStation = smooth.line.stationIds.length - 1;

      if (run.currentStationIndex >= 0) {
        run.speed = 0;
        if (run.dwellRemaining > 0) {
          run.dwellRemaining = Math.max(0, run.dwellRemaining - dt); run.state = 'dwell'; continue;
        }
        if ((run.direction > 0 && run.currentStationIndex >= lastStation) || (run.direction < 0 && run.currentStationIndex <= 0)) {
          run.direction = run.direction > 0 ? -1 : 1;
        }
        const next = run.currentStationIndex + run.direction;
        if (next < 0 || next > lastStation) continue;
        if (!this.canEnterBlock(run, run.currentStationIndex, next)) {
          run.state = 'signal'; continue;
        }
        run.originStationIndex = run.currentStationIndex;
        run.nextStationIndex = next;
        run.currentStationIndex = -1;
        run.state = 'running';
      }

      if (run.state !== 'running' || run.nextStationIndex < 0) continue;
      const targetDistance = smooth.stationDistances[run.nextStationIndex];
      const remaining = Math.abs(targetDistance - run.distance);
      const brakingTarget = Math.sqrt(Math.max(0, 2 * RailRenderer.BRAKE * Math.max(0, remaining - 0.35)));
      const targetSpeed = Math.min(run.cruiseSpeed, brakingTarget);
      if (run.speed < targetSpeed) run.speed = Math.min(targetSpeed, run.speed + RailRenderer.ACCEL * dt);
      else run.speed = Math.max(targetSpeed, run.speed - RailRenderer.BRAKE * dt);

      const move = Math.min(remaining, Math.max(0.15, run.speed) * dt);
      run.distance += run.direction * move;
      if (remaining <= 0.45 || move >= remaining - 0.02) {
        run.distance = targetDistance;
        run.speed = 0;
        run.currentStationIndex = run.nextStationIndex;
        run.originStationIndex = -1;
        run.nextStationIndex = -1;
        run.state = 'dwell';
        const stationId = smooth.line.stationIds[run.currentStationIndex];
        run.dwellRemaining = this.dwellSeconds(stationId);
      }
    }
  }

  /** One inter-station section is one block. A train may depart only when that block is clear. */
  private canEnterBlock(run: TrainRun, fromIndex: number, toIndex: number): boolean {
    const segment = Math.min(fromIndex, toIndex);
    const targetStationId = this.rail.lines[run.lineId]?.stationIds[toIndex] ?? -1;
    for (const other of this.trainRuns) {
      if (other.id === run.id || other.lineId !== run.lineId) continue;
      if (other.state === 'running' && other.originStationIndex >= 0 && other.nextStationIndex >= 0) {
        if (Math.min(other.originStationIndex, other.nextStationIndex) === segment) return false;
      }
      if (other.currentStationIndex === toIndex) {
        // A passing loop has one platform track per direction. Same-direction trains still queue.
        if (!this.stationHasPassingLoop(targetStationId) || other.direction === run.direction) return false;
      }
    }
    return true;
  }

  private dwellSeconds(stationId: number): number {
    const station = this.rail.stations[stationId]; if (!station) return 12;
    if (station.kind === RailStationKind.Central) return 24;
    if (station.kind === RailStationKind.SubCenter) return 20;
    if (station.kind === RailStationKind.Terminal) return 22;
    return 14;
  }

  private updateTrainMeshes(): void {
    if (!this.trainBody || !this.trainCabin) return;
    for (let i = 0; i < this.trainRuns.length; i++) {
      const run = this.trainRuns[i], smooth = this.smoothLines.get(run.lineId); if (!smooth) continue;
      const p = this.sampleSmooth(smooth, run.distance); if (!p) continue;
      const heading = run.direction > 0 ? p.heading : this.wrapAngle(p.heading + Math.PI);
      const offset = this.trainSidingOffset(run, smooth);
      const px = -Math.sin(p.heading), pz = Math.cos(p.heading);
      run.x = p.x + px * offset; run.z = p.z + pz * offset; run.heading = heading;
      this.pose(this.trainBody, i, run.x, RailRenderer.TRACK_Y + 1.85, run.z, heading, RailRenderer.TRAIN_LENGTH, 3.15, 2.9);
      this.pose(this.trainCabin, i, run.x, RailRenderer.TRACK_Y + 3.28, run.z, heading, 18.5, 0.72, 2.45);
    }
    this.trainBody.count = this.trainRuns.length; this.trainCabin.count = this.trainRuns.length;
    this.trainBody.instanceMatrix.needsUpdate = true; this.trainCabin.instanceMatrix.needsUpdate = true;
  }

  /** Enter/leave a passing loop gradually instead of teleporting sideways at the platform. */
  private trainSidingOffset(run: TrainRun, smooth: SmoothLine): number {
    if (smooth.line.kind !== 'trunk') return 0;
    let best = Infinity, stationId = -1;
    for (let i = 0; i < smooth.stationDistances.length; i++) {
      const d = Math.abs(run.distance - smooth.stationDistances[i]);
      if (d < best) { best = d; stationId = smooth.line.stationIds[i] ?? -1; }
    }
    if (stationId < 0 || !this.stationHasPassingLoop(stationId) || best >= 62) return 0;
    const t = THREE.MathUtils.clamp(1 - best / 62, 0, 1);
    const eased = t * t * (3 - 2 * t);
    return RailRenderer.SIDING_OFFSET * run.direction * eased;
  }

  private buildStations(): void {
    const platforms: StaticPart[] = [], roofs: StaticPart[] = [], signs: StaticPart[] = [], columns: StaticPart[] = [];
    const loopBallast: StaticPart[] = [], loopRails: StaticPart[] = [];
    for (const station of this.rail.stations) {
      const heading = this.stationHeading(station.id);
      const major = station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter;
      const passing = this.stationHasPassingLoop(station.id);
      const platformLength = station.kind === RailStationKind.Central ? 72 : major ? 62 : 50;
      const platformWidth = passing ? 3.7 : major ? 6.5 : 5.2;
      platforms.push({ matrix: this.matrix(station.x, RailRenderer.TRACK_Y + 0.38, station.z, platformLength, 0.38, platformWidth, -heading) });
      roofs.push({ matrix: this.matrix(station.x, RailRenderer.TRACK_Y + 3.25, station.z, platformLength * 0.72, 0.18, platformWidth * 0.82, -heading) });
      signs.push({ matrix: this.matrix(station.x, RailRenderer.TRACK_Y + 4.05, station.z, major ? 5.5 : 3.8, 1.25, 0.22, -heading) });
      columns.push({ matrix: this.matrix(station.x, RailRenderer.TRACK_Y * 0.5, station.z, major ? 1.1 : 0.8, RailRenderer.TRACK_Y, major ? 1.1 : 0.8) });
      if (passing) this.buildPassingLoop(station.x, station.z, heading, platformLength + 34, loopBallast, loopRails);
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xc9c7bf, roughness: 0.86 }), platforms);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x6f7d88, roughness: 0.58, metalness: 0.18 }), roofs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x2f6fa3, roughness: 0.52 }), signs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777d82, roughness: 0.9 }), columns);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), loopBallast);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), loopRails);
  }

  private buildPassingLoop(x: number, z: number, heading: number, length: number, ballast: StaticPart[], rails: StaticPart[]): void {
    const ux = Math.cos(heading), uz = Math.sin(heading), px = -uz, pz = ux;
    const half = length / 2;
    for (const side of [-1, 1]) {
      const off = RailRenderer.SIDING_OFFSET * side;
      const a = { x: x - ux * (half - 11) + px * off, z: z - uz * (half - 11) + pz * off };
      const b = { x: x + ux * (half - 11) + px * off, z: z + uz * (half - 11) + pz * off };
      this.pushTrackSegment(a, b, ballast, rails, 3.35);
      // Switches connect the siding back to the center line at both ends.
      const inA = { x: x - ux * half, z: z - uz * half };
      const inB = { x: x + ux * half, z: z + uz * half };
      this.pushTrackSegment(inA, a, ballast, rails, 2.7);
      this.pushTrackSegment(b, inB, ballast, rails, 2.7);
    }
  }

  private stationHasPassingLoop(stationId: number): boolean {
    const station = this.rail.stations[stationId]; if (!station || station.kind === RailStationKind.Terminal) return false;
    return station.lineIds.some((lineId) => this.rail.lines[lineId]?.kind === 'trunk');
  }

  private buildTrains(): void {
    for (const line of this.rail.lines) {
      const smooth = this.smoothLines.get(line.id); if (!smooth || smooth.length < 300 || line.stationIds.length < 2) continue;
      const count = line.kind === 'trunk' ? (smooth.length > 4500 ? 3 : 2) : 1;
      for (let i = 0; i < count; i++) {
        const maxStation = line.stationIds.length - 1;
        const stationIndex = Math.min(maxStation, Math.round((i * maxStation) / Math.max(1, count)));
        let direction: 1 | -1 = (i & 1) === 0 ? 1 : -1;
        if (stationIndex <= 0) direction = 1; else if (stationIndex >= maxStation) direction = -1;
        const id = this.trainRuns.length;
        this.trainRuns.push({
          id, lineId: line.id, cruiseSpeed: line.kind === 'trunk' ? 21.5 : 17.0,
          direction, speed: 0, distance: smooth.stationDistances[stationIndex] ?? 0,
          currentStationIndex: stationIndex, originStationIndex: -1, nextStationIndex: -1,
          dwellRemaining: 5 + i * 4, state: 'dwell', x: 0, z: 0, heading: 0,
        });
      }
    }
    if (this.trainRuns.length === 0) return;
    const cap = this.trainRuns.length;
    this.trainBody = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe5e8eb, roughness: 0.48, metalness: 0.12 }),
      cap,
    );
    this.trainCabin = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x304d66, roughness: 0.25, metalness: 0.18 }),
      cap,
    );
    const hitSphere = new THREE.Sphere(new THREE.Vector3(this.rail.sizeMeters / 2, RailRenderer.TRACK_Y, this.rail.sizeMeters / 2), Math.max(20_000, this.rail.sizeMeters * 2));
    for (const mesh of [this.trainBody, this.trainCabin]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.boundingSphere = hitSphere.clone(); this.scene.add(mesh);
    }
  }

  /** Convert the road-grid polyline into small quadratic corner fillets while preserving station anchors. */
  private makeSmoothLine(line: RailLine): SmoothLine {
    const src = line.path;
    const path: RailPoint[] = [];
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
      const anchor = line.stationIds.some((sid) => {
        const s = this.rail.stations[sid]; return s && Math.hypot(s.x - p.x, s.z - p.z) < 4;
      });
      if (anchor || dot > 0.992) { push(p); continue; }
      const radius = Math.min(34, la * 0.34, lb * 0.34);
      const entry = { x: p.x - uaX * radius, z: p.z - uaZ * radius };
      const exit = { x: p.x + ubX * radius, z: p.z + ubZ * radius };
      push(entry);
      const steps = 7;
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
      const a = path[i - 1], b = path[i], dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
      if (len2 < 0.01) continue;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
      const qx = a.x + dx * t, qz = a.z + dz * t, d2 = (x - qx) ** 2 + (z - qz) ** 2;
      if (d2 < bestD) { bestD = d2; bestAlong = cumulative[i - 1] + Math.sqrt(len2) * t; }
    }
    return bestAlong;
  }

  /** A*で曲がった後の滑らかな実線路から、駅に最も近いsegmentの向きを取る。 */
  private stationHeading(stationId: number): number {
    const station = this.rail.stations[stationId]; let bestD = Infinity, bestHeading = 0;
    for (const lineId of station.lineIds) {
      const smooth = this.smoothLines.get(lineId); if (!smooth) continue;
      for (let i = 1; i < smooth.path.length; i++) {
        const a = smooth.path[i - 1], b = smooth.path[i], dx = b.x - a.x, dz = b.z - a.z;
        const len2 = dx * dx + dz * dz; if (len2 < 0.01) continue;
        const t = THREE.MathUtils.clamp(((station.x - a.x) * dx + (station.z - a.z) * dz) / len2, 0, 1);
        const qx = a.x + dx * t, qz = a.z + dz * t, d2 = (station.x - qx) ** 2 + (station.z - qz) ** 2;
        if (d2 < bestD) { bestD = d2; bestHeading = Math.atan2(dz, dx); }
      }
    }
    return bestHeading;
  }

  private sampleSmooth(smooth: SmoothLine, distance: number): { x: number; z: number; heading: number } | null {
    if (smooth.path.length < 2 || smooth.length <= 0) return null;
    const d = THREE.MathUtils.clamp(distance, 0, smooth.length);
    let hi = 1;
    while (hi < smooth.cumulative.length && smooth.cumulative[hi] < d) hi++;
    hi = Math.min(hi, smooth.path.length - 1); const lo = Math.max(0, hi - 1);
    const a = smooth.path[lo], b = smooth.path[hi], start = smooth.cumulative[lo], end = smooth.cumulative[hi];
    const t = end > start ? (d - start) / (end - start) : 0;
    return { x: THREE.MathUtils.lerp(a.x, b.x, t), z: THREE.MathUtils.lerp(a.z, b.z, t), heading: Math.atan2(b.z - a.z, b.x - a.x) };
  }

  private pushTrackSegment(a: RailPoint, b: RailPoint, ballast: StaticPart[], rails: StaticPart[], ballastWidth = 3.8): void {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz); if (len < 0.35) return;
    const px = -dz / len, pz = dx / len, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const angle = -Math.atan2(dz, dx);
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
