import * as THREE from 'three';
import type { BusStop } from '../traffic/BusSystem';

/**
 * バス停を道路方向へ揃えて描画する。
 * headingは+X基準、sideは道路中心から見た歩道側(+1/-1)。
 */
export function buildAlignedBusStops(scene: THREE.Scene, stops: readonly BusStop[]): void {
  if (stops.length === 0) return;

  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.8, metalness: 0.4 });
  const signMat = new THREE.MeshStandardMaterial({ color: 0x2f6fd0, roughness: 0.6, emissive: 0x10233f, emissiveIntensity: 0.35 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x6b7480, roughness: 0.65, metalness: 0.25 });
  const backMat = new THREE.MeshStandardMaterial({ color: 0x506474, roughness: 0.45, transparent: true, opacity: 0.7 });
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x765d46, roughness: 0.9 });

  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.09, 2.6, 6), poleMat, stops.length);
  const sign = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.6, 0.12), signMat, stops.length);
  const shelterCount = stops.filter((_, i) => i % 2 === 0).length;
  const roof = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), roofMat, Math.max(1, shelterCount));
  const back = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), backMat, Math.max(1, shelterCount));
  const bench = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), benchMat, Math.max(1, shelterCount));
  roof.count = shelterCount; back.count = shelterCount; bench.count = shelterCount;

  const dummy = new THREE.Object3D();
  const put = (mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, heading: number): void => {
    dummy.position.set(x, y, z); dummy.rotation.set(0, -heading, 0); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
  };

  let shelter = 0;
  stops.forEach((s, i) => {
    const h = s.heading ?? 0, side = s.side || 1;
    const outX = Math.sin(h) * side, outZ = -Math.cos(h) * side;

    put(pole, i, s.x, 1.3, s.z, 1, 1, 1, h);
    put(sign, i, s.x, 2.5, s.z, 1, 1, 1, h);

    if ((i & 1) === 0) {
      // 停留所標柱よりさらに道路外側へ上屋を置き、長手方向を道路と平行にする。
      const cx = s.x + outX * 1.35, cz = s.z + outZ * 1.35;
      put(roof, shelter, cx, 2.55, cz, 2.8, 0.15, 1.5, h);
      put(back, shelter, cx + outX * 0.68, 1.35, cz + outZ * 0.68, 2.8, 2.2, 0.12, h);
      put(bench, shelter, cx + outX * 0.05, 0.55, cz + outZ * 0.05, 1.8, 0.16, 0.5, h);
      shelter++;
    }
  });

  for (const mesh of [pole, sign, roof, back, bench]) {
    mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh);
  }
}
