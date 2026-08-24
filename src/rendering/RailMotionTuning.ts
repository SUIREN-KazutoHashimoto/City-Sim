import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';

const CITY_RAIL_ACCEL_MPS2 = 3.0 / 3.6;
const CITY_RAIL_BRAKE_MPS2 = 4.2 / 3.6;
const CITY_RAIL_CAR_LENGTH = 20.0;
const CITY_RAIL_WIDTH = 3.0;
const CITY_RAIL_HEIGHT = 3.75;
const CITY_RAIL_BODY_BOTTOM_CLEARANCE = 0.275;
const CITY_RAIL_MIN_PLATFORM_LENGTH = 240;
const CITY_RAIL_DEPOT_SLOT_SPACING = 250;

interface MutableRailRendererConstructor {
  ACCEL: number;
  BRAKE: number;
  CAR_LENGTH: number;
  TRAIN_WIDTH: number;
  DEPOT_SLOT_SPACING: number;
}

interface DimensionTrainRun {
  lineId: number;
}

interface MutableRailRendererRuntime {
  trainBody: THREE.InstancedMesh | null;
  trainStripe: THREE.InstancedMesh | null;
  trainRuns: DimensionTrainRun[];
  trainInstanceToRun: number[];
  lineTrackY: (lineId: number) => number;
  updateTrainMeshes: () => void;
  platformLength: (stationId: number) => number;
}

interface MutableRailRendererPrototype extends Partial<MutableRailRendererRuntime> {
  __citySimDimensionsV027?: boolean;
}

let prepared = false;

/**
 * Apply requested city-rail dynamics and exterior dimensions before railway construction.
 *
 * The longest regular consist is now the 11-car local: 11 x 20 m plus 10 inter-car gaps is roughly
 * 227 m. Every passenger platform therefore gets at least 240 m usable length and depot slots are
 * spaced at 250 m centres. Platform roofs, columns, sidings, crossovers and access geometry already
 * derive from platformLength(), so they automatically follow the longer station footprint.
 */
export function prepareRailMotionTuning(): void {
  if (prepared) return;
  prepared = true;

  const ctor = RailRenderer as unknown as MutableRailRendererConstructor;
  ctor.ACCEL = CITY_RAIL_ACCEL_MPS2;
  ctor.BRAKE = CITY_RAIL_BRAKE_MPS2;
  ctor.CAR_LENGTH = CITY_RAIL_CAR_LENGTH;
  ctor.TRAIN_WIDTH = CITY_RAIL_WIDTH;
  ctor.DEPOT_SLOT_SPACING = CITY_RAIL_DEPOT_SLOT_SPACING;

  const proto = RailRenderer.prototype as unknown as MutableRailRendererPrototype;
  if (proto.__citySimDimensionsV027) return;
  proto.__citySimDimensionsV027 = true;

  const basePlatformLength = proto.platformLength;
  if (basePlatformLength) {
    proto.platformLength = function (this: MutableRailRendererRuntime, stationId: number): number {
      return Math.max(CITY_RAIL_MIN_PLATFORM_LENGTH, basePlatformLength.call(this, stationId));
    };
  }

  const baseUpdateTrainMeshes = proto.updateTrainMeshes;
  if (baseUpdateTrainMeshes) {
    proto.updateTrainMeshes = function (this: MutableRailRendererRuntime): void {
      baseUpdateTrainMeshes.call(this);
      if (!this.trainBody) return;

      const m = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const scale = new THREE.Vector3();

      for (let instance = 0; instance < this.trainBody.count; instance++) {
        const runId = this.trainInstanceToRun[instance] ?? -1;
        const run = runId >= 0 ? this.trainRuns[runId] : undefined;
        if (!run) continue;

        this.trainBody.getMatrixAt(instance, m);
        m.decompose(position, rotation, scale);
        position.y = this.lineTrackY(run.lineId) + CITY_RAIL_BODY_BOTTOM_CLEARANCE + CITY_RAIL_HEIGHT * 0.5;
        scale.set(CITY_RAIL_CAR_LENGTH, CITY_RAIL_HEIGHT, CITY_RAIL_WIDTH);
        m.compose(position, rotation, scale);
        this.trainBody.setMatrixAt(instance, m);

        if (this.trainStripe) {
          this.trainStripe.getMatrixAt(instance, m);
          m.decompose(position, rotation, scale);
          scale.z = CITY_RAIL_WIDTH + 0.01;
          m.compose(position, rotation, scale);
          this.trainStripe.setMatrixAt(instance, m);
        }
      }

      this.trainBody.instanceMatrix.needsUpdate = true;
      if (this.trainStripe) this.trainStripe.instanceMatrix.needsUpdate = true;
    };
  }
}
