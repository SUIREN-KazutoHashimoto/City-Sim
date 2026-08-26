import * as THREE from 'three';
import { TrainLiveryOverlay } from './TrainLiveryOverlay';

type AnyOverlay = Record<string, any>;

interface EndMatrices {
  first: THREE.Matrix4;
  last: THREE.Matrix4;
}

const proto = TrainLiveryOverlay.prototype as unknown as AnyOverlay;
if (!proto.__citySimHeadlightAttachmentV102) {
  proto.syncHeadlights = function syncHeadlightsOnActualLeadCar(this: AnyOverlay, activeRuns: Set<number>): void {
    const rail = this.rail;
    const mesh = this.headlampMesh as THREE.InstancedMesh | null;
    const proxy = rail?.trainHitMesh as THREE.InstancedMesh | null;
    if (!mesh || !proxy) return;
    this.ensureHeadlightPool();

    const ends = new Map<number, EndMatrices>();
    const matrix = new THREE.Matrix4();
    for (let instance = 0; instance < proxy.count; instance++) {
      const runId = rail.trainIdFromInstance(instance) as number;
      if (runId < 0 || !activeRuns.has(runId)) continue;
      proxy.getMatrixAt(instance, matrix);
      const copy = matrix.clone();
      const existing = ends.get(runId);
      if (existing) existing.last = copy;
      else ends.set(runId, { first: copy, last: copy });
    }

    const runtime = rail as Record<string, any>;
    const day = ((((runtime.railTime as number | undefined) ?? 0) % 86400) + 86400) % 86400;
    const hour = day / 3600;
    const coneIntensity = hour >= 17 || hour < 6.5 ? 145 : hour >= 16 || hour < 7 ? 58 : 12;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const lateral = new THREE.Vector3();
    const identity = new THREE.Quaternion();
    const lampScale = new THREE.Vector3(0.18, 0.18, 0.18);
    const lampMatrix = new THREE.Matrix4();
    let lampCount = 0;
    let realLightCount = 0;

    for (const runId of activeRuns) {
      const status = rail.trainStatus(runId);
      const end = ends.get(runId);
      if (!status || status.state === 'depot' || !end) continue;
      const leadMatrix = status.direction > 0 ? end.first : end.last;
      leadMatrix.decompose(position, quaternion, scale);
      forward.set(1, 0, 0).applyQuaternion(quaternion).normalize();
      lateral.set(0, 0, 1).applyQuaternion(quaternion).normalize();

      const faceCenter = position.clone().addScaledVector(forward, Math.abs(scale.x) * 0.5 + 0.12);
      // The proxy body center is roughly cab-window height; lamps sit slightly below it.
      faceCenter.y -= 0.18;
      for (const side of [-1, 1]) {
        const p = faceCenter.clone().addScaledVector(lateral, 0.72 * side);
        lampMatrix.compose(p, identity, lampScale);
        mesh.setMatrixAt(lampCount++, lampMatrix);
      }

      if (realLightCount < this.headlightPool.length) {
        const light = this.headlightPool[realLightCount++] as THREE.SpotLight;
        light.intensity = coneIntensity;
        light.position.copy(faceCenter);
        light.target.position.copy(faceCenter).addScaledVector(forward, 78);
        light.target.position.y = status.y + 0.45;
        light.target.updateMatrixWorld();
      }
    }

    mesh.count = lampCount;
    mesh.instanceMatrix.needsUpdate = true;
    for (let i = realLightCount; i < this.headlightPool.length; i++) this.headlightPool[i].intensity = 0;
  };
  proto.__citySimHeadlightAttachmentV102 = true;
}
