import * as THREE from 'three';
import { RailStationKind, type RailLine, type RailNetworkPlan, type RailPoint, type RailStation } from '../generation/RailPlanning';
import type { RoadNetwork } from '../traffic/RoadNetwork';
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
  __citySimRoadAlignedExternalRailV019?: boolean;
  railTime: number;
  rail: RailNetworkPlan;
  roads?: RoadNetwork;
  scene: THREE.Scene;
  stepOperations: (dt: number) => void;
  updateTrainMeshes: () => void;
  lineTrackY: (lineId: number) => number;
}

interface RouteGeometry {
  points: RailPoint[];
  cumulative: number[];
  length: number;
  centralPosition: number;
  trackY: number;
}

interface RouteSample { x: number; z: number; heading: number; }

const HEADWAY_SECONDS = 30 * 60;
const UP_PHASE_SECONDS = 15 * 60;
const MAX_SPEED = 320 / 3.6;
const ACCEL = 0.90;
const BRAKE = 1.10;
const DWELL_SECONDS = 60;
const TRACK_OFFSET = 2.4;
const CAR_LENGTH = 25.0;
const CAR_GAP = 1.0;
const PASSENGERS_PER_CAR = 90;
const TRAIN_CAPACITY_CARS = 96;
const DECK_WIDTH = 10.6;
const BARRIER_OFFSET = 5.05;
const INFRA_STEP = 34;

function matrixBox(x: number, y: number, z: number, length: number, height: number, width: number, heading: number): THREE.Matrix4 {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.rotation.y = -heading;
  o.scale.set(length, height, width);
  o.updateMatrix();
  return o.matrix.clone();
}

function nextSlot(after: number, phase: number): number {
  return phase + (Math.floor((after - phase) / HEADWAY_SECONDS) + 1) * HEADWAY_SECONDS;
}

function formatClock(seconds: number): string {
  const t = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
}

function findCentralStation(rail: RailNetworkPlan): RailStation | null {
  return rail.stations.find((station) => station.kind === RailStationKind.Central) ?? null;
}

function findRoadAlignedTrunk(rail: RailNetworkPlan, central: RailStation): RailLine | null {
  return rail.lines.find((line) => line.kind === 'trunk' && line.stationIds.includes(central.id) && line.path.length >= 2) ?? null;
}

function stripTerminalLandApproach(points: RailPoint[], line: RailLine, rail: RailNetworkPlan, roads?: RoadNetwork): RailPoint[] {
  if (!roads || points.length < 2) return points;
  const out = points.map((point) => ({ x: point.x, z: point.z }));
  const first = rail.stations[line.stationIds[0]];
  const last = rail.stations[line.stationIds[line.stationIds.length - 1]];
  if (first?.kind === RailStationKind.Terminal && first.roadNode >= 0 && roads.nodes[first.roadNode]) {
    const node = roads.nodes[first.roadNode]; out[0] = { x: node.x, z: node.z };
  }
  if (last?.kind === RailStationKind.Terminal && last.roadNode >= 0 && roads.nodes[last.roadNode]) {
    const node = roads.nodes[last.roadNode]; out[out.length - 1] = { x: node.x, z: node.z };
  }
  return out.filter((point, i) => i === 0 || Math.hypot(point.x - out[i - 1].x, point.z - out[i - 1].z) > 0.25);
}

function nearestPosition(points: RailPoint[], cumulative: number[], x: number, z: number): number {
  let bestD2 = Infinity, bestS = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-8) continue;
    const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d2 = (px - x) ** 2 + (pz - z) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = cumulative[i] + Math.sqrt(len2) * t;
    }
  }
  return bestS;
}

function buildRoute(rt: ExternalRailRuntime, central: RailStation): RouteGeometry {
  const line = findRoadAlignedTrunk(rt.rail, central);
  if (!line) throw new Error('High-speed line requires a road-aligned city trunk through Central');

  // RailPlanning aligns trunk.path to RoadNetwork after city roads are generated. Only terminal
  // stations have a short off-road land approach, so replace those two end points with roadNode.
  const points = stripTerminalLandApproach(line.path, line, rt.rail, rt.roads);
  if (points.length < 2) throw new Error('Road-aligned high-speed corridor has no usable geometry');
  const cumulative = new Array(points.length).fill(0);
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    cumulative[i] = length;
  }
  if (length < 1500) throw new Error('Road-aligned high-speed corridor is too short');

  const centralPosition = nearestPosition(points, cumulative, central.x, central.z);
  let highestCityRail = RailRenderer.TRACK_Y;
  for (const cityLine of rt.rail.lines) highestCityRail = Math.max(highestCityRail, rt.lineTrackY(cityLine.id));
  return { points, cumulative, length, centralPosition, trackY: Math.max(30, highestCityRail + 12) };
}

function sampleRoute(route: RouteGeometry, s: number, offset = 0): RouteSample {
  const points = route.points, cumulative = route.cumulative;
  let index: number, local: number;
  if (s <= 0) {
    index = 0; local = s;
  } else if (s >= route.length) {
    index = points.length - 2;
    local = cumulative[index + 1] - cumulative[index] + (s - route.length);
  } else {
    let lo = 0, hi = cumulative.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= s) lo = mid; else hi = mid;
    }
    index = Math.min(points.length - 2, lo);
    local = s - cumulative[index];
  }
  const a = points[index], b = points[index + 1];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.max(1e-6, Math.hypot(dx, dz));
  const ux = dx / len, uz = dz / len;
  return { x: a.x + ux * local - uz * offset, z: a.z + uz * local + ux * offset, heading: Math.atan2(uz, ux) };
}

class RoadAlignedHighSpeedRail {
  private readonly route: RouteGeometry;
  private readonly central: RailStation;
  private readonly visitorSystem: ExternalVisitorSystem | null;
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
    if (!central) throw new Error('High-speed line requires Central station');
    this.central = central;
    this.route = buildRoute(rt, central);
    this.visitorSystem = latestExternalVisitorSystem();
    this.lastTime = rt.railTime;
    this.nextDown = nextSlot(this.lastTime - 1e-6, 0);
    this.nextUp = nextSlot(this.lastTime - 1e-6, UP_PHASE_SECONDS);
    this.buildInfrastructure();

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.carBody = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0xf4f7f9, roughness: 0.34, metalness: 0.18 }), TRAIN_CAPACITY_CARS);
    this.carWindow = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0x18324a, roughness: 0.20, metalness: 0.18 }), TRAIN_CAPACITY_CARS * 2);
    this.carStripe = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0x2b74c7 }), TRAIN_CAPACITY_CARS * 2);
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
    while (Math.min(this.nextDown, this.nextUp) <= now + 1e-7) {
      const event = Math.min(this.nextDown, this.nextUp);
      this.advanceInterval(event - this.lastTime, this.lastTime);
      this.lastTime = event;
      if (this.nextDown <= event + 1e-7) { this.spawn(1, event); this.nextDown += HEADWAY_SECONDS; }
      if (this.nextUp <= event + 1e-7) { this.spawn(-1, event); this.nextUp += HEADWAY_SECONDS; }
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
      const trackOffset = train.direction > 0 ? TRACK_OFFSET : -TRACK_OFFSET;
      for (let car = 0; car < train.carCount && bodyCount < TRAIN_CAPACITY_CARS; car++) {
        const along = train.position - train.direction * car * (CAR_LENGTH + CAR_GAP);
        const center = sampleRoute(this.route, along, trackOffset);
        const heading = center.heading + (train.direction > 0 ? 0 : Math.PI);
        const y = this.route.trackY + 1.85;
        this.carBody.setMatrixAt(bodyCount, matrixBox(center.x, y, center.z, CAR_LENGTH, bodyHeight, bodyWidth, heading));
        for (const side of [-1, 1]) {
          const panel = sampleRoute(this.route, along, trackOffset + side * (bodyWidth * 0.5 + 0.035));
          this.carWindow.setMatrixAt(panelCount, matrixBox(panel.x, y + 0.55, panel.z, CAR_LENGTH * 0.72, 0.74, 0.07, heading));
          this.carStripe.setMatrixAt(panelCount, matrixBox(panel.x, y - 0.55, panel.z, CAR_LENGTH * 0.94, 0.24, 0.075, heading));
          panelCount++;
        }
        bodyCount++;
      }
    }
    this.carBody.count = bodyCount; this.carWindow.count = panelCount; this.carStripe.count = panelCount;
    this.carBody.instanceMatrix.needsUpdate = true; this.carWindow.instanceMatrix.needsUpdate = true; this.carStripe.instanceMatrix.needsUpdate = true;
  }

  private spawn(direction: Direction, now: number): void {
    const pattern = [10, 12, 14, 16] as const;
    const carCount = pattern[(this.nextTrainId - 1) % pattern.length];
    const half = (carCount * CAR_LENGTH + Math.max(0, carCount - 1) * CAR_GAP) * 0.5;
    const position = direction > 0 ? -half : this.route.length + half;
    const toCentral = Math.abs(this.route.centralPosition - position);
    this.trains.push({
      id: this.nextTrainId++, direction, carCount, position,
      speed: Math.min(MAX_SPEED, Math.sqrt(Math.max(0, 2 * BRAKE * Math.max(0, toCentral - 20)))),
      state: 'running', stoppedAtCentral: false, dwellUntil: 0, exchanged: false,
    });
    this.lastPanelAt = Math.min(this.lastPanelAt, now - 30);
  }

  private advanceInterval(dt: number, startTime: number): void {
    let remaining = Math.max(0, dt), time = startTime;
    while (remaining > 1e-7) {
      const step = Math.min(1, remaining); time += step;
      for (let i = this.trains.length - 1; i >= 0; i--) if (this.stepTrain(this.trains[i], step, time)) this.trains.splice(i, 1);
      remaining -= step;
    }
  }

  private stepTrain(train: HighSpeedTrain, dt: number, now: number): boolean {
    if (train.state === 'dwell') {
      train.speed = 0;
      if (now + 1e-7 < train.dwellUntil) return false;
      train.state = 'running'; train.stoppedAtCentral = true;
    }
    if (!train.stoppedAtCentral) {
      const remaining = Math.max(0, (this.route.centralPosition - train.position) * train.direction);
      const target = Math.min(MAX_SPEED, Math.sqrt(Math.max(0, 2 * BRAKE * Math.max(0, remaining - 1.5))));
      train.speed = train.speed < target ? Math.min(target, train.speed + ACCEL * dt) : Math.max(target, train.speed - BRAKE * dt);
      const move = train.speed * dt;
      if (move + 0.35 >= remaining) {
        train.position = this.route.centralPosition; train.speed = 0; train.state = 'dwell'; train.dwellUntil = now + DWELL_SECONDS;
        if (!train.exchanged) {
          this.visitorSystem?.exchangeAtStation(this.central.id, train.carCount * PASSENGERS_PER_CAR, now, 1_000_000 + train.id);
          train.exchanged = true;
        }
        this.updatePanel(true);
        return false;
      }
      train.position += train.direction * move;
      return false;
    }
    train.speed = Math.min(MAX_SPEED, train.speed + ACCEL * dt);
    train.position += train.direction * train.speed * dt;
    const half = (train.carCount * CAR_LENGTH + Math.max(0, train.carCount - 1) * CAR_GAP) * 0.5;
    return train.direction > 0 ? train.position - half > this.route.length : train.position + half < 0;
  }

  private segmentMatrix(s0: number, s1: number, y: number, height: number, width: number, offset = 0): THREE.Matrix4 {
    const a = sampleRoute(this.route, s0, offset), b = sampleRoute(this.route, s1, offset);
    const dx = b.x - a.x, dz = b.z - a.z;
    return matrixBox((a.x + b.x) * 0.5, y, (a.z + b.z) * 0.5, Math.hypot(dx, dz) + 0.25, height, width, Math.atan2(dz, dx));
  }

  private buildInfrastructure(): void {
    const decks: THREE.Matrix4[] = [], rails: THREE.Matrix4[] = [], barriers: THREE.Matrix4[] = [], piers: THREE.Matrix4[] = [];
    for (let s = 0; s < this.route.length - 1e-6; s += INFRA_STEP) {
      const end = Math.min(this.route.length, s + INFRA_STEP);
      decks.push(this.segmentMatrix(s, end, this.route.trackY - 0.55, 0.72, DECK_WIDTH));
      for (const track of [-TRACK_OFFSET, TRACK_OFFSET]) for (const gauge of [-0.72, 0.72]) rails.push(this.segmentMatrix(s, end, this.route.trackY + 0.06, 0.12, 0.10, track + gauge));
      for (const side of [-BARRIER_OFFSET, BARRIER_OFFSET]) barriers.push(this.segmentMatrix(s, end, this.route.trackY + 0.18, 0.48, 0.16, side));
    }
    for (let s = 52; s < this.route.length; s += 74) {
      if (Math.abs(s - this.route.centralPosition) < 260) continue;
      const p = sampleRoute(this.route, s);
      const height = Math.max(2.5, this.route.trackY - 0.35);
      piers.push(matrixBox(p.x, height * 0.5, p.z, 1.8, height, 2.1, p.heading));
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x686f75, roughness: 0.94 }), decks);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xb9c0c5, roughness: 0.32, metalness: 0.72 }), rails);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x8a949d, roughness: 0.72 }), barriers);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777d82, roughness: 0.92 }), piers);

    const platforms: THREE.Matrix4[] = [], roofs: THREE.Matrix4[] = [];
    const start = Math.max(0, this.route.centralPosition - 215), finish = Math.min(this.route.length, this.route.centralPosition + 215);
    for (const side of [-6.45, 6.45]) {
      for (let s = start; s < finish - 1e-6; s += 30) {
        const end = Math.min(finish, s + 30);
        platforms.push(this.segmentMatrix(s, end, this.route.trackY + 0.34, 0.42, 3.6, side));
        roofs.push(this.segmentMatrix(s, end, this.route.trackY + 5.2, 0.28, 4.7, side));
      }
      for (let s = start + 18; s <= finish - 18; s += 42) {
        const p = sampleRoute(this.route, s, side);
        roofs.push(matrixBox(p.x, this.route.trackY + 2.7, p.z, 0.34, 4.8, 0.34, p.heading));
      }
    }
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xb7bcc1, roughness: 0.88 }), platforms);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xd8e0e6, roughness: 0.58, metalness: 0.08 }), roofs);
  }

  private addStatic(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[]): void {
    if (!matrices.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;
    this.rt.scene.add(mesh);
  }

  private createPanel(): HTMLDivElement | null {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:220px;right:8px;z-index:14;width:320px;padding:7px 8px;border:1px solid #355a7a;border-radius:8px;background:rgba(9,17,27,.86);color:#d8e7f5;font:11px/1.4 ui-monospace,monospace;pointer-events:none;white-space:pre-line';
    document.body.appendChild(el); return el;
  }

  private updatePanel(force: boolean): void {
    if (!this.panel || (!force && this.lastTime - this.lastPanelAt < 30)) return;
    this.lastPanelAt = this.lastTime;
    const visitors = this.visitorSystem?.stats();
    const cars = this.trains.reduce((sum, train) => sum + train.carCount, 0);
    const stopped = this.trains.filter((train) => train.state === 'dwell').length;
    this.panel.textContent = `外部高速線 1路線  道路上高架  最高320km/h  10–16両\n運転中 ${this.trains.length}編成 (${cars}両)  中央停車${stopped}\n下り次発 ${formatClock(this.nextDown)}  上り次発 ${formatClock(this.nextUp)}  各30分間隔\n`
      + (visitors ? `来訪者 ${visitors.active.toLocaleString()}人  買物${visitors.shopping.toLocaleString()} 観光${visitors.tourism.toLocaleString()} 宿泊${visitors.hotelGuests.toLocaleString()}\n帰路待ち ${visitors.waitingOutbound.toLocaleString()}` : '来訪者モデル 準備中');
  }
}

export function installExternalRailConnection(renderer: RailRenderer): void {
  const rt = renderer as unknown as ExternalRailRuntime;
  if (rt.__citySimRoadAlignedExternalRailV019) return;
  rt.__citySimRoadAlignedExternalRailV019 = true;
  const central = findCentralStation(rt.rail);
  if (!central) { console.warn('[City-Sim] road-aligned high-speed line skipped: no Central station'); return; }

  let system: RoadAlignedHighSpeedRail;
  try { system = new RoadAlignedHighSpeedRail(rt); }
  catch (error) { console.warn('[City-Sim] road-aligned high-speed line skipped', error); return; }

  const baseStep = rt.stepOperations.bind(rt), baseMeshes = rt.updateTrainMeshes.bind(rt);
  rt.stepOperations = (dt) => { baseStep(dt); system.advanceTo(rt.railTime); };
  rt.updateTrainMeshes = () => { baseMeshes(); system.syncMeshes(); };
  console.info('[City-Sim] road-aligned dedicated high-speed line', { centralStation: central.name, headwaySeconds: HEADWAY_SECONDS, maxSpeedKmh: 320 });
}
