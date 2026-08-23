import * as THREE from 'three';
import { RailRenderer, TrainService } from './RailRenderer';

/**
 * 列車の外装レイヤー。
 *
 * 位置・回転の平滑化はRailRendererで編成中心の線路上距離へ1回だけ適用済み。
 * ここでは各車両poseを再補間せず、そのまま外装へ転写する。
 * これによりカーブ中に連結間隔が伸縮する「ゴム/ばね」挙動を発生させない。
 */
export class TrainLiveryOverlay {
  private shell: THREE.InstancedMesh | null = null;
  private windows: THREE.InstancedMesh | null = null;
  private stripes: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private proxyHidden = false;

  private readonly rawMatrix = new THREE.Matrix4();
  private readonly outMatrix = new THREE.Matrix4();
  private readonly rawPos = new THREE.Vector3();
  private readonly bodyPos = new THREE.Vector3();
  private readonly panelPos = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly rawQuat = new THREE.Quaternion();
  private readonly rawScale = new THREE.Vector3();
  private readonly outScale = new THREE.Vector3();
  private readonly routeColorTmp = new THREE.Color();
  private readonly rapidAccent = new THREE.Color(0xffb000);
  private readonly localBody = new THREE.Color(0xe8ecef);
  private readonly rapidBody = new THREE.Color(0xf7f8fa);

  constructor(private readonly scene: THREE.Scene, private readonly rail: RailRenderer) {}

  sync(_dt: number): void {
    const proxy = this.rail.trainHitMesh;
    if (!proxy || proxy.count <= 0) return;

    this.hideProxy(proxy);
    const required = Math.max(1, proxy.instanceMatrix.count);
    if (!this.shell || required !== this.capacity) this.rebuild(required);
    if (!this.shell || !this.windows || !this.stripes) return;

    let shellCount = 0, panelCount = 0;

    for (let i = 0; i < proxy.count; i++) {
      proxy.getMatrixAt(i, this.rawMatrix);
      this.rawMatrix.decompose(this.rawPos, this.rawQuat, this.rawScale);

      const length = Math.max(7.5, Math.abs(this.rawScale.x) * 1.015);
      const width = 3.08;
      const height = 3.42;
      this.bodyPos.set(this.rawPos.x, this.rawPos.y + 0.08, this.rawPos.z);

      this.outScale.set(length, height, width);
      this.outMatrix.compose(this.bodyPos, this.rawQuat, this.outScale);
      this.shell.setMatrixAt(shellCount, this.outMatrix);

      const runId = this.rail.trainIdFromInstance(i);
      const status = runId >= 0 ? this.rail.trainStatus(runId) : null;
      const service: TrainService = status?.service ?? 'local';
      this.shell.setColorAt(shellCount, service === 'rapid' ? this.rapidBody : this.localBody);

      const routeColor = this.routeColor(status?.lineId ?? 0, service);
      const sideOffset = width * 0.5 + 0.035;
      for (const side of [-1, 1]) {
        // 暗色は窓帯だけ。白/銀車体を覆わない。
        this.offset.set(0, 0.77, sideOffset * side).applyQuaternion(this.rawQuat);
        this.panelPos.copy(this.bodyPos).add(this.offset);
        this.outScale.set(length * 0.74, 0.72, 0.07);
        this.outMatrix.compose(this.panelPos, this.rawQuat, this.outScale);
        this.windows.setMatrixAt(panelCount, this.outMatrix);

        // 路線帯は照明非依存で常に発色。
        this.offset.set(0, -0.22, (sideOffset + 0.045) * side).applyQuaternion(this.rawQuat);
        this.panelPos.copy(this.bodyPos).add(this.offset);
        this.outScale.set(length * 0.94, service === 'rapid' ? 0.66 : 0.54, 0.075);
        this.outMatrix.compose(this.panelPos, this.rawQuat, this.outScale);
        this.stripes.setMatrixAt(panelCount, this.outMatrix);
        this.stripes.setColorAt(panelCount, routeColor);
        panelCount++;
      }
      shellCount++;
    }

    this.shell.count = shellCount;
    this.windows.count = panelCount;
    this.stripes.count = panelCount;
    this.shell.instanceMatrix.needsUpdate = true;
    this.windows.instanceMatrix.needsUpdate = true;
    this.stripes.instanceMatrix.needsUpdate = true;
    if (this.shell.instanceColor) this.shell.instanceColor.needsUpdate = true;
    if (this.stripes.instanceColor) this.stripes.instanceColor.needsUpdate = true;
  }

  private hideProxy(proxy: THREE.InstancedMesh): void {
    if (this.proxyHidden) return;
    proxy.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    proxy.castShadow = false;
    proxy.receiveShadow = false;
    this.proxyHidden = true;
  }

  private rebuild(capacity: number): void {
    if (this.shell) this.scene.remove(this.shell);
    if (this.windows) this.scene.remove(this.windows);
    if (this.stripes) this.scene.remove(this.stripes);

    this.capacity = capacity;
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.shell = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.48, metalness: 0.20 }),
      capacity,
    );
    this.windows = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: 0x263947, roughness: 0.22, metalness: 0.16 }),
      capacity * 2,
    );
    this.stripes = new THREE.InstancedMesh(
      box,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      capacity * 2,
    );

    for (const mesh of [this.shell, this.windows, this.stripes]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = mesh !== this.stripes;
      mesh.receiveShadow = mesh !== this.stripes;
      this.scene.add(mesh);
    }
  }

  private routeColor(lineId: number, service: TrainService): THREE.Color {
    const palette = [0x0788e6, 0xee4338, 0x19b46f, 0x955bd7, 0xff8a19, 0x00b9d0, 0xd83a89];
    this.routeColorTmp.setHex(palette[Math.abs(lineId) % palette.length]);
    if (service === 'rapid') this.routeColorTmp.lerp(this.rapidAccent, 0.28);
    return this.routeColorTmp;
  }
}
