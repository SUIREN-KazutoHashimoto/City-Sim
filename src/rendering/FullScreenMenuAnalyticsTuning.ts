import { GenerationType, PowerAssetState } from '../power/PowerTypes';
import { forEachTaxiVehicle, type TaxiPhase } from '../traffic/TaxiSystem';
import { VehicleState } from '../traffic/VehicleStore';
import { POICategory } from '../world/POI';
import { World } from '../world/World';

type AnyMethod = (...args: any[]) => any;
type AnyWorld = Record<string, any>;

interface PowerHistoryPoint {
  time: number;
  demand: number;
  supply: number;
  city: number;
  external: number;
  cityAvailable: number;
  externalAvailable: number;
}

interface BarItem {
  label: string;
  value: number;
  detail?: string;
}

interface LineSeries {
  label: string;
  key: keyof PowerHistoryPoint;
  color: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const HISTORY_LIMIT = 120;
const HISTORY_INTERVAL_SIM_SECONDS = 60;
const POWER_COLORS = ['#79b8ff', '#75e0a7', '#f0c66e', '#c89cff'];
const BAR_COLORS = ['#4e88bd', '#4e9a77', '#b38c4a', '#8b6db0', '#547f9d', '#9a6f76', '#678d5b', '#8a7c56'];

let latestWorld: World | null = null;
let menuMain: HTMLElement | null = null;
let menuObserver: MutationObserver | null = null;
let installTimer = 0;
let sampleTimer = 0;
let decorateQueued = false;
const powerHistory: PowerHistoryPoint[] = [];

const buildingCategoryLabel: Record<number, string> = {
  [POICategory.Home]: '住宅',
  [POICategory.Work]: '職場',
  [POICategory.Food]: '飲食',
  [POICategory.Retail]: '小売',
  [POICategory.Leisure]: '娯楽',
  [POICategory.Health]: '医療',
  [POICategory.Education]: '教育',
  [POICategory.Parking]: '駐車場',
};
const vehicleStateLabel: Record<number, string> = {
  [VehicleState.Parked]: '駐車・待機',
  [VehicleState.Driving]: '走行中',
  [VehicleState.Arrived]: '到着',
};
const taxiPhaseLabel: Record<TaxiPhase, string> = {
  idle: '待機',
  'to-pickup': '迎車',
  boarding: '乗車処理',
  occupied: '実車',
  alighting: '降車処理',
};

function fmtMw(value: number): string {
  return `${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)} MW`;
}
function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
function fmtInt(value: number): string {
  return Math.round(value).toLocaleString();
}
function simClock(totalSeconds: number): string {
  const daySeconds = ((totalSeconds % 86400) + 86400) % 86400;
  const h = Math.floor(daySeconds / 3600);
  const m = Math.floor((daySeconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function menuElements(): { main: HTMLElement } | null {
  for (const aside of Array.from(document.querySelectorAll<HTMLElement>('aside'))) {
    if (!aside.textContent?.includes('CITY SIM MENU')) continue;
    const main = aside.parentElement?.querySelector<HTMLElement>(':scope > main');
    if (main) return { main };
  }
  return null;
}

function tryInstall(): void {
  if (!latestWorld) return;
  const found = menuElements();
  if (!found) return;
  if (menuMain !== found.main) {
    menuObserver?.disconnect();
    menuMain = found.main;
    menuObserver = new MutationObserver(() => queueDecorate());
    menuObserver.observe(found.main, { childList: true, subtree: true, characterData: true });
  }
  queueDecorate();
}

function queueDecorate(): void {
  if (decorateQueued) return;
  decorateQueued = true;
  queueMicrotask(() => {
    decorateQueued = false;
    decorateCurrentPage();
  });
}

function captureWorld(world: World): void {
  latestWorld = world;
  tryInstall();
  samplePowerHistory();
}

function samplePowerHistory(): void {
  const world = latestWorld;
  if (!world?.power) return;
  const snap = world.power.snapshot();
  const time = Number.isFinite(snap.lastUpdateSimSeconds) ? snap.lastUpdateSimSeconds : world.clock.totalSeconds;
  const last = powerHistory[powerHistory.length - 1];
  if (last && time < last.time) powerHistory.length = 0;
  const currentLast = powerHistory[powerHistory.length - 1];
  if (currentLast && time - currentLast.time < HISTORY_INTERVAL_SIM_SECONDS) return;

  let cityAvailable = 0;
  for (const facility of world.power.generationFacilities) {
    const item = world.power.getGenerationFacilitySnapshot(facility.id);
    if (item?.state === PowerAssetState.Online) cityAvailable += Math.max(0, item.availableOutputMw);
  }
  let externalAvailable = 0;
  for (const connection of world.power.externalConnections) {
    const item = world.power.getExternalConnectionSnapshot(connection.id);
    if (item?.state === PowerAssetState.Online) externalAvailable += Math.max(0, item.maxImportMw);
  }

  powerHistory.push({
    time,
    demand: snap.demandMw,
    supply: snap.suppliedMw,
    city: snap.cityGenerationMw,
    external: snap.externalImportMw,
    cityAvailable,
    externalAvailable,
  });
  if (powerHistory.length > HISTORY_LIMIT) powerHistory.splice(0, powerHistory.length - HISTORY_LIMIT);
}

function dashboard(title: string, note: string): HTMLDivElement {
  const root = document.createElement('div');
  root.dataset.menuAnalytics = '1';
  root.style.cssText = 'margin:0 0 16px;border:1px solid #24364a;border-radius:10px;background:#09121c;padding:14px 15px';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;gap:12px;align-items:baseline;justify-content:space-between;margin-bottom:11px';
  const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-size:14px;font-weight:800;color:#e3edf8';
  const n = document.createElement('div'); n.textContent = note; n.style.cssText = 'font-size:10px;color:#748aa2;text-align:right';
  head.append(h, n); root.appendChild(head);
  return root;
}

function metricCard(label: string, value: string, detail = ''): HTMLElement {
  const card = document.createElement('div');
  card.style.cssText = 'min-width:0;border:1px solid #213246;border-radius:8px;background:#0d1824;padding:9px 11px';
  const l = document.createElement('div'); l.textContent = label; l.style.cssText = 'font-size:10px;color:#7f95ad;margin-bottom:3px';
  const v = document.createElement('div'); v.textContent = value; v.style.cssText = 'font-size:16px;font-weight:800;color:#edf5fd';
  card.append(l, v);
  if (detail) { const d = document.createElement('div'); d.textContent = detail; d.style.cssText = 'font-size:9px;color:#72879d;margin-top:2px'; card.appendChild(d); }
  return card;
}

function metricGrid(cards: HTMLElement[]): HTMLElement {
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:7px;margin-bottom:12px';
  grid.append(...cards);
  return grid;
}

function panel(title: string): HTMLDivElement {
  const box = document.createElement('div');
  box.style.cssText = 'min-width:0;border:1px solid #1f3043;border-radius:8px;background:#0b151f;padding:10px 11px';
  const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-size:11px;font-weight:700;color:#9eb2c7;margin-bottom:8px';
  box.appendChild(h);
  return box;
}

function twoColumn(left: HTMLElement, right: HTMLElement): HTMLElement {
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:8px';
  grid.append(left, right);
  return grid;
}

function barChart(items: BarItem[], empty = 'データなし'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  const max = Math.max(0, ...items.map((item) => item.value));
  if (!items.length || max <= 0) {
    const e = document.createElement('div'); e.textContent = empty; e.style.cssText = 'color:#71869c;padding:12px 2px'; wrap.appendChild(e); return wrap;
  }
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:minmax(72px,120px) 1fr auto;gap:8px;align-items:center';
    const label = document.createElement('div'); label.textContent = item.label; label.title = item.detail ?? item.label; label.style.cssText = 'font-size:10px;color:#9eb2c6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const track = document.createElement('div'); track.style.cssText = 'height:8px;border-radius:99px;background:#152335;overflow:hidden';
    const fill = document.createElement('div'); fill.style.cssText = `height:100%;width:${Math.max(1.5, item.value / max * 100).toFixed(1)}%;background:${BAR_COLORS[index % BAR_COLORS.length]};border-radius:99px`;
    track.appendChild(fill);
    const value = document.createElement('div'); value.textContent = fmtInt(item.value); value.style.cssText = 'font-size:10px;color:#d6e2ef;min-width:44px;text-align:right';
    row.append(label, track, value); wrap.appendChild(row);
  });
  return wrap;
}

function powerLineChart(points: PowerHistoryPoint[], series: LineSeries[]): HTMLElement {
  const wrap = document.createElement('div');
  if (points.length < 2) {
    const e = document.createElement('div');
    e.textContent = '時系列を収集中…';
    e.style.cssText = 'height:118px;display:grid;place-items:center;color:#71869c';
    wrap.appendChild(e);
    return wrap;
  }

  const width = 640, height = 150, left = 38, right = 10, top = 9, bottom = 24;
  const plotW = width - left - right, plotH = height - top - bottom;
  let maxValue = 0;
  for (const point of points) for (const s of series) maxValue = Math.max(maxValue, Number(point[s.key]) || 0);
  maxValue = Math.max(1, maxValue * 1.08);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'width:100%;height:150px;display:block';

  for (let i = 0; i <= 3; i++) {
    const y = top + plotH * i / 3;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(left)); line.setAttribute('x2', String(width - right)); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
    line.setAttribute('stroke', '#1d2b3c'); line.setAttribute('stroke-width', '1'); svg.appendChild(line);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(left - 5)); text.setAttribute('y', String(y + 3)); text.setAttribute('text-anchor', 'end'); text.setAttribute('fill', '#71869b'); text.setAttribute('font-size', '9');
    text.textContent = `${Math.round(maxValue * (1 - i / 3))}`; svg.appendChild(text);
  }

  for (const s of series) {
    const polyline = document.createElementNS(SVG_NS, 'polyline');
    const coords = points.map((point, index) => {
      const x = left + (points.length <= 1 ? 0 : index / (points.length - 1)) * plotW;
      const y = top + plotH - (Math.max(0, Number(point[s.key]) || 0) / maxValue) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    polyline.setAttribute('points', coords);
    polyline.setAttribute('fill', 'none'); polyline.setAttribute('stroke', s.color); polyline.setAttribute('stroke-width', '2'); polyline.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(polyline);
  }

  const first = document.createElementNS(SVG_NS, 'text');
  first.setAttribute('x', String(left)); first.setAttribute('y', String(height - 5)); first.setAttribute('fill', '#71869b'); first.setAttribute('font-size', '9'); first.textContent = simClock(points[0].time); svg.appendChild(first);
  const last = document.createElementNS(SVG_NS, 'text');
  last.setAttribute('x', String(width - right)); last.setAttribute('y', String(height - 5)); last.setAttribute('text-anchor', 'end'); last.setAttribute('fill', '#71869b'); last.setAttribute('font-size', '9'); last.textContent = simClock(points[points.length - 1].time); svg.appendChild(last);
  wrap.appendChild(svg);

  const legend = document.createElement('div'); legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px 14px;margin-top:3px';
  for (const s of series) {
    const item = document.createElement('span'); item.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:9px;color:#8fa3b8';
    const dot = document.createElement('i'); dot.style.cssText = `display:inline-block;width:12px;height:2px;background:${s.color}`;
    item.append(dot, document.createTextNode(s.label)); legend.appendChild(item);
  }
  wrap.appendChild(legend);
  return wrap;
}

function insertBeforeControls(main: HTMLElement, analytics: HTMLElement): void {
  const search = main.querySelector<HTMLInputElement>('input[type="search"]');
  const controls = search?.parentElement;
  if (controls?.parentElement === main) main.insertBefore(analytics, controls);
  else main.appendChild(analytics);
}

function buildingAnalytics(world: World): HTMLElement {
  const root = dashboard('都市構成', '建物用途とPOI利用状況');
  const categories = new Map<string, number>();
  for (const building of world.city.buildings) {
    const label = buildingCategoryLabel[building.category] ?? POICategory[building.category] ?? `種別 ${building.category}`;
    categories.set(label, (categories.get(label) ?? 0) + 1);
  }
  let occupancy = 0, capacity = 0, poiCount = 0;
  for (const poi of world.city.poi.all()) {
    poiCount++;
    occupancy += Math.max(0, poi.occupancy);
    capacity += Math.max(0, poi.capacity);
  }
  root.appendChild(metricGrid([
    metricCard('建物', fmtInt(world.city.buildings.length)),
    metricCard('POI', fmtInt(poiCount)),
    metricCard('利用人数', fmtInt(occupancy), `定員 ${fmtInt(capacity)}`),
    metricCard('POI利用率', fmtPct(capacity > 0 ? occupancy / capacity : 0)),
  ]));
  const chart = panel('建物用途別');
  chart.appendChild(barChart(Array.from(categories, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)));
  root.appendChild(chart);
  return root;
}

function carAnalytics(world: World): HTMLElement {
  const root = dashboard('乗用車サマリー', '一般乗用車のみ。バス・物流車・タクシーを除外');
  const taxis = new Set<number>();
  forEachTaxiVehicle(world.vehicles, (info) => taxis.add(info.vehicle));
  const counts = new Map<number, number>();
  let total = 0, moving = 0;
  for (let id = 0; id < world.vehicles.count; id++) {
    if (world.vehicles.isBus[id] || world.vehicles.isTruck[id] || taxis.has(id)) continue;
    total++;
    const state = world.vehicles.state[id];
    counts.set(state, (counts.get(state) ?? 0) + 1);
    if (state === VehicleState.Driving) moving++;
  }
  root.appendChild(metricGrid([
    metricCard('乗用車', fmtInt(total)),
    metricCard('走行中', fmtInt(moving)),
    metricCard('走行率', fmtPct(total > 0 ? moving / total : 0)),
  ]));
  const chart = panel('車両状態');
  chart.appendChild(barChart(Array.from(counts, ([state, value]) => ({ label: vehicleStateLabel[state] ?? `状態 ${state}`, value })).sort((a, b) => b.value - a.value)));
  root.appendChild(chart);
  return root;
}

function busAnalytics(world: World): HTMLElement {
  const root = dashboard('バス運行サマリー', '運行車両・乗車人数・平均混雑');
  const stateCounts = new Map<number, number>();
  let onboard = 0, seats = 0, moving = 0;
  for (let id = 0; id < world.bus.busCount; id++) {
    const status = world.bus.busStatus(id);
    if (!status) continue;
    onboard += status.onboard.length;
    seats += Math.max(0, status.capacity);
    const state = world.vehicles.state[status.vehicleId];
    stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
    if (state === VehicleState.Driving) moving++;
  }
  root.appendChild(metricGrid([
    metricCard('バス', fmtInt(world.bus.busCount)),
    metricCard('路線', fmtInt(world.bus.routes.length)),
    metricCard('運行中', fmtInt(moving)),
    metricCard('乗車中', fmtInt(onboard), `座席 ${fmtInt(seats)}`),
    metricCard('平均乗車率', fmtPct(seats > 0 ? onboard / seats : 0)),
  ]));
  const chart = panel('運行状態');
  chart.appendChild(barChart(Array.from(stateCounts, ([state, value]) => ({ label: vehicleStateLabel[state] ?? `状態 ${state}`, value })).sort((a, b) => b.value - a.value)));
  root.appendChild(chart);
  return root;
}

function taxiAnalytics(world: World): HTMLElement {
  const root = dashboard('タクシー営業サマリー', '待機・迎車・実車の構成');
  const phases = new Map<TaxiPhase, number>();
  let total = 0, active = 0, occupied = 0;
  forEachTaxiVehicle(world.vehicles, (info) => {
    total++;
    phases.set(info.phase, (phases.get(info.phase) ?? 0) + 1);
    if (info.phase !== 'idle') active++;
    if (info.phase === 'occupied' || info.phase === 'alighting') occupied++;
  });
  root.appendChild(metricGrid([
    metricCard('タクシー', fmtInt(total)),
    metricCard('営業対応中', fmtInt(active)),
    metricCard('実車', fmtInt(occupied)),
    metricCard('稼働率', fmtPct(total > 0 ? active / total : 0)),
  ]));
  const chart = panel('営業フェーズ');
  chart.appendChild(barChart(Array.from(phases, ([phase, value]) => ({ label: taxiPhaseLabel[phase] ?? phase, value })).sort((a, b) => b.value - a.value)));
  root.appendChild(chart);
  return root;
}

function trainAnalytics(main: HTMLElement): HTMLElement {
  const root = dashboard('列車運行サマリー', '現在ページに表示されている列車の状態');
  const search = main.querySelector<HTMLInputElement>('input[type="search"]');
  const controls = search?.parentElement;
  const list = controls?.nextElementSibling as HTMLElement | null;
  const counts = new Map<string, number>();
  let visible = 0;
  if (list) {
    for (const row of Array.from(list.children) as HTMLElement[]) {
      const cells = Array.from(row.children) as HTMLElement[];
      if (cells.length < 3 || cells[0]?.textContent === '対象') continue;
      const status = (cells[1]?.textContent ?? '').trim();
      if (!status) continue;
      visible++;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
  }
  const pager = controls?.querySelector('span')?.textContent ?? '';
  const totalMatch = pager.match(/([\d,]+)件/);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : visible;
  root.appendChild(metricGrid([
    metricCard('列車', fmtInt(Number.isFinite(total) ? total : visible)),
    metricCard('表示中', fmtInt(visible), total > visible ? 'グラフは現在ページ' : '全件表示'),
  ]));
  const chart = panel('運行状態');
  chart.appendChild(barChart(Array.from(counts, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)));
  root.appendChild(chart);
  return root;
}

function findMetricCard(main: HTMLElement, label: string): HTMLElement | null {
  for (const element of Array.from(main.querySelectorAll<HTMLElement>('div'))) {
    const children = Array.from(element.children) as HTMLElement[];
    if (children.length < 2) continue;
    if ((children[0]?.textContent ?? '').trim() !== label) continue;
    if (!children[1]?.textContent) continue;
    return element;
  }
  return null;
}

function setCardDetail(card: HTMLElement | null, detail: string): void {
  if (!card) return;
  const children = Array.from(card.children) as HTMLElement[];
  let target = children[2];
  if (!target) {
    target = document.createElement('div');
    target.style.cssText = 'color:#8296aa;font-size:10px;margin-top:3px';
    card.appendChild(target);
  }
  target.textContent = detail;
}

function patchPowerCards(world: World, main: HTMLElement, cityAvailable: number, externalAvailable: number): void {
  const snap = world.power.snapshot();
  const cityHeadroom = Math.max(0, cityAvailable - snap.cityGenerationMw);
  const externalHeadroom = Math.max(0, externalAvailable - snap.externalImportMw);
  setCardDetail(findMetricCard(main, '市内発電'), `利用可能 ${fmtMw(cityAvailable)}`);
  setCardDetail(findMetricCard(main, '外部受電'), `受電上限 ${fmtMw(externalAvailable)}`);
  const reserve = findMetricCard(main, '予備力');
  if (reserve) {
    const label = reserve.firstElementChild as HTMLElement | null;
    if (label) label.textContent = '利用可能余力';
    setCardDetail(reserve, `市内 ${fmtMw(cityHeadroom)} / 外部 ${fmtMw(externalHeadroom)}`);
  }
  const margin = findMetricCard(main, '予備率');
  if (margin) {
    const label = margin.firstElementChild as HTMLElement | null;
    if (label) label.textContent = '余力/需要';
    setCardDetail(margin, '利用可能余力 ÷ 現在需要');
  }
}

function patchGenerationRows(world: World, main: HTMLElement): void {
  const lifeline = new Map(world.power.lifelineGenerationSnapshots().map((item) => [item.facilityId, item] as const));
  const fuel = new Map(world.power.generationFuelSnapshots().map((item) => [item.facilityId, item] as const));
  const heading = Array.from(main.querySelectorAll('h2')).find((h) => h.textContent === '発電所・外部受電');
  const section = heading?.parentElement;
  if (!section) return;
  for (const row of Array.from(section.children) as HTMLElement[]) {
    if (row === heading) continue;
    const cells = Array.from(row.children) as HTMLElement[];
    if (cells.length < 3) continue;
    const title = cells[0]?.textContent ?? '';
    const facility = world.power.generationFacilities.find((item) => title.includes(item.id));
    if (facility) {
      const snap = world.power.getGenerationFacilitySnapshot(facility.id);
      if (!snap) continue;
      const staff = lifeline.get(facility.id);
      const inventory = fuel.get(facility.id);
      const staffText = staff ? `出勤 ${staff.onDutyStaff}/${staff.concurrentStaffTarget}` : '人員 --';
      const fuelText = facility.type === GenerationType.Thermal
        ? `燃料 ${inventory && inventory.capacityUnits > 0 ? fmtPct(inventory.stockUnits / inventory.capacityUnits) : '--'}`
        : '燃料不要';
      cells[2].textContent = `${fmtMw(snap.currentOutputMw)} / 利用可 ${fmtMw(snap.availableOutputMw)} / 定格 ${fmtMw(snap.maxOutputMw)} · ${staffText} · ${fuelText} · Zone ${snap.zoneId}`;
      continue;
    }
    const external = world.power.externalConnections.find((item) => title.includes(item.id));
    if (external) {
      const snap = world.power.getExternalConnectionSnapshot(external.id);
      if (!snap) continue;
      cells[2].textContent = `${fmtMw(snap.currentImportMw)} / 上限 ${fmtMw(snap.maxImportMw)} · 受電余力 ${fmtMw(Math.max(0, snap.maxImportMw - snap.currentImportMw))} · Zone ${snap.zoneId}`;
    }
  }
}

function powerAnalytics(world: World, main: HTMLElement): HTMLElement {
  samplePowerHistory();
  const snap = world.power.snapshot();
  let cityAvailable = 0;
  for (const facility of world.power.generationFacilities) {
    const item = world.power.getGenerationFacilitySnapshot(facility.id);
    if (item?.state === PowerAssetState.Online) cityAvailable += Math.max(0, item.availableOutputMw);
  }
  let externalAvailable = 0;
  for (const connection of world.power.externalConnections) {
    const item = world.power.getExternalConnectionSnapshot(connection.id);
    if (item?.state === PowerAssetState.Online) externalAvailable += Math.max(0, item.maxImportMw);
  }
  const cityHeadroom = Math.max(0, cityAvailable - snap.cityGenerationMw);
  const externalHeadroom = Math.max(0, externalAvailable - snap.externalImportMw);
  const lifeline = world.power.lifelineGenerationSnapshots();
  const onDuty = lifeline.reduce((sum, item) => sum + item.onDutyStaff, 0);
  const onDutyTarget = lifeline.reduce((sum, item) => sum + item.concurrentStaffTarget, 0);
  const fuels = world.power.generationFuelSnapshots();
  const fuelStock = fuels.reduce((sum, item) => sum + item.stockUnits, 0);
  const fuelCapacity = fuels.reduce((sum, item) => sum + item.capacityUnits, 0);

  patchPowerCards(world, main, cityAvailable, externalAvailable);
  patchGenerationRows(world, main);

  const root = dashboard('需給ダッシュボード', '直近のシミュレーション時刻を1分間隔で記録');
  root.appendChild(metricGrid([
    metricCard('市内発電余力', fmtMw(cityHeadroom), `利用可能 ${fmtMw(cityAvailable)}`),
    metricCard('外部受電余力', fmtMw(externalHeadroom), `上限 ${fmtMw(externalAvailable)}`),
    metricCard('発電所出勤', `${fmtInt(onDuty)}/${fmtInt(onDutyTarget)}`, onDutyTarget > 0 ? fmtPct(onDuty / onDutyTarget) : '--'),
    metricCard('火力燃料', fuelCapacity > 0 ? fmtPct(fuelStock / fuelCapacity) : '--', `${fmtInt(fuelStock)}/${fmtInt(fuelCapacity)} units`),
  ]));

  const trend = panel('需給トレンド（MW）');
  trend.appendChild(powerLineChart(powerHistory.slice(-60), [
    { label: '需要', key: 'demand', color: POWER_COLORS[0] },
    { label: '供給', key: 'supply', color: POWER_COLORS[1] },
    { label: '市内発電', key: 'city', color: POWER_COLORS[2] },
    { label: '外部受電', key: 'external', color: POWER_COLORS[3] },
  ]));

  const capacity = panel('現在の電源余力');
  capacity.appendChild(barChart([
    { label: '現在需要', value: snap.demandMw },
    { label: '市内発電', value: snap.cityGenerationMw },
    { label: '市内余力', value: cityHeadroom },
    { label: '外部受電', value: snap.externalImportMw },
    { label: '外部余力', value: externalHeadroom },
  ]));
  root.appendChild(twoColumn(trend, capacity));
  return root;
}

function decorateCurrentPage(): void {
  const world = latestWorld, main = menuMain;
  if (!world || !main) return;
  const heading = main.querySelector('h1')?.textContent?.trim();
  if (!heading) return;
  if (main.querySelector('[data-menu-analytics="1"]')) return;

  if (heading === '電力') {
    const analytics = powerAnalytics(world, main);
    const first = main.firstElementChild;
    if (first?.nextSibling) main.insertBefore(analytics, first.nextSibling);
    else main.appendChild(analytics);
    return;
  }

  let analytics: HTMLElement | null = null;
  if (heading === '建物一覧') analytics = buildingAnalytics(world);
  else if (heading === '乗用車一覧') analytics = carAnalytics(world);
  else if (heading === 'バス一覧') analytics = busAnalytics(world);
  else if (heading === 'タクシー一覧') analytics = taxiAnalytics(world);
  else if (heading === '列車一覧') analytics = trainAnalytics(main);
  if (analytics) insertBeforeControls(main, analytics);
}

const worldProto = World.prototype as unknown as AnyWorld;
if (!worldProto.__citySimFullScreenMenuAnalyticsV1021) {
  const previousPopulate = worldProto.populate as AnyMethod;
  worldProto.populate = function populateWithMenuAnalytics(this: World, ...args: any[]): any {
    captureWorld(this);
    const result = previousPopulate.apply(this, args);
    captureWorld(this);
    return result;
  };
  worldProto.__citySimFullScreenMenuAnalyticsV1021 = true;
}

installTimer = window.setInterval(() => {
  if (latestWorld) tryInstall();
  if (menuMain) window.clearInterval(installTimer);
}, 400);

sampleTimer = window.setInterval(() => {
  if (!latestWorld) return;
  samplePowerHistory();
  if (menuMain?.parentElement?.style.display !== 'none') queueDecorate();
}, 1500);
void sampleTimer;
