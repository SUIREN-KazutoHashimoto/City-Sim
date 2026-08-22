import * as THREE from 'three';
import { World } from '../world/World';
import { InstancedRenderer } from './InstancedRenderer';
import { AgentState } from '../agents/AgentStore';
import { POICategory } from '../world/POI';

/**
 * ============================================================================
 *  Inspector: Ctrl押下中のホバーで対象を調べるツールチップ
 * ============================================================================
 * Ctrl を押している間だけ、マウス直下のオブジェクト(歩行者/建物)を
 * レイキャストで特定し、その説明とステータスを画面に表示する。
 *
 * ピッキングの仕組み:
 *   InstancedMesh へのレイキャストは intersection.instanceId を返す。
 *   建物は生成順に追加しているので instanceId == buildings 配列 index、
 *   歩行者は instanceId == AgentStore の行 index に一致する。
 *
 * シミュレーション本体には一切干渉しない読み取り専用の観測ツール。
 */
export class Inspector {
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private el: HTMLDivElement;
  private ctrlHeld = false;
  private hasPointer = false;

  constructor(
    private world: World,
    private gfx: InstancedRenderer,
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    // ツールチップ用のDOMを生成
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'z-index:20', 'pointer-events:none',
      'font:12px/1.5 ui-monospace,monospace', 'color:#dfe8f5',
      'background:rgba(12,17,25,.92)', 'border:1px solid #3a4a63',
      'border-radius:8px', 'padding:8px 10px', 'max-width:280px',
      'box-shadow:0 6px 20px rgba(0,0,0,.4)', 'display:none', 'white-space:pre-line',
    ].join(';');
    document.body.appendChild(this.el);

    // ホバー座標(NDC)を追跡
    this.dom.addEventListener('mousemove', (e) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
      this.el.style.left = `${e.clientX + 16}px`;
      this.el.style.top = `${e.clientY + 16}px`;
      this.hasPointer = true;
    });
    // Ctrl の押下状態を追跡
    window.addEventListener('keydown', (e) => { if (e.key === 'Control') this.ctrlHeld = true; });
    window.addEventListener('keyup', (e) => { if (e.key === 'Control') this.ctrlHeld = false; });
    window.addEventListener('blur', () => { this.ctrlHeld = false; this.hide(); });
  }

  get active(): boolean { return this.ctrlHeld; }

  private hide(): void { this.el.style.display = 'none'; }

  /** 毎フレーム呼ぶ。Ctrl押下中のみピッキングして表示を更新する。 */
  update(): void {
    if (!this.ctrlHeld || !this.hasPointer) { this.hide(); return; }
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // 歩行者を優先的に判定(小さく手前にいることが多い)、次に建物
    const agentMesh = this.gfx.agents;
    const buildingMesh = this.gfx.buildings;

    const agentHit = agentMesh ? this.raycaster.intersectObject(agentMesh, false) : [];
    const buildingHit = buildingMesh ? this.raycaster.intersectObject(buildingMesh, false) : [];

    // 近い方を採用
    const aDist = agentHit.length ? agentHit[0].distance : Infinity;
    const bDist = buildingHit.length ? buildingHit[0].distance : Infinity;

    if (aDist < bDist && agentHit[0].instanceId != null) {
      this.el.textContent = this.describeAgent(agentHit[0].instanceId);
      this.el.style.display = 'block';
    } else if (buildingHit.length && buildingHit[0].instanceId != null) {
      this.el.textContent = this.describeBuilding(buildingHit[0].instanceId);
      this.el.style.display = 'block';
    } else {
      this.hide();
    }
  }

  // --- 表示テキストの構築 ---

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
