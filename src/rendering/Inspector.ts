import * as THREE from 'three';
import { World } from '../world/World';
import { InstancedRenderer } from './InstancedRenderer';
import { AgentState } from '../agents/AgentStore';
import { POICategory } from '../world/POI';

/**
 * ============================================================================
 *  Inspector: ホバーで対象を調べるツールチップ + エージェント追跡
 * ============================================================================
 * 左ボタン非押下(=ステータス表示モード)のとき、マウス直下の歩行者/建物を
 * レイキャストで特定し説明とステータスを表示する。左ボタン押下中は視点回転優先。
 * エージェント上でホイールクリックすると追跡(常時ステータス+カメラ追従)。
 */
export class Inspector {
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private el: HTMLDivElement;
  private pinEl: HTMLDivElement;
  private hasPointer = false;
  private leftHeld = false;

  private hoveredAgent = -1;
  private followedAgent = -1;
  readonly followPos = new THREE.Vector3();

  constructor(
    private world: World,
    private gfx: InstancedRenderer,
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    this.el = this.makePanel('none');
    this.pinEl = this.makePanel('none');
    this.pinEl.style.left = '8px';
    this.pinEl.style.bottom = '8px';
    this.pinEl.style.borderColor = '#5a7fb0';

    this.dom.addEventListener('mousemove', (e) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
      this.el.style.left = `${e.clientX + 16}px`;
      this.el.style.top = `${e.clientY + 16}px`;
      this.hasPointer = true;
    });
    this.dom.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.leftHeld = true;
      if (e.button === 1) { e.preventDefault(); this.toggleFollow(); }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.leftHeld = false; });
    window.addEventListener('blur', () => { this.leftHeld = false; this.hide(); });
  }

  private makePanel(display: string): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'z-index:20', 'pointer-events:none',
      'font:12px/1.5 ui-monospace,monospace', 'color:#dfe8f5',
      'background:rgba(12,17,25,.92)', 'border:1px solid #3a4a63',
      'border-radius:8px', 'padding:8px 10px', 'max-width:280px',
      'box-shadow:0 6px 20px rgba(0,0,0,.4)', 'white-space:pre-line',
      `display:${display}`,
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  private toggleFollow(): void {
    if (this.hoveredAgent >= 0 && this.hoveredAgent !== this.followedAgent) {
      this.followedAgent = this.hoveredAgent;
    } else {
      this.followedAgent = -1;
    }
  }

  get isFollowing(): boolean { return this.followedAgent >= 0; }
  getFollowPosition(): THREE.Vector3 | null {
    if (this.followedAgent < 0) return null;
    const s = this.world.store;
    this.followPos.set(s.posX[this.followedAgent], 0, s.posZ[this.followedAgent]);
    return this.followPos;
  }
  stopFollow(): void { this.followedAgent = -1; }

  private hide(): void { this.el.style.display = 'none'; }

  update(): void {
    if (this.followedAgent >= 0) {
      if (this.followedAgent < this.world.store.count) {
        this.pinEl.textContent = '📌 追跡中\n' + this.describeAgent(this.followedAgent);
        this.pinEl.style.display = 'block';
      } else { this.followedAgent = -1; this.pinEl.style.display = 'none'; }
    } else {
      this.pinEl.style.display = 'none';
    }

    this.hoveredAgent = -1;
    if (this.leftHeld || !this.hasPointer) { this.hide(); return; }
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const agentMesh = this.gfx.agents;
    const buildingMesh = this.gfx.buildings;
    const agentHit = agentMesh ? this.raycaster.intersectObject(agentMesh, false) : [];
    const buildingHit = buildingMesh ? this.raycaster.intersectObject(buildingMesh, false) : [];

    const aDist = agentHit.length ? agentHit[0].distance : Infinity;
    const bDist = buildingHit.length ? buildingHit[0].distance : Infinity;

    if (aDist < bDist && agentHit[0].instanceId != null) {
      this.hoveredAgent = agentHit[0].instanceId;
      this.el.textContent = this.describeAgent(agentHit[0].instanceId);
      this.el.style.display = 'block';
    } else if (buildingHit.length && buildingHit[0].instanceId != null) {
      this.el.textContent = this.describeBuilding(buildingHit[0].instanceId);
      this.el.style.display = 'block';
    } else {
      this.hide();
    }
  }

  private bar(v: number): string {
    const n = Math.round(THREE.MathUtils.clamp(v, 0, 1) * 10);
    return '█'.repeat(n) + '░'.repeat(10 - n);
  }

  private describeAgent(i: number): string {
    const s = this.world.store;
    const state = AgentState[s.state[i]] ?? '?';
    const goal = s.goalPOI[i];
    const goalCat = goal >= 0 ? POICategory[this.world.city.poi.get(goal).category] : '—';
    const speed = Math.hypot(s.velX[i], s.velZ[i]);
    return (
      `👤 市民 #${i}\n` +
      `年齢 ${s.age[i]}   所持金 ${(s.wealth[i] * 100).toFixed(0)}%\n` +
      `状態 ${state}   速度 ${speed.toFixed(1)} m/s\n` +
      `目的地 ${goalCat}\n` +
      `─────────────\n` +
      `体力 ${this.bar(s.energy[i])}\n` +
      `満腹 ${this.bar(s.hunger[i])}\n` +
      `社交 ${this.bar(s.social[i])}\n` +
      `衛生 ${this.bar(s.hygiene[i])}\n` +
      `娯楽 ${this.bar(s.fun[i])}`
    );
  }

  private describeBuilding(i: number): string {
    const b = this.world.city.buildings[i];
    if (!b) return '';
    const cat = POICategory[b.category] ?? '?';
    const pois = this.world.city.poi.poisInBuilding(b.id);
    let occ = 0, cap = 0;
    for (const p of pois) { occ += p.occupancy; cap += p.capacity; }
    const uses = pois.length
      ? pois.map((p) => `  · ${POICategory[p.category]} (在 ${p.occupancy}/${p.capacity})`).join('\n')
      : '  · 用途なし';
    return (
      `🏢 建物 #${b.id}  [${cat}]\n` +
      `階数 ${b.floors}F   間口 ${b.width.toFixed(0)}×${b.depth.toFixed(0)} m\n` +
      `延床(概算) ${(b.width * b.depth * b.floors).toFixed(0)} m²\n` +
      `在館 ${occ} / 収容 ${cap}\n` +
      `─────────────\n` +
      `入居用途:\n${uses}`
    );
  }
}
