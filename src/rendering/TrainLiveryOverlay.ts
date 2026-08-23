import * as THREE from 'three';
import { RailRenderer, TrainService } from './RailRenderer';

/**
 * RailRenderer本体のhit mesh姿勢を利用して、車体左右に明確な路線色パネルを重ねる。
 * 既存の細い埋め込みstripeは近距離でも見えづらいため、独立した側面パネルとして描画する。
 */
export class TrainLiveryOverlay {
  private stripes: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private readonly bodyMatrix = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly stripePosition = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly stripeScale = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly rapidAccent = new THREE.Color(0xffb000);

  constructor(private readonly scene: THREE.Scene, private readonly rail: RailRenderer) {}

  sync(): void {
    const body = this.rail.trainHitMesh;
    if (!body || body.count <= 0) return;
    const required = Math.max(2, body.instanceMatrix.count * 2);
    if (!this.stripes || required !== this.capacity) this.rebuild(required);
    if (!this.stripes) return;

    let out = 0;
    for (let i = 0; i < body.count; i++) {
      body.getMatrixAt(i, this.bodyMatrix);
      this.bodyMatrix.decompose(this.position, this.quaternion, this.scale);
      const runId = this.rail.trainIdFromInstance(i);
      const status = runId >= 0 ? this.rail.trainStatus(runId) : null;
      const lineId = status?.lineId ?? 0;
      const service: TrainService = status?.service ?? 'local';
      const routeColor = this.routeColor(lineId, service);

      const sideOffset = Math.abs(this.scale.z) * 0.5 + 0.075;
      const stripeLength = Math.max(4, Math.abs(this.scale.x) * 0.91);
      const stripeHeight = service === 'rapid' ? 0.72 : 0.62;
      this.stripeScale.set(stripeLength, stripeHeight, 0.15);

      for (const side of [-1, 1]) {
        this.offset.set(0, 0.12, sideOffset * side).applyQuaternion(this.quaternion);
        this.stripePosition.copy(this.position).add(this.offset);
        this.local.compose(this.stripePosition, this.quaternion, this.stripeScale);
        this.stripes.setMatrixAt(out, this.local);
        this.stripes.setColorAt(out, routeColor);
        out++;
      }
    }

    this.stripes.count = out;
    this.stripes.instanceMatrix.needsUpdate = true;
    if (this.stripes.instanceColor) this.stripes.instanceColor.needsUpdate = true;
  }

  private rebuild(capacity: number): void {
    if (this.stripes) this.scene.remove(this.stripes);
    this.capacity = capacity;
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.36,
      metalness: 0.16,
      vertexColors: true,
    });
    this.stripes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, capacity);
    this.stripes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.stripes.frustumCulled = false;
    this.stripes.castShadow = true;
    this.stripes.receiveShadow = true;
    this.scene.add(this.stripes);
  }

  private routeColor(lineId: number, service: TrainService): THREE.Color {
    const palette = [0x0877c9, 0xd83b32, 0x15925f, 0x7a48b7, 0xe57a18, 0x0097aa, 0xbb2f71];
    this.color.setHex(palette[Math.abs(lineId) % palette.length]);
    if (service === 'rapid') this.color.lerp(this.rapidAccent, 0.32);
    return this.color;
  }
}
