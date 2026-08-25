import * as THREE from 'three';
import { EnhancedRenderer } from './EnhancedRenderer';
import { InstancedRenderer } from './InstancedRenderer';
import { RailRenderer } from './RailRenderer';

type RenderCategory = 'ground' | 'roads' | 'buildings' | 'rail' | 'vehicles' | 'agents';
type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

interface RenderState {
  ground: boolean;
  roads: boolean;
  buildings: boolean;
  rail: boolean;
  vehicles: boolean;
  agents: boolean;
}

interface PendingCapture {
  category: RenderCategory;
  before: Set<THREE.Object3D>;
}

interface SceneContext {
  roots: Map<RenderCategory, THREE.Group>;
  state: RenderState;
  pending: PendingCapture | null;
  panel: HTMLDivElement | null;
}

const STORAGE_KEY = 'city-sim-render-filter-v1';
const ROOT_FLAG = '__citySimRenderFilterRoot';
const contexts = new WeakMap<THREE.Scene, SceneContext>();
const categories: RenderCategory[] = ['ground', 'roads', 'buildings', 'rail', 'vehicles', 'agents'];
const labels: Record<RenderCategory, string> = {
  ground: '地面',
  roads: '道路・信号・バス停',
  buildings: '建物・公園・施設',
  rail: '鉄道',
  vehicles: '道路車両',
  agents: '歩行者',
};

function defaultState(): RenderState {
  return { ground: true, roads: true, buildings: true, rail: true, vehicles: true, agents: true };
}

function loadState(): RenderState {
  const state = defaultState();
  if (typeof localStorage === 'undefined') return state;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return state;
    const parsed = JSON.parse(raw) as Partial<RenderState>;
    for (const key of categories) if (typeof parsed[key] === 'boolean') state[key] = parsed[key] as boolean;
  } catch {
    // Ignore stale or malformed debug state.
  }
  return state;
}

function saveState(state: RenderState): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage can be disabled */ }
}

function contextFor(scene: THREE.Scene): SceneContext {
  let ctx = contexts.get(scene);
  if (ctx) return ctx;
  ctx = { roots: new Map(), state: loadState(), pending: null, panel: null };
  contexts.set(scene, ctx);
  return ctx;
}

function ensureRoot(scene: THREE.Scene, category: RenderCategory): THREE.Group {
  const ctx = contextFor(scene);
  let root = ctx.roots.get(category);
  if (root) return root;
  root = new THREE.Group();
  root.name = `render-filter:${category}`;
  root.userData[ROOT_FLAG] = true;
  root.visible = ctx.state[category];
  scene.add(root);
  ctx.roots.set(category, root);
  return root;
}

function moveDirectChildren(scene: THREE.Scene, category: RenderCategory, before: Set<THREE.Object3D>): void {
  const root = ensureRoot(scene, category);
  for (const child of [...scene.children]) {
    if (before.has(child) || child === root || child.userData[ROOT_FLAG]) continue;
    root.add(child);
  }
}

function captureAdded<T>(scene: THREE.Scene, category: RenderCategory, run: () => T): T {
  const before = new Set(scene.children);
  try {
    return run();
  } finally {
    moveDirectChildren(scene, category, before);
  }
}

function startPending(scene: THREE.Scene, category: RenderCategory): void {
  flushPending(scene);
  contextFor(scene).pending = { category, before: new Set(scene.children) };
}

function flushPending(scene: THREE.Scene): void {
  const ctx = contextFor(scene);
  const pending = ctx.pending;
  if (!pending) return;
  ctx.pending = null;
  moveDirectChildren(scene, pending.category, pending.before);
}

function sceneOf(host: AnyHost): THREE.Scene | null {
  const scene = host.sceneRef ?? host.scene;
  return scene instanceof THREE.Scene ? scene : null;
}

function isVisible(scene: THREE.Scene, category: RenderCategory): boolean {
  return contextFor(scene).state[category];
}

function applyState(scene: THREE.Scene, patch: Partial<RenderState>): void {
  const ctx = contextFor(scene);
  Object.assign(ctx.state, patch);
  for (const category of categories) ensureRoot(scene, category).visible = ctx.state[category];
  saveState(ctx.state);
  refreshPanel(scene);
}

function preset(name: 'all' | 'rail' | 'roads' | 'rail-roads'): Partial<RenderState> {
  if (name === 'rail') return { ground: true, roads: false, buildings: false, rail: true, vehicles: false, agents: false };
  if (name === 'roads') return { ground: true, roads: true, buildings: false, rail: false, vehicles: false, agents: false };
  if (name === 'rail-roads') return { ground: true, roads: true, buildings: false, rail: true, vehicles: false, agents: false };
  return defaultState();
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = text;
  el.type = 'button';
  el.style.cssText = 'border:1px solid #50657c;background:#18232f;color:#e6eef7;border-radius:5px;padding:4px 7px;font:11px ui-monospace,monospace;cursor:pointer';
  el.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
  return el;
}

function ensurePanel(scene: THREE.Scene): void {
  if (typeof document === 'undefined') return;
  const ctx = contextFor(scene);
  if (ctx.panel) return;

  const panel = document.createElement('div');
  panel.dataset.renderFilter = 'true';
  panel.style.cssText = [
    'position:fixed', 'right:12px', 'top:58px', 'z-index:28', 'width:248px',
    'padding:9px 10px', 'background:rgba(8,13,19,.92)', 'border:1px solid #43566b',
    'border-radius:8px', 'color:#dce8f5', 'font:11px/1.4 ui-monospace,monospace',
    'box-shadow:0 6px 22px rgba(0,0,0,.38)', 'user-select:none',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = '描画フィルター  [F9]';
  title.style.cssText = 'font-weight:700;font-size:12px;margin-bottom:6px;color:#f0f6ff';
  panel.appendChild(title);

  const note = document.createElement('div');
  note.textContent = '描画だけOFF。シミュレーションは継続します';
  note.style.cssText = 'opacity:.66;margin-bottom:7px';
  panel.appendChild(note);

  const presets = document.createElement('div');
  presets.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:7px';
  presets.append(
    button('全表示', () => applyState(scene, preset('all'))),
    button('鉄道のみ', () => applyState(scene, preset('rail'))),
    button('道路のみ', () => applyState(scene, preset('roads'))),
    button('鉄道+道路', () => applyState(scene, preset('rail-roads'))),
  );
  panel.appendChild(presets);

  for (const category of categories) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:7px;padding:2px 1px;cursor:pointer';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.category = category;
    check.checked = ctx.state[category];
    check.addEventListener('change', () => applyState(scene, { [category]: check.checked } as Partial<RenderState>));
    const text = document.createElement('span');
    text.textContent = labels[category];
    row.append(check, text);
    panel.appendChild(row);
  }

  document.body.appendChild(panel);
  ctx.panel = panel;
  refreshPanel(scene);

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'F9') return;
    event.preventDefault();
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
}

function refreshPanel(scene: THREE.Scene): void {
  const ctx = contextFor(scene);
  if (!ctx.panel) return;
  for (const input of ctx.panel.querySelectorAll<HTMLInputElement>('input[data-category]')) {
    const category = input.dataset.category as RenderCategory | undefined;
    if (category && categories.includes(category)) input.checked = ctx.state[category];
  }
}

function claimEnhancedLightPools(scene: THREE.Scene): void {
  const roadRoot = ensureRoot(scene, 'roads');
  const vehicleRoot = ensureRoot(scene, 'vehicles');
  const headlightTargets = new Set<THREE.Object3D>();
  for (const child of [...scene.children]) {
    if (child instanceof THREE.PointLight && child.distance > 27 && child.distance < 29 && child.color.getHex() === 0xffd58a) {
      roadRoot.add(child);
    } else if (child instanceof THREE.SpotLight && child.distance > 61 && child.distance < 63 && child.color.getHex() === 0xffefc7) {
      headlightTargets.add(child.target);
      vehicleRoot.add(child);
    }
  }
  for (const target of headlightTargets) if (target.parent === scene) vehicleRoot.add(target);
}

function wrapCapture(proto: AnyHost, name: string, category: RenderCategory, before?: (scene: THREE.Scene) => void, after?: (scene: THREE.Scene) => void): void {
  const previous = proto[name] as AnyMethod | undefined;
  if (typeof previous !== 'function' || (previous as AnyHost).__renderFilterWrapped) return;
  const wrapped = function (this: AnyHost, ...args: any[]): any {
    const scene = sceneOf(this);
    if (!scene) return previous.apply(this, args);
    before?.(scene);
    const result = captureAdded(scene, category, () => previous.apply(this, args));
    after?.(scene);
    return result;
  };
  (wrapped as AnyHost).__renderFilterWrapped = true;
  proto[name] = wrapped;
}

function wrapVisibilitySkip(proto: AnyHost, name: string, category: RenderCategory): void {
  const previous = proto[name] as AnyMethod | undefined;
  if (typeof previous !== 'function' || (previous as AnyHost).__renderFilterVisibilityWrapped) return;
  const wrapped = function (this: AnyHost, ...args: any[]): any {
    const scene = sceneOf(this);
    if (scene && !isVisible(scene, category)) return undefined;
    return previous.apply(this, args);
  };
  (wrapped as AnyHost).__renderFilterVisibilityWrapped = true;
  proto[name] = wrapped;
}

function install(): void {
  const enhanced = EnhancedRenderer.prototype as unknown as AnyHost;
  if (enhanced.__citySimRenderFilterV038) return;
  enhanced.__citySimRenderFilterV038 = true;

  const base = InstancedRenderer.prototype as unknown as AnyHost;
  for (const name of ['buildGround']) wrapCapture(base, name, 'ground');
  for (const name of ['buildRoads', 'buildCenterLines', 'buildSidewalks', 'buildParking', 'buildSignals', 'buildCrosswalks', 'buildStopLines', 'buildBusStops', 'buildGates']) {
    wrapCapture(base, name, 'roads');
  }
  wrapCapture(base, 'buildBuildings', 'buildings');
  wrapCapture(base, 'buildAgents', 'agents');
  wrapCapture(base, 'buildVehicles', 'vehicles');

  for (const name of ['buildBuildingLod']) wrapCapture(enhanced, name, 'buildings');
  for (const name of ['buildRoadDetails', 'prepareParkingMarkings', 'prepareStreetFurniture']) wrapCapture(enhanced, name, 'roads');
  wrapCapture(enhanced, 'buildAgents', 'agents', (scene) => flushPending(scene));
  wrapCapture(enhanced, 'buildVehicles', 'vehicles');

  const enhancedBuildStatic = enhanced.buildStatic as AnyMethod | undefined;
  if (typeof enhancedBuildStatic === 'function') {
    enhanced.buildStatic = function filteredBuildStatic(this: AnyHost, ...args: any[]): any {
      const scene = sceneOf(this);
      if (!scene) return enhancedBuildStatic.apply(this, args);
      claimEnhancedLightPools(scene);
      const result = enhancedBuildStatic.apply(this, args);
      // The standalone special-facility/park renderer is called immediately after buildStatic().
      startPending(scene, 'buildings');
      return result;
    };
  }

  wrapVisibilitySkip(enhanced, 'syncAgents', 'agents');
  wrapVisibilitySkip(enhanced, 'syncVehicles', 'vehicles');
  wrapVisibilitySkip(enhanced, 'syncSignals', 'roads');

  const enhancedUpdateLod = enhanced.updateLod as AnyMethod | undefined;
  if (typeof enhancedUpdateLod === 'function') {
    enhanced.updateLod = function filteredUpdateLod(this: AnyHost, ...args: any[]): any {
      const scene = sceneOf(this);
      if (scene) {
        flushPending(scene);
        ensurePanel(scene);
      }
      return enhancedUpdateLod.apply(this, args);
    };
  }

  const rail = RailRenderer.prototype as unknown as AnyHost;
  const railBuild = rail.build as AnyMethod | undefined;
  if (typeof railBuild === 'function') {
    rail.build = function filteredRailBuild(this: AnyHost, ...args: any[]): any {
      const scene = sceneOf(this);
      if (!scene) return railBuild.apply(this, args);
      // Flush standalone station-area scenery generated between gfx.buildStatic() and rail.build().
      flushPending(scene);
      const result = captureAdded(scene, 'rail', () => railBuild.apply(this, args));
      // TrainLiveryOverlay is constructed immediately after rail.build().
      startPending(scene, 'rail');
      return result;
    };
  }

  const railUpdate = rail.update as AnyMethod | undefined;
  if (typeof railUpdate === 'function') {
    rail.update = function filteredRailUpdate(this: AnyHost, ...args: any[]): any {
      const scene = sceneOf(this);
      if (!scene) return railUpdate.apply(this, args);
      return captureAdded(scene, 'rail', () => railUpdate.apply(this, args));
    };
  }

  // buildAlignedBusStops() is standalone and runs between buildStopLines() and buildGates().
  const baseStopLines = base.buildStopLines as AnyMethod | undefined;
  if (typeof baseStopLines === 'function' && !(baseStopLines as AnyHost).__renderFilterBusStopPending) {
    const previous = baseStopLines;
    const wrapped = function (this: AnyHost, ...args: any[]): any {
      const scene = sceneOf(this);
      const result = previous.apply(this, args);
      if (scene) startPending(scene, 'roads');
      return result;
    };
    (wrapped as AnyHost).__renderFilterBusStopPending = true;
    base.buildStopLines = wrapped;
  }

  const baseGates = base.buildGates as AnyMethod | undefined;
  if (typeof baseGates === 'function' && !(baseGates as AnyHost).__renderFilterGateFlush) {
    const previous = baseGates;
    const wrapped = function (this: AnyHost, ...args: any[]): any {
      const scene = sceneOf(this);
      if (scene) flushPending(scene);
      return previous.apply(this, args);
    };
    (wrapped as AnyHost).__renderFilterGateFlush = true;
    base.buildGates = wrapped;
  }
}

install();
