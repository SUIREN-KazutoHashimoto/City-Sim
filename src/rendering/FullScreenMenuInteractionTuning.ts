import { forEachTaxiVehicle } from '../traffic/TaxiSystem';
import { VehicleState } from '../traffic/VehicleStore';
import { World } from '../world/World';
import { FirstPersonController } from './FirstPersonController';
import { UniversalInspector } from './UniversalInspector';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;
type FollowKind = 'vehicle' | 'train' | 'highSpeedTrain';

interface TruckView {
  vehicle: number;
  truckId: number;
  kind: 'freight' | 'fuel';
  phase: string;
  cargo: number;
  capacity: number;
  speedKmh: number;
  x: number;
  z: number;
}

let latestWorld: World | null = null;
let latestController: FirstPersonController | null = null;
let latestInspector: UniversalInspector | null = null;
let menuAside: HTMLElement | null = null;
let menuMain: HTMLElement | null = null;
let truckButton: HTMLButtonElement | null = null;
let truckActive = false;
let truckQuery = '';
let truckSearchInput: HTMLInputElement | null = null;
let observer: MutationObserver | null = null;
let refreshTimer = 0;
let installTimer = 0;
let trainPatchQueued = false;
let jumpListenerInstalled = false;

const truckPhaseLabel: Record<string, string> = {
  idle: '待機',
  toStore: '店舗へ配送',
  toSource: '積込先へ移動',
  loading: '積込中',
  toDestination: '配送中',
  unloading: '荷下ろし中',
  returning: '帰庫中',
  'to-source': '燃料積込先へ移動',
  'to-plant': '発電所へ配送',
  unavailable: '状態不明',
};

function captureWorld(world: World): void {
  latestWorld = world;
  tryInstall();
}

function menuElements(): { aside: HTMLElement; main: HTMLElement } | null {
  for (const aside of Array.from(document.querySelectorAll<HTMLElement>('aside'))) {
    if (!aside.textContent?.includes('CITY SIM MENU')) continue;
    const main = aside.parentElement?.querySelector<HTMLElement>(':scope > main');
    if (main) return { aside, main };
  }
  return null;
}

function findMenuButton(): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'MENU  F10') ?? null;
}

function closeMenuNormally(force = false): void {
  const overlay = menuMain?.parentElement;
  const button = findMenuButton();
  if (!button || !overlay) return;
  if (force || overlay.style.display !== 'none') button.click();
}

function setTruckButtonState(active: boolean): void {
  if (!menuAside || !truckButton) return;
  for (const button of Array.from(menuAside.querySelectorAll<HTMLButtonElement>('button'))) {
    if (button === truckButton) {
      button.style.background = active ? '#253b52' : '#111c28';
      button.style.borderColor = active ? '#5d82aa' : '#27384b';
    } else if (active) {
      button.style.background = '#111c28';
      button.style.borderColor = '#27384b';
    }
  }
}

function tryInstall(): void {
  if (!latestWorld) return;
  const found = menuElements();
  if (!found) return;
  menuAside = found.aside;
  menuMain = found.main;

  if (!truckButton) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'トラック一覧';
    button.style.cssText = 'text-align:left;border:1px solid #27384b;background:#111c28;color:#dce8f5;border-radius:7px;padding:10px 11px;cursor:pointer;font:inherit';
    const trainButton = Array.from(found.aside.querySelectorAll<HTMLButtonElement>('button'))
      .find((item) => item.textContent?.trim() === '列車一覧');
    found.aside.insertBefore(button, trainButton ?? null);
    truckButton = button;

    for (const other of Array.from(found.aside.querySelectorAll<HTMLButtonElement>('button'))) {
      if (other === button) continue;
      other.addEventListener('click', () => {
        truckActive = false;
        setTruckButtonState(false);
        queueTrainChartPatch();
      });
    }

    button.addEventListener('click', () => {
      truckActive = true;
      setTruckButtonState(true);
      renderTruckPanel();
    });
  }

  if (!observer) {
    observer = new MutationObserver(() => {
      if (truckActive) return;
      queueTrainChartPatch();
    });
    observer.observe(found.main, { childList: true, subtree: true, characterData: true });
  }

  if (!refreshTimer) {
    refreshTimer = window.setInterval(() => {
      if (truckActive && menuMain?.parentElement?.style.display !== 'none') {
        if (truckSearchInput && document.activeElement === truckSearchInput) return;
        renderTruckPanel();
      } else {
        queueTrainChartPatch();
      }
    }, 1500);
  }

  if (!jumpListenerInstalled) {
    document.addEventListener('click', handleJumpClick, true);
    jumpListenerInstalled = true;
  }
  queueTrainChartPatch();
}

function truckViews(world: World): TruckView[] {
  const rows: TruckView[] = [];
  const vs = world.vehicles;
  const logistics = world.logistics as unknown as AnyHost;
  const power = (world as unknown as AnyHost).power as AnyHost | undefined;
  const fuelCapacity = Number(power?.config?.thermalFuelTruckCapacityUnits) || 0;

  for (let vehicle = 0; vehicle < vs.count; vehicle++) {
    if (!vs.isTruck[vehicle]) continue;
    const truckId = vs.truckId[vehicle];
    const fuel = truckId >= 10_000;
    const runtimeId = fuel ? truckId - 10_000 : truckId;
    const phase = fuel
      ? String(logistics.fuelTruckPhase?.(runtimeId) ?? 'unavailable')
      : String(logistics.truckPhase?.(runtimeId) ?? 'unavailable');
    const cargo = fuel
      ? Number(logistics.fuelTruckCargo?.(runtimeId) ?? 0)
      : Number(logistics.truckCargo?.(runtimeId) ?? 0);
    const capacity = fuel
      ? fuelCapacity
      : Number(logistics.truckCapacity?.(runtimeId) ?? 0);
    rows.push({
      vehicle,
      truckId,
      kind: fuel ? 'fuel' : 'freight',
      phase,
      cargo: Number.isFinite(cargo) ? cargo : 0,
      capacity: Number.isFinite(capacity) ? capacity : 0,
      speedKmh: Math.max(0, vs.speed[vehicle] * 3.6),
      x: vs.posX[vehicle],
      z: vs.posZ[vehicle],
    });
  }
  return rows;
}

function metricCard(label: string, value: string, detail = ''): HTMLElement {
  const card = document.createElement('div');
  card.style.cssText = 'border:1px solid #213246;border-radius:8px;background:#0d1824;padding:9px 11px;min-width:0';
  const l = document.createElement('div');
  l.textContent = label;
  l.style.cssText = 'font-size:10px;color:#7f95ad;margin-bottom:3px';
  const v = document.createElement('div');
  v.textContent = value;
  v.style.cssText = 'font-size:16px;font-weight:800;color:#edf5fd';
  card.append(l, v);
  if (detail) {
    const d = document.createElement('div');
    d.textContent = detail;
    d.style.cssText = 'font-size:9px;color:#72879d;margin-top:2px';
    card.appendChild(d);
  }
  return card;
}

function simpleBars(items: Array<{ label: string; value: number }>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  const positive = items.filter((item) => item.value > 0);
  const max = Math.max(0, ...positive.map((item) => item.value));
  if (!positive.length || max <= 0) {
    const empty = document.createElement('div');
    empty.textContent = 'データなし';
    empty.style.cssText = 'padding:10px;color:#71869c';
    wrap.appendChild(empty);
    return wrap;
  }
  for (const item of positive) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:minmax(90px,140px) 1fr 48px;gap:8px;align-items:center';
    const label = document.createElement('div');
    label.textContent = item.label;
    label.style.cssText = 'font-size:10px;color:#9eb2c6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const track = document.createElement('div');
    track.style.cssText = 'height:8px;border-radius:99px;background:#152335;overflow:hidden';
    const fill = document.createElement('div');
    fill.style.cssText = `height:100%;width:${Math.max(2, item.value / max * 100).toFixed(1)}%;background:#5c91c5;border-radius:99px`;
    track.appendChild(fill);
    const value = document.createElement('div');
    value.textContent = Math.round(item.value).toLocaleString();
    value.style.cssText = 'font-size:10px;color:#d6e2ef;text-align:right';
    row.append(label, track, value);
    wrap.appendChild(row);
  }
  return wrap;
}

function renderTruckPanel(): void {
  const world = latestWorld;
  const main = menuMain;
  if (!world || !main || !truckActive) return;
  const trucks = truckViews(world);
  const q = truckQuery.trim().toLocaleLowerCase();
  const visible = q
    ? trucks.filter((truck) => {
      const phase = truckPhaseLabel[truck.phase] ?? truck.phase;
      const kind = truck.kind === 'fuel' ? '燃料輸送' : '一般物流';
      return `${kind} ${phase} ${truck.vehicle} ${truck.truckId}`.toLocaleLowerCase().includes(q);
    })
    : trucks;

  main.replaceChildren();

  const title = document.createElement('h1');
  title.textContent = 'トラック一覧';
  title.style.cssText = 'font-size:22px;margin:0 0 6px';
  const note = document.createElement('div');
  note.textContent = '一般物流トラックと発電所向け燃料輸送車をまとめて確認します。';
  note.style.cssText = 'color:#8fa3ba;margin-bottom:18px';

  const freight = trucks.filter((truck) => truck.kind === 'freight').length;
  const fuel = trucks.filter((truck) => truck.kind === 'fuel').length;
  const driving = trucks.filter((truck) => world.vehicles.state[truck.vehicle] === VehicleState.Driving).length;
  const loaded = trucks.filter((truck) => truck.cargo > 0).length;

  const analytics = document.createElement('div');
  analytics.dataset.menuAnalytics = '1';
  analytics.style.cssText = 'margin:0 0 16px;border:1px solid #24364a;border-radius:10px;background:#09121c;padding:14px 15px';
  const metrics = document.createElement('div');
  metrics.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:7px;margin-bottom:12px';
  metrics.append(
    metricCard('トラック', trucks.length.toLocaleString()),
    metricCard('一般物流', freight.toLocaleString()),
    metricCard('燃料輸送', fuel.toLocaleString()),
    metricCard('走行中', driving.toLocaleString()),
    metricCard('積載中', loaded.toLocaleString()),
  );
  analytics.appendChild(metrics);

  const phaseCounts = new Map<string, number>();
  for (const truck of trucks) {
    const label = truckPhaseLabel[truck.phase] ?? truck.phase;
    phaseCounts.set(label, (phaseCounts.get(label) ?? 0) + 1);
  }
  const phasePanel = document.createElement('div');
  phasePanel.style.cssText = 'border:1px solid #1f3043;border-radius:8px;background:#0b151f;padding:10px 11px';
  const phaseTitle = document.createElement('div');
  phaseTitle.textContent = '運行フェーズ';
  phaseTitle.style.cssText = 'font-size:11px;font-weight:700;color:#9eb2c7;margin-bottom:8px';
  phasePanel.append(phaseTitle, simpleBars(Array.from(phaseCounts, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)));
  analytics.appendChild(phasePanel);

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;position:sticky;top:-24px;background:#070b11;padding:12px 0;z-index:2';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'トラックを検索…';
  search.value = truckQuery;
  search.style.cssText = 'flex:1;max-width:520px;border:1px solid #344960;background:#0d1621;color:#edf4fd;border-radius:7px;padding:8px 10px;font:inherit;outline:none';
  search.addEventListener('input', () => {
    truckQuery = search.value;
    renderTruckPanel();
    queueMicrotask(() => truckSearchInput?.focus());
  });
  truckSearchInput = search;
  const count = document.createElement('span');
  count.textContent = `${visible.length.toLocaleString()}件`;
  count.style.cssText = 'color:#93a8bf;min-width:90px;text-align:right';
  controls.append(search, count);

  const list = document.createElement('div');
  const header = document.createElement('div');
  header.style.cssText = rowStyle('background:#101a26;color:#91a7bd;font-weight:700;border-color:#2a3a4d');
  header.append(cell('対象'), cell('状態'), cell('詳細'), cell(''));
  list.appendChild(header);

  for (const truck of visible) {
    const row = document.createElement('div');
    row.style.cssText = rowStyle('background:#0b131d;border-color:#1e2d3e');
    const kind = truck.kind === 'fuel' ? '燃料輸送車' : '物流トラック';
    const titleCell = cell(`${kind} #${truck.truckId}`);
    titleCell.style.fontWeight = '700';
    const phase = truckPhaseLabel[truck.phase] ?? truck.phase;
    const status = cell(`${phase} · ${truck.speedKmh.toFixed(0)} km/h`);
    status.style.color = '#b8cee5';
    const loadPct = truck.capacity > 0 ? Math.round(truck.cargo / truck.capacity * 100) : 0;
    const detail = cell(`車両 #${truck.vehicle} · 積載 ${truck.cargo.toFixed(0)}/${truck.capacity.toFixed(0)} (${loadPct}%) · (${truck.x.toFixed(0)}, ${truck.z.toFixed(0)})`);
    detail.style.color = '#8fa3b9';
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.textContent = 'ジャンプ';
    jump.dataset.citysimJumpKind = 'vehicle';
    jump.dataset.citysimJumpId = String(truck.vehicle);
    jump.style.cssText = 'border:1px solid #3b5067;background:#162535;color:#edf4fc;border-radius:6px;padding:6px 9px;font:inherit;cursor:pointer;white-space:nowrap';
    row.append(titleCell, status, detail, jump);
    list.appendChild(row);
  }

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.textContent = '該当するトラックはありません';
    empty.style.cssText = 'padding:24px;color:#7f93aa';
    list.appendChild(empty);
  }

  main.append(title, note, analytics, controls, list);
}

function rowStyle(extra: string): string {
  return `display:grid;grid-template-columns:minmax(180px,1.1fr) minmax(160px,.8fr) minmax(280px,1.8fr) auto;gap:12px;align-items:center;border:1px solid;border-radius:7px;padding:9px 10px;margin-bottom:5px;${extra}`;
}

function cell(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  return el;
}

function queueTrainChartPatch(): void {
  if (trainPatchQueued) return;
  trainPatchQueued = true;
  queueMicrotask(() => {
    trainPatchQueued = false;
    patchTrainChart();
  });
}

function patchTrainChart(): void {
  const main = menuMain;
  if (!main || truckActive || main.querySelector('h1')?.textContent?.trim() !== '列車一覧') return;
  const analytics = main.querySelector<HTMLElement>('[data-menu-analytics="1"]');
  if (!analytics) return;

  const search = main.querySelector<HTMLInputElement>('input[type="search"]');
  const controls = search?.parentElement;
  const list = controls?.nextElementSibling as HTMLElement | null;
  if (!list) return;

  const counts = new Map<string, number>();
  for (const row of Array.from(list.children) as HTMLElement[]) {
    const cells = Array.from(row.children) as HTMLElement[];
    if (cells.length < 3 || cells[0]?.textContent?.trim() === '対象') continue;
    const raw = (cells[1]?.textContent ?? '').trim();
    if (!raw) continue;
    const state = raw.split('·', 1)[0]?.trim() || '不明';
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  let panel: HTMLElement | null = null;
  for (const candidate of Array.from(analytics.querySelectorAll<HTMLElement>('div'))) {
    if (candidate.firstElementChild?.textContent?.trim() === '運行状態') {
      panel = candidate;
      break;
    }
  }
  if (!panel) return;

  const items = Array.from(counts, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const signature = items.map((item) => `${item.label}:${item.value}`).join('|');
  if (panel.dataset.citysimNormalizedTrainChart === signature) return;
  panel.dataset.citysimNormalizedTrainChart = signature;
  while (panel.children.length > 1) panel.removeChild(panel.lastElementChild!);
  panel.appendChild(simpleBars(items));
}

function handleJumpClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.textContent?.trim() !== 'ジャンプ') return;
  const main = target.closest('main') as HTMLElement | null;
  const overlay = main?.parentElement;
  const aside = overlay?.querySelector<HTMLElement>(':scope > aside');
  if (!main || !aside?.textContent?.includes('CITY SIM MENU')) return;

  const heading = main.querySelector('h1')?.textContent?.trim() ?? '';

  if (heading === '電力') {
    queueMicrotask(() => closeMenuNormally(true));
    return;
  }

  const dataKind = target.dataset.citysimJumpKind;
  const dataId = Number(target.dataset.citysimJumpId);
  if (dataKind === 'vehicle' && Number.isInteger(dataId)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    startFollow('vehicle', dataId);
    return;
  }

  const row = target.parentElement;
  const title = row?.firstElementChild?.textContent?.trim() ?? '';
  let handled = false;

  if (heading === '建物一覧') {
    const match = title.match(/^#(\d+)\b/);
    if (match) handled = jumpBuilding(Number(match[1]));
  } else if (heading === '乗用車一覧') {
    const match = title.match(/乗用車\s+#(\d+)/);
    if (match) handled = startFollow('vehicle', Number(match[1]));
  } else if (heading === 'バス一覧') {
    const match = title.match(/バス\s+#(\d+)/);
    const busId = match ? Number(match[1]) : -1;
    const status = latestWorld?.bus.busStatus(busId);
    if (status) handled = startFollow('vehicle', status.vehicleId);
  } else if (heading === 'タクシー一覧') {
    const match = title.match(/タクシー\s+#(\d+)/);
    if (match && latestWorld) {
      const taxiId = Number(match[1]);
      let vehicle = -1;
      forEachTaxiVehicle(latestWorld.vehicles, (info) => {
        if (info.taxiId === taxiId) vehicle = info.vehicle;
      });
      if (vehicle >= 0) handled = startFollow('vehicle', vehicle);
    }
  } else if (heading === '列車一覧') {
    let match = title.match(/市内列車\s+#(\d+)/);
    if (match) handled = startFollow('train', Number(match[1]));
    else {
      match = title.match(/新幹線\s+#(\d+)/);
      if (match) handled = startFollow('highSpeedTrain', Number(match[1]));
    }
  }

  if (handled) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function startFollow(kind: FollowKind, id: number): boolean {
  const inspector = latestInspector as unknown as AnyHost | null;
  const controller = latestController as unknown as AnyHost | null;
  if (!inspector || !controller || id < 0) return false;

  inspector.followKind = kind;
  inspector.followId = id;
  const followTarget = inspector.getFollowTarget?.();
  if (!followTarget) return false;

  closeMenuNormally();
  controller.followDistance = kind === 'vehicle' ? 18 : 42;
  controller.setFollowTarget?.(followTarget);
  controller.update?.(0);
  return true;
}

function jumpBuilding(id: number): boolean {
  const world = latestWorld;
  const controller = latestController as unknown as AnyHost | null;
  const inspector = latestInspector as unknown as AnyHost | null;
  if (!world || !controller || !inspector) return false;
  const building = world.city.buildings.find((item) => item.id === id) ?? world.city.buildings[id];
  if (!building) return false;
  const camera = controller.camera as {
    position: { set: (x: number, y: number, z: number) => void };
    lookAt: (x: number, y: number, z: number) => void;
  } | undefined;
  if (!camera) return false;

  inspector.followKind = 'none';
  inspector.followId = -1;
  controller.setFollowTarget?.(null);
  closeMenuNormally();

  const height = Math.max(6, building.floors * 3.2);
  const distance = Math.max(42, Math.max(building.width, building.depth) * 1.7);
  camera.position.set(building.x - distance, height + 28, building.z - distance);
  camera.lookAt(building.x, Math.max(2, height * 0.45), building.z);
  controller.syncFreeAnglesFromCamera?.();
  return true;
}

const worldProto = World.prototype as unknown as AnyHost;
if (!worldProto.__citySimFullScreenInteractionV1023) {
  const previousPopulate = worldProto.populate as AnyMethod;
  worldProto.populate = function populateWithFullScreenInteraction(this: World, ...args: any[]): any {
    captureWorld(this);
    const result = previousPopulate.apply(this, args);
    captureWorld(this);
    return result;
  };
  worldProto.__citySimFullScreenInteractionV1023 = true;
}

const controllerProto = FirstPersonController.prototype as unknown as AnyHost;
if (!controllerProto.__citySimFullScreenInteractionCaptureV1023) {
  const previousSetPosition = controllerProto.setPosition as AnyMethod;
  controllerProto.setPosition = function setPositionAndCapture(this: FirstPersonController, ...args: any[]): any {
    latestController = this;
    tryInstall();
    return previousSetPosition.apply(this, args);
  };
  controllerProto.__citySimFullScreenInteractionCaptureV1023 = true;
}

const inspectorProto = UniversalInspector.prototype as unknown as AnyHost;
if (!inspectorProto.__citySimFullScreenInteractionCaptureV1023) {
  const previousUpdate = inspectorProto.update as AnyMethod;
  inspectorProto.update = function updateAndCaptureFullScreenInteraction(this: UniversalInspector, ...args: any[]): any {
    latestInspector = this;
    tryInstall();
    return previousUpdate.apply(this, args);
  };
  inspectorProto.__citySimFullScreenInteractionCaptureV1023 = true;
}

installTimer = window.setInterval(() => {
  tryInstall();
  if (truckButton && menuMain && latestController && latestInspector) window.clearInterval(installTimer);
}, 400);
