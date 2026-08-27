import * as THREE from 'three';
import type { Building } from '../generation/CityGenerator';
import { EnhancedRenderer } from './EnhancedRenderer';
import { UniversalInspector } from './UniversalInspector';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;
type PowerFacilityRole = 'thermal' | 'solar' | 'substation' | 'external';
type PowerBuilding = Building & {
  infrastructureLabel?: string;
  powerFacilityRole?: PowerFacilityRole;
};

function roleOf(building: Building): PowerFacilityRole | null {
  const role = (building as PowerBuilding).powerFacilityRole;
  return role === 'thermal' || role === 'solar' || role === 'substation' || role === 'external' ? role : null;
}

function matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion(),
    new THREE.Vector3(sx, sy, sz),
  );
}

function addBatch(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
  shadow = true,
): void {
  if (!matrices.length) return;
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadow;
  mesh.receiveShadow = shadow;
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);
}

function buildPowerBuildingDetails(scene: THREE.Scene, buildings: Building[]): void {
  const thermalStacks: THREE.Matrix4[] = [];
  const thermalStackCaps: THREE.Matrix4[] = [];
  const solarPanels: THREE.Matrix4[] = [];
  const transformerBodies: THREE.Matrix4[] = [];
  const transformerTops: THREE.Matrix4[] = [];
  const switchgear: THREE.Matrix4[] = [];

  for (const building of buildings) {
    const role = roleOf(building);
    if (!role) continue;
    const w = Math.max(5, building.width);
    const d = Math.max(5, building.depth);
    const h = Math.max(3.2, building.floors * 3.2);

    if (role === 'thermal') {
      const stackHeight = Math.max(12, Math.min(24, Math.max(w, d) * 0.45));
      const radius = Math.max(0.7, Math.min(1.5, Math.min(w, d) * 0.035));
      const z = building.z - Math.min(d * 0.27, 7);
      const xOff = Math.min(w * 0.26, 8);
      for (const x of [building.x - xOff, building.x + xOff]) {
        thermalStacks.push(matrix(x, h + stackHeight * 0.5, z, radius, stackHeight, radius));
        thermalStackCaps.push(matrix(x, h + stackHeight + 0.35, z, radius * 1.18, 0.7, radius * 1.18));
      }
      continue;
    }

    if (role === 'solar') {
      const rows = Math.max(3, Math.min(6, Math.floor(w / 6)));
      const panelW = Math.max(2.5, (w * 0.78) / rows);
      const panelD = Math.max(3, d * 0.68);
      for (let i = 0; i < rows; i++) {
        const x = building.x - w * 0.39 + panelW * (i + 0.5);
        solarPanels.push(matrix(x, h + 0.32, building.z, panelW * 0.86, 0.18, panelD));
      }
      continue;
    }

    const count = role === 'external' ? 3 : 2;
    const bodyW = Math.max(1.8, Math.min(4.2, w * 0.18));
    const bodyD = Math.max(1.6, Math.min(3.8, d * 0.24));
    for (let i = 0; i < count; i++) {
      const x = building.x + (i - (count - 1) * 0.5) * bodyW * 1.45;
      transformerBodies.push(matrix(x, h + 0.75, building.z, bodyW, 1.5, bodyD));
      transformerTops.push(matrix(x, h + 1.75, building.z, bodyW * 0.72, 0.5, bodyD * 0.72));
      const postOffset = Math.min(bodyW * 0.24, 0.8);
      switchgear.push(matrix(x - postOffset, h + 2.65, building.z, 0.16, 1.5, 0.16));
      switchgear.push(matrix(x + postOffset, h + 2.65, building.z, 0.16, 1.5, 0.16));
    }
  }

  addBatch(scene, new THREE.CylinderGeometry(1, 1.08, 1, 10), new THREE.MeshStandardMaterial({ color: 0x6a6762, roughness: 0.72, metalness: 0.18 }), thermalStacks);
  addBatch(scene, new THREE.CylinderGeometry(1, 1, 1, 10), new THREE.MeshStandardMaterial({ color: 0xb45b4a, roughness: 0.68 }), thermalStackCaps);
  addBatch(scene, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x263d55, roughness: 0.28, metalness: 0.25 }), solarPanels);
  addBatch(scene, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x59636a, roughness: 0.62, metalness: 0.32 }), transformerBodies);
  addBatch(scene, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x7a858c, roughness: 0.55, metalness: 0.35 }), transformerTops);
  addBatch(scene, new THREE.CylinderGeometry(1, 1, 1, 7), new THREE.MeshStandardMaterial({ color: 0x9a8e79, roughness: 0.48 }), switchgear);
}

const rendererProto = EnhancedRenderer.prototype as unknown as AnyHost;
if (!rendererProto.__citySimPowerFacilityBuildingVisualV1027) {
  const previousColor = rendererProto.buildingColor as AnyMethod;
  rendererProto.buildingColor = function powerFacilityBuildingColor(this: EnhancedRenderer, building: Building): THREE.Color {
    const role = roleOf(building);
    if (role === 'thermal') return new THREE.Color(0x807064);
    if (role === 'solar') return new THREE.Color(0x718596);
    if (role === 'substation') return new THREE.Color(0xa3aaad);
    if (role === 'external') return new THREE.Color(0x7d9188);
    return previousColor.call(this, building);
  };

  const previousBuildStatic = rendererProto.buildStatic as AnyMethod;
  rendererProto.buildStatic = function buildStaticWithPowerFacilityDetails(this: EnhancedRenderer, buildings: Building[], ...args: any[]): any {
    const result = previousBuildStatic.call(this, buildings, ...args);
    const host = this as unknown as AnyHost;
    if (!host.__powerFacilityDetailsBuilt && host.sceneRef instanceof THREE.Scene) {
      buildPowerBuildingDetails(host.sceneRef, buildings);
      host.__powerFacilityDetailsBuilt = true;
    }
    return result;
  };

  rendererProto.__citySimPowerFacilityBuildingVisualV1027 = true;
}

const inspectorProto = UniversalInspector.prototype as unknown as AnyHost;
if (!inspectorProto.__citySimPowerFacilityBuildingInspectorV1027) {
  const previousDescribeBuilding = inspectorProto.describeBuilding as AnyMethod;
  inspectorProto.describeBuilding = function describePowerFacilityBuilding(this: UniversalInspector, id: number): string {
    const base = String(previousDescribeBuilding.call(this, id) ?? '');
    const host = this as unknown as AnyHost;
    const building = host.world?.city?.buildings?.[id] as PowerBuilding | undefined;
    const label = building?.infrastructureLabel;
    const role = building ? roleOf(building) : null;
    if (!label || !role) return base;
    const kind = role === 'thermal' ? '火力発電施設'
      : role === 'solar' ? '太陽光発電施設'
        : role === 'substation' ? '変電施設' : '外部受電施設';
    return `${label} [${kind}]\n${base}`;
  };
  inspectorProto.__citySimPowerFacilityBuildingInspectorV1027 = true;
}
