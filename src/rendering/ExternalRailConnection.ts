import * as THREE from 'three';
import { RailStationKind, type RailNetworkPlan, type RailStation } from '../generation/RailPlanning';
import { latestExternalVisitorSystem, type ExternalVisitorSystem } from '../world/ExternalVisitorSystem';
import { RailRenderer } from './RailRenderer';

type Direction = 1 | -1;
type HighSpeedState = 'running' | 'dwell';

interface HighSpeedTrain {
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

interface ExternalRailRuntime {
  __citySimExternalRailV018?: boolean;
  railTime: number;
  rail: RailNetworkPlan;
  scene: THREE.Scene;
  stepOperations: (dt: number) => void;
  updateTrainMeshes: () => void;
  lineTrackY: (lineId: number) => number;
}

interface RouteGeometry {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ux: number;
  uz: number;
  nx: number;
  nz: number;
  heading: number;
  length: number;
  centralPosition: number;
  trackY: number;
}

const HEADWAY_SECONDS = 30 * 60;
const UP_PHASE_SECONDS = 15 * 60;
const MAX_SPEED = 320 / 3.6;
const ACCEL = 0.90;
const BRAKE = 1.10;
const DWELL_SECONDS = 60;
const TRACK_OFFSET = 3.9;
const CAR_LENGTH = 25.0;
const CAR_GAP = 1.0;
const PASSENGERS_PER_CAR = 90;
const TRAIN_CAPACITY_CARS = 96;

function matrixBox(
  x: number,
  y: number,
  z: number,
  length: number,
  height: number,
  width: number,
  heading: number,
): THREE.Matrix4 {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.rotation.y = -heading;
  o.scale.set(length, height, width);
  o.updateMatrix();
  return o.matrix.clone();
}

function nextSlot(after: number, phase: number): number {
  const n = Math.floor((after - phase) / HEADWAY_SECONDS) + 1;
  return phase + n * HEADWAY_SECONDS;
}

function formatClock(seconds: number): string {
  const t = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  return `${h}:${m}`;
}

function findCentralStation(rail: RailNetworkPlan): RailStation | null {
  return rail.stations.find((station) => station.kind === RailStationKind.Central) ?? null;
}

function preferredHeading(rail: RailNetworkPlan, central: RailStation): number {
  // Use the first city trunk as a geographic reference, then rotate the dedicated high-speed line
  // by 30 degrees so it does not visually sit on top of the existing corridor.
  for (const line of rail.lines) {
    if (line.kind !== 'trunk') continue;
    const index = line.stationIds.indexOf(central.id);
    if (index < 0) continue;
    const beforeId = line.stationIds[Math.max(0, index - 1)];
    const afterId = line.stationIds[Math.min(line.stationIds.length - 1, index + 1)];
    const before = rail.stations[beforeId], after = rail.stations[afterId];
    if (!before || !after || before.id === after.id) continue;
    const heading = Math.atan2(after.z - before.z, after.x - before.x);
    if (Number.isFinite(heading)) return heading + Math.PI / 6;
  }
  return 0;
}

function rayToBoundary(
  x: number,
  z: number,
  ux: number,
  uz: number,
  size: number,
  sign: Direction,
): number {
  const dx = ux * sign, dz = uz * sign;
  const candidates: number[] = [];
  if (dx > 1e-6) candidates.push((size - x) / dx);
  else if (dx < -1e-6) candidates.push((0 - x) / dx);
  if (dz > 1e-6) candidates.push((size - z) / dz);
  else if (dz < -1e-6) candidates.push((0 - z) / dz);
  const valid = candidates.filter((v) => Number.isFinite(v) && v >= 0);
  return valid.length ? Math.min(...valid) : size * 0.5;
}

function buildRoute(rt: ExternalRailRuntime, central: RailStation): RouteGeometry {
  const heading = preferredHeading(rt.rail, central);
  const ux = Math.cos(heading), uz = Math.sin(heading);
  const nx = -uz, nz = ux;
  const minus = rayToBoundary(central.x, central.z, ux, uz, rt.rail.sizeMeters, -1);
  const plus = rayToBoundary(central.x, central.z, ux, uz, rt.rail.sizeMeters, 1);
  const ax = central.x - ux * minus, az = central.z - uz * minus;
  const bx = central.x + ux * plus, bz = central.z + uz * plus;
  let highestCityRail = RailRenderer.TRACK_Y;
  for (const line of rt.rail.lines) highestCityRail = Math.max(highestCityRail, rt.lineTrackY(line.id));
  const trackY = Math.max(30, highestCityRail + 12.0);
  return {
    ax, az, bx, bz, ux, uz, nx, nz, heading,
    length: minus + plus,
    centralPosition: minus,
    trackY,
  };
}

class DedicatedHighSpeedRail {
  private readonly visitorSystem: ExternalVisitorSystem | null;
  private readonly route: RouteGeometry;
  private readonly central: RailStation;
  private readonly trains: HighSpeedTrain[] = [];
  private readonly carBody: THREE.InstancedMesh;
  private readonly carWindow: THREE.InstancedMesh;
  private readonly carStripe: THREE.InstancedMesh;
  private nextDown: number;
  private nextUp: number;
  private nextTrainId = 1;
  private lastTime: number;
  private lastPanelAt = -Infinity;
  private readonly panel: HTMLDivElement | null;

  constructor(private readonly rt: ExternalRailRuntime) {
    const central = findCentralStation(rt.rail);
    if (!central) throw new Error('High-speed external line requires a central station');
    this.central = central;
    this.route = buildRoute(rt, central);
    this.visitorSystem = latestExternalVisitorSystem();
    this.lastTime = rt.railTime;
    this.nextDown = nextSlot(this.lastTime - 1e-6, 0);
    this.nextUp = nextSlot(this.lastTime - 1e-6, UP_PHASE_SECONDS);

    this.buildInfrastructure();

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.carBody = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: 0xf4f7f9, roughness: 0.34, metalness: 0.18 }),
      TRAIN_CAPACITY_CARS,
    );
    this.carWindow = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: 0x18324a, roughness: 0.20, metalness: 0.18 }),
      TRAIN_CAPACITY_CARS * 2,
    );
    this.carStripe = new THREE.InstancedMesh(
      box,
      new THREE.MeshBasicMaterial({ color: 0x2b74c7 }),
      TRAIN_CAPACITY_CARS * 2,
    );
    for (const mesh of [this.carBody, this.carWindow, this.carStripe]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = mesh !== this.carStripe;
      mesh.receiveShadow = mesh !== this.carStripe;
      rt.scene.add(mesh);
    }
    this.panel = this.createPanel();
    this.syncMeshes();
    this.updatePanel(true);
  }

  advanceTo(now: number): void {
    if (!Number.isFinite(now) || now <= this.lastTime + 1e-7) return;

    while (true) {
      const nextEvent = Math.min(this.nextDown, this.nextUp);
      if (nextEvent > now + 1e-7) break;
      this.advanceInterval(nextEvent - this.lastTime, this.lastTime);
      this.lastTime = nextEvent;
      if (this.nextDown <= nextEvent + 1e-7) {
        this.spawn(1, nextEvent);
        this.nextDown += HEADWAY_SECONDS;
      }
      if (this.nextUp <= nextEvent + 1e-7) {
        this.spawn(-1, nextEvent);
        this.nextUp += HEADWAY_SECONDS;
      }
    }

    this.advanceInterval(now - this.lastTime, this.lastTime);
    this.lastTime = now;
    this.visitorSystem?.advanceTo(now);
    this.updatePanel(false);
  }

  syncMeshes(): void {
    let bodyCount = 0, panelCount = 0;
    const bodyHeight = 3.45, bodyWidth = 3.35;
    for (const train of this.trains) {
      const directionHeading = train.direction > 0 ? this.route.heading : this.route.heading + Math.PI;
      const trainTrackOffset = train.direction > 0 ? TRACK_OFFSET : -TRACK_OFFSET;
      for (let car = 0; car < train.carCount; car++) {
        if (bodyCount >= TRAIN_CAPACITY_CARS) break;
        const along = train.position - train.direction * car * (CAR_LENGTH + CAR_GAP);
        const cx = this.route.ax + this.route.ux * along + this.route.nx * trainTrackOffset;
        const cz = this.route.az + this.route.uz * along + this.route.nz * trainTrackOffset;
        const y = this.route.trackY + 1.85;
        this.carBody.setMatrixAt(bodyCount, matrixBox(cx, y, cz, CAR_LENGTH, bodyHeight, bodyWidth, directionHeading));

        for (const side of [-1, 1]) {
          const off = trainTrackOffset + side * (bodyWidth * 0.5 + 0.035);
          const px = this.route.ax + this.route.ux * along + this.route.nx * off;
          const pz = this.route.az + this.route.uz * along + this.route.nz * off;
          this.carWindow.setMatrixAt(panelCount, matrixBox(px, y + 0.55, pz, CAR_LENGTH * 0.72, 0.74, 0.07, directionHeading));
          this.carStripe.setMatrixAt(panelCount, matrixBox(px, y - 0.55, pz, CAR_LENGTH * 0.94, 0.24, 0.075, directionHeading));
          panelCount++;
        }
        bodyCount++;
      }
    }
    this.carBody.count = bodyCount;
    this.carWindow.count = panelCount;
    this.carStripe.count = panelCount;
    this.carBody.instanceMatrix.needsUpdate = true;
    this.carWindow.instanceMatrix.needsUpdate = true;
    this.carStripe.instanceMatrix.needsUpdate = true;
  }

  private spawn(direction: Direction, now: number): void {
    const pattern = [10, 12, 14, 16] as const;
    const carCount = pattern[(this.nextTrainId - 1) % pattern.length];
    const halfLength = (carCount * CAR_LENGTH + Math.max(0, carCount - 1) * CAR_GAP) * 0.5;
    const position = direction > 0 ? -halfLength : this.route.length + halfLength;
    const toCentral = Math.abs(this.route.centralPosition - position);
    const safeEntrySpeed = Math.sqrt(Math.max(0, 2 * BRAKE * Math.max(0, toCentral - 20)));
    this.trains.push({
      id: this.nextTrainId++,
      direction,
      carCount,
      position,
      speed: Math.min(MAX_SPEED, safeEntrySpeed),
      state: 'running',
      stoppedAtCentral: false,
      dwellUntil: 0,
      exchanged: false,
    });
    this.lastPanelAt = Math.min(this.lastPanelAt, now - 30);
  }

  private advanceInterval(dt: number, startTime: number): void {
    let remaining = Math.max(0, dt);
    let time = startTime;
    while (remaining > 1e-7) {
      const step = Math.min(1, remaining);
      time += step;
      for (let i = this.trains.length - 1; i >= 0; i--) {
        if (this.stepTrain(this.trains[i], step, time)) this.trains.splice(i, 1);
      }
      remaining -= step;
    }
  }

  /** Returns true once the full consist has cleared the map edge. */
  private stepTrain(train: HighSpeedTrain, dt: number, now: number): boolean {
    if (train.state === 'dwell') {
      train.speed = 0;
      if (now + 1e-7 < train.dwellUntil) return false;
      train.state = 'running';
      train.stoppedAtCentral = true;
    }

    if (!train.stoppedAtCentral) {
      const remaining = Math.max(0, (this.route.centralPosition - train.position) * train.direction);
      const targetSpeed = Math.min(MAX_SPEED, Math.sqrt(Math.max(0, 2 * BRAKE * Math.max(0, remaining - 1.5))));
      train.speed = this.approachSpeed(train.speed, targetSpeed, dt);
      const move = train.speed * dt;
      if (move + 0.35 >= remaining) {
        train.position = this.route.centralPosition;
        train.speed = 0;
        train.state = 'dwell';
        train.dwellUntil = now + DWELL_SECONDS;
        if (!train.exchanged) {
          this.visitorSystem?.exchangeAtStation(
            this.central.id,
            train.carCount * PASSENGERS_PER_CAR,
            now,
            1_000_000 + train.id,
          );
          train.exchanged = true;
        }
        this.updatePanel(true);
        return false;
      }
      train.position += train.direction * move;
      return false;
    }

    train.speed = this.approachSpeed(train.speed, MAX_SPEED, dt);
    train.position += train.direction * train.speed * dt;
    const halfLength = (train.carCount * CAR_LENGTH + Math.max(0, train.carCount - 1) * CAR_GAP) * 0.5;
    return train.direction > 0
      ? train.position - halfLength > this.route.length
      : train.position + halfLength < 0;
  }

  private approachSpeed(speed: number, target: number, dt: number): number {
    if (speed < target) return Math.min(target, speed + ACCEL * dt);
    return Math.max(target, speed - BRAKE * dt);
  }

  private pointAt(s: number, offset: number): { x: number; z: number } {
    return {
      x: this.route.ax + this.route.ux * s + this.route.nx * offset,
      z: this.route.az + this.route.uz * s + this.route.nz * offset,
    };
  }

  private buildInfrastructure(): void {
    const deckParts: THREE.Matrix4[] = [];
    const railParts: THREE.Matrix4[] = [];
    const barrierParts: THREE.Matrix4[] = [];
    const pierParts: THREE.Matrix4[] = [];
    const segment = 80;

    for (let s = 0; s < this.route.length - 1e-6; s += segment) {
      const len = Math.min(segment, this.route.length - s);
      const mid = s + len * 0.5;
      const p = this.pointAt(mid, 0);
      deckParts.push(matrixBox(p.x, this.route.trackY - 0.55, p.z, len + 0.4, 0.72, 14.8, this.route.heading));

      for (const track of [-TRACK_OFFSET, TRACK_OFFSET]) {
        for (const gauge of [-0.72, 0.72]) {
          const q = this.pointAt(mid, track + gauge);
          railParts.push(matrixBox(q.x, this.route.trackY + 0.06, q.z, len + 0.5, 0.12, 0.10, this.route.heading));
        }
      }
      for (const side of [-7.15, 7.15]) {
        const q = this.pointAt(mid, side);
        barrierParts.push(matrixBox(q.x, this.route.trackY + 0.18, q.z, len + 0.4, 0.48, 0.16, this.route.heading));
      }
    }

    for (let s = 55; s < this.route.length; s += 82) {
      if (Math.abs(s - this.route.centralPosition) < 260) continue;
      const p = this.pointAt(s, 0);
      const height = Math.max(2.5, this.route.trackY - 0.35);
      pierParts.push(matrixBox(p.x, height * 0.5, p.z, 1.8, height, 2.2, this.route.heading));
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x686f75, roughness: 0.94 }), deckParts);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xb9c0c5, roughness: 0.32, metalness: 0.72 }), railParts);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x8a949d, roughness: 0.72 }), barrierParts);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777d82, roughness: 0.92 }), pierParts);

    const platformLength = 430;
    const stationParts: THREE.Matrix4[] = [];
    const roofParts: THREE.Matrix4[] = [];
    for (const side of [-8.7, 8.7]) {
      const p = this.pointAt(this.route.centralPosition, side);
      stationParts.push(matrixBox(p.x, this.route.trackY + 0.34, p.z, platformLength, 0.42, 4.1, this.route.heading));
      roofParts.push(matrixBox(p.x, this.route.trackY + 5.2, p.z, platformLength * 0.92, 0.28, 5.2, this.route.heading));
      for (let s = -platformLength * 0.42; s <= platformLength * 0.42; s += 42) {
        const post = this.pointAt(this.route.centralPosition + s, side);
        roofParts.push(matrixBox(post.x, this.route.trackY + 2.7, post.z, 0.34, 4.8, 0.34, this.route.heading));
      }
    }
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xb7bcc1, roughness: 0.88 }), stationParts);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xd8e0e6, roughness: 0.58, metalness: 0.08 }), roofParts);
  }

  private addStatic(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[]): void {
    if (!matrices.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.rt.scene.add(mesh);
  }

  private createPanel(): HTMLDivElement | null {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:220px', 'right:8px', 'z-index:14', 'width:320px',
      'padding:7px 8px', 'border:1px solid #355a7a', 'border-radius:8px',
      'background:rgba(9,17,27,.86)', 'color:#d8e7f5', 'font:11px/1.4 ui-monospace,monospace',
      'pointer-events:none', 'white-space:pre-line',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  private updatePanel(force: boolean): void {
    if (!this.panel) return;
    if (!force && this.lastTime - this.lastPanelAt < 30) return;
    this.lastPanelAt = this.lastTime;
    const visitors = this.visitorSystem?.stats();
    const activeCars = this.trains.reduce((sum, train) => sum + train.carCount, 0);
    const running = this.trains.filter((train) => train.state === 'running').length;
    const stopped = this.trains.length - running;
    const visitorText = visitors
      ? `来訪者 ${visitors.active.toLocaleString()}人  買物${visitors.shopping.toLocaleString()} 観光${visitors.tourism.toLocaleString()} 宿泊${visitors.hotelGuests.toLocaleString()}\n帰路待ち ${visitors.waitingOutbound.toLocaleString()}  今日 入${visitors.arrivedToday.toLocaleString()} / 出${visitors.departedToday.toLocaleString()}`
      : '来訪者モデル 準備中';
    this.panel.textContent =
      `外部高速線 1路線  最高320km/h  10–16両\n`
      + `運転中 ${this.trains.length}編成 (${activeCars}両)  走行${running} / 中央停車${stopped}\n`
      + `下り次発 ${formatClock(this.nextDown)}  上り次発 ${formatClock(this.nextUp)}  各30分間隔\n`
      + visitorText;
  }
}

/**
 * Install a physically independent high-speed external rail line.
 *
 * v0.1.17 injected "external" trains into every existing city trunk. That increased contention at
 * city platforms/crossovers and was visible in deadlock reports. v0.1.18 deliberately does not touch
 * RailRenderer.trainRuns, blocks, platforms or route reservations. The high-speed line has its own
 * two tracks, one Central-station stop and its own train lifecycle; it only shares simulation time
 * and the non-resident visitor demand model.
 */
export function installExternalRailConnection(renderer: RailRenderer): void {
  const rt = renderer as unknown as ExternalRailRuntime;
  if (rt.__citySimExternalRailV018) return;
  rt.__citySimExternalRailV018 = true;

  const central = findCentralStation(rt.rail);
  if (!central) {
    console.warn('[City-Sim] dedicated high-speed line skipped: no central station');
    return;
  }

  const system = new DedicatedHighSpeedRail(rt);
  const baseStepOperations = rt.stepOperations.bind(rt);
  const baseUpdateTrainMeshes = rt.updateTrainMeshes.bind(rt);

  rt.stepOperations = (dt) => {
    baseStepOperations(dt);
    system.advanceTo(rt.railTime);
  };
  rt.updateTrainMeshes = () => {
    baseUpdateTrainMeshes();
    system.syncMeshes();
  };

  console.info('[City-Sim] dedicated external high-speed line', {
    centralStation: central.name,
    headwaySeconds: HEADWAY_SECONDS,
    maxSpeedKmh: 320,
    cars: '10-16',
  });
}
