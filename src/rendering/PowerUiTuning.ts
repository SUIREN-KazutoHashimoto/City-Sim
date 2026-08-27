import { GenerationType, PowerAssetState, PowerGridState, PowerLineState, PowerPriority, BuildingPowerState } from '../power/PowerTypes';
import { World } from '../world/World';
import { FirstPersonController } from './FirstPersonController';
import { UniversalInspector } from './UniversalInspector';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

let latestWorld: World | null = null;
let latestController: FirstPersonController | null = null;
let powerActive = false;
let powerButton: HTMLButtonElement | null = null;
let menuMain: HTMLElement | null = null;
let menuAside: HTMLElement | null = null;
let refreshTimer = 0;
let observer: MutationObserver | null = null;

const gridStateLabel: Record<string, string> = {
  [PowerGridState.Normal]: '正常',
  [PowerGridState.Tight]: '逼迫',
  [PowerGridState.LimitedSupply]: '制限給電',
  [PowerGridState.Blackout]: '停電',
};
const assetStateLabel: Record<string, string> = {
  [PowerAssetState.Online]: '稼働', [PowerAssetState.Standby]: '待機', [PowerAssetState.Offline]: '停止', [PowerAssetState.Fault]: '故障',
};
const buildingStateLabel: Record<string, string> = {
  [BuildingPowerState.Supplied]: '給電中', [BuildingPowerState.Limited]: '制限給電', [BuildingPowerState.Blackout]: '停電', [BuildingPowerState.Disconnected]: '未接続',
};
const priorityLabel: Record<number, string> = {
  [PowerPriority.Critical]: '最優先', [PowerPriority.High]: '高', [PowerPriority.Medium]: '中', [PowerPriority.Low]: '低',
};

function fmtMw(value: number): string { return `${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)} MW`; }
function fmtPct(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function fmtHz(value: number): string { return `${value.toFixed(2)} Hz`; }
function fmtKv(value: number): string { return `${value.toFixed(2)} kV`; }
function fmtMvar(value: number): string { return `${value.toFixed(1)} Mvar`; }
function fmtPf(value: number): string { return value.toFixed(3); }

function ensureCapturedWorld(world: World): void {
  latestWorld = world;
  tryInstallPowerTab();
}

function menuElements(): { aside: HTMLElement; main: HTMLElement } | null {
  for (const aside of Array.from(document.querySelectorAll<HTMLElement>('aside'))) {
    if (!aside.textContent?.includes('CITY SIM MENU')) continue;
    const parent = aside.parentElement;
    const main = parent?.querySelector<HTMLElement>(':scope > main');
    if (parent && main) return { aside, main };
  }
  return null;
}

function tryInstallPowerTab(): void {
  if (powerButton || !latestWorld) return;
  const found = menuElements();
  if (!found) return;
  menuAside = found.aside; menuMain = found.main;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '電力';
  button.style.cssText = 'text-align:left;border:1px solid #27384b;background:#111c28;color:#dce8f5;border-radius:7px;padding:10px 11px;cursor:pointer;font:inherit';
  const graphics = Array.from(found.aside.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === 'グラフィックス設定');
  found.aside.insertBefore(button, graphics ?? null);
  powerButton = button;

  for (const other of Array.from(found.aside.querySelectorAll<HTMLButtonElement>('button'))) {
    if (other === button) continue;
    other.addEventListener('click', () => {
      powerActive = false;
      setButtonState(false);
      if (other.textContent === '建物一覧') queueMicrotask(annotateBuildingRows);
    });
  }
  button.addEventListener('click', () => {
    powerActive = true;
    setButtonState(true);
    renderPowerPanel();
  });

  observer = new MutationObserver(() => {
    if (!powerActive) queueMicrotask(annotateBuildingRows);
  });
  observer.observe(found.main, { childList: true, subtree: true });
  queueMicrotask(annotateBuildingRows);

  if (!refreshTimer) {
    refreshTimer = window.setInterval(() => {
      if (powerActive && menuMain?.parentElement?.style.display !== 'none') renderPowerPanel();
      else annotateBuildingRows();
    }, 1500);
  }
}

function setButtonState(active: boolean): void {
  if (!powerButton || !menuAside) return;
  for (const button of Array.from(menuAside.querySelectorAll<HTMLButtonElement>('button'))) {
    if (button === powerButton) {
      button.style.background = active ? '#253b52' : '#111c28';
      button.style.borderColor = active ? '#5d82aa' : '#27384b';
    } else if (active) {
      button.style.background = '#111c28';
      button.style.borderColor = '#27384b';
    }
  }
}

function annotateBuildingRows(): void {
  const world = latestWorld, main = menuMain;
  if (!world || !main || powerActive) return;
  const heading = main.querySelector('h1');
  if (heading?.textContent !== '建物一覧') return;
  for (const row of Array.from(main.querySelectorAll<HTMLElement>('div'))) {
    if (row.dataset.powerAnnotated === '1') continue;
    const cells = Array.from(row.children) as HTMLElement[];
    if (cells.length < 3) continue;
    const match = cells[0]?.textContent?.match(/^#(\d+)\b/);
    if (!match) continue;
    const id = Number(match[1]);
    const power = world.power.getBuildingSnapshot(id);
    if (!power) continue;
    cells[1].textContent = `${cells[1].textContent ?? ''} · 給電 ${(power.supplyRatio * 100).toFixed(0)}%`;
    cells[2].textContent = `${cells[2].textContent ?? ''} · ${buildingStateLabel[power.state] ?? power.state}`;
    row.dataset.powerAnnotated = '1';
  }
}

function panelTitle(text: string, note?: string): HTMLElement {
  const wrap = document.createElement('div');
  const title = document.createElement('h1'); title.textContent = text; title.style.cssText = 'font-size:22px;margin:0 0 6px';
  wrap.appendChild(title);
  if (note) { const el = document.createElement('div'); el.textContent = note; el.style.cssText = 'color:#8fa3ba;margin-bottom:18px'; wrap.appendChild(el); }
  return wrap;
}

function card(label: string, value: string, detail = ''): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'border:1px solid #293b50;border-radius:9px;background:#0c151f;padding:12px 14px;min-width:0';
  const l = document.createElement('div'); l.textContent = label; l.style.cssText = 'color:#849ab2;font-size:11px;margin-bottom:4px';
  const v = document.createElement('div'); v.textContent = value; v.style.cssText = 'font-size:18px;font-weight:800;color:#eef5fd';
  el.append(l, v);
  if (detail) { const d = document.createElement('div'); d.textContent = detail; d.style.cssText = 'color:#8296aa;font-size:10px;margin-top:3px'; el.appendChild(d); }
  return el;
}

function section(titleText: string, rows: HTMLElement[], emptyText = '該当なし'): HTMLElement {
  const section = document.createElement('section'); section.style.cssText = 'margin-top:22px';
  const title = document.createElement('h2'); title.textContent = titleText; title.style.cssText = 'font-size:16px;margin:0 0 9px;color:#dfeaf7';
  section.appendChild(title);
  if (!rows.length) { const empty = document.createElement('div'); empty.textContent = emptyText; empty.style.cssText = 'padding:14px;border:1px solid #1f2f40;border-radius:7px;color:#70869c;background:#0a121b'; section.appendChild(empty); }
  else for (const row of rows) section.appendChild(row);
  return section;
}

function listRow(titleText: string, status: string, detail: string, jump?: () => void): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:grid;grid-template-columns:minmax(180px,1.1fr) minmax(150px,.75fr) minmax(260px,1.7fr) auto;gap:12px;align-items:center;border:1px solid #1e2d3e;border-radius:7px;padding:9px 10px;margin-bottom:5px;background:#0b131d';
  const title = document.createElement('div'); title.textContent = titleText; title.style.fontWeight = '700';
  const st = document.createElement('div'); st.textContent = status; st.style.color = '#b8cee5';
  const det = document.createElement('div'); det.textContent = detail; det.style.cssText = 'color:#8fa3b9;min-width:0;overflow:hidden;text-overflow:ellipsis';
  row.append(title, st, det);
  if (jump) { const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'ジャンプ'; btn.style.cssText = 'border:1px solid #3b5067;background:#162535;color:#edf4fc;border-radius:6px;padding:6px 9px;font:inherit;cursor:pointer;white-space:nowrap'; btn.addEventListener('click', jump); row.appendChild(btn); }
  else row.appendChild(document.createElement('span'));
  return row;
}

function jumpTo(x: number, z: number, height = 32): void {
  const controller = latestController as unknown as AnyHost | null;
  if (!controller) return;
  const camera = controller.camera as { position?: { set: (x: number, y: number, z: number) => void }; lookAt?: (x: number, y: number, z: number) => void } | undefined;
  const distance = Math.max(42, height * 1.4);
  controller.setFollowTarget?.(null);
  if (camera?.position && camera.lookAt) {
    camera.position.set(x - distance, height + 28, z - distance);
    camera.lookAt(x, Math.max(2, height * 0.35), z);
    controller.syncFreeAnglesFromCamera?.();
  } else controller.setPosition?.(x - distance, height + 28, z - distance);
  const overlay = menuMain?.parentElement;
  if (overlay) overlay.style.display = 'none';
  const menuButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'MENU  F10');
  if (menuButton) menuButton.style.display = 'block';
  powerActive = false; setButtonState(false);
}

function renderPowerPanel(): void {
  const world = latestWorld, main = menuMain;
  if (!world || !main) return;
  const system = world.power;
  const snap = system.snapshot();
  const quality = system.powerQualitySnapshot();
  main.replaceChildren();
  main.appendChild(panelTitle('電力', '都市の需給、発電設備、変電所、系統、過負荷、停電と電力品質を確認します。'));

  const cards = document.createElement('div');
  cards.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-bottom:10px';
  cards.append(
    card('状態', gridStateLabel[snap.state] ?? snap.state),
    card('需要', fmtMw(snap.demandMw)),
    card('供給', fmtMw(snap.suppliedMw), fmtPct(snap.demandMw > 0 ? snap.suppliedMw / snap.demandMw : 1)),
    card('市内発電', fmtMw(snap.cityGenerationMw)),
    card('外部受電', fmtMw(snap.externalImportMw)),
    card('予備力', fmtMw(snap.reserveMw)),
    card('予備率', fmtPct(snap.reserveMarginRatio)),
    card('停電建物', snap.blackoutBuildingCount.toLocaleString(), `制限 ${snap.limitedBuildingCount.toLocaleString()} / 未接続 ${snap.disconnectedBuildingCount.toLocaleString()}`),
  );
  main.appendChild(cards);

  const qualityCards = document.createElement('div');
  qualityCards.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-top:8px';
  qualityCards.append(
    card('周波数', fmtHz(quality.frequencyHz), `基準 ${fmtHz(quality.nominalFrequencyHz)}`),
    card('系統電圧', fmtKv(quality.averageGridVoltageKv), `${fmtPct(quality.averageVoltagePu)} pu`),
    card('無効電力', fmtMvar(quality.reactivePowerMvar)),
    card('力率', fmtPf(quality.powerFactor)),
    card('皮相電力', `${quality.apparentPowerMva.toFixed(1)} MVA`),
    card('相不平衡', fmtPct(quality.phaseImbalanceRatio)),
  );
  main.appendChild(qualityCards);

  const generationRows = system.generationFacilities.map((facility) => {
    const s = system.getGenerationFacilitySnapshot(facility.id)!;
    const type = s.type === GenerationType.Thermal ? '火力' : '太陽光';
    return listRow(`${type} ${s.id}`, assetStateLabel[s.state] ?? s.state, `${s.currentOutputMw.toFixed(1)}/${s.maxOutputMw.toFixed(1)} MW · 稼働率 ${fmtPct(s.utilization)} · Zone ${s.zoneId}`, () => jumpTo(s.x, s.z, 34));
  });
  for (const ext of system.externalConnections) {
    const s = system.getExternalConnectionSnapshot(ext.id)!;
    generationRows.push(listRow(`外部系統 ${s.id}`, assetStateLabel[s.state] ?? s.state, `${s.currentImportMw.toFixed(1)}/${s.maxImportMw.toFixed(1)} MW · 利用率 ${fmtPct(s.utilization)} · Zone ${s.zoneId}`, () => jumpTo(s.x, s.z, 30)));
  }
  main.appendChild(section('発電所・外部受電', generationRows));

  const substations = system.substations.map((substation) => {
    const s = system.getSubstationSnapshot(substation.id)!;
    return listRow(s.id, assetStateLabel[s.state] ?? s.state, `${s.suppliedMw.toFixed(1)}/${s.capacityMw.toFixed(1)} MW · 利用率 ${fmtPct(s.utilization)} · 建物 ${s.assignedBuildingCount} · ${s.overload ? '容量超過' : '正常'}`, () => jumpTo(s.x, s.z, 26));
  });
  main.appendChild(section('変電所一覧', substations));

  const electricalByZone = new Map(system.powerZoneElectricalSnapshots().map((zone) => [zone.zoneId, zone] as const));
  const zones = system.getPowerZoneSnapshots().map((zone) => {
    const e = electricalByZone.get(zone.id);
    return listRow(`Zone ${zone.id}`, zone.blackoutBuildingCount > 0 ? `停電 ${zone.blackoutBuildingCount}` : zone.overloadedLineCount > 0 ? '過負荷' : '正常', `${zone.suppliedMw.toFixed(1)}/${zone.demandMw.toFixed(1)} MW · 予備率 ${fmtPct(zone.reserveMarginRatio)} · ${e ? `${fmtHz(e.frequencyHz)} / ${fmtKv(e.lineLineVoltageKv)} / PF ${fmtPf(e.powerFactor)}` : '電気品質なし'}`);
  });
  main.appendChild(section('系統一覧', zones));

  const overloaded = system.lineSegments.filter((line) => line.overload || line.state === PowerLineState.Broken).map((line) => {
    const s = system.getLineSegmentSnapshot(line.id)!;
    const electrical = system.powerLineElectricalSnapshot(line.id);
    const a = world.city.net.nodes[line.fromNodeId], b = world.city.net.nodes[line.toNodeId];
    return listRow(`Line #${line.id}`, line.state === PowerLineState.Broken ? '断線' : '過負荷', `${s.currentLoadMw.toFixed(1)}/${s.capacityMw.toFixed(1)} MW · 負荷率 ${fmtPct(s.loadRatio)}${electrical ? ` · ΔV ${fmtPct(electrical.voltageDropPu)}` : ''}`, () => jumpTo((a.x + b.x) * 0.5, (a.z + b.z) * 0.5, 20));
  });
  main.appendChild(section('過負荷・断線区間', overloaded));

  const blackoutRows: HTMLElement[] = [];
  for (const building of world.city.buildings) {
    const s = system.getBuildingSnapshot(building.id);
    if (!s || (s.state !== BuildingPowerState.Blackout && s.state !== BuildingPowerState.Disconnected && s.supplyRatio >= 0.999)) continue;
    const e = system.buildingElectricalSnapshot(building.id);
    blackoutRows.push(listRow(`建物 #${building.id}`, buildingStateLabel[s.state] ?? s.state, `需要 ${s.demandKw.toFixed(1)} kW · 給電 ${s.suppliedKw.toFixed(1)} kW (${fmtPct(s.supplyRatio)}) · ${s.substationId ?? '変電所なし'}${e ? ` · ${e.serviceVoltageV.toFixed(0)} V / ${fmtHz(e.frequencyHz)}` : ''}`, () => jumpTo(building.x, building.z, Math.max(12, building.floors * 3.2))));
    if (blackoutRows.length >= 300) break;
  }
  main.appendChild(section(`停電・制限建物 ${snap.blackoutBuildingCount + snap.disconnectedBuildingCount + snap.limitedBuildingCount}件`, blackoutRows, '停電・制限中の建物はありません'));
}

const worldProto = World.prototype as unknown as AnyHost;
if (!worldProto.__citySimPowerUiCaptureV110) {
  const previousPopulate = worldProto.populate as AnyMethod;
  worldProto.populate = function populateAndCapturePowerUi(this: World, ...args: any[]): any {
    const result = previousPopulate.apply(this, args);
    ensureCapturedWorld(this);
    return result;
  };
  worldProto.__citySimPowerUiCaptureV110 = true;
}

const controllerProto = FirstPersonController.prototype as unknown as AnyHost;
if (!controllerProto.__citySimPowerUiCaptureV110) {
  const previousSetPosition = controllerProto.setPosition as AnyMethod;
  controllerProto.setPosition = function setPositionAndCapturePowerUi(this: FirstPersonController, ...args: any[]): any {
    latestController = this; tryInstallPowerTab(); return previousSetPosition.apply(this, args);
  };
  controllerProto.__citySimPowerUiCaptureV110 = true;
}

const inspectorProto = UniversalInspector.prototype as unknown as AnyHost;
if (!inspectorProto.__citySimPowerInspectorV110) {
  const previousDescribeBuilding = inspectorProto.describeBuilding as (id: number) => string;
  inspectorProto.describeBuilding = function describeBuildingWithPower(this: AnyHost, id: number): string {
    const base = previousDescribeBuilding.call(this, id);
    const world = this.world as World | undefined;
    if (!world) return base;
    const p = world.power.getBuildingSnapshot(id);
    if (!p) return base;
    const e = world.power.buildingElectricalSnapshot(id);
    const electrical = e
      ? `\n電圧 ${e.serviceVoltageV.toFixed(0)}V (${fmtPct(e.voltagePu)}) / ${fmtHz(e.frequencyHz)} / PF ${fmtPf(e.powerFactor)} / 相 ${e.phase}`
      : '';
    return `${base}\n電力 需要 ${p.demandKw.toFixed(1)}kW / 給電 ${p.suppliedKw.toFixed(1)}kW / 給電率 ${fmtPct(p.supplyRatio)}\n接続 ${p.substationId ?? 'なし'} / 優先度 ${priorityLabel[p.priority] ?? p.priority} / 状態 ${buildingStateLabel[p.state] ?? p.state}${electrical}`;
  };
  inspectorProto.__citySimPowerInspectorV110 = true;
}

const installTimer = window.setInterval(() => {
  tryInstallPowerTab();
  if (powerButton) window.clearInterval(installTimer);
}, 400);
