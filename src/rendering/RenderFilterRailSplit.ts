import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';
import { TrainLiveryOverlay } from './TrainLiveryOverlay';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

type RailRuntime = Record<string, unknown>;
type LiveryRuntime = Record<string, unknown>;
type HighSpeedRuntime = Record<string, unknown>;

const STORAGE_KEY = 'city-sim-render-filter-trains-v1';
const ROOT_FLAG = '__citySimRenderFilterRoot';
const TRAIN_ROOT_NAME = 'render-filter:trains';
const scenes = new Set<THREE.Scene>();
const rails = new Set<RailRenderer>();
const overlays = new Set<TrainLiveryOverlay>();
let trainVisible = loadTrainVisible();

function loadTrainVisible(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw == null ? true : raw !== 'false';
  } catch {
    return true;
  }
}

function saveTrainVisible(): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, String(trainVisible)); } catch { /* storage may be disabled */ }
}

function sceneOfRail(rail: RailRenderer): THREE.Scene | null {
  const value = (rail as unknown as { scene?: unknown }).scene;
  return value instanceof THREE.Scene ? value : null;
}

function sceneOfOverlay(overlay: TrainLiveryOverlay): THREE.Scene | null {
  const value = (overlay as unknown as { scene?: unknown }).scene;
  return value instanceof THREE.Scene ? value : null;
}

function trainRoot(scene: THREE.Scene): THREE.Group {
  const existing = scene.children.find((child) => child instanceof THREE.Group && child.name === TRAIN_ROOT_NAME);
  if (existing instanceof THREE.Group) {
    existing.visible = trainVisible;
    return existing;
  }
  const root = new THREE.Group();
  root.name = TRAIN_ROOT_NAME;
  root.userData[ROOT_FLAG] = true;
  root.visible = trainVisible;
  scene.add(root);
  return root;
}

function moveIfObject(value: unknown, root: THREE.Group): void {
  if (value instanceof THREE.Object3D && value.parent !== root) root.add(value);
}

function adoptRailProxyMeshes(rail: RailRenderer): void {
  const scene = sceneOfRail(rail); if (!scene) return;
  const root = trainRoot(scene);
  const rt = rail as unknown as RailRuntime;
  moveIfObject(rt.trainBody, root);
  moveIfObject(rt.trainStripe, root);
  moveIfObject(rt.trainCabin, root);
}

function adoptHighSpeedMeshes(scene: THREE.Scene): void {
  const source = latestHighSpeedRailInspectionSource() as unknown as HighSpeedRuntime | null;
  if (!source) return;
  const root = trainRoot(scene);
  moveIfObject(source.carBody, root);
  moveIfObject(source.carWindow, root);
  moveIfObject(source.carStripe, root);
}

function setObjectVisible(value: unknown, visible: boolean): void {
  if (value instanceof THREE.Object3D) value.visible = visible;
}

function applyOverlayVisibility(overlay: TrainLiveryOverlay): void {
  const rt = overlay as unknown as LiveryRuntime;
  setObjectVisible(rt.shell, trainVisible);
  setObjectVisible(rt.windows, trainVisible);
  setObjectVisible(rt.routeStripes, trainVisible);
  setObjectVisible(rt.serviceStripes, trainVisible);
  setObjectVisible(rt.headlampMesh, trainVisible);
  const pool = rt.headlightPool;
  if (Array.isArray(pool)) {
    for (const item of pool) {
      if (!(item instanceof THREE.SpotLight)) continue;
      item.visible = trainVisible;
      if (!trainVisible) item.intensity = 0;
    }
  }
}

function applyAll(): void {
  for (const scene of scenes) {
    trainRoot(scene).visible = trainVisible;
    adoptHighSpeedMeshes(scene);
  }
  for (const rail of rails) adoptRailProxyMeshes(rail);
  for (const overlay of overlays) applyOverlayVisibility(overlay);
  refreshPanel();
}

function setTrainVisible(value: boolean): void {
  trainVisible = value;
  saveTrainVisible();
  applyAll();
}

function dispatchCheck(input: HTMLInputElement, checked: boolean): void {
  if (input.checked === checked) return;
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function applyLegacyPanelState(panel: HTMLDivElement, state: Record<string, boolean>): void {
  for (const input of panel.querySelectorAll<HTMLInputElement>('input[data-category]')) {
    const category = input.dataset.category;
    if (category && category in state) dispatchCheck(input, state[category]);
  }
}

function addSplitPreset(panel: HTMLDivElement, label: string, onClick: () => void): void {
  if (Array.from(panel.querySelectorAll('button')).some((button) => button.textContent === label)) return;
  const presetContainer = Array.from(panel.querySelectorAll('div')).find((el) => el.querySelectorAll(':scope > button').length >= 3);
  if (!presetContainer) return;
  const sample = presetContainer.querySelector('button');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (sample instanceof HTMLButtonElement) button.style.cssText = sample.style.cssText;
  button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
  presetContainer.appendChild(button);
}

function enhancePanel(panel: HTMLDivElement): void {
  if (panel.dataset.railSplitV040 === 'true') return;
  panel.dataset.railSplitV040 = 'true';

  const railInput = panel.querySelector<HTMLInputElement>('input[data-category="rail"]');
  const railRow = railInput?.closest('label');
  const railText = railRow?.querySelector('span');
  if (railText) railText.textContent = '線路・駅設備';

  if (!panel.querySelector('input[data-category="trains"]')) {
    const row = document.createElement('label');
    row.style.cssText = railRow instanceof HTMLElement
      ? railRow.style.cssText
      : 'display:flex;align-items:center;gap:7px;padding:2px 1px;cursor:pointer';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.category = 'trains';
    check.checked = trainVisible;
    check.addEventListener('change', () => setTrainVisible(check.checked));
    const text = document.createElement('span');
    text.textContent = '列車';
    row.append(check, text);
    if (railRow?.parentElement) railRow.parentElement.insertBefore(row, railRow.nextSibling);
    else panel.appendChild(row);
  }

  for (const button of panel.querySelectorAll<HTMLButtonElement>('button')) {
    if (button.dataset.railSplitPreset === 'true') continue;
    const original = button.textContent ?? '';
    if (original === '鉄道のみ') button.textContent = '鉄道一式';
    const label = button.textContent ?? '';
    if (label === '全表示' || label === '鉄道一式' || label === '鉄道+道路') {
      button.dataset.railSplitPreset = 'true';
      button.addEventListener('click', () => setTrainVisible(true));
    } else if (label === '道路のみ') {
      button.dataset.railSplitPreset = 'true';
      button.addEventListener('click', () => setTrainVisible(false));
    }
  }

  addSplitPreset(panel, '線路のみ', () => {
    applyLegacyPanelState(panel, { ground: true, roads: false, buildings: false, rail: true, vehicles: false, agents: false });
    setTrainVisible(false);
  });
  addSplitPreset(panel, '列車のみ', () => {
    applyLegacyPanelState(panel, { ground: true, roads: false, buildings: false, rail: false, vehicles: false, agents: false });
    setTrainVisible(true);
  });
  refreshPanel();
}

function refreshPanel(): void {
  if (typeof document === 'undefined') return;
  const panel = document.querySelector<HTMLDivElement>('div[data-render-filter="true"]');
  const input = panel?.querySelector<HTMLInputElement>('input[data-category="trains"]');
  if (input) input.checked = trainVisible;
}

function scanPanel(): void {
  if (typeof document === 'undefined') return;
  const panel = document.querySelector<HTMLDivElement>('div[data-render-filter="true"]');
  if (panel) enhancePanel(panel);
}

function install(): void {
  const railProto = RailRenderer.prototype as unknown as Record<string, unknown>;
  if (railProto.__citySimRailFilterSplitV040) return;
  railProto.__citySimRailFilterSplitV040 = true;

  const previousBuild = RailRenderer.prototype.build;
  RailRenderer.prototype.build = function splitFilteredRailBuild(this: RailRenderer): void {
    previousBuild.call(this);
    const scene = sceneOfRail(this);
    if (scene) {
      scenes.add(scene);
      rails.add(this);
      adoptRailProxyMeshes(this);
      adoptHighSpeedMeshes(scene);
      trainRoot(scene).visible = trainVisible;
    }
  };

  const previousSync = TrainLiveryOverlay.prototype.sync;
  TrainLiveryOverlay.prototype.sync = function splitFilteredLiverySync(this: TrainLiveryOverlay, dt: number): void {
    previousSync.call(this, dt);
    const scene = sceneOfOverlay(this);
    if (scene) {
      scenes.add(scene);
      overlays.add(this);
      adoptHighSpeedMeshes(scene);
      trainRoot(scene).visible = trainVisible;
    }
    applyOverlayVisibility(this);
  };

  if (typeof document !== 'undefined') {
    const observer = new MutationObserver(() => scanPanel());
    observer.observe(document.body, { childList: true, subtree: true });
    window.requestAnimationFrame(scanPanel);
    window.setInterval(() => applyAll(), 1000);
  }
}

install();
