import * as THREE from 'three';

export interface HighSpeedTrainStatusSnapshot {
  id: number;
  lineName: string;
  carCount: number;
  consistLength: number;
  stateLabel: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  maxSpeed: number;
  direction: 1 | -1;
  stoppedAtCentral: boolean;
  dwellRemaining: number;
  firstPersonForwardOffset: number;
}

export interface HighSpeedRailInspectionSource {
  readonly trainHitMesh: THREE.InstancedMesh;
  trainIdFromInstance(instanceId: number): number;
  trainStatus(id: number): HighSpeedTrainStatusSnapshot | null;
}

const HIT_CAPACITY = 32;
const NOSE_CAPACITY = HIT_CAPACITY * 2;
const NOSE_LENGTH = 9.0;
const BODY_CENTER_Y = 1.85;

function matrixBox(
  x: number,
  y: number,
  z: number,
  length: number,
  height: number,
  width: number,
  heading: number,
): THREE.Matrix4 {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.rotation.y = -heading;
  o.scale.set(length, height, width);
  o.updateMatrix();
  return o.matrix.clone();
}

class HighSpeedInspectionAdapter implements HighSpeedRailInspectionSource {
  private readonly hitMesh: THREE.InstancedMesh;
  private readonly noseMesh: THREE.InstancedMesh;
  private readonly hitIds = new Int32Array(HIT_CAPACITY).fill(-1);
  private readonly noseParent: THREE.Object3D | null;

  constructor(private readonly source: HighSpeedRailInspectionSource) {
    this.hitMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      HIT_CAPACITY,
    );
    this.hitMesh.frustumCulled = false;
    this.hitMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100_000);
    this.hitMesh.count = 0;
    this.hitMesh.updateMatrixWorld(true);

    const noseGeometry = new THREE.ConeGeometry(0.5, 1, 4, 1, false, Math.PI / 4);
    noseGeometry.rotateZ(-Math.PI / 2);
    this.noseMesh = new THREE.InstancedMesh(
      noseGeometry,
      new THREE.MeshStandardMaterial({ color: 0xf4f7f9, roughness: 0.28, metalness: 0.16 }),
      NOSE_CAPACITY,
    );
    this.noseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.noseMesh.frustumCulled = false;
    this.noseMesh.castShadow = true;
    this.noseMesh.receiveShadow = true;
    this.noseMesh.count = 0;
    this.noseMesh.onBeforeRender = () => this.syncNoses();

    this.noseParent = source.trainHitMesh.parent;
    this.noseParent?.add(this.noseMesh);
  }

  get trainHitMesh(): THREE.InstancedMesh {
    this.syncHitMesh();
    return this.hitMesh;
  }

  trainIdFromInstance(instanceId: number): number {
    return instanceId >= 0 && instanceId < this.hitIds.length ? this.hitIds[instanceId] : -1;
  }

  trainStatus(id: number): HighSpeedTrainStatusSnapshot | null {
    return this.source.trainStatus(id);
  }

  dispose(): void {
    this.noseParent?.remove(this.noseMesh);
    this.hitMesh.geometry.dispose();
    (this.hitMesh.material as THREE.Material).dispose();
    this.noseMesh.geometry.dispose();
    (this.noseMesh.material as THREE.Material).dispose();
  }

  private snapshots(): HighSpeedTrainStatusSnapshot[] {
    const ids = new Set<number>();
    const sourceMesh = this.source.trainHitMesh;
    for (let i = 0; i < sourceMesh.count; i++) {
      const id = this.source.trainIdFromInstance(i);
      if (id >= 0) ids.add(id);
    }
    const out: HighSpeedTrainStatusSnapshot[] = [];
    for (const id of ids) {
      const snapshot = this.source.trainStatus(id);
      if (snapshot) out.push(snapshot);
    }
    return out;
  }

  private syncHitMesh(): void {
    const snapshots = this.snapshots();
    this.hitIds.fill(-1);
    let count = 0;
    for (const s of snapshots) {
      if (count >= HIT_CAPACITY) break;
      const length = s.consistLength + NOSE_LENGTH * 2;
      this.hitMesh.setMatrixAt(
        count,
        matrixBox(s.x, s.y + BODY_CENTER_Y, s.z, length, 4.6, 4.3, s.heading),
      );
      this.hitIds[count] = s.id;
      count++;
    }
    this.hitMesh.count = count;
    this.hitMesh.instanceMatrix.needsUpdate = true;
    this.hitMesh.updateMatrixWorld(true);
  }

  private syncNoses(): void {
    const snapshots = this.snapshots();
    let count = 0;
    for (const s of snapshots) {
      if (count + 1 >= NOSE_CAPACITY) break;
      const dx = Math.cos(s.heading);
      const dz = Math.sin(s.heading);
      const reach = s.consistLength * 0.5 + NOSE_LENGTH * 0.5;
      const y = s.y + BODY_CENTER_Y;

      const fx = s.x + dx * reach;
      const fz = s.z + dz * reach;
      this.noseMesh.setMatrixAt(count++, matrixBox(fx, y, fz, NOSE_LENGTH, 3.3, 3.25, s.heading));

      const rx = s.x - dx * reach;
      const rz = s.z - dz * reach;
      this.noseMesh.setMatrixAt(count++, matrixBox(rx, y, rz, NOSE_LENGTH, 3.3, 3.25, s.heading + Math.PI));
    }
    this.noseMesh.count = count;
    this.noseMesh.instanceMatrix.needsUpdate = true;
  }
}

let currentSource: HighSpeedRailInspectionSource | null = null;
let currentAdapter: HighSpeedInspectionAdapter | null = null;

export function registerHighSpeedRailInspectionSource(source: HighSpeedRailInspectionSource | null): void {
  currentAdapter?.dispose();
  currentAdapter = null;
  currentSource = null;
  if (!source) return;
  currentAdapter = new HighSpeedInspectionAdapter(source);
  currentSource = currentAdapter;
}

export function latestHighSpeedRailInspectionSource(): HighSpeedRailInspectionSource | null {
  return currentSource;
}
