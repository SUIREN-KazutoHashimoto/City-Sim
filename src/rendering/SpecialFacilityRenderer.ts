import * as THREE from 'three';
import { FacilityRecord, FacilityType, ParkSpace } from '../generation/SpecialFacilityPlanner';

interface Part { matrix: THREE.Matrix4; color?: THREE.Color; }
type StationPark = ParkSpace & { stationSurface?: 'plaza' | 'park'; stationRelated?: boolean; stationId?: number };

export function buildSpecialFacilityVisuals(scene: THREE.Scene, facilities: FacilityRecord[], parks: ParkSpace[]): void {
  buildParks(scene, parks);
  buildFacilityMarkers(scene, facilities);
}

function buildParks(scene: THREE.Scene, parks: ParkSpace[]): void {
  if (parks.length === 0) return;
  const greenGrounds: Part[] = [], concreteGrounds: Part[] = [], paths: Part[] = [], plazaBands: Part[] = [];
  const trunks: Part[] = [], crowns: Part[] = [];
  const stallBodies: Part[] = [], stallRoofs: Part[] = [], stallCounters: Part[] = [];

  for (const rawPark of parks) {
    const park = rawPark as StationPark;
    const w = Math.max(10, park.width - (park.stationRelated ? 2 : 7));
    const d = Math.max(10, park.depth - (park.stationRelated ? 2 : 7));

    if (park.stationSurface === 'plaza') {
      concreteGrounds.push({ matrix: matrix(park.x, 0.052, park.z, w, 0.10, d) });
      const bandW = Math.max(0.7, Math.min(1.4, Math.min(w, d) * 0.025));
      plazaBands.push({ matrix: matrix(park.x, 0.108, park.z, w * 0.86, 0.025, bandW) });
      plazaBands.push({ matrix: matrix(park.x, 0.109, park.z, bandW, 0.026, d * 0.86) });
      continue;
    }

    greenGrounds.push({ matrix: matrix(park.x, 0.045, park.z, w, 0.09, d) });
    const pathW = Math.max(1.8, Math.min(3.2, Math.min(w, d) * 0.035));
    paths.push({ matrix: matrix(park.x, 0.10, park.z, w * 0.88, 0.045, pathW) });
    paths.push({ matrix: matrix(park.x, 0.10, park.z, pathW, 0.045, d * 0.88) });

    const area = w * d;
    const divisor = park.stationRelated ? 1300 : 2400;
    const treeCount = Math.min(park.stationRelated ? 16 : 32, Math.max(4, Math.floor(area / divisor)));
    for (let i = 0; i < treeCount; i++) {
      const t = hash01(park.id * 97 + i * 31 + 11), u = hash01(park.id * 53 + i * 71 + 23);
      const edge = i & 3;
      let x = park.x + (t - 0.5) * w * 0.82, z = park.z + (u - 0.5) * d * 0.82;
      if (edge === 0) z = park.z - d * 0.38;
      else if (edge === 1) z = park.z + d * 0.38;
      else if (edge === 2) x = park.x - w * 0.38;
      else x = park.x + w * 0.38;
      const h = 2.8 + hash01(i * 43 + park.id * 13) * 2.3;
      trunks.push({ matrix: matrix(x, h * 0.28, z, 0.35, h * 0.56, 0.35) });
      crowns.push({ matrix: matrix(x, h * 0.73, z, 2.0 + h * 0.16, h * 0.72, 2.0 + h * 0.16) });
    }

    if (park.stationRelated) {
      const stallCount = Math.max(2, Math.min(5, Math.round(area / 950)));
      for (let i = 0; i < stallCount; i++) {
        const t = stallCount === 1 ? 0.5 : i / Math.max(1, stallCount - 1);
        const x = park.x + (t - 0.5) * w * 0.64;
        const z = park.z + d * 0.31;
        const bodyColor = new THREE.Color().setHSL((0.05 + hash01(park.id * 31 + i * 19) * 0.14) % 1, 0.42, 0.50);
        const roofColor = new THREE.Color().setHSL((0.56 + hash01(park.id * 47 + i * 13) * 0.12) % 1, 0.46, 0.42);
        stallBodies.push({ matrix: matrix(x, 1.05, z, 2.35, 2.05, 2.1), color: bodyColor });
        stallRoofs.push({ matrix: matrix(x, 2.18, z, 2.75, 0.22, 2.5), color: roofColor });
        stallCounters.push({ matrix: matrix(x, 1.18, z - 1.18, 1.65, 0.16, 0.35), color: new THREE.Color(0xd5c39f) });
      }
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  add(scene, box, new THREE.MeshStandardMaterial({ color: 0x4f7b49, roughness: 1 }), greenGrounds);
  add(scene, box, new THREE.MeshStandardMaterial({ color: 0xa8aaad, roughness: 0.93, metalness: 0.02 }), concreteGrounds);
  add(scene, box, new THREE.MeshStandardMaterial({ color: 0xb9ad91, roughness: 1 }), paths);
  add(scene, box, new THREE.MeshStandardMaterial({ color: 0xc7c9cb, roughness: 0.95 }), plazaBands);
  add(scene, new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0x66503a, roughness: 1 }), trunks);
  add(scene, new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x3e7547, roughness: 1 }), crowns);
  add(scene, box, new THREE.MeshStandardMaterial({ roughness: 0.75 }), stallBodies, true);
  add(scene, box, new THREE.MeshStandardMaterial({ roughness: 0.68 }), stallRoofs, true);
  add(scene, box, new THREE.MeshStandardMaterial({ roughness: 0.88 }), stallCounters, true);
}

function buildFacilityMarkers(scene: THREE.Scene, facilities: FacilityRecord[]): void {
  if (facilities.length === 0) return;
  const plates: Part[] = [], signs: Part[] = [], poles: Part[] = [], crossA: Part[] = [], crossB: Part[] = [];
  for (const f of facilities) {
    const h = Math.max(3.2, f.floors * 3.2), accent = facilityColor(f.type);
    plates.push({ matrix: matrix(f.x, h + 0.18, f.z, Math.max(4, f.width * 0.42), 0.20, Math.max(4, f.depth * 0.42)), color: accent });

    const side = frontageVector(f.frontage), sx = f.x + side.x * (Math.max(f.width, f.depth) * 0.42 + 2.0), sz = f.z + side.z * (Math.max(f.width, f.depth) * 0.42 + 2.0);
    poles.push({ matrix: matrix(sx, 2.0, sz, 0.18, 4.0, 0.18), color: accent });
    signs.push({ matrix: matrix(sx, 3.7, sz, 1.8, 0.65, 0.18), color: accent });

    if (f.type === FacilityType.Hospital) {
      crossA.push({ matrix: matrix(f.x, h + 0.34, f.z, Math.max(2.4, f.width * 0.18), 0.12, Math.max(0.7, f.depth * 0.045)) });
      crossB.push({ matrix: matrix(f.x, h + 0.35, f.z, Math.max(0.7, f.width * 0.045), 0.13, Math.max(2.4, f.depth * 0.18)) });
    }
  }
  const base = new THREE.BoxGeometry(1, 1, 1);
  add(scene, base, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 }), plates, true);
  add(scene, base, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.12 }), signs, true);
  add(scene, base, new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.25 }), poles, true);
  const red = new THREE.MeshStandardMaterial({ color: 0xc92222, roughness: 0.6 });
  add(scene, base, red, crossA); add(scene, base, red.clone(), crossB);
}

function facilityColor(type: FacilityType): THREE.Color {
  switch (type) {
    case FacilityType.School: return new THREE.Color(0xd4a72c);
    case FacilityType.Hospital: return new THREE.Color(0xf2f2f2);
    case FacilityType.University: return new THREE.Color(0x6d5cae);
    case FacilityType.CityHall: return new THREE.Color(0x4e79a7);
    case FacilityType.PoliceStation: return new THREE.Color(0x315f9f);
    case FacilityType.FireStation: return new THREE.Color(0xb43b32);
    case FacilityType.Mall: return new THREE.Color(0xc47b37);
    case FacilityType.Supermarket: return new THREE.Color(0x4e9c62);
    case FacilityType.Hotel: return new THREE.Color(0x8c6ca8);
    case FacilityType.GasStation: return new THREE.Color(0xe3c84a);
    case FacilityType.Stadium: return new THREE.Color(0x4c8f83);
  }
}

function frontageVector(side: FacilityRecord['frontage']): { x: number; z: number } {
  if (side === 'north') return { x: 0, z: -1 };
  if (side === 'south') return { x: 0, z: 1 };
  if (side === 'west') return { x: -1, z: 0 };
  return { x: 1, z: 0 };
}

function add(scene: THREE.Scene, geometry: THREE.BufferGeometry, material: THREE.Material, parts: Part[], colors = false): void {
  if (parts.length === 0) return;
  const mesh = new THREE.InstancedMesh(geometry, material, parts.length);
  if (colors) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(parts.length * 3), 3);
  parts.forEach((p, i) => { mesh.setMatrixAt(i, p.matrix); if (colors && p.color) mesh.setColorAt(i, p.color); });
  mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh);
}

function matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
}

function hash01(v: number): number {
  const x = Math.sin(v * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x);
}
