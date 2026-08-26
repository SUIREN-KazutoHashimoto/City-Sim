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
const HSR_WIDTH = 3.4;
const HSR_HEIGHT = 3.7;
const BODY_CENTER_Y = HSR_HEIGHT * 0.5;

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

/**
 * Unit triangular prism whose longitudinal axis is +X.
 *
 * Seen from the side it is a right triangle: the rear face at x=-0.5 has full body height, the
 * bottom stays level, and the roof slopes down to the forward tip at x=+0.5. Extruding that triangle
 * across Z gives the requested horizontal wedge rather than a pyramid.
 */
function makeHorizontalTriangularPrism(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, -0.5,
    -0.5,  0.5, -0.5,
     0.5, -0.5, -0.5,
    -0.5, -0.5,  0.5,
    -0.5,  0.5,  0.5,
     0.5, -0.5,  0.5,
  ], 3));
  geometry.setIndex([
    0, 1, 2,
    3, 5, 4,
    0, 3, 4, 0, 4, 1,
    0, 2, 5, 0, 5, 3,
    1, 4, 5, 1, 5, 2,
  ]);
  const hard = geometry.toNonIndexed();
  geometry.dispose();
  hard.computeVertexNormals();
  return hard;
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

    this.noseMesh = new THREE.InstancedMesh(
      makeHorizontalTriangularPrism(),
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
    const snapshot = this.source.trainStatus(id);
    if (!snapshot) return null;
    return {
      ...snapshot,
      firstPersonForwardOffset: Math.max(
        snapshot.firstPersonForwardOffset,
        snapshot.consistLength * 0.5 + 0.5,
      ),
    };
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
      this.hitMesh.setMatrixAt(
        count,
        matrixBox(s.x, s.y + BODY_CENTER_Y, s.z, s.consistLength + 1.0, HSR_HEIGHT + 0.6, HSR_WIDTH + 0.8, s.heading),
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
      const reach = Math.max(0, s.consistLength * 0.5 - NOSE_LENGTH * 0.5);
      const y = s.y + BODY_CENTER_Y;

      const fx = s.x + dx * reach;
      const fz = s.z + dz * reach;
      this.noseMesh.setMatrixAt(count++, matrixBox(fx, y, fz, NOSE_LENGTH, HSR_HEIGHT, HSR_WIDTH, s.heading));

      const rx = s.x - dx * reach;
      const rz = s.z - dz * reach;
      this.noseMesh.setMatrixAt(count++, matrixBox(rx, y, rz, NOSE_LENGTH, HSR_HEIGHT, HSR_WIDTH, s.heading + Math.PI));
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
