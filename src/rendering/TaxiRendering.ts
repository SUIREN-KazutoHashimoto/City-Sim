import * as THREE from 'three';
import { EnhancedRenderer } from './EnhancedRenderer';
import { forEachTaxiVehicle } from '../traffic/TaxiSystem';
import { VehicleState, type VehicleStore } from '../traffic/VehicleStore';

type AnyRenderer = any;
type AnyMethod = (...args: any[]) => any;

function matrix(x: number, y: number, z: number, heading: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -heading, 0)),
    new THREE.Vector3(0.86, 0.20, 0.30),
  );
}

const proto = EnhancedRenderer.prototype as unknown as Record<string, any>;
if (!proto.__citySimTaxiRenderingV074) {
  const previousBuildVehicles = proto.buildVehicles as AnyMethod;
  proto.buildVehicles = function buildVehiclesWithTaxiSigns(this: AnyRenderer, capacity: number): void {
    previousBuildVehicles.call(this, capacity);
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0xc9ffe0,
        emissive: 0x67ff9d,
        emissiveIntensity: 2.6,
        roughness: 0.30,
      }),
      Math.max(1, Math.min(capacity, 256)),
    );
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.count = 0;
    (this.sceneRef as THREE.Scene).add(mesh);
    this.__taxiRoofSigns = mesh;
  };

  const previousSyncVehicles = proto.syncVehicles as AnyMethod;
  proto.syncVehicles = function syncVehiclesWithTaxiSigns(
    this: AnyRenderer,
    vs: VehicleStore,
    hourF = 12,
    blinkTime = 0,
    cameraPos?: THREE.Vector3,
  ): void {
    previousSyncVehicles.call(this, vs, hourF, blinkTime, cameraPos);
    const mesh = this.__taxiRoofSigns as THREE.InstancedMesh | undefined;
    if (!mesh) return;

    const camX = cameraPos?.x ?? 0, camZ = cameraPos?.z ?? 0;
    const useDistance = !!cameraPos;
    const maxD2 = EnhancedRenderer.LOD0_DISTANCE * EnhancedRenderer.LOD0_DISTANCE;
    let count = 0;
    const maxSigns = mesh.instanceMatrix.count;
    forEachTaxiVehicle(vs, (taxi) => {
      if (count >= maxSigns || taxi.phase !== 'idle') return;
      const v = taxi.vehicle;
      const state = vs.state[v];
      if (state !== VehicleState.Driving && state !== VehicleState.Parked && state !== VehicleState.Arrived) return;
      if (useDistance) {
        const dx = vs.posX[v] - camX, dz = vs.posZ[v] - camZ;
        if (dx * dx + dz * dz > maxD2) return;
      }
      mesh.setMatrixAt(count++, matrix(vs.posX[v], 1.58, vs.posZ[v], vs.heading[v]));
    });
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  };

  proto.__citySimTaxiRenderingV074 = true;
}
