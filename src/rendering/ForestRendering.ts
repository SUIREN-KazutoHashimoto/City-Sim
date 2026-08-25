import * as THREE from 'three';
import { latestCityForestSpaces, type ForestSpace } from '../generation/CityDiversityTuning';
import { EnhancedRenderer } from './EnhancedRenderer';

type AnyRenderer = EnhancedRenderer & Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const MAX_FOREST_TREES = 18_000;

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
}

function disposeMesh(scene: THREE.Scene, mesh: THREE.InstancedMesh | undefined): void {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  if (Array.isArray(mesh.material)) mesh.material.forEach((m: THREE.Material) => m.dispose());
  else mesh.material.dispose();
}

function buildForestMeshes(renderer: AnyRenderer, forests: readonly ForestSpace[]): void {
  const scene = renderer.sceneRef as THREE.Scene | undefined;
  if (!scene) return;
  disposeMesh(scene, renderer.__forestGroundMesh as THREE.InstancedMesh | undefined);
  disposeMesh(scene, renderer.__forestTrunkMesh as THREE.InstancedMesh | undefined);
  disposeMesh(scene, renderer.__forestCrownMesh as THREE.InstancedMesh | undefined);
  renderer.__forestGroundMesh = undefined;
  renderer.__forestTrunkMesh = undefined;
  renderer.__forestCrownMesh = undefined;
  if (forests.length === 0) return;

  const grounds: THREE.Matrix4[] = [];
  const trunks: THREE.Matrix4[] = [];
  const crowns: THREE.Matrix4[] = [];
  let trees = 0;
  for (const forest of forests) {
    grounds.push(matrix(forest.x, 0.025, forest.z, forest.width, 0.05, forest.depth));
    if (trees >= MAX_FOREST_TREES) continue;
    const area = forest.width * forest.depth;
    const desired = Math.max(2, Math.min(10, Math.floor(area / 1500 * forest.density)));
    for (let i = 0; i < desired && trees < MAX_FOREST_TREES; i++) {
      const rx = hash01(forest.id * 4099 + i * 131 + 17);
      const rz = hash01(forest.id * 3253 + i * 197 + 31);
      const x = forest.x + (rx - 0.5) * forest.width * 0.82;
      const z = forest.z + (rz - 0.5) * forest.depth * 0.82;
      const h = 3.8 + hash01(forest.id * 1237 + i * 271 + 53) * 4.6;
      const crownW = 1.55 + h * 0.16;
      trunks.push(matrix(x, h * 0.28, z, 0.30, h * 0.56, 0.30));
      crowns.push(matrix(x, h * 0.72, z, crownW, h * 0.72, crownW));
      trees++;
    }
  }

  const ground = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x355d37, roughness: 1 }),
    grounds.length,
  );
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(1, 1, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x5f4934, roughness: 1 }),
    Math.max(1, trunks.length),
  );
  const crown = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0x315f39, roughness: 1 }),
    Math.max(1, crowns.length),
  );
  grounds.forEach((m, i) => ground.setMatrixAt(i, m));
  trunks.forEach((m, i) => trunk.setMatrixAt(i, m));
  crowns.forEach((m, i) => crown.setMatrixAt(i, m));
  ground.count = grounds.length;
  trunk.count = trunks.length;
  crown.count = crowns.length;
  for (const mesh of [ground, trunk, crown]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  ground.name = 'rural-forest-ground';
  trunk.name = 'rural-forest-trunks';
  crown.name = 'rural-forest-crowns';
  renderer.__forestGroundMesh = ground;
  renderer.__forestTrunkMesh = trunk;
  renderer.__forestCrownMesh = crown;
}

const proto = EnhancedRenderer.prototype as unknown as Record<string, any>;
if (!proto.__citySimForestRenderingV068) {
  const previousBuildStatic = proto.buildStatic as AnyMethod;
  proto.buildStatic = function buildStaticWithForests(this: AnyRenderer, ...args: any[]): void {
    previousBuildStatic.apply(this, args);
    buildForestMeshes(this, latestCityForestSpaces());
  };
  proto.__citySimForestRenderingV068 = true;
}
