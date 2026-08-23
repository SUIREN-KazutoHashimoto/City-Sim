import * as THREE from 'three';
import { RailRenderer, TrainService } from './RailRenderer';

/**
 * 列車の最終表示レイヤー。
 *
 * RailRendererの運行poseは非同期SIM更新の影響を受けるため、そのまま表示せず
 * VehicleVisualSmootherと同じ一次指数補間で位置/回転だけを追従する。
 * 二次系・速度追従を持たないので、オーバーシュート（ばね挙動）は発生しない。
 *
 * 元のtrainHitMeshはRaycast proxyとして透明化し、外観はこのクラスで描画する。
 * proxy自体も同じ補間poseへ書き戻すため、hover/追跡と見た目がずれない。
 */
export class TrainLiveryOverlay {
  private shell: THREE.InstancedMesh | null = null;
  private windows: THREE.InstancedMesh | null = null;
  private stripes: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private proxyHidden = false;

  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private z = new Float32Array(0);
  private qx = new Float32Array(0);
  private qy = new Float32Array(0);
  private qz = new Float32Array(0);
  private qw = new Float32Array(0);
  private initialized = new Uint8Array(0);

  private trainX = new Float32Array(0);
  private trainY = new Float32Array(0);
  private trainZ = new Float32Array(0);
  private trainHeading = new Float32Array(0);
  private trainPoseValid = new Uint8Array(0);

  private readonly rawMatrix = new THREE.Matrix4();
  private readonly outMatrix = new THREE.Matrix4();
  private readonly rawPos = new THREE.Vector3();
  private readonly smoothPos = new THREE.Vector3();
  private readonly panelPos = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly rawQuat = new THREE.Quaternion();
  private readonly smoothQuat = new THREE.Quaternion();
  private readonly rawScale = new THREE.Vector3();
  private readonly outScale = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly routeColorTmp = new THREE.Color();
  private readonly rapidAccent = new THREE.Color(0xffb000);
  private readonly localBody = new THREE.Color(0xe8ecef);
  private readonly rapidBody = new THREE.Color(0xf7f8fa);

  constructor(private readonly scene: THREE.Scene, private readonly rail: RailRenderer) {}

  sync(dt: number): void {
    const proxy = this.rail.trainHitMesh;
    if (!proxy || proxy.count <= 0) return;

    this.hideProxy(proxy);
    const required = Math.max(1, proxy.instanceMatrix.count);
    if (!this.shell || required !== this.capacity) this.rebuild(required);
    if (!this.shell || !this.windows || !this.stripes) return;

    const posAlpha = 1 - Math.exp(-Math.max(0, dt) * 9);
    const rotAlpha = 1 - Math.exp(-Math.max(0, dt) * 7);
    let shellCount = 0, panelCount = 0;
    let previousRunId = -1;

    for (let i = 0; i < proxy.count; i++) {
      proxy.getMatrixAt(i, this.rawMatrix);
      this.rawMatrix.decompose(this.rawPos, this.rawQuat, this.rawScale);

      const dx = this.rawPos.x - this.x[i];
      const dy = this.rawPos.y - this.y[i];
      const dz = this.rawPos.z - this.z[i];
      if (!this.initialized[i] || dx * dx + dy * dy + dz * dz > 90 * 90) {
        this.x[i] = this.rawPos.x; this.y[i] = this.rawPos.y; this.z[i] = this.rawPos.z;
        this.qx[i] = this.rawQuat.x; this.qy[i] = this.rawQuat.y; this.qz[i] = this.rawQuat.z; this.qw[i] = this.rawQuat.w;
        this.initialized[i] = 1;
      } else {
        this.x[i] += dx * posAlpha; this.y[i] += dy * posAlpha; this.z[i] += dz * posAlpha;
        this.smoothQuat.set(this.qx[i], this.qy[i], this.qz[i], this.qw[i]);
        this.smoothQuat.slerp(this.rawQuat, rotAlpha).normalize();
        this.qx[i] = this.smoothQuat.x; this.qy[i] = this.smoothQuat.y; this.qz[i] = this.smoothQuat.z; this.qw[i] = this.smoothQuat.w;
      }

      this.smoothPos.set(this.x[i], this.y[i] + 0.08, this.z[i]);
      this.smoothQuat.set(this.qx[i], this.qy[i], this.qz[i], this.qw[i]).normalize();

      const length = Math.max(7.5, Math.abs(this.rawScale.x) * 1.015);
      const width = 3.08;
      const height = 3.42;

      this.outScale.set(length, height, width);
      this.outMatrix.compose(this.smoothPos, this.smoothQuat, this.outScale);
      this.shell.setMatrixAt(shellCount, this.outMatrix);

      const runId = this.rail.trainIdFromInstance(i);
      const status = runId >= 0 ? this.rail.trainStatus(runId) : null;
      const service: TrainService = status?.service ?? 'local';
      this.shell.setColorAt(shellCount, service === 'rapid' ? this.rapidBody : this.localBody);

      if (runId >= 0 && runId !== previousRunId) {
        this.ensureTrainPoseCapacity(runId + 1);
        this.trainX[runId] = this.smoothPos.x;
        this.trainY[runId] = this.smoothPos.y;
        this.trainZ[runId] = this.smoothPos.z;
        this.euler.setFromQuaternion(this.smoothQuat, 'YXZ');
        this.trainHeading[runId] = -this.euler.y;
        this.trainPoseValid[runId] = 1;
        previousRunId = runId;
      }

      const routeColor = this.routeColor(status?.lineId ?? 0, service);
      const sideOffset = width * 0.5 + 0.035;
      for (const side of [-1, 1]) {
        this.offset.set(0, 0.77, sideOffset * side).applyQuaternion(this.smoothQuat);
        this.panelPos.copy(this.smoothPos).add(this.offset);
        this.outScale.set(length * 0.74, 0.72, 0.07);
        this.outMatrix.compose(this.panelPos, this.smoothQuat, this.outScale);
        this.windows.setMatrixAt(panelCount, this.outMatrix);

        this.offset.set(0, -0.22, (sideOffset + 0.045) * side).applyQuaternion(this.smoothQuat);
        this.panelPos.copy(this.smoothPos).add(this.offset);
        this.outScale.set(length * 0.94, service === 'rapid' ? 0.66 : 0.54, 0.075);
        this.outMatrix.compose(this.panelPos, this.smoothQuat, this.outScale);
        this.stripes.setMatrixAt(panelCount, this.outMatrix);
        this.stripes.setColorAt(panelCount, routeColor);
        panelCount++;
      }

      // Raycast proxyも表示と同じ位置・回転へ合わせる。
      this.outScale.copy(this.rawScale);
      this.outMatrix.compose(new THREE.Vector3(this.x[i], this.y[i], this.z[i]), this.smoothQuat, this.outScale);
      proxy.setMatrixAt(i, this.outMatrix);
      shellCount++;
    }

    this.shell.count = shellCount;
    this.windows.count = panelCount;
    this.stripes.count = panelCount;
    this.shell.instanceMatrix.needsUpdate = true;
    this.windows.instanceMatrix.needsUpdate = true;
    this.stripes.instanceMatrix.needsUpdate = true;
    proxy.instanceMatrix.needsUpdate = true;
    if (this.shell.instanceColor) this.shell.instanceColor.needsUpdate = true;
    if (this.stripes.instanceColor) this.stripes.instanceColor.needsUpdate = true;
  }

  getTrainPose(id: number, out: THREE.Vector3): number | null {
    if (id < 0 || id >= this.trainPoseValid.length || !this.trainPoseValid[id]) return null;
    out.set(this.trainX[id], this.trainY[id], this.trainZ[id]);
    return this.trainHeading[id];
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
    this.x = new Float32Array(capacity); this.y = new Float32Array(capacity); this.z = new Float32Array(capacity);
    this.qx = new Float32Array(capacity); this.qy = new Float32Array(capacity); this.qz = new Float32Array(capacity); this.qw = new Float32Array(capacity);
    this.initialized = new Uint8Array(capacity);

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

  private ensureTrainPoseCapacity(required: number): void {
    if (required <= this.trainPoseValid.length) return;
    const size = Math.max(required, this.trainPoseValid.length * 2, 8);
    const growF32 = (src: Float32Array): Float32Array => { const dst = new Float32Array(size); dst.set(src); return dst; };
    const growU8 = (src: Uint8Array): Uint8Array => { const dst = new Uint8Array(size); dst.set(src); return dst; };
    this.trainX = growF32(this.trainX); this.trainY = growF32(this.trainY); this.trainZ = growF32(this.trainZ);
    this.trainHeading = growF32(this.trainHeading); this.trainPoseValid = growU8(this.trainPoseValid);
  }

  private routeColor(lineId: number, service: TrainService): THREE.Color {
    const palette = [0x0788e6, 0xee4338, 0x19b46f, 0x955bd7, 0xff8a19, 0x00b9d0, 0xd83a89];
    this.routeColorTmp.setHex(palette[Math.abs(lineId) % palette.length]);
    if (service === 'rapid') this.routeColorTmp.lerp(this.rapidAccent, 0.28);
    return this.routeColorTmp;
  }
}
