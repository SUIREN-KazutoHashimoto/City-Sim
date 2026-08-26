import * as THREE from 'three';
import { EnhancedRenderer } from './EnhancedRenderer';
import type { VehicleStore } from '../traffic/VehicleStore';
import { forEachHazardVehicle, vehicleSignalState } from '../traffic/VehicleSignalRuntime';

type AnyRenderer = any;
type AnyMethod = (...args: any[]) => any;
type TurnMethod = (this: AnyRenderer, vs: VehicleStore, vehicle: number) => -1 | 0 | 1;

const proto = EnhancedRenderer.prototype as unknown as Record<string, any>;
if (!proto.__citySimVehicleSignalRenderingV074) {
  const previousTurnDirection = proto.turnDirection as TurnMethod;
  proto.turnDirection = function turnDirectionWithLaneChange(this: AnyRenderer, vs: VehicleStore, vehicle: number): -1 | 0 | 1 {
    const state = vehicleSignalState(vs, vehicle);
    if (state.hazard) return 0;
    if (state.laneChange !== 0) return state.laneChange;
    return previousTurnDirection.call(this, vs, vehicle);
  };

  const previousBuildVehicles = proto.buildVehicles as AnyMethod;
  proto.buildVehicles = function buildVehiclesWithHazards(this: AnyRenderer, capacity: number): void {
    previousBuildVehicles.call(this, capacity);
    const maxHazardVehicles = Math.max(1, Math.min(capacity, 512));
    this.__hazardIndicator = this.dynamicMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xff9f28, emissive: 0xff7400, emissiveIntensity: 4.5, roughness: 0.3 }),
      maxHazardVehicles * 4,
      false,
      false,
    );
  };

  const previousSyncVehicles = proto.syncVehicles as AnyMethod;
  proto.syncVehicles = function syncVehiclesWithHazards(
    this: AnyRenderer,
    vs: VehicleStore,
    hourF = 12,
    blinkTime = 0,
    cameraPos?: THREE.Vector3,
  ): void {
    previousSyncVehicles.call(this, vs, hourF, blinkTime, cameraPos);
    const mesh = this.__hazardIndicator as THREE.InstancedMesh | undefined;
    if (!mesh) return;
    const blinkOn = (Math.floor(blinkTime * 2.2) & 1) === 0;
    if (!blinkOn) {
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      return;
    }

    const camX = cameraPos?.x ?? 0, camZ = cameraPos?.z ?? 0;
    const useDistance = !!cameraPos;
    const maxD2 = EnhancedRenderer.LOD0_DISTANCE * EnhancedRenderer.LOD0_DISTANCE;
    let count = 0;
    const capacity = mesh.instanceMatrix.count;

    forEachHazardVehicle(vs, (v) => {
      if (count + 4 > capacity) return;
      const x = vs.posX[v], z = vs.posZ[v];
      if (useDistance) {
        const dx = x - camX, dz = z - camZ;
        if (dx * dx + dz * dz > maxD2) return;
      }
      let len = vs.length[v] || 4.5, width = 1.9;
      if (vs.isBus[v]) { len = 11; width = 2.5; }
      else if (vs.isTruck[v]) { len = 9; width = 2.4; }
      const h = vs.heading[v];
      for (const side of [-1, 1]) {
        this.pose(mesh, count++, x, z, h, len / 2 + 0.07, 0.78, side * width * 0.43, 0.11, 0.16, 0.15, 0);
        this.pose(mesh, count++, x, z, h, -len / 2 - 0.07, 0.78, side * width * 0.43, 0.11, 0.16, 0.15, 0);
      }
    });

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  };

  proto.__citySimVehicleSignalRenderingV074 = true;
}
