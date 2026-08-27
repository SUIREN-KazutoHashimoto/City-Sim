import * as THREE from 'three';
import type { Building } from '../generation/CityGenerator';
import { powerSystemForRoad } from '../power/PowerRuntimeRegistry';
import { PowerSystem } from '../power/PowerSystem';
import type { PowerZoneElectricalSnapshot } from '../power/PowerQualityModel';
import { BuildingPowerState, PowerAssetState, PowerLineState } from '../power/PowerTypes';
import { laneOffset, type RoadNetwork } from '../traffic/RoadNetwork';
import type { SignalSystem } from '../traffic/SignalSystem';
import { TrafficSystem } from '../traffic/TrafficSystem';
import { VehicleState, type VehicleStore } from '../traffic/VehicleStore';
import { EnhancedRenderer } from './EnhancedRenderer';

export type OverlayMode =
  | 'off'
  | 'traffic-congestion'
  | 'traffic-speed'
  | 'traffic-volume'
  | 'traffic-wait'
  | 'power-supply'
  | 'power-load'
  | 'power-voltage'
  | 'power-zone';

type OverlayFamily = 'traffic' | 'power';

interface OverlayModeDefinition {
  id: Exclude<OverlayMode, 'off'>;
  family: OverlayFamily;
  label: string;
  legend: string;
}

interface TrafficDiagnosticSnapshot {
  vehicleCount: Uint32Array;
  occupiedMeters: Float32Array;
  speedSum: Float32Array;
  waitSecondsSum: Float32Array;
  waitingVehicleCount: Uint32Array;
  sampleVersion: number;
  sampledAtWallMs: number;
}

interface TrafficDiagnosticRuntime extends TrafficDiagnosticSnapshot {
  vehicleWaitSeconds: Float32Array;
  pendingSimSeconds: number;
  lastWallSampleMs: number;
}

interface PowerDiagnosticRuntime {
  version: number;
  lastSimSeconds: number;
}

interface TrafficSystemRuntime {
  net: RoadNetwork;
  vs: VehicleStore;
  signals: SignalSystem;
}

interface PowerSystemRuntime {
  lastUpdateSimSeconds: number;
}

const MODE_DEFINITIONS: readonly OverlayModeDefinition[] = [
  { id: 'traffic-congestion', family: 'traffic', label: '交通: 混雑度', legend: '緑=余裕 / 黄=混雑 / 赤=高密度' },
  { id: 'traffic-speed', family: 'traffic', label: '交通: 速度比', legend: '赤=制限速度比が低い / 緑=流れている' },
  { id: 'traffic-volume', family: 'traffic', label: '交通: 交通量密度', legend: '車両数を車線kmあたりに正規化' },
  { id: 'traffic-wait', family: 'traffic', label: '交通: 信号待ち', legend: '現在待機中の車両の平均待ち秒数' },
  { id: 'power-supply', family: 'power', label: '電力: 給電状態', legend: '緑=給電 / 黄=制限 / 赤=停電・切断' },
  { id: 'power-load', family: 'power', label: '電力: 系統負荷', legend: '送電線・変電所の負荷率。赤は過負荷/故障' },
  { id: 'power-voltage', family: 'power', label: '電力: 電圧状態', legend: '緑=公称付近 / 黄=低下 / 赤=大幅低下' },
  { id: 'power-zone', family: 'power', label: '電力: Zone', legend: '同じ色は同一電力Zone。地下送電経路も表示' },
] as const;

const modeById = new Map<OverlayMode, OverlayModeDefinition>(MODE_DEFINITIONS.map((definition): [OverlayMode, OverlayModeDefinition] => [definition.id, definition]));
const trafficEnabledRoads = new WeakSet<RoadNetwork>();
const powerEnabledSystems = new WeakSet<PowerSystem>();
const trafficDiagnostics = new WeakMap<RoadNetwork, TrafficDiagnosticRuntime>();
const trafficSources = new WeakMap<RoadNetwork, TrafficSystemRuntime>();
const powerDiagnostics = new WeakMap<PowerSystem, PowerDiagnosticRuntime>();
const managers = new WeakMap<EnhancedRenderer, OverlayManager>();

const dummy = new THREE.Object3D();
const severityColor = new THREE.Color();
const zoneColor = new THREE.Color();
const mutedColor = new THREE.Color(0x45515e);
const goodColor = new THREE.Color(0x41b96c);
const warnColor = new THREE.Color(0xf0c74b);
const badColor = new THREE.Color(0xe24b4b);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function colorForSeverity(value: number): THREE.Color {
  const t = clamp01(value);
  if (t <= 0.5) return severityColor.copy(goodColor).lerp(warnColor, t * 2);
  return severityColor.copy(warnColor).lerp(badColor, (t - 0.5) * 2);
}

function colorForZone(zoneId: number): THREE.Color {
  if (zoneId < 0) return zoneColor.copy(mutedColor);
  return zoneColor.setHSL((zoneId * 0.173 + 0.08) % 1, 0.66, 0.53);
}

function isTrafficMode(mode: OverlayMode): boolean {
  return mode.startsWith('traffic-');
}

function isPowerMode(mode: OverlayMode): boolean {
  return mode.startsWith('power-');
}

function ensureTrafficRuntime(net: RoadNetwork, vs: VehicleStore): TrafficDiagnosticRuntime {
  const existing = trafficDiagnostics.get(net);
  if (existing && existing.vehicleWaitSeconds.length === vs.capacity && existing.vehicleCount.length === net.edges.length) return existing;
  const runtime: TrafficDiagnosticRuntime = {
    vehicleCount: new Uint32Array(net.edges.length),
    occupiedMeters: new Float32Array(net.edges.length),
    speedSum: new Float32Array(net.edges.length),
    waitSecondsSum: new Float32Array(net.edges.length),
    waitingVehicleCount: new Uint32Array(net.edges.length),
    vehicleWaitSeconds: new Float32Array(vs.capacity),
    pendingSimSeconds: 0,
    lastWallSampleMs: -Infinity,
    sampleVersion: 0,
    sampledAtWallMs: 0,
  };
  trafficDiagnostics.set(net, runtime);
  return runtime;
}

function sampleTrafficDiagnostics(runtimeData: TrafficSystemRuntime, dt: number, force = false): void {
  const { net, vs, signals } = runtimeData;
  if (!trafficEnabledRoads.has(net)) return;
  const runtime = ensureTrafficRuntime(net, vs);
  runtime.pendingSimSeconds += Math.max(0, Number.isFinite(dt) ? dt : 0);
  const now = performance.now();
  if (!force && now - runtime.lastWallSampleMs < 250) return;

  const elapsedSimSeconds = runtime.pendingSimSeconds;
  runtime.pendingSimSeconds = 0;
  runtime.lastWallSampleMs = now;
  runtime.vehicleCount.fill(0);
  runtime.occupiedMeters.fill(0);
  runtime.speedSum.fill(0);
  runtime.waitSecondsSum.fill(0);
  runtime.waitingVehicleCount.fill(0);

  for (let vehicle = 0; vehicle < vs.count; vehicle++) {
    if (vs.state[vehicle] !== VehicleState.Driving) {
      runtime.vehicleWaitSeconds[vehicle] = 0;
      continue;
    }
    const edgeId = vs.edge[vehicle];
    const edge = net.edges[edgeId];
    if (!edge) {
      runtime.vehicleWaitSeconds[vehicle] = 0;
      continue;
    }

    runtime.vehicleCount[edgeId]++;
    runtime.speedSum[edgeId] += Math.max(0, vs.speed[vehicle]);
    runtime.occupiedMeters[edgeId] += Math.max(1, vs.length[vehicle] + vs.s0[vehicle]);

    const toNode = vs.toNode[vehicle];
    const fromNode = vs.fromNode[vehicle];
    const nearIntersection = vs.segT[vehicle] >= 0.58 && net.nodes[toNode]?.hasSignal === true;
    const axis = fromNode >= 0 && toNode >= 0 ? net.axisOf(fromNode, toNode) : 0;
    const redSignal = nearIntersection && !signals.vehicleGreen(toNode, axis);
    const queueStopped = nearIntersection && vs.speed[vehicle] <= 0.8;
    const waiting = redSignal || queueStopped;
    runtime.vehicleWaitSeconds[vehicle] = waiting
      ? Math.min(3600, runtime.vehicleWaitSeconds[vehicle] + elapsedSimSeconds)
      : 0;
    if (waiting) {
      runtime.waitSecondsSum[edgeId] += runtime.vehicleWaitSeconds[vehicle];
      runtime.waitingVehicleCount[edgeId]++;
    }
  }

  runtime.sampleVersion++;
  runtime.sampledAtWallMs = now;
}

function markPowerUpdate(system: PowerSystem): void {
  if (!powerEnabledSystems.has(system)) return;
  const runtimeSystem = system as unknown as PowerSystemRuntime;
  const current = Math.max(0, Number.isFinite(runtimeSystem.lastUpdateSimSeconds) ? runtimeSystem.lastUpdateSimSeconds : 0);
  let runtime = powerDiagnostics.get(system);
  if (!runtime) {
    runtime = { version: 1, lastSimSeconds: current };
    powerDiagnostics.set(system, runtime);
  } else if (current !== runtime.lastSimSeconds) {
    runtime.lastSimSeconds = current;
    runtime.version++;
  }
}

function createMaterial(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

function setSegmentMatrix(mesh: THREE.InstancedMesh, index: number, ax: number, az: number, bx: number, bz: number, y: number, width: number, lateralOffset = 0): void {
  const dx = bx - ax, dz = bz - az;
  const length = Math.max(0.1, Math.hypot(dx, dz));
  const nx = dx / length, nz = dz / length;
  const rightX = nz, rightZ = -nx;
  dummy.position.set((ax + bx) * 0.5 + rightX * lateralOffset, y, (az + bz) * 0.5 + rightZ * lateralOffset);
  dummy.rotation.set(0, -Math.atan2(dz, dx), 0);
  dummy.scale.set(Math.max(0.1, length * 0.98), 1, Math.max(0.2, width));
  dummy.updateMatrix();
  mesh.setMatrixAt(index, dummy.matrix);
}

function setBuildingMatrix(mesh: THREE.InstancedMesh, index: number, building: Building): void {
  dummy.position.set(building.x, 0.16, building.z);
  dummy.rotation.set(0, -building.rotation, 0);
  dummy.scale.set(Math.max(1, building.width), 1, Math.max(1, building.depth));
  dummy.updateMatrix();
  mesh.setMatrixAt(index, dummy.matrix);
}

export class OverlayManager {
  private readonly group = new THREE.Group();
  private readonly trafficMaterial = createMaterial(0.58);
  private readonly buildingMaterial = createMaterial(0.34);
  private readonly powerLineMaterial = createMaterial(0.72);
  private readonly assetMaterial = createMaterial(0.88);
  private readonly trafficMesh: THREE.InstancedMesh;
  private readonly buildingMesh: THREE.InstancedMesh;
  private readonly powerLineMesh: THREE.InstancedMesh | null;
  private readonly assetMesh: THREE.InstancedMesh | null;
  private readonly powerSystem: PowerSystem | null;
  private readonly panel: HTMLDivElement;
  private readonly select: HTMLSelectElement;
  private readonly opacityInput: HTMLInputElement;
  private readonly legend: HTMLDivElement;
  private readonly summary: HTMLDivElement;
  private modeValue: OverlayMode = 'off';
  private lastNonOffMode: Exclude<OverlayMode, 'off'> = 'traffic-congestion';
  private panelOpen = false;
  private lastRefreshWallMs = -Infinity;
  private lastTrafficVersion = -1;
  private lastPowerVersion = -1;
  private lastPowerRefreshWallMs = -Infinity;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly net: RoadNetwork,
    private readonly buildings: Building[],
  ) {
    this.powerSystem = powerSystemForRoad(net);
    this.group.name = 'city-diagnostic-overlay';
    this.group.visible = false;
    this.scene.add(this.group);

    this.trafficMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.10, 1), this.trafficMaterial, net.edges.length);
    this.trafficMesh.name = 'diagnostic-traffic-roads';
    this.trafficMesh.renderOrder = 80;
    for (const edge of net.edges) {
      const from = net.nodes[edge.from], to = net.nodes[edge.to];
      if (!from || !to) continue;
      const width = Math.max(2.4, edge.lanes * 3.0);
      setSegmentMatrix(this.trafficMesh, edge.id, from.x, from.z, to.x, to.z, 0.19, width, laneOffset(edge.lanes));
      this.trafficMesh.setColorAt(edge.id, mutedColor);
    }
    this.trafficMesh.instanceMatrix.needsUpdate = true;
    if (this.trafficMesh.instanceColor) this.trafficMesh.instanceColor.needsUpdate = true;
    this.group.add(this.trafficMesh);

    this.buildingMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.12, 1), this.buildingMaterial, buildings.length);
    this.buildingMesh.name = 'diagnostic-power-buildings';
    this.buildingMesh.renderOrder = 81;
    for (let index = 0; index < buildings.length; index++) {
      setBuildingMatrix(this.buildingMesh, index, buildings[index]);
      this.buildingMesh.setColorAt(index, mutedColor);
    }
    this.buildingMesh.instanceMatrix.needsUpdate = true;
    if (this.buildingMesh.instanceColor) this.buildingMesh.instanceColor.needsUpdate = true;
    this.group.add(this.buildingMesh);

    if (this.powerSystem) {
      const lineSegments = this.powerSystem.lineSegments;
      const lineMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.08, 1), this.powerLineMaterial, lineSegments.length);
      lineMesh.name = 'diagnostic-power-underground-lines';
      lineMesh.renderOrder = 82;
      for (let index = 0; index < lineSegments.length; index++) {
        const segment = lineSegments[index];
        const from = net.nodes[segment.fromNodeId], to = net.nodes[segment.toNodeId];
        if (!from || !to) continue;
        setSegmentMatrix(lineMesh, index, from.x, from.z, to.x, to.z, 0.25, 1.6);
        lineMesh.setColorAt(index, mutedColor);
      }
      lineMesh.instanceMatrix.needsUpdate = true;
      if (lineMesh.instanceColor) lineMesh.instanceColor.needsUpdate = true;
      this.powerLineMesh = lineMesh;
      this.group.add(lineMesh);

      const assetCount = this.powerSystem.substations.length + this.powerSystem.generationFacilities.length + this.powerSystem.externalConnections.length;
      const markerMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), this.assetMaterial, assetCount);
      markerMesh.name = 'diagnostic-power-assets';
      markerMesh.renderOrder = 83;
      let index = 0;
      const addMarker = (x: number, z: number, radius: number, height: number): void => {
        dummy.position.set(x, height * 0.5 + 0.35, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(radius, height, radius);
        dummy.updateMatrix();
        markerMesh.setMatrixAt(index++, dummy.matrix);
      };
      for (const substation of this.powerSystem.substations) addMarker(substation.x, substation.z, 5.5, 5);
      for (const facility of this.powerSystem.generationFacilities) addMarker(facility.x, facility.z, 8, 8);
      for (const connection of this.powerSystem.externalConnections) addMarker(connection.x, connection.z, 7, 7);
      markerMesh.instanceMatrix.needsUpdate = true;
      this.assetMesh = markerMesh;
      this.group.add(markerMesh);
    } else {
      this.powerLineMesh = null;
      this.assetMesh = null;
    }

    const ui = this.createUi();
    this.panel = ui.panel;
    this.select = ui.select;
    this.opacityInput = ui.opacityInput;
    this.legend = ui.legend;
    this.summary = ui.summary;
    document.body.appendChild(this.panel);
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    this.setOpacity(0.58);
    this.applyModeVisibility();
  }

  get mode(): OverlayMode { return this.modeValue; }

  setMode(mode: OverlayMode): void {
    if (this.modeValue === mode) return;
    const wasTraffic = isTrafficMode(this.modeValue);
    const wasPower = isPowerMode(this.modeValue);
    this.modeValue = mode;
    if (mode !== 'off') this.lastNonOffMode = mode;
    if (wasTraffic && !isTrafficMode(mode)) trafficEnabledRoads.delete(this.net);
    if (!wasTraffic && isTrafficMode(mode)) {
      trafficEnabledRoads.add(this.net);
      const source = trafficSources.get(this.net);
      if (source) sampleTrafficDiagnostics(source, 0, true);
    }
    if (this.powerSystem) {
      if (wasPower && !isPowerMode(mode)) powerEnabledSystems.delete(this.powerSystem);
      if (!wasPower && isPowerMode(mode)) powerEnabledSystems.add(this.powerSystem);
    }
    this.lastRefreshWallMs = -Infinity;
    this.lastTrafficVersion = -1;
    this.lastPowerVersion = -1;
    this.select.value = mode;
    this.applyModeVisibility();
    this.refresh(performance.now(), true);
  }

  setOpacity(opacity: number): void {
    const normalized = THREE.MathUtils.clamp(opacity, 0.15, 0.90);
    this.opacityInput.value = String(Math.round(normalized * 100));
    this.trafficMaterial.opacity = normalized;
    this.buildingMaterial.opacity = normalized * 0.62;
    this.powerLineMaterial.opacity = Math.min(0.95, normalized * 1.08);
    this.assetMaterial.opacity = Math.min(1, normalized * 1.18);
  }

  refresh(now = performance.now(), force = false): void {
    if (this.modeValue === 'off') return;
    if (!force && now - this.lastRefreshWallMs < 250) return;
    this.lastRefreshWallMs = now;
    if (isTrafficMode(this.modeValue)) this.refreshTraffic();
    else if (isPowerMode(this.modeValue)) this.refreshPower(now, force);
  }

  private createUi(): { panel: HTMLDivElement; select: HTMLSelectElement; opacityInput: HTMLInputElement; legend: HTMLDivElement; summary: HTMLDivElement } {
    const panel = document.createElement('div');
    panel.id = 'city-diagnostic-overlay-panel';
    panel.style.cssText = 'position:fixed;right:18px;top:76px;z-index:1200;width:min(330px,calc(100vw - 36px));padding:12px 14px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(12,18,26,.90);color:#eef4fb;font:12px/1.45 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);backdrop-filter:blur(8px);display:none;';

    const title = document.createElement('div');
    title.textContent = '都市診断オーバーレイ';
    title.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:8px;';
    panel.appendChild(title);

    const select = document.createElement('select');
    select.style.cssText = 'width:100%;box-sizing:border-box;background:#182433;color:#eef4fb;border:1px solid #526477;border-radius:5px;padding:6px;';
    const off = document.createElement('option'); off.value = 'off'; off.textContent = 'OFF'; select.appendChild(off);
    for (const definition of MODE_DEFINITIONS) {
      const option = document.createElement('option');
      option.value = definition.id;
      option.textContent = definition.label;
      select.appendChild(option);
    }
    select.addEventListener('change', () => this.setMode(select.value as OverlayMode));
    panel.appendChild(select);

    const opacityRow = document.createElement('label');
    opacityRow.style.cssText = 'display:grid;grid-template-columns:auto 1fr;align-items:center;gap:10px;margin-top:10px;';
    const opacityLabel = document.createElement('span'); opacityLabel.textContent = '不透明度'; opacityRow.appendChild(opacityLabel);
    const opacityInput = document.createElement('input');
    opacityInput.type = 'range'; opacityInput.min = '15'; opacityInput.max = '90'; opacityInput.step = '5'; opacityInput.value = '58';
    opacityInput.addEventListener('input', () => this.setOpacity(Number(opacityInput.value) / 100));
    opacityRow.appendChild(opacityInput);
    panel.appendChild(opacityRow);

    const legend = document.createElement('div');
    legend.style.cssText = 'margin-top:9px;color:#c6d2df;';
    panel.appendChild(legend);
    const summary = document.createElement('div');
    summary.style.cssText = 'margin-top:6px;color:#93a7b9;font-variant-numeric:tabular-nums;';
    panel.appendChild(summary);

    const hint = document.createElement('div');
    hint.textContent = 'F9: 表示/非表示';
    hint.style.cssText = 'margin-top:9px;padding-top:7px;border-top:1px solid rgba(255,255,255,.12);color:#8295a8;';
    panel.appendChild(hint);
    return { panel, select, opacityInput, legend, summary };
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'F9') return;
    event.preventDefault();
    this.panelOpen = !this.panelOpen;
    this.panel.style.display = this.panelOpen ? 'block' : 'none';
    this.setMode(this.panelOpen ? this.lastNonOffMode : 'off');
  };

  private applyModeVisibility(): void {
    const traffic = isTrafficMode(this.modeValue);
    const power = isPowerMode(this.modeValue);
    this.group.visible = traffic || power;
    this.trafficMesh.visible = traffic;
    this.buildingMesh.visible = power && (this.modeValue === 'power-supply' || this.modeValue === 'power-voltage' || this.modeValue === 'power-zone');
    if (this.powerLineMesh) this.powerLineMesh.visible = power;
    if (this.assetMesh) this.assetMesh.visible = power;
    const definition = modeById.get(this.modeValue);
    this.legend.textContent = definition?.legend ?? 'F9で診断表示を開始';
    this.summary.textContent = this.modeValue === 'off' ? '通常描画のみ' : '更新待ち';
  }

  private refreshTraffic(): void {
    const snapshot = trafficDiagnostics.get(this.net);
    if (!snapshot) {
      this.summary.textContent = '交通Snapshotを取得中';
      return;
    }
    if (snapshot.sampleVersion === this.lastTrafficVersion) return;
    this.lastTrafficVersion = snapshot.sampleVersion;

    let activeEdges = 0, vehicles = 0, aggregate = 0;
    for (const edge of this.net.edges) {
      const count = snapshot.vehicleCount[edge.id];
      const avgSpeed = count > 0 ? snapshot.speedSum[edge.id] / count : edge.speedLimit;
      const speedRatio = edge.speedLimit > 0 ? avgSpeed / edge.speedLimit : 1;
      const occupancyRatio = snapshot.occupiedMeters[edge.id] / Math.max(1, edge.length * Math.max(1, edge.lanes));
      const laneKm = Math.max(0.02, edge.length * Math.max(1, edge.lanes) / 1000);
      const volumeDensity = count / laneKm;
      const waitingCount = snapshot.waitingVehicleCount[edge.id];
      const waitSeconds = waitingCount > 0 ? snapshot.waitSecondsSum[edge.id] / waitingCount : 0;
      let severity = 0;
      if (this.modeValue === 'traffic-congestion') severity = clamp01((occupancyRatio * 0.70 + (1 - clamp01(speedRatio)) * 0.45) / 0.75);
      else if (this.modeValue === 'traffic-speed') severity = 1 - clamp01(speedRatio);
      else if (this.modeValue === 'traffic-volume') severity = clamp01(volumeDensity / 60);
      else if (this.modeValue === 'traffic-wait') severity = clamp01(waitSeconds / 90);
      this.trafficMesh.setColorAt(edge.id, count > 0 || this.modeValue === 'traffic-speed' ? colorForSeverity(severity) : mutedColor);
      if (count > 0) {
        activeEdges++;
        vehicles += count;
        aggregate += this.modeValue === 'traffic-wait' ? waitSeconds : severity;
      }
    }
    if (this.trafficMesh.instanceColor) this.trafficMesh.instanceColor.needsUpdate = true;
    const average = activeEdges > 0 ? aggregate / activeEdges : 0;
    const ageMs = Math.max(0, performance.now() - snapshot.sampledAtWallMs);
    const metric = this.modeValue === 'traffic-wait' ? `平均待ち ${average.toFixed(1)}s` : `平均指標 ${(average * 100).toFixed(0)}%`;
    this.summary.textContent = `${metric} / 走行車 ${vehicles} / 対象Edge ${activeEdges} / age ${Math.round(ageMs)}ms`;
  }

  private refreshPower(now: number, force: boolean): void {
    const system = this.powerSystem;
    if (!system) {
      this.summary.textContent = '電力システムが無効です';
      return;
    }
    const runtime = powerDiagnostics.get(system);
    const version = runtime?.version ?? 0;
    if (!force && version === this.lastPowerVersion && now - this.lastPowerRefreshWallMs < 1000) return;
    this.lastPowerVersion = version;
    this.lastPowerRefreshWallMs = now;

    const qualitySystem = system as PowerSystem & { powerZoneElectricalSnapshots?: () => PowerZoneElectricalSnapshot[] };
    const zoneVoltage = new Map<number, number>();
    if (this.modeValue === 'power-voltage' && qualitySystem.powerZoneElectricalSnapshots) {
      for (const zone of qualitySystem.powerZoneElectricalSnapshots()) zoneVoltage.set(zone.zoneId, zone.voltagePu);
    }

    let affectedBuildings = 0;
    for (let index = 0; index < this.buildings.length; index++) {
      const building = this.buildings[index];
      const connection = system.buildingConnections.get(building.id);
      if (!connection) {
        this.buildingMesh.setColorAt(index, mutedColor);
        continue;
      }
      if (connection.state !== BuildingPowerState.Supplied) affectedBuildings++;
      if (this.modeValue === 'power-zone') this.buildingMesh.setColorAt(index, colorForZone(connection.zoneId));
      else if (this.modeValue === 'power-voltage') {
        const voltagePu = zoneVoltage.get(connection.zoneId) ?? 1;
        this.buildingMesh.setColorAt(index, colorForSeverity(clamp01((0.98 - voltagePu) / 0.18)));
      } else this.buildingMesh.setColorAt(index, colorForSeverity(1 - clamp01(connection.supplyRatio)));
    }
    if (this.buildingMesh.instanceColor) this.buildingMesh.instanceColor.needsUpdate = true;

    let overloadedLines = 0;
    if (this.powerLineMesh) {
      for (let index = 0; index < system.lineSegments.length; index++) {
        const segment = system.lineSegments[index];
        const loadRatio = segment.capacityKw > 0 ? segment.currentLoadKw / segment.capacityKw : 0;
        const failed = segment.state === PowerLineState.Broken || segment.overload;
        if (failed) overloadedLines++;
        const color = this.modeValue === 'power-zone'
          ? colorForZone(segment.zoneId)
          : this.modeValue === 'power-voltage'
            ? colorForSeverity(clamp01((0.98 - (zoneVoltage.get(segment.zoneId) ?? 1)) / 0.18))
            : failed ? badColor : colorForSeverity(clamp01(loadRatio / 1.05));
        this.powerLineMesh.setColorAt(index, color);
      }
      if (this.powerLineMesh.instanceColor) this.powerLineMesh.instanceColor.needsUpdate = true;
    }

    let overloadedAssets = 0;
    if (this.assetMesh) {
      let index = 0;
      for (const substation of system.substations) {
        const failed = substation.state !== PowerAssetState.Online || substation.overload;
        if (failed) overloadedAssets++;
        const color = this.modeValue === 'power-zone' ? colorForZone(substation.zoneId)
          : this.modeValue === 'power-voltage' ? colorForSeverity(clamp01((0.98 - (zoneVoltage.get(substation.zoneId) ?? 1)) / 0.18))
            : failed ? badColor : colorForSeverity(clamp01(substation.utilization));
        this.assetMesh.setColorAt(index++, color);
      }
      for (const facility of system.generationFacilities) {
        const failed = facility.state !== PowerAssetState.Online;
        if (failed) overloadedAssets++;
        const color = this.modeValue === 'power-zone' ? colorForZone(facility.zoneId)
          : this.modeValue === 'power-voltage' ? colorForSeverity(clamp01((0.98 - (zoneVoltage.get(facility.zoneId) ?? 1)) / 0.18))
            : failed ? badColor : goodColor;
        this.assetMesh.setColorAt(index++, color);
      }
      for (const connection of system.externalConnections) {
        const failed = connection.state !== PowerAssetState.Online;
        if (failed) overloadedAssets++;
        const color = this.modeValue === 'power-zone' ? colorForZone(connection.zoneId)
          : this.modeValue === 'power-voltage' ? colorForSeverity(clamp01((0.98 - (zoneVoltage.get(connection.zoneId) ?? 1)) / 0.18))
            : failed ? badColor : goodColor;
        this.assetMesh.setColorAt(index++, color);
      }
      if (this.assetMesh.instanceColor) this.assetMesh.instanceColor.needsUpdate = true;
    }

    const generationMw = system.generationFacilities.reduce((sum, facility) => sum + facility.currentOutputKw, 0) / 1000;
    const importMw = system.externalConnections.reduce((sum, connection) => sum + connection.currentImportKw, 0) / 1000;
    const voltageValues = [...zoneVoltage.values()];
    const voltageText = voltageValues.length > 0
      ? ` / 平均電圧 ${(voltageValues.reduce((sum, value) => sum + value, 0) / voltageValues.length).toFixed(3)}pu`
      : '';
    this.summary.textContent = `給電異常 建物${affectedBuildings} / 系統異常 ${overloadedLines} / 設備異常 ${overloadedAssets} / 発電 ${generationMw.toFixed(1)}MW / 受電 ${importMw.toFixed(1)}MW${voltageText}`;
  }
}

const trafficProto = TrafficSystem.prototype as unknown as Record<string, unknown>;
if (!trafficProto.__citySimDiagnosticOverlayTrafficV112) {
  const previousUpdate = trafficProto.update as (this: TrafficSystem, dt: number) => void;
  trafficProto.update = function patchedTrafficDiagnosticUpdate(this: TrafficSystem, dt: number): void {
    previousUpdate.call(this, dt);
    const runtime = this as unknown as TrafficSystemRuntime;
    if (!trafficSources.has(runtime.net)) trafficSources.set(runtime.net, runtime);
    sampleTrafficDiagnostics(runtime, dt);
  };
  trafficProto.__citySimDiagnosticOverlayTrafficV112 = true;
}

const powerProto = PowerSystem.prototype as unknown as Record<string, unknown>;
if (!powerProto.__citySimDiagnosticOverlayPowerV112) {
  const previousUpdate = powerProto.update as (this: PowerSystem, dtSec: number, totalSimSeconds: number, force?: boolean) => void;
  powerProto.update = function patchedPowerDiagnosticUpdate(this: PowerSystem, dtSec: number, totalSimSeconds: number, force?: boolean): void {
    previousUpdate.call(this, dtSec, totalSimSeconds, force);
    markPowerUpdate(this);
  };
  powerProto.__citySimDiagnosticOverlayPowerV112 = true;
}

const enhancedProto = EnhancedRenderer.prototype as unknown as Record<string, unknown>;
if (!enhancedProto.__citySimDiagnosticOverlayRendererV112) {
  const previousBuildStatic = enhancedProto.buildStatic as EnhancedRenderer['buildStatic'];
  const previousSyncVehicles = enhancedProto.syncVehicles as EnhancedRenderer['syncVehicles'];
  enhancedProto.buildStatic = function patchedDiagnosticBuildStatic(this: EnhancedRenderer, ...args: Parameters<EnhancedRenderer['buildStatic']>): void {
    previousBuildStatic.apply(this, args);
    const internals = this as unknown as Record<string, unknown>;
    const scene = internals.sceneRef as THREE.Scene | undefined;
    if (!scene || managers.has(this)) return;
    managers.set(this, new OverlayManager(scene, args[1], args[0]));
  };
  enhancedProto.syncVehicles = function patchedDiagnosticSyncVehicles(this: EnhancedRenderer, ...args: Parameters<EnhancedRenderer['syncVehicles']>): void {
    previousSyncVehicles.apply(this, args);
    managers.get(this)?.refresh();
  };
  enhancedProto.__citySimDiagnosticOverlayRendererV112 = true;
}
