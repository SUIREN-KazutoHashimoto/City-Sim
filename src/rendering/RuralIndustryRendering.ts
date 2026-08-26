import * as THREE from 'three';
import { EnhancedRenderer } from './EnhancedRenderer';
import { productionSitesForNetwork } from '../generation/RuralIndustryAndDepotTuning';
import type { RoadNetwork } from '../traffic/RoadNetwork';

type AnyRenderer = any;
type AnyMethod = (...args: any[]) => any;

function matrix(x: number, y: number, z: number, heading: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -heading, 0)),
    new THREE.Vector3(sx, sy, sz),
  );
}

function rowCount(depth: number): number {
  return Math.max(7, Math.min(28, Math.round(depth / 14)));
}

const proto = EnhancedRenderer.prototype as unknown as Record<string, any>;
if (!proto.__citySimRuralIndustryRenderingV077) {
  const previousBuildStatic = proto.buildStatic as AnyMethod;
  proto.buildStatic = function buildStaticWithFarmEstates(this: AnyRenderer, buildings: any[], net: RoadNetwork, sidewalk: any, lots: any[]): void {
    previousBuildStatic.call(this, buildings, net, sidewalk, lots);
    const farms = productionSitesForNetwork(net).filter((s) => s.kind === 'farm');
    if (farms.length === 0) return;

    const field = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x6f7f3f, roughness: 1 }),
      farms.length,
    );
    field.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(farms.length * 3), 3);
    const fieldColors = [new THREE.Color(0x667d3f), new THREE.Color(0x8a8740), new THREE.Color(0x5f7841), new THREE.Color(0x8b7540)];
    farms.forEach((farm, i) => {
      field.setMatrixAt(i, matrix(farm.x, 0.025, farm.z, farm.heading, farm.width, 0.05, farm.depth));
      field.setColorAt(i, fieldColors[i % fieldColors.length]);
    });
    field.instanceMatrix.needsUpdate = true;
    if (field.instanceColor) field.instanceColor.needsUpdate = true;
    field.receiveShadow = true; field.castShadow = false;
    this.sceneRef.add(field);

    const totalRows = farms.reduce((sum, farm) => sum + rowCount(farm.depth), 0);
    const rowMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xb29b62, roughness: 1 }),
      Math.max(1, totalRows),
    );
    let k = 0;
    for (const farm of farms) {
      const rows = rowCount(farm.depth);
      const px = Math.sin(farm.heading), pz = -Math.cos(farm.heading);
      for (let r = 0; r < rows; r++) {
        const lateral = (r - (rows - 1) * 0.5) * (farm.depth / (rows + 1));
        const x = farm.x + px * lateral, z = farm.z + pz * lateral;
        rowMesh.setMatrixAt(k++, matrix(x, 0.065, z, farm.heading, farm.width * 0.94, 0.035, 0.45));
      }
    }
    rowMesh.count = k; rowMesh.instanceMatrix.needsUpdate = true; rowMesh.castShadow = false; rowMesh.receiveShadow = false;
    this.sceneRef.add(rowMesh);
    this.__ruralFarmFields = field;
    this.__ruralFarmRows = rowMesh;
  };
  proto.__citySimRuralIndustryRenderingV077 = true;
}
