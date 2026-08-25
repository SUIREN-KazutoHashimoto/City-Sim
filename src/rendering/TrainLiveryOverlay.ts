import * as THREE from 'three';
import { RailRenderer, TrainService } from './RailRenderer';
import '../generation/RailPlanningEnhancements';
import './RailRendererEnhancements';
import './RailDepotPlacement';
import './RailRightHandOperation';
import './RailSignalPlatformClearance';
import './RailLightingAndIndicators';
import './RailSupportClearance';
import './RailStationArchitecture';
import './PedestrianSignalOrientation';
import './RailPassengerStationAccess';
import '../world/RailPassengerAutoAttach';
import './RailPassengerVisualConsistency';
import '../world/RailPassengerDemand';
import './TrainPassengerInspector';
import './RailStationRuntimeV033';

/** Exterior city-rail layer plus visible/illuminating front headlights. */
export class TrainLiveryOverlay {
  private shell: THREE.InstancedMesh | null = null;
  private windows: THREE.InstancedMesh | null = null;
  private routeStripes: THREE.InstancedMesh | null = null;
  private serviceStripes: THREE.InstancedMesh | null = null;
  private headlampMesh: THREE.InstancedMesh | null = null;
  private readonly headlightPool: THREE.SpotLight[] = [];
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
  private readonly identityQuat = new THREE.Quaternion();
  private readonly localBody = new THREE.Color(0xe8ecef);
  private readonly rapidBody = new THREE.Color(0xf3f5f6);
  private readonly limitedBody = new THREE.Color(0xf7f8fa);
  private readonly localService = new THREE.Color(0x2dbb63);
  private readonly rapidService = new THREE.Color(0xf39a22);
  private readonly limitedService = new THREE.Color(0xe5484d);

  constructor(private readonly scene: THREE.Scene, private readonly rail: RailRenderer) {}

  sync(_dt: number): void {
    const proxy = this.rail.trainHitMesh;
    if (!proxy || proxy.count <= 0) {
      this.disableHeadlightPool();
      return;
    }

    this.hideProxy(proxy);
    const required = Math.max(1, proxy.instanceMatrix.count);
    if (!this.shell || required !== this.capacity) this.rebuild(required);
    if (!this.shell || !this.windows || !this.routeStripes || !this.serviceStripes || !this.headlampMesh) return;

    let shellCount = 0, panelCount = 0;
    const activeRuns = new Set<number>();

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
      if (runId >= 0) activeRuns.add(runId);
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

    this.syncHeadlights(activeRuns);
  }

  private syncHeadlights(activeRuns: Set<number>): void {
    if (!this.headlampMesh) return;
    this.ensureHeadlightPool();
    let lampCount = 0;
    let realLightCount = 0;
    const runtime = this.rail as unknown as { railTime?: number };
    const day = (((runtime.railTime ?? 0) % 86400) + 86400) % 86400;
    const hour = day / 3600;
    const coneIntensity = hour >= 17 || hour < 6.5 ? 145 : hour >= 16 || hour < 7 ? 58 : 12;

    for (const runId of activeRuns) {
      const status = this.rail.trainStatus(runId);
      if (!status || status.state === 'depot') continue;
      const fx = Math.cos(status.heading), fz = Math.sin(status.heading);
      const lx = -fz, lz = fx;
      const forward = status.firstPersonForwardOffset;
      const frontX = status.x + fx * forward;
      const frontZ = status.z + fz * forward;
      const lampY = status.y + 1.62;

      for (const side of [-1, 1]) {
        const p = new THREE.Vector3(frontX + lx * 0.72 * side, lampY, frontZ + lz * 0.72 * side);
        this.outScale.set(0.18, 0.18, 0.18);
        this.outMatrix.compose(p, this.identityQuat, this.outScale);
        this.headlampMesh.setMatrixAt(lampCount++, this.outMatrix);
      }

      if (realLightCount < this.headlightPool.length) {
        const light = this.headlightPool[realLightCount++];
        light.intensity = coneIntensity;
        light.position.set(frontX, lampY, frontZ);
        light.target.position.set(frontX + fx * 78, status.y + 0.45, frontZ + fz * 78);
        light.target.updateMatrixWorld();
      }
    }

    this.headlampMesh.count = lampCount;
    this.headlampMesh.instanceMatrix.needsUpdate = true;
    for (let i = realLightCount; i < this.headlightPool.length; i++) this.headlightPool[i].intensity = 0;
  }

  private ensureHeadlightPool(): void {
    if (this.headlightPool.length) return;
    const maxRealHeadlights = 12;
    for (let i = 0; i < maxRealHeadlights; i++) {
      const light = new THREE.SpotLight(0xf8fbff, 0, 115, Math.PI / 10, 0.48, 1.45);
      light.castShadow = false;
      this.scene.add(light);
      this.scene.add(light.target);
      this.headlightPool.push(light);
    }
  }

  private disableHeadlightPool(): void {
    for (const light of this.headlightPool) light.intensity = 0;
    if (this.headlampMesh) this.headlampMesh.count = 0;
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
    if (this.headlampMesh) this.scene.remove(this.headlampMesh);

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
    this.headlampMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xf8fbff, toneMapped: false }),
      capacity * 2,
    );

    for (const mesh of [this.shell, this.windows, this.routeStripes, this.serviceStripes, this.headlampMesh]) {
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
