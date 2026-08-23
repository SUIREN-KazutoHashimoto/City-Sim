import * as THREE from 'three';
import { RailRenderer, TrainService } from './RailRenderer';
import '../generation/RailPlanningEnhancements';
import './RailRendererEnhancements';
import './RailDepotPlacement';
import './RailRightHandOperation';
import './RailSignalPlatformClearance';
import './RailLightingAndIndicators';
import './RailSupportClearance';
import './PedestrianSignalOrientation';
import './RailPassengerStationAccess';
import '../world/RailPassengerAutoAttach';
import '../world/RailPassengerDemand';
import './TrainPassengerInspector';

/**
 * 列車の外装レイヤー。
 *
 * RailRendererで確定した台車ベースposeをそのまま転写する。
 * 側面は「路線色」と「種別色」の2本帯にして、路線と普通/快速/特急を同時に識別できるようにする。
 */
export class TrainLiveryOverlay {
  private shell: THREE.InstancedMesh | null = null;
  private windows: THREE.InstancedMesh | null = null;
  private routeStripes: THREE.InstancedMesh | null = null;
  private serviceStripes: THREE.InstancedMesh | null = null;
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
  private readonly localBody = new THREE.Color(0xe8ecef);
  private readonly rapidBody = new THREE.Color(0xf3f5f6);
  private readonly limitedBody = new THREE.Color(0xf7f8fa);
  private readonly localService = new THREE.Color(0x2dbb63);
  private readonly rapidService = new THREE.Color(0xf39a22);
  private readonly limitedService = new THREE.Color(0xe5484d);

  constructor(private readonly scene: THREE.Scene, private readonly rail: RailRenderer) {}

  sync(_dt: number): void {
    const proxy = this.rail.trainHitMesh;
    if (!proxy || proxy.count <= 0) return;

    this.hideProxy(proxy);
    const required = Math.max(1, proxy.instanceMatrix.count);
    if (!this.shell || required !== this.capacity) this.rebuild(required);
    if (!this.shell || !this.windows || !this.routeStripes || !this.serviceStripes) return;

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
      this.shell.setColorAt(shellCount, this.bodyColor(service));

      const routeColor = this.routeColor(status?.lineId ?? 0);
      const serviceColor = this.serviceColor(service);
      const sideOffset = width * 0.5 + 0.035;
      for (const side of [-1, 1]) {
        this.offset.set(0, 0.77, sideOffset * side).applyQuaternion(this.rawQuat);
        this.panelPos.copy(this.bodyPos).add(this.offset);
        this.outScale.set(length * 0.74, 0.72, 0.07);
        this.outMatrix.compose(this.panelPos, this.rawQuat, this.outScale);
        this.windows.setMatrixAt(panelCount, this.outMatrix);

        this.offset.set(0, -0.10, (sideOffset + 0.045) * side).applyQuaternion(this.rawQuat);
        this.panelPos.copy(this.bodyPos).add(this.offset);
        this.outScale.set(length * 0.94, 0.22, 0.075);
        this.outMatrix.compose(this.panelPos, this.rawQuat, this.outScale);
        this.routeStripes.setMatrixAt(panelCount, this.outMatrix);
        this.routeStripes.setColorAt(panelCount, routeColor);

        this.offset.set(0, -0.43, (sideOffset + 0.047) * side).applyQuaternion(this.rawQuat);
        this.panelPos.copy(this.bodyPos).add(this.offset);
        this.outScale.set(length * 0.94, 0.24, 0.078);
        this.outMatrix.compose(this.panelPos, this.rawQuat, this.outScale);
        this.serviceStripes.setMatrixAt(panelCount, this.outMatrix);
        this.serviceStripes.setColorAt(panelCount, serviceColor);
        panelCount++;
      }
      shellCount++;
    }

    this.shell.count = shellCount;
    this.windows.count = panelCount;
    this.routeStripes.count = panelCount;
    this.serviceStripes.count = panelCount;
    for (const mesh of [this.shell, this.windows, this.routeStripes, this.serviceStripes]) mesh.instanceMatrix.needsUpdate = true;
    if (this.shell.instanceColor) this.shell.instanceColor.needsUpdate = true;
    if (this.routeStripes.instanceColor) this.routeStripes.instanceColor.needsUpdate = true;
    if (this.serviceStripes.instanceColor) this.serviceStripes.instanceColor.needsUpdate = true;
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
    if (this.routeStripes) this.scene.remove(this.routeStripes);
    if (this.serviceStripes) this.scene.remove(this.serviceStripes);

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
    this.routeStripes = new THREE.InstancedMesh(
      box,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      capacity * 2,
    );
    this.serviceStripes = new THREE.InstancedMesh(
      box,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      capacity * 2,
    );

    for (const mesh of [this.shell, this.windows, this.routeStripes, this.serviceStripes]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      const lit = mesh === this.shell || mesh === this.windows;
      mesh.castShadow = lit;
      mesh.receiveShadow = lit;
      this.scene.add(mesh);
    }
  }

  private bodyColor(service: TrainService): THREE.Color {
    if (service === 'limited') return this.limitedBody;
    if (service === 'rapid') return this.rapidBody;
    return this.localBody;
  }

  private serviceColor(service: TrainService): THREE.Color {
    if (service === 'limited') return this.limitedService;
    if (service === 'rapid') return this.rapidService;
    return this.localService;
  }

  private routeColor(lineId: number): THREE.Color {
    const palette = [0x0788e6, 0x7f62d9, 0x00a6b8, 0xd66db0, 0x4477cc, 0x9a6bd8, 0x2d9bb3];
    this.routeColorTmp.setHex(palette[Math.abs(lineId) % palette.length]);
    return this.routeColorTmp;
  }
}