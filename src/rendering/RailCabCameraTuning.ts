import * as THREE from 'three';
import type { CameraFollowTarget } from './FirstPersonController';
import { FirstPersonController } from './FirstPersonController';
import { UniversalInspector } from './UniversalInspector';

type TrainState = 'depot' | 'dwell' | 'running' | 'signal' | 'schedule';

interface CityTrainRuntime {
  lineId: number;
  carCount: number;
  direction: 1 | -1;
  state: TrainState;
}

interface CityRailPose {
  x: number;
  z: number;
  heading: number;
}

interface CityRailCameraRuntime {
  trainRuns: CityTrainRuntime[];
  smoothLines: Map<number, unknown>;
  carPose: (run: CityTrainRuntime, smooth: unknown, carIndex: number) => CityRailPose | null;
  depotCarPose: (run: CityTrainRuntime, smooth: unknown, carIndex: number) => CityRailPose | null;
  lineTrackY: (lineId: number) => number;
}

interface InspectorRuntime {
  rail: CityRailCameraRuntime;
}

interface TunedFollowTarget extends CameraFollowTarget {
  __citySimCabX?: number;
  __citySimCabY?: number;
  __citySimCabZ?: number;
  __citySimCabHeading?: number;
}

interface FirstPersonRuntime {
  camera: THREE.PerspectiveCamera;
  followTarget: TunedFollowTarget | null;
  followFirstPerson: boolean;
}

const CITY_RAIL_CAR_LENGTH = 20.0;
const CITY_CAMERA_AHEAD_OF_FRONT = 0.35;
const HSR_CAMERA_AHEAD_OF_NOSE = 0.45;

let prepared = false;

function clearCabAnchor(target: TunedFollowTarget): void {
  target.__citySimCabX = undefined;
  target.__citySimCabY = undefined;
  target.__citySimCabZ = undefined;
  target.__citySimCabHeading = undefined;
}

function setCabAnchor(target: TunedFollowTarget, x: number, y: number, z: number, heading: number): void {
  target.__citySimCabX = x;
  target.__citySimCabY = y;
  target.__citySimCabZ = z;
  target.__citySimCabHeading = heading;
}

/**
 * Rail stock currently has exterior window/cabin geometry but no true cab interior. Put the
 * first-person eye just beyond the leading exterior face so the window/stripe geometry cannot clip
 * into view. City rail still uses the exact leading-car pose on curves; HSR is straight and can use
 * its consist centre plus half-length. Third-person tracking continues to use the consist centre.
 */
export function prepareRailCabCameraTuning(): void {
  if (prepared) return;
  prepared = true;

  const inspectorProto = UniversalInspector.prototype as unknown as {
    getFollowTarget: (this: UniversalInspector) => CameraFollowTarget | null;
  };
  const baseGetFollowTarget = inspectorProto.getFollowTarget;

  inspectorProto.getFollowTarget = function (this: UniversalInspector): CameraFollowTarget | null {
    const target = baseGetFollowTarget.call(this) as TunedFollowTarget | null;
    if (!target) return null;
    clearCabAnchor(target);

    if (target.kind === 'train') {
      const rail = (this as unknown as InspectorRuntime).rail;
      const run = rail.trainRuns[target.id];
      const smooth = run ? rail.smoothLines.get(run.lineId) : undefined;
      if (run && smooth) {
        const leadCar = run.direction > 0 ? 0 : Math.max(0, run.carCount - 1);
        const pose = run.state === 'depot'
          ? rail.depotCarPose(run, smooth, leadCar)
          : rail.carPose(run, smooth, leadCar);
        if (pose) {
          const forward = CITY_RAIL_CAR_LENGTH * 0.5 + CITY_CAMERA_AHEAD_OF_FRONT;
          setCabAnchor(
            target,
            pose.x + Math.cos(pose.heading) * forward,
            rail.lineTrackY(run.lineId),
            pose.z + Math.sin(pose.heading) * forward,
            pose.heading,
          );
        }
      }
    } else if (target.kind === 'highSpeedTrain' && target.heading != null && target.length != null) {
      const forward = Math.max(0, target.length * 0.5 + HSR_CAMERA_AHEAD_OF_NOSE);
      setCabAnchor(
        target,
        target.position.x + Math.cos(target.heading) * forward,
        target.position.y,
        target.position.z + Math.sin(target.heading) * forward,
        target.heading,
      );
    }

    return target;
  };

  const controllerProto = FirstPersonController.prototype as unknown as {
    update: (this: FirstPersonController, dt: number) => void;
  };
  const baseUpdate = controllerProto.update;

  controllerProto.update = function (this: FirstPersonController, dt: number): void {
    const runtime = this as unknown as FirstPersonRuntime;
    const target = runtime.followTarget;
    if (
      runtime.followFirstPerson
      && target
      && (target.kind === 'train' || target.kind === 'highSpeedTrain')
      && Number.isFinite(target.__citySimCabX)
      && Number.isFinite(target.__citySimCabY)
      && Number.isFinite(target.__citySimCabZ)
      && Number.isFinite(target.__citySimCabHeading)
    ) {
      const heading = target.__citySimCabHeading as number;
      runtime.camera.position.set(
        target.__citySimCabX as number,
        (target.__citySimCabY as number) + (target.firstPersonHeight ?? 1.35),
        target.__citySimCabZ as number,
      );
      runtime.camera.quaternion.setFromEuler(new THREE.Euler(0, -heading - Math.PI / 2, 0, 'YXZ'));
      return;
    }

    baseUpdate.call(this, dt);
  };
}
