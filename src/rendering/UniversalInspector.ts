import * as THREE from 'three';
import { AgentState, Occupation, OCCUPATION_LABEL } from '../agents/AgentStore';
import { RAIL_STATION_KIND_LABEL } from '../generation/RailPlanning';
import { FACILITY_LABEL } from '../generation/SpecialFacilityPlanner';
import { RoadClass, roadWidth } from '../traffic/RoadNetwork';
import { SignalMode } from '../traffic/SignalSystem';
import { VehicleState } from '../traffic/VehicleStore';
import { POICategory } from '../world/POI';
import { World } from '../world/World';
import type { CameraFollowTarget } from './FirstPersonController';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';
import { InstancedRenderer } from './InstancedRenderer';
import { RailRenderer } from './RailRenderer';

type MovingKind = 'agent' | 'vehicle' | 'train' | 'highSpeedTrain';
type StaticKind = 'building' | 'road' | 'roadNode' | 'signal' | 'busStop' | 'railStation' | 'parking' | 'gate' | 'park';
type InspectKind = MovingKind | StaticKind;

interface InspectHit {
  distance: number;
  kind: InspectKind;
  id: number;
}

interface ProxyGroup {
  kind: StaticKind;
  mesh: THREE.InstancedMesh;
  ids: number[];
}

export class UniversalInspector {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly hoverEl: HTMLDivElement;
  private readonly pinEl: HTMLDivElement;
  private readonly proxies: ProxyGroup[] = [];
  private hasPointer = false;
  private leftHeld = false;
  private hoveredKind: InspectKind | 'none' = 'none';
  private hoveredId = -1;
  private followKind: MovingKind | 'none' = 'none';
  private followId = -1;
  readonly followPos = new THREE.Vector3();
  private readonly followTarget: CameraFollowTarget = { kind: 'agent', id: -1, position: this.followPos };

  constructor(
    private readonly world: World,
    private readonly gfx: InstancedRenderer,
    private readonly rail: RailRenderer,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
  ) {
    this.hoverEl = this.panel('none');
    this.pinEl = this.panel('none');
    this.pinEl.style.left = '8px';
    this.pinEl.style.bottom = '8px';
    this.pinEl.style.borderColor = '#5a7fb0';
    this.pinEl.style.maxWidth = '520px';
    this.buildStaticProxies();

    this.dom.addEventListener('mousemove', (e) => {
      const rect = this.dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
      this.hoverEl.style.left = `${e.clientX + 16}px`;
      this.hoverEl.style.top = `${e.clientY + 16}px`;
      this.hasPointer = true;
    });
    this.dom.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.leftHeld = true;
      if (e.button === 1) {
        e.preventDefault();
        this.toggleFollow();
      }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.leftHeld = false; });
    window.addEventListener('blur', () => { this.leftHeld = false; this.hide(); });
  }

  get isFollowing(): boolean { return this.followKind !== 'none'; }
  get isFollowingVehicle(): boolean { return this.followKind === 'vehicle'; }
  get isFollowingTrain(): boolean { return this.followKind === 'train'; }
  get isFollowingHighSpeedTrain(): boolean { return this.followKind === 'highSpeedTrain'; }
  get isFollowingAgent(): boolean { return this.followKind === 'agent'; }

  getFollowTarget(): CameraFollowTarget | null {
    if (this.followKind === 'agent') {
      if (this.followId < 0 || this.followId >= this.world.store.count) return this.clearInvalidFollow();
      const s = this.world.store;
      this.followPos.set(s.posX[this.followId], 0, s.posZ[this.followId]);
      this.followTarget.kind = 'agent';
      this.followTarget.id = this.followId;
      this.followTarget.heading = s.heading[this.followId];
      this.followTarget.length = 0.4;
      this.followTarget.firstPersonHeight = 1.62;
      this.followTarget.firstPersonForwardOffset = 0.08;
      return this.followTarget;
    }
    if (this.followKind === 'vehicle') {
      const vs = this.world.vehicles;
      if (this.followId < 0 || this.followId >= vs.count) return this.clearInvalidFollow();
      const length = vs.length[this.followId] || 4.5;
      this.followPos.set(vs.posX[this.followId], 0, vs.posZ[this.followId]);
      this.followTarget.kind = 'vehicle';
      this.followTarget.id = this.followId;
      this.followTarget.heading = vs.heading[this.followId];
      this.followTarget.length = length;
      this.followTarget.firstPersonHeight = vs.isBus[this.followId] ? 2.35 : vs.isTruck[this.followId] ? 2.0 : 1.3;
      this.followTarget.firstPersonForwardOffset = Math.max(0.8, length * 0.36);
      return this.followTarget;
    }
    if (this.followKind === 'train') {
      const s = this.rail.trainStatus(this.followId);
      if (!s) return this.clearInvalidFollow();
      this.followPos.set(s.x, s.y, s.z);
      this.followTarget.kind = 'train';
      this.followTarget.id = s.id;
      this.followTarget.heading = s.heading;
      this.followTarget.length = s.consistLength;
      this.followTarget.firstPersonHeight = 2.45;
      this.followTarget.firstPersonForwardOffset = s.firstPersonForwardOffset;
      return this.followTarget;
    }
    if (this.followKind === 'highSpeedTrain') {
      const s = latestHighSpeedRailInspectionSource()?.trainStatus(this.followId);
      if (!s) return this.clearInvalidFollow();
      this.followPos.set(s.x, s.y, s.z);
      this.followTarget.kind = 'highSpeedTrain';
      this.followTarget.id = s.id;
      this.followTarget.heading = s.heading;
      this.followTarget.length = s.consistLength;
      this.followTarget.firstPersonHeight = 2.65;
      this.followTarget.firstPersonForwardOffset = s.firstPersonForwardOffset;
      return this.followTarget;
    }
    return null;
  }

  getFollowPosition(): THREE.Vector3 | null { return this.getFollowTarget()?.position ?? null; }

  update(): void {
    this.updatePinnedStatus();
    this.hoveredKind = 'none';
    this.hoveredId = -1;
    if (this.leftHeld || !this.hasPointer) { this.hide(); return; }

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const candidates: InspectHit[] = [];
    const add = (candidate: InspectHit | null): void => {
      if (candidate && Number.isFinite(candidate.distance)) candidates.push(candidate);
    };

    add(this.hitMappedMesh(this.gfx.agents, 'agent', (instance) => this.gfx.agentIndexOf(instance)));
    add(this.hitMappedMesh(this.gfx.vehicles, 'vehicle', (instance) => this.gfx.vehicleIndexOf(instance)));
    add(this.hitMappedMesh(this.rail.trainHitMesh, 'train', (instance) => this.rail.trainIdFromInstance(instance)));

    const highSpeed = latestHighSpeedRailInspectionSource();
    if (highSpeed) add(this.hitMappedMesh(highSpeed.trainHitMesh, 'highSpeedTrain', (instance) => highSpeed.trainIdFromInstance(instance)));

    add(this.hitMappedMesh(this.gfx.buildings, 'building', (instance) => instance));
    for (const group of this.proxies) {
      add(this.hitMappedMesh(group.mesh, group.kind, (instance) => group.ids[instance] ?? -1));
    }

    if (candidates.length === 0) { this.hide(); return; }
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) if (candidates[i].distance < best.distance) best = candidates[i];
    if (best.id < 0) { this.hide(); return; }
    this.hoveredKind = best.kind;
    this.hoveredId = best.id;
    this.hoverEl.textContent = this.describe(best.kind, best.id) + (this.isMoving(best.kind) ? '\n中クリック: 追跡 / 解除' : '');
    this.hoverEl.style.display = 'block';
  }

  private clearInvalidFollow(): null {
    this.followKind = 'none';
    this.followId = -1;
    return null;
  }

  private toggleFollow(): void {
    if (!this.isMoving(this.hoveredKind) || this.hoveredId < 0) {
      this.followKind = 'none';
      this.followId = -1;
      return;
    }
    if (this.followKind === this.hoveredKind && this.followId === this.hoveredId) {
      this.followKind = 'none';
      this.followId = -1;
      return;
    }
    this.followKind = this.hoveredKind;
    this.followId = this.hoveredId;
  }

  private isMoving(kind: InspectKind | 'none'): kind is MovingKind {
    return kind === 'agent' || kind === 'vehicle' || kind === 'train' || kind === 'highSpeedTrain';
  }

  private hitMappedMesh(
    mesh: THREE.InstancedMesh | null | undefined,
    kind: InspectKind,
    map: (instanceId: number) => number,
  ): InspectHit | null {
    if (!mesh) return null;
    const hits = this.raycaster.intersectObject(mesh, false);
    const hit = hits[0];
    if (!hit || hit.instanceId == null) return null;
    const id = map(hit.instanceId);
    return id >= 0 ? { distance: hit.distance, kind, id } : null;
  }

  private updatePinnedStatus(): void {
    if (this.followKind === 'none') { this.pinEl.style.display = 'none'; return; }
    const text = this.describe(this.followKind, this.followId);
    if (!text) { this.clearInvalidFollow(); this.pinEl.style.display = 'none'; return; }
    const label = this.followKind === 'agent' ? '市民'
      : this.followKind === 'vehicle' ? '車両'
        : this.followKind === 'train' ? '市内列車' : '新幹線';
    this.pinEl.textContent = `追跡: ${label}\n${text}`;
    this.pinEl.style.display = 'block';
  }

  private panel(display: string): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'z-index:20', 'pointer-events:none', 'font:12px/1.5 ui-monospace,monospace',
      'color:#dfe8f5', 'background:rgba(12,17,25,.92)', 'border:1px solid #3a4a63', 'border-radius:8px',
      'padding:8px 10px', 'max-width:390px', 'max-height:calc(100vh - 24px)', 'overflow:hidden',
      'box-shadow:0 6px 20px rgba(0,0,0,.4)', 'white-space:pre-line', `display:${display}`,
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  private hide(): void { this.hoverEl.style.display = 'none'; }

  private buildStaticProxies(): void {
    this.buildRoadProxy();
    this.buildRoadNodeProxy();
    this.buildSignalProxy();
    this.buildBusStopProxy();
    this.buildRailStationProxy();
    this.buildParkingProxy();
    this.buildGateProxy();
    this.buildParkProxy();
  }

  private proxyMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color: 0xffffff });
  }

  private makeProxy(kind: StaticKind, geometry: THREE.BufferGeometry, matrices: THREE.Matrix4[], ids: number[]): void {
    if (!matrices.length) return;
    const mesh = new THREE.InstancedMesh(geometry, this.proxyMaterial(), matrices.length);
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.updateMatrixWorld(true);
    mesh.computeBoundingSphere();
    this.proxies.push({ kind, mesh, ids });
  }

  private boxMatrix(x: number, y: number, z: number, length: number, height: number, width: number, heading = 0): THREE.Matrix4 {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -heading, 0));
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(length, height, width));
  }

  private buildRoadProxy(): void {
    const matrices: THREE.Matrix4[] = [];
    const ids: number[] = [];
    const drawn = new Set<string>();
    const net = this.world.city.net;
    for (const edge of net.edges) {
      const key = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = net.nodes[edge.from], b = net.nodes[edge.to];
      const heading = Math.atan2(b.z - a.z, b.x - a.x);
      matrices.push(this.boxMatrix((a.x + b.x) * 0.5, 0.20, (a.z + b.z) * 0.5, edge.length, 0.35, roadWidth(edge.lanes), heading));
      ids.push(edge.id);
    }
    this.makeProxy('road', new THREE.BoxGeometry(1, 1, 1), matrices, ids);
  }

  private buildRoadNodeProxy(): void {
    const matrices: THREE.Matrix4[] = [];
    const ids: number[] = [];
    for (const node of this.world.city.net.nodes) {
      matrices.push(this.boxMatrix(node.x, 0.9, node.z, 2.2, 1.8, 2.2));
      ids.push(node.id);
    }
    this.makeProxy('roadNode', new THREE.BoxGeometry(1, 1, 1), matrices, ids);
  }

  private buildSignalProxy(): void {
    const matrices: THREE.Matrix4[] = [];
    const ids: number[] = [];
    for (const nodeId of this.world.signals.nodeIds) {
      const node = this.world.city.net.nodes[nodeId];
      if (!node) continue;
      matrices.push(this.boxMatrix(node.x, 3.0, node.z, 5.5, 6.2, 5.5));
      ids.push(nodeId);
    }
    this.makeProxy('signal', new THREE.BoxGeometry(1, 1, 1), matrices, ids);
  }

  private buildBusStopProxy(): void {
    const matrices = this.world.bus.stops.map((stop) => this.boxMatrix(stop.x, 1.6, stop.z, 3.5, 3.2, 3.5, stop.heading));
    const ids = this.world.bus.stops.map((stop) => stop.id);
    this.makeProxy('busStop', new THREE.BoxGeometry(1, 1, 1), matrices, ids);
  }

  private buildRailStationProxy(): void {
    const matrices: THREE.Matrix4[] = [];
    const ids: number[] = [];
    for (const station of this.world.city.planning.rail.stations) {
      matrices.push(this.boxMatrix(station.x, RailRenderer.TRACK_Y + 2.5, station.z, 34, 8, 18));
      ids.push(station.id);
    }
    this.makeProxy('railStation', new THREE.BoxGeometry(1, 1, 1), matrices, ids);
  }

  private buildParkingProxy(): void {
    const matrices = this.world.city.parkingLots.map((lot) => this.boxMatrix(lot.x, 0.18, lot.z, lot.width, 0.35, lot.depth));
    const ids = this.world.city.parkingLots.map((lot) => lot.id);
    this.makeProxy('parking', new THREE.BoxGeometry(1, 1, 1), matrices, ids);
  }

  private buildGateProxy(): void {
    const matrices: THREE.Matrix4[] = [];
    const ids: number[] = [];
    for (const nodeId of this.world.city.gateNodes) {
      const node = this.world.city.net.nodes[nodeId];
      if (!node) continue;
      matrices.push(this.boxMatrix(node.x, 3.0, node.z, 14, 6, 14));
      ids.push(nodeId);
    }
    this.makeProxy('gate', new THREE.BoxGeometry(1, 1, 1), matrices, ids);
  }

  private buildParkProxy(): void {
    const matrices = this.world.city.parks.map((park) => this.boxMatrix(park.x, 0.15, park.z, park.width, 0.3, park.depth));
    const ids = this.world.city.parks.map((park) => park.id);
    this.makeProxy('park', new THREE.BoxGeometry(1, 1, 1), matrices, ids);
  }

  private describe(kind: InspectKind, id: number): string {
    switch (kind) {
      case 'agent': return this.describeAgent(id);
      case 'vehicle': return this.describeVehicle(id);
      case 'train': return this.describeTrain(id);
      case 'highSpeedTrain': return this.describeHighSpeedTrain(id);
      case 'building': return this.describeBuilding(id);
      case 'road': return this.describeRoad(id);
      case 'roadNode': return this.describeRoadNode(id);
      case 'signal': return this.describeSignal(id);
      case 'busStop': return this.describeBusStop(id);
      case 'railStation': return this.describeRailStation(id);
      case 'parking': return this.describeParking(id);
      case 'gate': return this.describeGate(id);
      case 'park': return this.describePark(id);
    }
  }

  private bar(v: number): string {
    const n = Math.round(THREE.MathUtils.clamp(v, 0, 1) * 10);
    return '█'.repeat(n) + '░'.repeat(10 - n);
  }

  private describeAgent(i: number): string {
    const s = this.world.store;
    if (i < 0 || i >= s.count) return '';
    const state = AgentState[s.state[i]] ?? '?';
    const goal = s.goalPOI[i];
    const goalCat = goal >= 0 ? POICategory[this.world.city.poi.get(goal).category] : '—';
    const occ = OCCUPATION_LABEL[s.occupation[i] as Occupation] ?? '?';
    const speed = Math.hypot(s.velX[i], s.velZ[i]);
    const wait = s.waiting[i] ? ' / 信号待ち' : '';
    const wh = s.workEnd[i] !== s.workStart[i] ? `${s.workStart[i]}-${s.workEnd[i]}時` : '不定';
    return `市民 #${i} [${occ}]\n年齢 ${s.age[i]} / 車 ${s.ownsCar[i] ? '有' : '無'} / 勤務 ${wh}\n状態 ${state}${wait} / 速度 ${speed.toFixed(1)}m/s\n目的地 ${goalCat}\n体力 ${this.bar(s.energy[i])}\n満腹 ${this.bar(s.hunger[i])}\n社交 ${this.bar(s.social[i])}\n娯楽 ${this.bar(s.fun[i])}`;
  }

  private describeVehicle(v: number): string {
    const vs = this.world.vehicles;
    if (v < 0 || v >= vs.count) return '';
    const kmh = vs.speed[v] * 3.6;
    const maxKmh = vs.maxSpeed[v] * 3.6;
    if (vs.isBus[v]) {
      const busId = vs.busId[v];
      const snap = busId >= 0 ? this.world.bus.busStatus(busId) : null;
      return snap
        ? `路線バス #${busId} / Vehicle #${v}\n路線 R${snap.routeId} / 乗客 ${snap.onboard.length}/${snap.capacity}\n状態 ${snap.dwellRemaining > 0 ? `停車中 ${snap.dwellRemaining.toFixed(1)}s` : '走行中'}\n速度 ${kmh.toFixed(0)}/${maxKmh.toFixed(0)}km/h\n次停留所 #${snap.targetStopId}`
        : `路線バス Vehicle #${v}\n運行情報なし`;
    }
    if (vs.isTruck[v]) {
      const truckId = vs.truckId[v];
      const phase = truckId >= 0 ? this.world.logistics.truckPhase(truckId) : '';
      const cargo = truckId >= 0 ? this.world.logistics.truckCargo(truckId) : 0;
      const cap = truckId >= 0 ? this.world.logistics.truckCapacity(truckId) : 0;
      return `配送トラック #${truckId} / Vehicle #${v}\n状態 ${phase || '待機'}\n速度 ${kmh.toFixed(0)}/${maxKmh.toFixed(0)}km/h\n積荷 ${cargo}/${cap}`;
    }
    const parked = vs.state[v] === VehicleState.Parked;
    const path = vs.paths[v];
    return `車両 #${v}\n状態 ${parked ? '駐車中' : kmh < 1 ? '停止中' : '走行中'}\n速度 ${kmh.toFixed(0)}/${maxKmh.toFixed(0)}km/h\n運転者 市民#${vs.driver[v]}\n経路 ${path.length > 1 ? `${vs.pathCursor[v]}/${path.length - 1}` : '—'}\n位置 (${vs.posX[v].toFixed(1)}, ${vs.posZ[v].toFixed(1)})`;
  }

  private describeTrain(id: number): string {
    const s = this.rail.trainStatus(id);
    if (!s) return '';
    const arrival = s.scheduledArrivalAt > 0 ? this.formatRailTime(s.scheduledArrivalAt) : '—';
    return `${s.serviceLabel} #${s.id} / ${s.lineName}\n${s.carCount}両 / ${s.stateLabel}\n速度 ${(s.speed * 3.6).toFixed(0)}km/h / 制限 ${(s.currentSpeedLimit * 3.6).toFixed(0)}km/h / 最高 ${(s.cruiseSpeed * 3.6).toFixed(0)}km/h\n方向 ${s.direction > 0 ? '下り' : '上り'}\n現在 ${s.currentStationName !== '—' ? s.currentStationName : `${s.originStationName} → ${s.nextStationName}`}\n到着予定 ${arrival} / 遅れ ${Math.round(s.delaySeconds)}s`;
  }

  private describeHighSpeedTrain(id: number): string {
    const s = latestHighSpeedRailInspectionSource()?.trainStatus(id);
    if (!s) return '';
    return `新幹線 #${s.id} / ${s.lineName}\n${s.carCount}両 / ${s.stateLabel}\n速度 ${(s.speed * 3.6).toFixed(0)}km/h / 最高 ${(s.maxSpeed * 3.6).toFixed(0)}km/h\n方向 ${s.direction > 0 ? '下り' : '上り'}\n中央駅停車 ${s.stoppedAtCentral ? '済' : 'これから'}${s.dwellRemaining > 0 ? ` / あと${s.dwellRemaining.toFixed(0)}s` : ''}\n位置 (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`;
  }

  private describeBuilding(i: number): string {
    const b = this.world.city.buildings[i];
    if (!b) return '';
    const facility = this.world.city.facilities.find((item) => item.buildingId === b.id);
    const pois = this.world.city.poi.poisInBuilding(b.id);
    let occ = 0, cap = 0;
    for (const p of pois) { occ += p.occupancy; cap += p.capacity; }
    const uses = pois.length
      ? pois.map((p) => `${POICategory[p.category]} ${p.occupancy}/${p.capacity}${p.maxStock > 0 ? ` 在庫${p.stock}/${p.maxStock}` : ''}`).join('\n')
      : '用途なし';
    return `建物 #${b.id} [${POICategory[b.category] ?? '?'}]\n${facility ? `施設 ${FACILITY_LABEL[facility.type]} / 定員${facility.capacity}\n` : ''}${b.floors}F / ${b.width.toFixed(0)}×${b.depth.toFixed(0)}m\n在館 ${occ}/${cap}\n地価 ${b.landValue.toFixed(2)} / 開発強度 ${b.developmentIntensity.toFixed(2)}\n用途:\n${uses}`;
  }

  private describeRoad(edgeId: number): string {
    const edge = this.world.city.net.edges[edgeId];
    if (!edge) return '';
    return `道路 Edge #${edge.id}\n${edge.from} → ${edge.to} / ${RoadClass[edge.roadClass]}\n延長 ${edge.length.toFixed(1)}m / ${edge.lanes * 2}車線 / 幅${roadWidth(edge.lanes).toFixed(1)}m\n制限 ${(edge.speedLimit * 3.6).toFixed(0)}km/h\n占有車両 ${edge.occupants.length}`;
  }

  private describeRoadNode(nodeId: number): string {
    const node = this.world.city.net.nodes[nodeId];
    if (!node) return '';
    return `道路ノード #${node.id}\n位置 (${node.x.toFixed(1)}, ${node.z.toFixed(1)})\n接続 ${node.edges.length} edge\n信号 ${node.hasSignal ? 'あり' : 'なし'}`;
  }

  private describeSignal(nodeId: number): string {
    const mode = this.world.signals.modeOf(nodeId);
    if (mode == null) return `信号 #${nodeId}\n信号情報なし`;
    const axis0 = this.world.signals.vehicleColor(nodeId, 0);
    const axis1 = this.world.signals.vehicleColor(nodeId, 1);
    const ped0 = this.world.signals.pedColor(nodeId, 0);
    const ped1 = this.world.signals.pedColor(nodeId, 1);
    return `信号 / Node #${nodeId}\n方式 ${mode === SignalMode.Scramble ? 'スクランブル' : '通常'}\n東西 車${axis0} / 歩行者${ped0}\n南北 車${axis1} / 歩行者${ped1}`;
  }

  private describeBusStop(id: number): string {
    const stop = this.world.bus.stopById(id);
    if (!stop) return '';
    return `バス停 #${stop.id}\n位置 (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)})\n道路 Node #${stop.node}\n路線 ${stop.routes.length ? stop.routes.map((r) => `R${r}`).join(', ') : 'なし'}`;
  }

  private describeRailStation(id: number): string {
    const station = this.world.city.planning.rail.stations[id];
    if (!station) return '';
    const lines = station.lineIds.map((lineId) => this.world.city.planning.rail.lines[lineId]?.name ?? `L${lineId}`).join(', ');
    return `鉄道駅 #${station.id} ${station.name}\n種別 ${RAIL_STATION_KIND_LABEL[station.kind]}\n路線 ${lines || 'なし'}\n道路Node #${station.roadNode} / バス停 #${station.busStopId}\n位置 (${station.x.toFixed(1)}, ${station.z.toFixed(1)})`;
  }

  private describeParking(id: number): string {
    const lot = this.world.city.parkingLots[id];
    if (!lot) return '';
    let free = 0;
    for (let i = 0; i < lot.free.length; i++) if (lot.free[i]) free++;
    return `駐車場 #${lot.id}\n容量 ${lot.capacity} / 空き ${free}\nPOI #${lot.poiId}\n位置 (${lot.x.toFixed(1)}, ${lot.z.toFixed(1)})`;
  }

  private describeGate(nodeId: number): string {
    const node = this.world.city.net.nodes[nodeId];
    if (!node) return '';
    return `物流ゲート / Node #${nodeId}\n位置 (${node.x.toFixed(1)}, ${node.z.toFixed(1)})\n接続道路 ${node.edges.length}`;
  }

  private describePark(id: number): string {
    const park = this.world.city.parks[id];
    if (!park) return '';
    const poi = this.world.city.poi.get(park.poiId);
    return `公園 #${park.id} [${park.kind}]\n広さ ${park.width.toFixed(0)}×${park.depth.toFixed(0)}m\n利用 ${poi.occupancy}/${poi.capacity}\n位置 (${park.x.toFixed(1)}, ${park.z.toFixed(1)})`;
  }

  private formatRailTime(seconds: number): string {
    const t = ((Math.floor(seconds) % 86400) + 86400) % 86400;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
