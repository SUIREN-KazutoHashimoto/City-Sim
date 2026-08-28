import * as THREE from 'three';
import { AStar } from '../traffic/AStar';
import type { Building } from '../generation/CityGenerator';
import type { RoadNetwork } from '../traffic/RoadNetwork';
import type { World } from '../world/World';
import { EnhancedRenderer } from './EnhancedRenderer';
import type { OverlayManager } from './CityDiagnosticOverlay';

export type ExtendedOverlayMode =
  | 'transit-load' | 'transit-coverage'
  | 'population-density' | 'population-daynight'
  | 'employment-staffing' | 'employment-commute'
  | 'landuse-category' | 'landuse-utilization'
  | 'logistics-supply' | 'logistics-fleet'
  | 'access-station' | 'access-work' | 'access-commercial' | 'access-public'
  | 'developer-diagnostics';
export type AnyMode = ExtendedOverlayMode | string;
export type AccessKind = 'transit' | 'station' | 'work' | 'commercial' | 'public';

export interface ExtendedModeDefinition { id: ExtendedOverlayMode; group: string; label: string; legend: string; }
export interface OverlayInternals {
  group: THREE.Group; net: RoadNetwork; buildings: Building[];
  trafficMesh: THREE.InstancedMesh; buildingMesh: THREE.InstancedMesh;
  powerLineMesh: THREE.InstancedMesh | null; assetMesh: THREE.InstancedMesh | null;
  legend: HTMLDivElement; summary: HTMLDivElement; modeValue: AnyMode;
}
export interface BuildingChunkRuntime { cx: number; cz: number; ids: number[]; lod: 0 | 1 | 2 | 3; }
export interface RendererInternals { buildingChunks: BuildingChunkRuntime[]; }
export interface RouteSegment {
  kind: 'bus' | 'rail'; routeId: number; ax: number; az: number; bx: number; bz: number; y: number; width: number;
}
export interface ExpansionState {
  manager: OverlayManager; world: World | null; renderer: EnhancedRenderer | null;
  gridMesh: THREE.InstancedMesh; routeMesh: THREE.InstancedMesh; markerMesh: THREE.InstancedMesh;
  coverageMesh: THREE.InstancedMesh; flowMesh: THREE.InstancedMesh; chunkMesh: THREE.InstancedMesh;
  routeSegments: RouteSegment[]; chunks: BuildingChunkRuntime[];
  gridCols: number; gridRows: number; gridCellSize: number;
  homeCellCounts: Uint32Array | null; buildingSidewalkNodes: Int32Array | null;
  accessCache: Map<AccessKind, Float64Array>; lastRefreshAt: number; refreshCostEmaMs: number;
  opacity: number; transitCoverageRatio: number | null;
}

export const EXTENDED_MODES: readonly ExtendedModeDefinition[] = [
  { id: 'transit-load', group: '公共交通', label: '公共交通: 利用・混雑', legend: '路線=混雑率 / 停留所・駅=待ち人数。緑→黄→赤ほど混雑' },
  { id: 'transit-coverage', group: '公共交通', label: '公共交通: 徒歩圏', legend: 'バス停約350m・駅約850mの徒歩圏。路線も同時表示' },
  { id: 'population-density', group: '人口', label: '人口: 現在密度', legend: '500mグリッドの現在人口。青→黄→赤ほど集中' },
  { id: 'population-daynight', group: '人口', label: '人口: 昼夜差', legend: '青=居住人口より少ない / 灰=同程度 / 赤=現在人口が多い' },
  { id: 'employment-staffing', group: '雇用', label: '雇用: 充足・出勤', legend: '職場の定員充足・現在出勤・ライフライン人員不足を統合。赤ほど不足' },
  { id: 'employment-commute', group: '雇用', label: '雇用: 通勤流動', legend: '現在の通勤者から目的地への流動。徒歩=緑 / 車=橙 / バス=青 / 鉄道=紫' },
  { id: 'landuse-category', group: '土地利用', label: '土地利用: 用途', legend: '住宅・業務・商業・公共・産業/物流・余暇・インフラを用途別に着色' },
  { id: 'landuse-utilization', group: '土地利用', label: '建物: POI利用率', legend: '青=低利用 / 黄=高利用。職場は実出勤、その他はPOI占有率' },
  { id: 'logistics-supply', group: '物流', label: '物流: 在庫・供給網', legend: '生産段階・店舗在庫・発電燃料を可視化。赤ほど不足またはボトルネック' },
  { id: 'logistics-fleet', group: '物流', label: '物流: トラック・道路負荷', legend: 'トラック位置と物流車が集中する道路。赤ほど停滞・集中' },
  { id: 'access-station', group: 'アクセシビリティ', label: '到達性: 駅', legend: '歩道ネットワーク上の最寄駅までの徒歩時間。緑=近い / 赤=遠い' },
  { id: 'access-work', group: 'アクセシビリティ', label: '到達性: 職場', legend: '歩道ネットワーク上の最寄職場までの徒歩時間' },
  { id: 'access-commercial', group: 'アクセシビリティ', label: '到達性: 商業', legend: '歩道ネットワーク上の最寄商業POIまでの徒歩時間' },
  { id: 'access-public', group: 'アクセシビリティ', label: '到達性: 公共施設', legend: '歩道ネットワーク上の最寄公共施設までの徒歩時間' },
  { id: 'developer-diagnostics', group: '開発者診断', label: '開発者: LOD・負荷', legend: '500m密度 + LODチャンク境界。概要にPathfinding/Simulation/Render負荷を表示' },
] as const;
export const extendedById = new Map<string, ExtendedModeDefinition>(EXTENDED_MODES.map((item) => [item.id, item]));

export const muted = new THREE.Color(0x526477), good = new THREE.Color(0x42c778), warn = new THREE.Color(0xf1c84c), bad = new THREE.Color(0xef5350);
export const cool = new THREE.Color(0x3f78c5), hot = new THREE.Color(0xf05b48), neutral = new THREE.Color(0x7c8792);
const severityScratch = new THREE.Color(), gradientScratch = new THREE.Color(), routeScratch = new THREE.Color();
export const matrixDummy = new THREE.Object3D();

export function clamp01(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
export function severityColor(value: number): THREE.Color {
  const t = clamp01(value); return t <= 0.5 ? severityScratch.copy(good).lerp(warn, t * 2) : severityScratch.copy(warn).lerp(bad, (t - 0.5) * 2);
}
export function densityColor(value: number): THREE.Color {
  const t = clamp01(value); return t <= 0.5 ? gradientScratch.copy(cool).lerp(warn, t * 2) : gradientScratch.copy(warn).lerp(hot, (t - 0.5) * 2);
}
export function divergingColor(value: number): THREE.Color {
  const t = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  return t < 0 ? gradientScratch.copy(neutral).lerp(cool, -t) : gradientScratch.copy(neutral).lerp(hot, t);
}
export function routeColor(id: number, kind: 'bus' | 'rail'): THREE.Color {
  return routeScratch.setHSL(((id * 0.173 + (kind === 'rail' ? 0.70 : 0.34)) % 1 + 1) % 1, 0.68, 0.55);
}
export function extendedMode(mode: AnyMode): mode is ExtendedOverlayMode { return extendedById.has(mode); }

function material(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: false, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
}
function createMesh(geometry: THREE.BufferGeometry, capacity: number, opacity: number, name: string, order: number): THREE.InstancedMesh {
  const count = Math.max(1, capacity), mesh = new THREE.InstancedMesh(geometry, material(opacity), count);
  mesh.name = name; mesh.count = 0; mesh.renderOrder = order; mesh.frustumCulled = false;
  for (let i = 0; i < count; i++) mesh.setColorAt(i, muted);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}
export function setSegment(mesh: THREE.InstancedMesh, index: number, ax: number, az: number, bx: number, bz: number, y: number, width: number): void {
  const dx = bx - ax, dz = bz - az, length = Math.max(0.1, Math.hypot(dx, dz));
  matrixDummy.position.set((ax + bx) * 0.5, y, (az + bz) * 0.5); matrixDummy.rotation.set(0, -Math.atan2(dz, dx), 0); matrixDummy.scale.set(length, 1, Math.max(0.3, width)); matrixDummy.updateMatrix();
  mesh.setMatrixAt(index, matrixDummy.matrix);
}
export function setMarker(mesh: THREE.InstancedMesh, index: number, x: number, z: number, radius: number, height: number, color: THREE.Color, y = 0.35): void {
  matrixDummy.position.set(x, y + height * 0.5, z); matrixDummy.rotation.set(0, 0, 0); matrixDummy.scale.set(radius, height, radius); matrixDummy.updateMatrix(); mesh.setMatrixAt(index, matrixDummy.matrix); mesh.setColorAt(index, color);
}
export function setCoverage(mesh: THREE.InstancedMesh, index: number, x: number, z: number, radius: number, color: THREE.Color): void {
  matrixDummy.position.set(x, 0.13, z); matrixDummy.rotation.set(0, 0, 0); matrixDummy.scale.set(radius, 1, radius); matrixDummy.updateMatrix(); mesh.setMatrixAt(index, matrixDummy.matrix); mesh.setColorAt(index, color);
}
export function updateMesh(mesh: THREE.InstancedMesh): void { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
export function gridIndex(state: ExpansionState, x: number, z: number): number {
  const gx = Math.max(0, Math.min(state.gridCols - 1, Math.floor(x / state.gridCellSize))), gz = Math.max(0, Math.min(state.gridRows - 1, Math.floor(z / state.gridCellSize)));
  return gz * state.gridCols + gx;
}

function buildRoutes(world: World): RouteSegment[] {
  const out: RouteSegment[] = [], astar = new AStar(world.city.net, 'drive', 0);
  for (const route of world.bus.routes) for (let i = 0; i + 1 < route.stopSeq.length; i++) {
    const a = world.bus.stops[route.stopSeq[i]], b = world.bus.stops[route.stopSeq[i + 1]]; if (!a || !b) continue;
    const path = astar.findPath(a.node, b.node);
    if (path.length >= 2) for (let p = 0; p + 1 < path.length; p++) { const from = world.city.net.nodes[path[p]], to = world.city.net.nodes[path[p + 1]]; if (from && to) out.push({ kind: 'bus', routeId: route.id, ax: from.x, az: from.z, bx: to.x, bz: to.z, y: 0.34, width: 2.1 }); }
    else out.push({ kind: 'bus', routeId: route.id, ax: a.x, az: a.z, bx: b.x, bz: b.z, y: 0.34, width: 2.1 });
  }
  for (const line of world.city.planning.rail.lines) for (let i = 0; i + 1 < line.path.length; i++) { const a = line.path[i], b = line.path[i + 1]; if (Math.hypot(b.x - a.x, b.z - a.z) >= 0.5) out.push({ kind: 'rail', routeId: line.id, ax: a.x, az: a.z, bx: b.x, bz: b.z, y: 9.4, width: 2.6 }); }
  return out;
}

export function createExpansionState(manager: OverlayManager, world: World | null, renderer: EnhancedRenderer | null): ExpansionState {
  const internals = manager as unknown as OverlayInternals; let fallbackSize = 1000;
  if (!world) for (const node of internals.net.nodes) fallbackSize = Math.max(fallbackSize, node.x, node.z);
  const size = world?.city.sizeMeters ?? fallbackSize, gridCellSize = EnhancedRenderer.CHUNK_SIZE;
  const gridCols = Math.max(1, Math.ceil(size / gridCellSize)), gridRows = Math.max(1, Math.ceil(size / gridCellSize)), gridCount = gridCols * gridRows;
  const routes = world ? buildRoutes(world) : [], chunks = renderer ? ((renderer as unknown as RendererInternals).buildingChunks ?? []) : [];
  const markerCapacity = Math.max(1, world?.vehicles.capacity ?? 1, (world?.bus.stops.length ?? 0) + (world?.city.planning.rail.stations.length ?? 0) + 64);
  const gridMesh = createMesh(new THREE.BoxGeometry(1, 0.08, 1), gridCount, 0.30, 'diagnostic-grid-heatmap', 88);
  for (let gz = 0; gz < gridRows; gz++) for (let gx = 0; gx < gridCols; gx++) { const i = gz * gridCols + gx; matrixDummy.position.set((gx + 0.5) * gridCellSize, 0.16, (gz + 0.5) * gridCellSize); matrixDummy.rotation.set(0, 0, 0); matrixDummy.scale.set(gridCellSize - 5, 1, gridCellSize - 5); matrixDummy.updateMatrix(); gridMesh.setMatrixAt(i, matrixDummy.matrix); }
  gridMesh.count = gridCount; updateMesh(gridMesh);
  const routeMesh = createMesh(new THREE.BoxGeometry(1, 0.10, 1), routes.length, 0.78, 'diagnostic-transit-routes', 91);
  routes.forEach((s, i) => { setSegment(routeMesh, i, s.ax, s.az, s.bx, s.bz, s.y, s.width); routeMesh.setColorAt(i, routeColor(s.routeId, s.kind)); }); routeMesh.count = routes.length; updateMesh(routeMesh);
  const markerMesh = createMesh(new THREE.CylinderGeometry(1, 1, 1, 8), markerCapacity, 0.88, 'diagnostic-dynamic-markers', 94);
  const coverageMesh = createMesh(new THREE.CylinderGeometry(1, 1, 0.06, 28), Math.max(1, (world?.bus.stops.length ?? 0) + (world?.city.planning.rail.stations.length ?? 0)), 0.13, 'diagnostic-transit-coverage', 87);
  const flowMesh = createMesh(new THREE.BoxGeometry(1, 0.10, 1), 1800, 0.68, 'diagnostic-flow-lines', 93);
  const chunkMesh = createMesh(new THREE.BoxGeometry(1, 0.12, 1), Math.max(1, chunks.length * 4), 0.78, 'diagnostic-lod-chunks', 95);
  chunks.forEach((c, i) => { const h = gridCellSize * 0.5, b = i * 4; setSegment(chunkMesh, b, c.cx-h,c.cz-h,c.cx+h,c.cz-h,0.52,2.8); setSegment(chunkMesh,b+1,c.cx+h,c.cz-h,c.cx+h,c.cz+h,0.52,2.8); setSegment(chunkMesh,b+2,c.cx+h,c.cz+h,c.cx-h,c.cz+h,0.52,2.8); setSegment(chunkMesh,b+3,c.cx-h,c.cz+h,c.cx-h,c.cz-h,0.52,2.8); }); chunkMesh.count = chunks.length * 4; updateMesh(chunkMesh);
  for (const mesh of [gridMesh, routeMesh, markerMesh, coverageMesh, flowMesh, chunkMesh]) { mesh.visible = false; internals.group.add(mesh); }
  return { manager, world, renderer, gridMesh, routeMesh, markerMesh, coverageMesh, flowMesh, chunkMesh, routeSegments: routes, chunks, gridCols, gridRows, gridCellSize, homeCellCounts: null, buildingSidewalkNodes: null, accessCache: new Map(), lastRefreshAt: -Infinity, refreshCostEmaMs: 0, opacity: 0.58, transitCoverageRatio: null };
}

export function appendExtendedOptions(select: HTMLSelectElement): void {
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const d of EXTENDED_MODES) { let g = groups.get(d.group); if (!g) { g = document.createElement('optgroup'); g.label = d.group; groups.set(d.group, g); select.appendChild(g); } const o = document.createElement('option'); o.value = d.id; o.textContent = d.label; g.appendChild(o); }
}
export function setExpansionOpacity(state: ExpansionState, opacity: number): void {
  state.opacity = clamp01(opacity); const mat = (m: THREE.InstancedMesh) => m.material as THREE.MeshBasicMaterial;
  mat(state.gridMesh).opacity = Math.max(0.12, state.opacity * 0.52); mat(state.routeMesh).opacity = Math.max(0.26, Math.min(0.95, state.opacity * 1.15)); mat(state.markerMesh).opacity = Math.max(0.34, Math.min(1, state.opacity * 1.28)); mat(state.coverageMesh).opacity = Math.max(0.06, state.opacity * 0.22); mat(state.flowMesh).opacity = Math.max(0.22, state.opacity * 0.92); mat(state.chunkMesh).opacity = Math.max(0.30, Math.min(1, state.opacity * 1.18));
}
