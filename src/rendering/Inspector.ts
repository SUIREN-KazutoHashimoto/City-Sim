import * as THREE from 'three';
import { World } from '../world/World';
import { InstancedRenderer } from './InstancedRenderer';
import type { CameraFollowTarget } from './FirstPersonController';
import { AgentState, Occupation, OCCUPATION_LABEL } from '../agents/AgentStore';
import { VehicleState } from '../traffic/VehicleStore';
import { POICategory } from '../world/POI';
import { FACILITY_LABEL } from '../generation/SpecialFacilityPlanner';

export class Inspector {
  private raycaster = new THREE.Raycaster(); private pointer = new THREE.Vector2();
  private el: HTMLDivElement; private pinEl: HTMLDivElement;
  private hasPointer = false; private leftHeld = false;
  private hoveredAgent = -1; private hoveredVehicle = -1;
  private followKind: 'none' | 'agent' | 'vehicle' = 'none'; private followId = -1;
  readonly followPos = new THREE.Vector3();
  private readonly followTarget: CameraFollowTarget = { kind: 'agent', id: -1, position: this.followPos };

  constructor(private world: World, private gfx: InstancedRenderer, private camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    this.el = this.panel('none'); this.pinEl = this.panel('none'); this.pinEl.style.left = '8px'; this.pinEl.style.bottom = '8px'; this.pinEl.style.borderColor = '#5a7fb0'; this.pinEl.style.maxWidth = '470px';
    this.dom.addEventListener('mousemove', (e) => { this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1; this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1; this.el.style.left = `${e.clientX + 16}px`; this.el.style.top = `${e.clientY + 16}px`; this.hasPointer = true; });
    this.dom.addEventListener('mousedown', (e) => { if (e.button === 0) this.leftHeld = true; if (e.button === 1) { e.preventDefault(); this.toggleFollow(); } });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.leftHeld = false; });
    window.addEventListener('blur', () => { this.leftHeld = false; this.hide(); });
  }

  private panel(display: string): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = ['position:fixed', 'z-index:20', 'pointer-events:none', 'font:12px/1.5 ui-monospace,monospace', 'color:#dfe8f5', 'background:rgba(12,17,25,.92)', 'border:1px solid #3a4a63', 'border-radius:8px', 'padding:8px 10px', 'max-width:330px', 'max-height:calc(100vh - 24px)', 'overflow:hidden', 'box-shadow:0 6px 20px rgba(0,0,0,.4)', 'white-space:pre-line', `display:${display}`].join(';');
    document.body.appendChild(el); return el;
  }

  private toggleFollow(): void {
    if (this.hoveredVehicle >= 0) {
      if (this.followKind === 'vehicle' && this.followId === this.hoveredVehicle) { this.followKind = 'none'; this.followId = -1; }
      else { this.followKind = 'vehicle'; this.followId = this.hoveredVehicle; }
    } else if (this.hoveredAgent >= 0) {
      if (this.followKind === 'agent' && this.followId === this.hoveredAgent) { this.followKind = 'none'; this.followId = -1; }
      else { this.followKind = 'agent'; this.followId = this.hoveredAgent; }
    } else { this.followKind = 'none'; this.followId = -1; }
  }

  get isFollowing(): boolean { return this.followKind !== 'none'; }
  get isFollowingVehicle(): boolean { return this.followKind === 'vehicle'; }

  getFollowTarget(): CameraFollowTarget | null {
    if (this.followKind === 'agent') {
      if (this.followId < 0 || this.followId >= this.world.store.count) { this.followKind = 'none'; return null; }
      const s = this.world.store;
      this.followPos.set(s.posX[this.followId], 0, s.posZ[this.followId]);
      this.followTarget.kind = 'agent'; this.followTarget.id = this.followId; this.followTarget.heading = s.heading[this.followId]; this.followTarget.length = undefined; this.followTarget.firstPersonHeight = undefined;
      return this.followTarget;
    }
    if (this.followKind === 'vehicle') {
      const vs = this.world.vehicles;
      if (this.followId < 0 || this.followId >= vs.count) { this.followKind = 'none'; return null; }
      this.followPos.set(vs.posX[this.followId], 0, vs.posZ[this.followId]);
      this.followTarget.kind = 'vehicle'; this.followTarget.id = this.followId; this.followTarget.heading = vs.heading[this.followId]; this.followTarget.length = vs.length[this.followId] || 4.5;
      this.followTarget.firstPersonHeight = vs.isBus[this.followId] ? 2.35 : vs.isTruck[this.followId] ? 2.0 : 1.3;
      return this.followTarget;
    }
    return null;
  }

  /** 従来API互換。 */
  getFollowPosition(): THREE.Vector3 | null { return this.getFollowTarget()?.position ?? null; }

  private hide(): void { this.el.style.display = 'none'; }

  update(): void {
    if (this.followKind === 'agent' && this.followId < this.world.store.count) { this.pinEl.textContent = '📌 追跡: 市民\n' + this.describeAgent(this.followId); this.pinEl.style.display = 'block'; }
    else if (this.followKind === 'vehicle' && this.followId < this.world.vehicles.count) { this.pinEl.textContent = '📌 追跡: 車両\n' + this.describeVehicle(this.followId); this.pinEl.style.display = 'block'; }
    else this.pinEl.style.display = 'none';

    this.hoveredAgent = -1; this.hoveredVehicle = -1;
    if (this.leftHeld || !this.hasPointer) { this.hide(); return; }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const aHit = this.gfx.agents ? this.raycaster.intersectObject(this.gfx.agents, false) : [];
    const vHit = this.gfx.vehicles ? this.raycaster.intersectObject(this.gfx.vehicles, false) : [];
    const bHit = this.gfx.buildings ? this.raycaster.intersectObject(this.gfx.buildings, false) : [];
    const aD = aHit.length ? aHit[0].distance : Infinity, vD = vHit.length ? vHit[0].distance : Infinity, bD = bHit.length ? bHit[0].distance : Infinity;
    if (aD <= vD && aD <= bD && aHit[0]?.instanceId != null) { const idx = this.gfx.agentIndexOf(aHit[0].instanceId); if (idx >= 0) { this.hoveredAgent = idx; this.el.textContent = this.describeAgent(idx); this.el.style.display = 'block'; return; } }
    if (vD <= bD && vHit[0]?.instanceId != null) { const vi = this.gfx.vehicleIndexOf(vHit[0].instanceId); if (vi >= 0) { this.hoveredVehicle = vi; this.el.textContent = this.describeVehicle(vi); this.el.style.display = 'block'; return; } }
    if (bHit.length && bHit[0].instanceId != null) { this.el.textContent = this.describeBuilding(bHit[0].instanceId); this.el.style.display = 'block'; } else this.hide();
  }

  private bar(v: number): string { const n = Math.round(THREE.MathUtils.clamp(v, 0, 1) * 10); return '█'.repeat(n) + '░'.repeat(10 - n); }

  private describeAgent(i: number): string {
    const s = this.world.store; const state = AgentState[s.state[i]] ?? '?'; const goal = s.goalPOI[i]; const goalCat = goal >= 0 ? POICategory[this.world.city.poi.get(goal).category] : '—';
    const occ = OCCUPATION_LABEL[s.occupation[i] as Occupation] ?? '?'; const speed = Math.hypot(s.velX[i], s.velZ[i]); const wait = s.waiting[i] ? '  🚦信号待ち' : '';
    const wh = s.workEnd[i] !== s.workStart[i] ? `${s.workStart[i]}-${s.workEnd[i]}時` : '不定';
    return `👤 市民 #${i}  [${occ}]\n年齢 ${s.age[i]}   車 ${s.ownsCar[i] ? '🚗有' : '無'}   勤務 ${wh}\n状態 ${state}${wait}   速度 ${speed.toFixed(1)} m/s\n目的地 ${goalCat}\n─────────────\n体力 ${this.bar(s.energy[i])}\n満腹 ${this.bar(s.hunger[i])}\n社交 ${this.bar(s.social[i])}\n娯楽 ${this.bar(s.fun[i])}`;
  }

  private formatRouteStops(stops: number[], current: number): string {
    const items = stops.map((sid, idx) => `${idx === current ? '▶' : ''}${idx + 1}:#${sid}`);
    const rows: string[] = []; for (let i = 0; i < items.length; i += 10) rows.push(items.slice(i, i + 10).join('  ')); return rows.join('\n');
  }

  private formatPassengerDestinations(agents: number[]): string {
    if (agents.length === 0) return '  なし';
    const items = agents.map((agent) => {
      const stopId = this.world.bus.alightStopFor(agent), stop = stopId >= 0 ? this.world.bus.stopById(stopId) : null;
      return stop ? `#${agent}→S${stopId}(${stop.x.toFixed(0)},${stop.z.toFixed(0)})` : `#${agent}→未定`;
    });
    const rows: string[] = []; for (let i = 0; i < items.length; i += 3) rows.push('  ' + items.slice(i, i + 3).join('   ')); return rows.join('\n');
  }

  private describeBus(v: number): string {
    const vs = this.world.vehicles, bid = vs.busId[v], snap = bid >= 0 ? this.world.bus.busStatus(bid) : null;
    if (!snap) return `🚌 路線バス #${bid}\n運行情報なし`;
    const target = snap.targetStopId >= 0 ? this.world.bus.stopById(snap.targetStopId) : null;
    const kmh = vs.speed[v] * 3.6, maxKmh = vs.maxSpeed[v] * 3.6;
    const status = snap.dwellRemaining > 0 ? `🛑 停留所#${snap.targetStopId} 停車中 あと${snap.dwellRemaining.toFixed(1)}s` : vs.speed[v] < 0.3 ? '🛑 信号/渋滞で停止' : `🚌 走行中 → 停留所#${snap.targetStopId}`;
    const road = vs.fromNode[v] >= 0 ? `${vs.fromNode[v]}→${vs.toNode[v]} ${(vs.segT[v] * 100).toFixed(0)}%` : '—';
    const targetText = target ? `S${target.id} (${target.x.toFixed(0)}, ${target.z.toFixed(0)})` : '—';
    return `🚌 路線バス #${bid}  路線 R${snap.routeId}\n${status}\n速度 ${kmh.toFixed(0)} km/h (上限 ${maxKmh.toFixed(0)})\n現在地 (${vs.posX[v].toFixed(1)}, ${vs.posZ[v].toFixed(1)})  road ${road}\n次/現在停留所 ${targetText}\n乗客 ${snap.onboard.length} / ${snap.capacity}\n──────── 路線全体 (${snap.routeStops.length} stop) ────────\n${this.formatRouteStops(snap.routeStops, snap.sequenceIndex)}\n──────── 乗客の降車予定地 ────────\n${this.formatPassengerDestinations(snap.onboard)}`;
  }

  private describeVehicle(v: number): string {
    const vs = this.world.vehicles; const parked = vs.state[v] === VehicleState.Parked; const kmh = vs.speed[v] * 3.6, maxKmh = vs.maxSpeed[v] * 3.6, accel = vs.accel[v], driver = vs.driver[v];
    if (vs.isBus[v]) return this.describeBus(v);
    if (vs.isTruck[v]) { const tid = vs.truckId[v]; const phase = tid >= 0 ? this.world.logistics.truckPhase(tid) : ''; const cargo = tid >= 0 ? this.world.logistics.truckCargo(tid) : 0; const cap = tid >= 0 ? this.world.logistics.truckCapacity(tid) : 200; const label = phase === 'toStore' ? '🏪 配送先へ' : phase === 'unloading' ? '📦 荷降ろし中' : phase === 'returning' ? '🚚 拠点へ帰還' : '待機'; return `🚚 配送トラック #${tid}\n${label}\n速度 ${kmh.toFixed(0)} km/h\n積荷 ${cargo} / ${cap}`; }
    if (parked) return `🚗 車両 #${v}\n🅿️ 駐車中\n所有者 市民#${driver}\n車長 ${vs.length[v].toFixed(1)} m`;
    let goalCat = '—'; if (driver >= 0) { const g = this.world.store.goalPOI[driver]; if (g >= 0) goalCat = POICategory[this.world.city.poi.get(g).category]; }
    const path = vs.paths[v]; const prog = path.length > 1 ? `${vs.pathCursor[v]}/${path.length - 1}` : '—'; const status = vs.speed[v] < 0.3 ? '🛑 停止(信号待ち/渋滞)' : '🚗 走行中';
    return `🚗 車両 #${v}\n${status}\n速度 ${kmh.toFixed(0)} km/h (上限 ${maxKmh.toFixed(0)})\n加速度 ${accel >= 0 ? '+' : ''}${accel.toFixed(1)} m/s²\n目的地 ${goalCat}   経路 ${prog}\n運転者 市民#${driver}`;
  }

  private describeBuilding(i: number): string {
    const b = this.world.city.buildings[i]; if (!b) return ''; const cat = POICategory[b.category] ?? '?';
    const facility = this.world.city.facilities.find((f) => f.buildingId === b.id);
    const facilityText = facility ? `\n施設 ${FACILITY_LABEL[facility.type]}  定員 ${facility.capacity}` : '';
    const pois = this.world.city.poi.poisInBuilding(b.id); let occ = 0, cap = 0; for (const p of pois) { occ += p.occupancy; cap += p.capacity; }
    const uses = pois.length ? pois.map((p) => { const stk = p.maxStock > 0 ? `  在庫${p.stock}/${p.maxStock}` : ''; return `  · ${POICategory[p.category]} (在 ${p.occupancy}/${p.capacity})${stk}`; }).join('\n') : '  · 用途なし';
    const dev = `地価 ${b.landValue.toFixed(2)}  開発強度 ${b.developmentIntensity.toFixed(2)}\n敷地 ${b.siteArea.toFixed(0)}m²  統合Parcel ${b.parcelCount}\n建ぺい率 ${(b.coverageRatio * 100).toFixed(0)}%  容積率 ${(b.floorAreaRatio * 100).toFixed(0)}%`;
    const plan = this.world.city.planning.sample(b.x, b.z);
    const station = plan.nearestStationId >= 0 ? this.world.city.planning.rail.stations[plan.nearestStationId] : null;
    const transitText = station && plan.transitInfluence > 0.02 ? `\n最寄駅 ${station.name}  駅勢圏 ${(plan.transitInfluence * 100).toFixed(0)}%` : '';
    return `🏢 建物 #${b.id}  [${cat}]${facilityText}\n階数 ${b.floors}F   間口 ${b.width.toFixed(0)}×${b.depth.toFixed(0)} m\n${dev}${transitText}\n在館 ${occ} / 収容 ${cap}\n─────────────\n入居用途:\n${uses}`;
  }
}
