import * as THREE from 'three';
import { BuildingArchetype } from '../generation/CityGenerator';
import { forEachTaxiVehicle, type TaxiPhase } from '../traffic/TaxiSystem';
import { VehicleState } from '../traffic/VehicleStore';
import { POICategory } from '../world/POI';
import { World } from '../world/World';
import { FirstPersonController } from './FirstPersonController';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';
import { RailRenderer } from './RailRenderer';
import { UniversalInspector } from './UniversalInspector';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;
type TabKey = 'buildings' | 'cars' | 'buses' | 'taxis' | 'trains' | 'graphics';
type MovingKind = 'vehicle' | 'train' | 'highSpeedTrain';

interface MenuRow {
  key: string;
  title: string;
  status: string;
  detail: string;
  jump: () => void;
}

interface GraphicsState {
  pixelRatioCap: number;
  shadows: boolean;
  shadowSize: number;
  viewDistance: number;
}

export interface FullScreenMenuRuntime {
  world: World;
  rail: RailRenderer;
  controller: FirstPersonController;
  inspector: UniversalInspector;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

const PAGE_SIZE = 120;
const GRAPHICS_STORAGE = 'city-sim-graphics-v1';
let latestWorld: World | null = null;
let latestRail: RailRenderer | null = null;
let latestController: FirstPersonController | null = null;
let latestInspector: UniversalInspector | null = null;
let latestRenderer: THREE.WebGLRenderer | null = null;
let latestScene: THREE.Scene | null = null;
let latestCamera: THREE.PerspectiveCamera | null = null;
let menu: FullScreenMenu | null = null;

const categoryLabel: Record<number, string> = {
  [POICategory.Home]: '住宅', [POICategory.Work]: '職場', [POICategory.Food]: '飲食', [POICategory.Retail]: '小売',
  [POICategory.Leisure]: '娯楽', [POICategory.Health]: '医療', [POICategory.Education]: '教育', [POICategory.Parking]: '駐車場',
};
const vehicleStateLabel: Record<number, string> = {
  [VehicleState.Parked]: '駐車/待機', [VehicleState.Driving]: '走行中', [VehicleState.Arrived]: '到着',
};
const taxiPhaseLabel: Record<TaxiPhase, string> = {
  idle: '待機', 'to-pickup': '迎車', boarding: '乗車中', occupied: '実車', alighting: '降車中',
};

function tryCreateMenu(): void {
  if (menu || !latestWorld || !latestRail || !latestController || !latestInspector || !latestRenderer || !latestScene || !latestCamera) return;
  menu = new FullScreenMenu(latestWorld, latestRail, latestController, latestInspector, latestRenderer, latestScene, latestCamera);
}

export function registerFullScreenMenuRuntime(runtime: FullScreenMenuRuntime): void {
  latestWorld = runtime.world;
  latestRail = runtime.rail;
  latestController = runtime.controller;
  latestInspector = runtime.inspector;
  latestRenderer = runtime.renderer;
  latestScene = runtime.scene;
  latestCamera = runtime.camera;
  tryCreateMenu();
}

class FullScreenMenu {
  private readonly overlay: HTMLDivElement;
  private readonly content: HTMLElement;
  private readonly navButtons = new Map<TabKey, HTMLButtonElement>();
  private readonly menuButton: HTMLButtonElement;
  private activeTab: TabKey = 'buildings';
  private openState = false;
  private page = 0;
  private query = '';
  private listArea: HTMLDivElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private pagerText: HTMLSpanElement | null = null;
  private prevButton: HTMLButtonElement | null = null;
  private nextButton: HTMLButtonElement | null = null;
  private readonly graphics: GraphicsState;
  private readonly baseCameraFar: number;
  private readonly baseFogNear: number;
  private readonly baseFogFar: number;
  private readonly sun: THREE.DirectionalLight | null;

  constructor(
    private readonly world: World,
    private readonly rail: RailRenderer,
    private readonly controller: FirstPersonController,
    private readonly inspector: UniversalInspector,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.baseCameraFar = camera.far;
    const fog = scene.fog instanceof THREE.Fog ? scene.fog : null;
    this.baseFogNear = fog?.near ?? Math.max(800, world.city.sizeMeters * 0.12);
    this.baseFogFar = fog?.far ?? Math.max(3000, world.city.sizeMeters * 0.75);
    let sun: THREE.DirectionalLight | null = null;
    scene.traverse((object) => { if (!sun && object instanceof THREE.DirectionalLight) sun = object; });
    this.sun = sun;
    this.graphics = this.loadGraphics();

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:85', 'display:none', 'grid-template-columns:230px 1fr',
      'background:rgba(6,10,15,.975)', 'color:#e7eef8', 'font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'backdrop-filter:blur(7px)',
    ].join(';');

    const nav = document.createElement('aside');
    nav.style.cssText = 'border-right:1px solid #29384a;padding:24px 14px;display:flex;flex-direction:column;gap:7px;background:#0b121b';
    const brand = document.createElement('div');
    brand.textContent = 'CITY SIM MENU';
    brand.style.cssText = 'font-size:18px;font-weight:800;letter-spacing:.08em;padding:2px 8px 18px';
    nav.appendChild(brand);
    const tabs: Array<[TabKey, string]> = [
      ['buildings', '建物一覧'], ['cars', '乗用車一覧'], ['buses', 'バス一覧'], ['taxis', 'タクシー一覧'], ['trains', '列車一覧'], ['graphics', 'グラフィックス設定'],
    ];
    for (const [key, label] of tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = 'text-align:left;border:1px solid #27384b;background:#111c28;color:#dce8f5;border-radius:7px;padding:10px 11px;cursor:pointer;font:inherit';
      button.addEventListener('click', () => this.selectTab(key));
      nav.appendChild(button);
      this.navButtons.set(key, button);
    }
    const hint = document.createElement('div');
    hint.textContent = 'F10: 開閉\nEsc: 閉じる\nシミュレーションは継続';
    hint.style.cssText = 'margin-top:auto;padding:12px 8px;color:#8295ac;font-size:11px;white-space:pre-line';
    nav.appendChild(hint);

    this.content = document.createElement('main');
    this.content.style.cssText = 'min-width:0;overflow:auto;padding:24px 28px 36px';
    this.overlay.append(nav, this.content);
    document.body.appendChild(this.overlay);

    this.menuButton = document.createElement('button');
    this.menuButton.type = 'button';
    this.menuButton.textContent = 'MENU  F10';
    this.menuButton.style.cssText = 'position:fixed;right:10px;top:10px;z-index:45;border:1px solid #3a4e66;background:rgba(10,16,24,.88);color:#e6eef8;border-radius:7px;padding:7px 10px;font:11px ui-monospace,monospace;cursor:pointer';
    this.menuButton.addEventListener('click', () => this.toggle());
    document.body.appendChild(this.menuButton);

    window.addEventListener('keydown', (event) => {
      if (event.code === 'F10') { event.preventDefault(); this.toggle(); return; }
      if (event.code === 'Escape' && this.openState) { event.preventDefault(); this.close(); }
    });
    window.setInterval(() => {
      if (!this.openState || this.activeTab === 'graphics') return;
      if (this.searchInput && document.activeElement === this.searchInput) return;
      this.refreshRows();
    }, 1500);

    this.applyGraphics();
    this.selectTab('buildings');
  }

  get isOpen(): boolean { return this.openState; }

  toggle(): void { if (this.openState) this.close(); else this.open(); }
  open(): void {
    this.openState = true;
    this.overlay.style.display = 'grid';
    this.menuButton.style.display = 'none';
    const c = this.controller as unknown as AnyHost;
    c.keys?.clear?.(); c.dragging = false;
    this.renderTab();
  }
  close(): void {
    this.openState = false;
    this.overlay.style.display = 'none';
    this.menuButton.style.display = 'block';
    const c = this.controller as unknown as AnyHost;
    c.keys?.clear?.(); c.dragging = false;
  }

  private selectTab(tab: TabKey): void {
    this.activeTab = tab;
    this.page = 0;
    this.query = '';
    for (const [key, button] of this.navButtons) {
      button.style.background = key === tab ? '#253b52' : '#111c28';
      button.style.borderColor = key === tab ? '#5d82aa' : '#27384b';
    }
    this.renderTab();
  }

  private renderTab(): void {
    this.content.replaceChildren();
    this.listArea = null;
    this.searchInput = null;
    this.pagerText = null;
    this.prevButton = null;
    this.nextButton = null;
    if (this.activeTab === 'graphics') { this.renderGraphics(); return; }

    const title = document.createElement('h1');
    title.textContent = this.tabTitle(this.activeTab);
    title.style.cssText = 'font-size:22px;margin:0 0 6px';
    const note = document.createElement('div');
    note.textContent = 'ステータスを確認し、「ジャンプ」で対象を追跡/表示します。';
    note.style.cssText = 'color:#8fa3ba;margin-bottom:18px';
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;position:sticky;top:-24px;background:#070b11;padding:12px 0;z-index:2';
    const search = document.createElement('input');
    search.type = 'search'; search.placeholder = '検索…';
    search.style.cssText = 'flex:1;max-width:520px;border:1px solid #344960;background:#0d1621;color:#edf4fd;border-radius:7px;padding:8px 10px;font:inherit;outline:none';
    search.addEventListener('input', () => { this.query = search.value; this.page = 0; this.refreshRows(); });
    this.searchInput = search;
    const refresh = this.smallButton('更新', () => this.refreshRows());
    const prev = this.smallButton('←', () => { if (this.page > 0) { this.page--; this.refreshRows(); } });
    const next = this.smallButton('→', () => { this.page++; this.refreshRows(); });
    const pager = document.createElement('span');
    pager.style.cssText = 'color:#93a8bf;min-width:150px;text-align:center';
    this.prevButton = prev; this.nextButton = next; this.pagerText = pager;
    controls.append(search, refresh, prev, pager, next);
    const list = document.createElement('div');
    this.listArea = list;
    this.content.append(title, note, controls, list);
    this.refreshRows();
  }

  private refreshRows(): void {
    if (!this.listArea) return;
    const all = this.rowsFor(this.activeTab);
    const q = this.query.trim().toLocaleLowerCase();
    const rows = q ? all.filter((row) => `${row.title} ${row.status} ${row.detail}`.toLocaleLowerCase().includes(q)) : all;
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    const start = this.page * PAGE_SIZE;
    const visible = rows.slice(start, start + PAGE_SIZE);
    this.listArea.replaceChildren();

    const header = document.createElement('div');
    header.style.cssText = this.rowGridStyle('background:#101a26;color:#91a7bd;font-weight:700;border-color:#2a3a4d');
    header.append(this.cell('対象'), this.cell('状態'), this.cell('詳細'), this.cell(''));
    this.listArea.appendChild(header);
    for (const row of visible) {
      const el = document.createElement('div');
      el.style.cssText = this.rowGridStyle('background:#0b131d;border-color:#1e2d3e');
      const title = this.cell(row.title); title.style.fontWeight = '700';
      const status = this.cell(row.status); status.style.color = '#b8cee5';
      const detail = this.cell(row.detail); detail.style.color = '#8fa3b9';
      const action = this.smallButton('ジャンプ', row.jump);
      el.append(title, status, detail, action);
      this.listArea.appendChild(el);
    }
    if (!visible.length) {
      const empty = document.createElement('div'); empty.textContent = '該当する対象はありません'; empty.style.cssText = 'padding:24px;color:#7f93aa'; this.listArea.appendChild(empty);
    }
    if (this.pagerText) this.pagerText.textContent = `${rows.length.toLocaleString()}件  ${this.page + 1}/${pages}`;
    if (this.prevButton) this.prevButton.disabled = this.page <= 0;
    if (this.nextButton) this.nextButton.disabled = this.page >= pages - 1;
  }

  private rowsFor(tab: TabKey): MenuRow[] {
    if (tab === 'buildings') return this.buildingRows();
    if (tab === 'cars') return this.carRows();
    if (tab === 'buses') return this.busRows();
    if (tab === 'taxis') return this.taxiRows();
    if (tab === 'trains') return this.trainRows();
    return [];
  }

  private buildingRows(): MenuRow[] {
    return this.world.city.buildings.map((building) => {
      const pois = this.world.city.poi.poisInBuilding(building.id);
      const capacity = pois.reduce((sum, p) => sum + Math.max(0, p.capacity), 0);
      const occupancy = pois.reduce((sum, p) => sum + Math.max(0, p.occupancy), 0);
      const label = categoryLabel[building.category] ?? POICategory[building.category] ?? '建物';
      const archetype = BuildingArchetype[building.archetype] ?? `type ${building.archetype}`;
      return {
        key: `building:${building.id}`,
        title: `#${building.id} ${label}`,
        status: `${building.floors}階 · ${archetype}`,
        detail: `POI ${pois.length} · 利用 ${occupancy}/${capacity} · (${building.x.toFixed(0)}, ${building.z.toFixed(0)})`,
        jump: () => this.jumpBuilding(building.id),
      };
    });
  }

  private carRows(): MenuRow[] {
    const taxiVehicles = new Set<number>();
    forEachTaxiVehicle(this.world.vehicles, (info) => taxiVehicles.add(info.vehicle));
    const vs = this.world.vehicles;
    const rows: MenuRow[] = [];
    for (let id = 0; id < vs.count; id++) {
      if (vs.isBus[id] || vs.isTruck[id] || taxiVehicles.has(id)) continue;
      rows.push({
        key: `car:${id}`,
        title: `乗用車 #${id}`,
        status: `${vehicleStateLabel[vs.state[id]] ?? '不明'} · ${(vs.speed[id] * 3.6).toFixed(0)} km/h`,
        detail: `運転者 ${vs.driver[id] >= 0 ? `#${vs.driver[id]}` : 'なし'} · (${vs.posX[id].toFixed(0)}, ${vs.posZ[id].toFixed(0)})`,
        jump: () => this.follow('vehicle', id),
      });
    }
    return rows;
  }

  private busRows(): MenuRow[] {
    const rows: MenuRow[] = [];
    const vs = this.world.vehicles;
    for (let id = 0; id < this.world.bus.busCount; id++) {
      const status = this.world.bus.busStatus(id); if (!status) continue;
      const v = status.vehicleId;
      rows.push({
        key: `bus:${id}`,
        title: `バス #${id} / 路線 ${status.routeId}`,
        status: `${status.dwellRemaining > 0 ? '停車中' : vehicleStateLabel[vs.state[v]] ?? '運行中'} · ${(vs.speed[v] * 3.6).toFixed(0)} km/h`,
        detail: `乗客 ${status.onboard.length}/${status.capacity} · 次停留所 #${status.targetStopId}`,
        jump: () => this.follow('vehicle', v),
      });
    }
    return rows;
  }

  private taxiRows(): MenuRow[] {
    const rows: MenuRow[] = [];
    const vs = this.world.vehicles;
    forEachTaxiVehicle(vs, (info) => {
      rows.push({
        key: `taxi:${info.taxiId}`,
        title: `タクシー #${info.taxiId}`,
        status: `${taxiPhaseLabel[info.phase]} · ${(vs.speed[info.vehicle] * 3.6).toFixed(0)} km/h`,
        detail: `車両 #${info.vehicle} · 乗客 ${info.passenger >= 0 ? `#${info.passenger}` : 'なし'} · 走行予定 ${info.tripDistance.toFixed(0)}m`,
        jump: () => this.follow('vehicle', info.vehicle),
      });
    });
    return rows;
  }

  private trainRows(): MenuRow[] {
    const rows: MenuRow[] = [];
    for (let id = 0; id < this.rail.trainCount; id++) {
      const s = this.rail.trainStatus(id); if (!s) continue;
      rows.push({
        key: `train:${id}`,
        title: `市内列車 #${id} · ${s.lineName} ${s.serviceLabel}`,
        status: `${s.stateLabel} · ${(s.speed * 3.6).toFixed(0)} km/h`,
        detail: `${s.carCount}両 · 次駅 ${s.nextStationName} · 遅延 ${Math.max(0, s.delaySeconds).toFixed(0)}秒`,
        jump: () => this.follow('train', id),
      });
    }
    const highSpeed = latestHighSpeedRailInspectionSource();
    if (highSpeed) {
      const ids = new Set<number>();
      const hit = highSpeed.trainHitMesh;
      for (let i = 0; i < hit.count; i++) { const id = highSpeed.trainIdFromInstance(i); if (id >= 0) ids.add(id); }
      for (const id of ids) {
        const s = highSpeed.trainStatus(id); if (!s) continue;
        rows.push({
          key: `hsr:${id}`,
          title: `新幹線 #${id} · ${s.lineName}`,
          status: `${s.stateLabel} · ${(s.speed * 3.6).toFixed(0)} km/h`,
          detail: `${s.carCount}両 · ${s.stoppedAtCentral ? '中央駅停車中' : '運行中'}`,
          jump: () => this.follow('highSpeedTrain', id),
        });
      }
    }
    return rows;
  }

  private follow(kind: MovingKind, id: number): void {
    const inspector = this.inspector as unknown as AnyHost;
    inspector.followKind = kind;
    inspector.followId = id;
    this.controller.followDistance = kind === 'vehicle' ? 16 : 36;
    this.close();
  }

  private jumpBuilding(id: number): void {
    const building = this.world.city.buildings[id]; if (!building) return;
    const inspector = this.inspector as unknown as AnyHost;
    inspector.followKind = 'none'; inspector.followId = -1;
    this.controller.setFollowTarget(null);
    const height = Math.max(6, building.floors * 3.2);
    const distance = Math.max(38, Math.max(building.width, building.depth) * 1.6);
    this.camera.position.set(building.x - distance, height + 24, building.z - distance);
    this.camera.lookAt(building.x, height * 0.45, building.z);
    const controller = this.controller as unknown as AnyHost;
    controller.syncFreeAnglesFromCamera?.();
    this.close();
  }

  private renderGraphics(): void {
    const title = document.createElement('h1'); title.textContent = 'グラフィックス設定'; title.style.cssText = 'font-size:22px;margin:0 0 6px';
    const note = document.createElement('div'); note.textContent = '変更は即時反映され、ブラウザに保存されます。'; note.style.cssText = 'color:#8fa3ba;margin-bottom:22px';
    const presets = document.createElement('div'); presets.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px';
    presets.append(
      this.smallButton('低', () => this.setGraphics({ pixelRatioCap: 0.8, shadows: false, shadowSize: 1024, viewDistance: 0.62 })),
      this.smallButton('中', () => this.setGraphics({ pixelRatioCap: 1.0, shadows: true, shadowSize: 1024, viewDistance: 0.82 })),
      this.smallButton('高', () => this.setGraphics({ pixelRatioCap: 1.5, shadows: true, shadowSize: 2048, viewDistance: 1.0 })),
      this.smallButton('最高', () => this.setGraphics({ pixelRatioCap: 2.0, shadows: true, shadowSize: 4096, viewDistance: 1.25 })),
    );
    const panel = document.createElement('div'); panel.style.cssText = 'max-width:720px;border:1px solid #293b50;border-radius:10px;background:#0c151f;padding:18px';
    panel.append(
      this.selectControl('解像度上限', `${this.graphics.pixelRatioCap}`, [['0.75','0.75'],['1','1.0'],['1.25','1.25'],['1.5','1.5'],['2','2.0']], (value) => this.setGraphics({ pixelRatioCap: Number(value) })),
      this.checkboxControl('リアルタイム影', this.graphics.shadows, (value) => this.setGraphics({ shadows: value })),
      this.selectControl('影解像度', `${this.graphics.shadowSize}`, [['1024','1024'],['2048','2048'],['4096','4096']], (value) => this.setGraphics({ shadowSize: Number(value) })),
      this.selectControl('描画距離', `${this.graphics.viewDistance}`, [['0.6','60%'],['0.8','80%'],['1','100%'],['1.25','125%'],['1.5','150%']], (value) => this.setGraphics({ viewDistance: Number(value) })),
    );
    this.content.append(title, note, presets, panel);
  }

  private selectControl(label: string, value: string, options: Array<[string, string]>, onChange: (value: string) => void): HTMLElement {
    const row = this.settingRow(label);
    const select = document.createElement('select');
    select.style.cssText = 'border:1px solid #3b5067;background:#111d29;color:#e9f1fb;border-radius:6px;padding:7px 9px;font:inherit;min-width:150px';
    for (const [v, text] of options) { const option = document.createElement('option'); option.value = v; option.textContent = text; select.appendChild(option); }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    row.appendChild(select); return row;
  }

  private checkboxControl(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
    const row = this.settingRow(label);
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; input.style.transform = 'scale(1.25)';
    input.addEventListener('change', () => onChange(input.checked)); row.appendChild(input); return row;
  }

  private settingRow(label: string): HTMLDivElement {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 4px;border-bottom:1px solid #1c2b3b';
    const text = document.createElement('span'); text.textContent = label; text.style.fontWeight = '700'; row.appendChild(text); return row;
  }

  private setGraphics(patch: Partial<GraphicsState>): void {
    Object.assign(this.graphics, patch);
    this.saveGraphics();
    this.applyGraphics();
    this.renderGraphicsTabAgain();
  }

  private renderGraphicsTabAgain(): void { if (this.activeTab === 'graphics') this.renderTab(); }

  private applyGraphics(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Math.max(0.5, this.graphics.pixelRatioCap)));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = this.graphics.shadows;
    if (this.sun) {
      this.sun.castShadow = this.graphics.shadows;
      const size = Math.max(512, Math.min(4096, Math.round(this.graphics.shadowSize)));
      if (this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
    }
    const distance = THREE.MathUtils.clamp(this.graphics.viewDistance, 0.5, 1.6);
    this.camera.far = this.baseCameraFar * distance;
    this.camera.updateProjectionMatrix();
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.far = this.baseFogFar * distance;
      this.scene.fog.near = Math.min(this.baseFogNear, this.scene.fog.far * 0.38);
    }
  }

  private loadGraphics(): GraphicsState {
    const defaults: GraphicsState = { pixelRatioCap: 1.5, shadows: true, shadowSize: 2048, viewDistance: 1.0 };
    try {
      const raw = localStorage.getItem(GRAPHICS_STORAGE); if (!raw) return defaults;
      const saved = JSON.parse(raw) as Partial<GraphicsState>;
      return { ...defaults, ...saved };
    } catch { return defaults; }
  }
  private saveGraphics(): void { try { localStorage.setItem(GRAPHICS_STORAGE, JSON.stringify(this.graphics)); } catch { /* unavailable */ } }

  private tabTitle(tab: TabKey): string {
    return tab === 'buildings' ? '建物一覧' : tab === 'cars' ? '乗用車一覧' : tab === 'buses' ? 'バス一覧' : tab === 'taxis' ? 'タクシー一覧' : '列車一覧';
  }
  private smallButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    button.style.cssText = 'border:1px solid #3b5067;background:#162535;color:#edf4fc;border-radius:6px;padding:6px 9px;font:inherit;cursor:pointer;white-space:nowrap';
    button.addEventListener('click', onClick); return button;
  }
  private cell(text: string): HTMLDivElement { const el = document.createElement('div'); el.textContent = text; el.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis'; return el; }
  private rowGridStyle(extra: string): string { return `display:grid;grid-template-columns:minmax(190px,1.15fr) minmax(180px,.9fr) minmax(280px,1.8fr) auto;gap:12px;align-items:center;border:1px solid;border-radius:7px;padding:9px 10px;margin-bottom:5px;${extra}`; }
}

const worldProto = World.prototype as unknown as AnyHost;
if (!worldProto.__citySimFullscreenMenuCaptureV102) {
  const previousPopulate = worldProto.populate as AnyMethod;
  worldProto.populate = function populateAndCapture(this: World, ...args: any[]): any {
    const result = previousPopulate.apply(this, args);
    latestWorld = this; tryCreateMenu(); return result;
  };
  worldProto.__citySimFullscreenMenuCaptureV102 = true;
}

const railProto = RailRenderer.prototype as unknown as AnyHost;
if (!railProto.__citySimFullscreenMenuCaptureV102) {
  const previousBuild = railProto.build as AnyMethod;
  railProto.build = function buildAndCapture(this: RailRenderer, ...args: any[]): any {
    const result = previousBuild.apply(this, args);
    latestRail = this; tryCreateMenu(); return result;
  };
  railProto.__citySimFullscreenMenuCaptureV102 = true;
}

const controllerProto = FirstPersonController.prototype as unknown as AnyHost;
if (!controllerProto.__citySimFullscreenMenuCaptureV102) {
  const previousSetPosition = controllerProto.setPosition as AnyMethod;
  controllerProto.setPosition = function setPositionAndCapture(this: FirstPersonController, ...args: any[]): any {
    latestController = this; tryCreateMenu(); return previousSetPosition.apply(this, args);
  };
  const previousUpdate = controllerProto.update as AnyMethod;
  controllerProto.update = function updateUnlessMenuOpen(this: FirstPersonController, ...args: any[]): any {
    if (menu?.isOpen) return;
    return previousUpdate.apply(this, args);
  };
  controllerProto.__citySimFullscreenMenuCaptureV102 = true;
}

const inspectorProto = UniversalInspector.prototype as unknown as AnyHost;
if (!inspectorProto.__citySimFullscreenMenuCaptureV102) {
  const previousUpdate = inspectorProto.update as AnyMethod;
  inspectorProto.update = function updateAndCapture(this: UniversalInspector, ...args: any[]): any {
    latestInspector = this; tryCreateMenu(); return previousUpdate.apply(this, args);
  };
  inspectorProto.__citySimFullscreenMenuCaptureV102 = true;
}
