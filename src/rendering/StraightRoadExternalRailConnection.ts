import * as THREE from 'three';
import { RailStationKind, type RailNetworkPlan, type RailStation } from '../generation/RailPlanning';
import { RoadClass, roadWidth, type RoadNetwork } from '../traffic/RoadNetwork';
import { latestExternalVisitorSystem, type ExternalVisitorSystem } from '../world/ExternalVisitorSystem';
import { RailRenderer } from './RailRenderer';
import {
  registerHighSpeedRailInspectionSource,
  type HighSpeedRailInspectionSource,
  type HighSpeedTrainStatusSnapshot,
} from './HighSpeedRailRegistry';

type Direction = 1 | -1;
type HighSpeedState = 'running' | 'dwell';
type RoadAxis = 0 | 1;

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
  __citySimStraightRoadExternalRailV020?: boolean;
  railTime: number;
  rail: RailNetworkPlan;
  roads?: RoadNetwork;
  scene: THREE.Scene;
  stepOperations: (dt: number) => void;
  updateTrainMeshes: () => void;
  lineTrackY: (lineId: number) => number;
}

interface StraightRoadRoute {
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
  roadAxis: RoadAxis;
  minRoadWidth: number;
  majorRoadMeters: number;
}

interface AxisWalkResult {
  endpoint: number;
  distance: number;
  minRoadWidth: number;
  majorRoadMeters: number;
}

interface AxisCandidate {
  axis: RoadAxis;
  negative: AxisWalkResult;
  positive: AxisWalkResult;
  length: number;
  minRoadWidth: number;
  majorRoadMeters: number;
  score: number;
}

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
const ROAD_ALIGNMENT_EPSILON = 0.25;

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

function roadClassPriority(roadClass: RoadClass): number {
  switch (roadClass) {
    case RoadClass.Highway: return 5;
    case RoadClass.Arterial: return 4;
    case RoadClass.Collector: return 3;
    case RoadClass.Local: return 1;
    default: return -10;
  }
}

function walkStraightAxis(net: RoadNetwork, startNode: number, axis: RoadAxis, sign: Direction): AxisWalkResult {
  const start = net.nodes[startNode];
  let current = startNode;
  let distance = 0;
  let minWidth = Infinity;
  let majorRoadMeters = 0;
  const visited = new Set<number>([startNode]);

  for (let guard = 0; guard < net.nodes.length; guard++) {
    const node = net.nodes[current];
    let bestEdge = -1;
    let bestNode = -1;
    let bestAlong = -Infinity;
    let bestPriority = -Infinity;

    for (const edgeId of node.edges) {
      const edge = net.edges[edgeId];
      if (!edge || edge.roadClass === RoadClass.Path) continue;
      const next = net.nodes[edge.to];
      if (!next || visited.has(next.id)) continue;
      const along = axis === 0 ? (next.x - node.x) * sign : (next.z - node.z) * sign;
      const cross = axis === 0 ? Math.abs(next.z - start.z) : Math.abs(next.x - start.x);
      if (along <= 0.01 || cross > ROAD_ALIGNMENT_EPSILON) continue;
      const priority = roadClassPriority(edge.roadClass) * 1_000 + along;
      if (priority > bestPriority) {
        bestPriority = priority;
        bestAlong = along;
        bestEdge = edgeId;
        bestNode = next.id;
      }
    }

    if (bestEdge < 0 || bestNode < 0 || bestAlong <= 0) break;
    const edge = net.edges[bestEdge];
    distance += edge.length;
    minWidth = Math.min(minWidth, roadWidth(edge.lanes));
    if (edge.roadClass === RoadClass.Highway || edge.roadClass === RoadClass.Arterial || edge.roadClass === RoadClass.Collector) {
      majorRoadMeters += edge.length;
    }
    current = bestNode;
    visited.add(current);
  }

  return {
    endpoint: current,
    distance,
    minRoadWidth: Number.isFinite(minWidth) ? minWidth : 0,
    majorRoadMeters,
  };
}

function axisCandidate(net: RoadNetwork, startNode: number, axis: RoadAxis): AxisCandidate {
  const negative = walkStraightAxis(net, startNode, axis, -1);
  const positive = walkStraightAxis(net, startNode, axis, 1);
  const length = negative.distance + positive.distance;
  const minRoadWidth = Math.min(negative.minRoadWidth || Infinity, positive.minRoadWidth || Infinity);
  const majorRoadMeters = negative.majorRoadMeters + positive.majorRoadMeters;
  const widthBonus = minRoadWidth >= DECK_WIDTH ? 4_000 : minRoadWidth >= 9 ? 1_000 : 0;
  return {
    axis,
    negative,
    positive,
    length,
    minRoadWidth: Number.isFinite(minRoadWidth) ? minRoadWidth : 0,
    majorRoadMeters,
    score: length + majorRoadMeters * 0.45 + widthBonus,
  };
}

function buildRoute(rt: ExternalRailRuntime, central: RailStation): StraightRoadRoute {
  const roads = rt.roads;
  if (!roads || central.roadNode < 0 || !roads.nodes[central.roadNode]) {
    throw new Error('Straight high-speed line requires Central station to be attached to RoadNetwork');
  }

  const horizontal = axisCandidate(roads, central.roadNode, 0);
  const vertical = axisCandidate(roads, central.roadNode, 1);
  const best = horizontal.score >= vertical.score ? horizontal : vertical;
  if (best.length < Math.max(1_500, rt.rail.sizeMeters * 0.45)) {
    throw new Error(`No sufficiently long straight road corridor through Central (${best.length.toFixed(0)}m)`);
  }

  const a = roads.nodes[best.negative.endpoint];
  const b = roads.nodes[best.positive.endpoint];
  const c = roads.nodes[central.roadNode];
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  const ux = dx / Math.max(1e-6, length), uz = dz / Math.max(1e-6, length);
  const centralPosition = (c.x - a.x) * ux + (c.z - a.z) * uz;

  let highestCityRail = RailRenderer.TRACK_Y;
  for (const cityLine of rt.rail.lines) highestCityRail = Math.max(highestCityRail, rt.lineTrackY(cityLine.id));

  return {
    ax: a.x,
    az: a.z,
    bx: b.x,
    bz: b.z,
    ux,
    uz,
    nx: -uz,
    nz: ux,
    heading: Math.atan2(uz, ux),
    length,
    centralPosition,
    trackY: Math.max(30, highestCityRail + 12),
    roadAxis: best.axis,
    minRoadWidth: best.minRoadWidth,
    majorRoadMeters: best.majorRoadMeters,
  };
}

class StraightRoadHighSpeedRail implements HighSpeedRailInspectionSource {
  private readonly route: StraightRoadRoute;
  private readonly central: RailStation;
  private readonly visitorSystem: ExternalVisitorSystem | null;
  private readonly trains: HighSpeedTrain[] = [];
  private readonly carBody: THREE.InstancedMesh;
  private readonly carWindow: THREE.InstancedMesh;
  private readonly carStripe: THREE.InstancedMesh;
  private readonly instanceTrainIds = new Int32Array(TRAIN_CAPACITY_CARS).fill(-1);
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

  get trainHitMesh(): THREE.InstancedMesh { return this.carBody; }

  trainIdFromInstance(instanceId: number): number {
    return instanceId >= 0 && instanceId < this.instanceTrainIds.length ? this.instanceTrainIds[instanceId] : -1;
  }

  trainStatus(id: number): HighSpeedTrainStatusSnapshot | null {
    const train = this.trains.find((item) => item.id === id);
    if (!train) return null;
    const trackOffset = train.direction > 0 ? TRACK_OFFSET : -TRACK_OFFSET;
    const p = this.pointAt(train.position, trackOffset);
    const consistLength = this.consistLength(train.carCount);
    return {
      id: train.id,
      lineName: '外部高速線',
      carCount: train.carCount,
      consistLength,
      stateLabel: train.state === 'dwell' ? '中央駅停車中' : train.stoppedAtCentral ? '市外方面へ走行中' : '中央駅方面へ走行中',
      x: p.x,
      y: this.route.trackY,
      z: p.z,
      heading: this.route.heading + (train.direction > 0 ? 0 : Math.PI),
      speed: train.speed,
      maxSpeed: MAX_SPEED,
      direction: train.direction,
      stoppedAtCentral: train.stoppedAtCentral,
      dwellRemaining: train.state === 'dwell' ? Math.max(0, train.dwellUntil - this.lastTime) : 0,
      firstPersonForwardOffset: consistLength * 0.5 + 1.0,
    };
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
    let bodyCount = 0;
    let panelCount = 0;
    this.instanceTrainIds.fill(-1);
    const bodyHeight = 3.45;
    const bodyWidth = 3.35;

    for (const train of this.trains) {
      const trackOffset = train.direction > 0 ? TRACK_OFFSET : -TRACK_OFFSET;
      const heading = this.route.heading + (train.direction > 0 ? 0 : Math.PI);
      const spacing = CAR_LENGTH + CAR_GAP;
      for (let car = 0; car < train.carCount && bodyCount < TRAIN_CAPACITY_CARS; car++) {
        const local = (car - (train.carCount - 1) * 0.5) * spacing;
        const along = train.position + local;
        const center = this.pointAt(along, trackOffset);
        const y = this.route.trackY + 1.85;
        this.carBody.setMatrixAt(bodyCount, matrixBox(center.x, y, center.z, CAR_LENGTH, bodyHeight, bodyWidth, heading));
        this.instanceTrainIds[bodyCount] = train.id;
        for (const side of [-1, 1]) {
          const panel = this.pointAt(along, trackOffset + side * (bodyWidth * 0.5 + 0.035));
          this.carWindow.setMatrixAt(panelCount, matrixBox(panel.x, y + 0.55, panel.z, CAR_LENGTH * 0.72, 0.74, 0.07, heading));
          this.carStripe.setMatrixAt(panelCount, matrixBox(panel.x, y - 0.55, panel.z, CAR_LENGTH * 0.94, 0.24, 0.075, heading));
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

  private consistLength(carCount: number): number {
    return carCount * CAR_LENGTH + Math.max(0, carCount - 1) * CAR_GAP;
  }

  private spawn(direction: Direction, now: number): void {
    const pattern = [10, 12, 14, 16] as const;
    const carCount = pattern[(this.nextTrainId - 1) % pattern.length];
    const half = this.consistLength(carCount) * 0.5;
    const position = direction > 0 ? -half : this.route.length + half;
    const toCentral = Math.abs(this.route.centralPosition - position);
    this.trains.push({
      id: this.nextTrainId++,
      direction,
      carCount,
      position,
      speed: Math.min(MAX_SPEED, Math.sqrt(Math.max(0, 2 * BRAKE * Math.max(0, toCentral - 20)))),
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

  private stepTrain(train: HighSpeedTrain, dt: number, now: number): boolean {
    if (train.state === 'dwell') {
      train.speed = 0;
      if (now + 1e-7 < train.dwellUntil) return false;
      train.state = 'running';
      train.stoppedAtCentral = true;
    }

    if (!train.stoppedAtCentral) {
      const remaining = Math.max(0, (this.route.centralPosition - train.position) * train.direction);
      const target = Math.min(MAX_SPEED, Math.sqrt(Math.max(0, 2 * BRAKE * Math.max(0, remaining - 1.5))));
      train.speed = train.speed < target ? Math.min(target, train.speed + ACCEL * dt) : Math.max(target, train.speed - BRAKE * dt);
      const move = train.speed * dt;
      if (move + 0.35 >= remaining) {
        train.position = this.route.centralPosition;
        train.speed = 0;
        train.state = 'dwell';
        train.dwellUntil = now + DWELL_SECONDS;
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
    const half = this.consistLength(train.carCount) * 0.5;
    return train.direction > 0 ? train.position - half > this.route.length : train.position + half < 0;
  }

  private pointAt(s: number, offset = 0): { x: number; z: number } {
    return {
      x: this.route.ax + this.route.ux * s + this.route.nx * offset,
      z: this.route.az + this.route.uz * s + this.route.nz * offset,
    };
  }

  private buildInfrastructure(): void {
    const decks: THREE.Matrix4[] = [];
    const rails: THREE.Matrix4[] = [];
    const barriers: THREE.Matrix4[] = [];
    const piers: THREE.Matrix4[] = [];
    const segment = 80;

    for (let s = 0; s < this.route.length - 1e-6; s += segment) {
      const len = Math.min(segment, this.route.length - s);
      const mid = s + len * 0.5;
      const p = this.pointAt(mid);
      decks.push(matrixBox(p.x, this.route.trackY - 0.55, p.z, len + 0.4, 0.72, DECK_WIDTH, this.route.heading));
      for (const track of [-TRACK_OFFSET, TRACK_OFFSET]) {
        for (const gauge of [-0.72, 0.72]) {
          const rail = this.pointAt(mid, track + gauge);
          rails.push(matrixBox(rail.x, this.route.trackY + 0.06, rail.z, len + 0.5, 0.12, 0.10, this.route.heading));
        }
      }
      for (const side of [-BARRIER_OFFSET, BARRIER_OFFSET]) {
        const barrier = this.pointAt(mid, side);
        barriers.push(matrixBox(barrier.x, this.route.trackY + 0.18, barrier.z, len + 0.4, 0.48, 0.16, this.route.heading));
      }
    }

    for (let s = 55; s < this.route.length; s += 82) {
      if (Math.abs(s - this.route.centralPosition) < 260) continue;
      const p = this.pointAt(s);
      const height = Math.max(2.5, this.route.trackY - 0.35);
      piers.push(matrixBox(p.x, height * 0.5, p.z, 1.8, height, 2.2, this.route.heading));
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x686f75, roughness: 0.94 }), decks);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xb9c0c5, roughness: 0.32, metalness: 0.72 }), rails);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x8a949d, roughness: 0.72 }), barriers);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777d82, roughness: 0.92 }), piers);

    const platformLength = 430;
    const platforms: THREE.Matrix4[] = [];
    const roofs: THREE.Matrix4[] = [];
    for (const side of [-6.45, 6.45]) {
      const p = this.pointAt(this.route.centralPosition, side);
      platforms.push(matrixBox(p.x, this.route.trackY + 0.34, p.z, platformLength, 0.42, 3.6, this.route.heading));
      roofs.push(matrixBox(p.x, this.route.trackY + 5.2, p.z, platformLength * 0.92, 0.28, 4.7, this.route.heading));
      for (let offset = -platformLength * 0.42; offset <= platformLength * 0.42; offset += 42) {
        const post = this.pointAt(this.route.centralPosition + offset, side);
        roofs.push(matrixBox(post.x, this.route.trackY + 2.7, post.z, 0.34, 4.8, 0.34, this.route.heading));
      }
    }
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xb7bcc1, roughness: 0.88 }), platforms);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xd8e0e6, roughness: 0.58, metalness: 0.08 }), roofs);
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
    el.style.cssText = 'position:fixed;top:220px;right:8px;z-index:14;width:320px;padding:7px 8px;border:1px solid #355a7a;border-radius:8px;background:rgba(9,17,27,.86);color:#d8e7f5;font:11px/1.4 ui-monospace,monospace;pointer-events:none;white-space:pre-line';
    document.body.appendChild(el);
    return el;
  }

  private updatePanel(force: boolean): void {
    if (!this.panel || (!force && this.lastTime - this.lastPanelAt < 30)) return;
    this.lastPanelAt = this.lastTime;
    const visitors = this.visitorSystem?.stats();
    const cars = this.trains.reduce((sum, train) => sum + train.carCount, 0);
    const stopped = this.trains.filter((train) => train.state === 'dwell').length;
    this.panel.textContent = `外部高速線 1路線  直線・道路上高架  最高320km/h  10–16両\n`
      + `道路軸 ${this.route.roadAxis === 0 ? '東西' : '南北'}  延長${(this.route.length / 1000).toFixed(1)}km  最小道路幅${this.route.minRoadWidth.toFixed(1)}m\n`
      + `運転中 ${this.trains.length}編成 (${cars}両)  中央停車${stopped}\n`
      + `下り次発 ${formatClock(this.nextDown)}  上り次発 ${formatClock(this.nextUp)}  各30分間隔\n`
      + (visitors
        ? `来訪者 ${visitors.active.toLocaleString()}人  買物${visitors.shopping.toLocaleString()} 観光${visitors.tourism.toLocaleString()} 宿泊${visitors.hotelGuests.toLocaleString()}\n帰路待ち ${visitors.waitingOutbound.toLocaleString()}`
        : '来訪者モデル 準備中');
  }
}

export function installExternalRailConnection(renderer: RailRenderer): void {
  const rt = renderer as unknown as ExternalRailRuntime;
  if (rt.__citySimStraightRoadExternalRailV020) return;
  rt.__citySimStraightRoadExternalRailV020 = true;

  const central = findCentralStation(rt.rail);
  if (!central) {
    console.warn('[City-Sim] straight road high-speed line skipped: no Central station');
    return;
  }

  let system: StraightRoadHighSpeedRail;
  try {
    system = new StraightRoadHighSpeedRail(rt);
  } catch (error) {
    console.warn('[City-Sim] straight road high-speed line skipped', error);
    return;
  }

  registerHighSpeedRailInspectionSource(system);
  const baseStep = rt.stepOperations.bind(rt);
  const baseMeshes = rt.updateTrainMeshes.bind(rt);
  rt.stepOperations = (dt) => { baseStep(dt); system.advanceTo(rt.railTime); };
  rt.updateTrainMeshes = () => { baseMeshes(); system.syncMeshes(); };

  console.info('[City-Sim] straight road dedicated high-speed line', {
    centralStation: central.name,
    headwaySeconds: HEADWAY_SECONDS,
    maxSpeedKmh: 320,
  });
}
