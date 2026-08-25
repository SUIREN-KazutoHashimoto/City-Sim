import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const TRAIN_ROOT_NAME = 'render-filter:trains';

function trainRoot(scene: THREE.Scene): THREE.Group | null {
  const root = scene.children.find((child) => child instanceof THREE.Group && child.name === TRAIN_ROOT_NAME);
  return root instanceof THREE.Group ? root : null;
}

function sceneOf(rail: RailRenderer): THREE.Scene | null {
  const value = (rail as unknown as AnyHost).scene;
  return value instanceof THREE.Scene ? value : null;
}

function moveToTrainRoot(value: unknown, root: THREE.Group): void {
  if (value instanceof THREE.Object3D && value.parent !== root) root.add(value);
}

/**
 * The public HSR inspection registry returns an adapter, while the actual visual meshes
 * live on its wrapped source. RenderFilterRailSplit used to inspect only the adapter,
 * leaving the HSR body/window/stripe under the rail infrastructure root.
 */
function adoptHighSpeedTrainVisuals(scene: THREE.Scene): void {
  const root = trainRoot(scene);
  const inspection = latestHighSpeedRailInspectionSource() as unknown as AnyHost | null;
  if (!root || !inspection) return;

  const source = (inspection.source ?? inspection) as AnyHost;
  moveToTrainRoot(source.carBody, root);
  moveToTrainRoot(source.carWindow, root);
  moveToTrainRoot(source.carStripe, root);

  // HighSpeedInspectionAdapter owns the visible wedge noses separately from the source.
  // Keep those in the same train category as the body. Updating noseParent also keeps
  // adapter disposal correct after reparenting.
  if (inspection.noseMesh instanceof THREE.Object3D) {
    moveToTrainRoot(inspection.noseMesh, root);
    inspection.noseParent = root;
  }
}

function install(): void {
  const proto = RailRenderer.prototype as unknown as AnyHost;
  if (proto.__citySimHighSpeedTrainFilterV053) return;
  proto.__citySimHighSpeedTrainFilterV053 = true;

  const previousBuild = proto.build as AnyMethod;
  proto.build = function buildWithHighSpeedTrainCategory(this: RailRenderer, ...args: any[]): any {
    const result = previousBuild.apply(this, args);
    const scene = sceneOf(this);
    if (scene) {
      adoptHighSpeedTrainVisuals(scene);
      // External-rail decorators are installed during build; a zero-delay pass catches
      // any adapter registration completed at the end of the same call without relying
      // on simulation time or animation frames.
      if (typeof window !== 'undefined') window.setTimeout(() => adoptHighSpeedTrainVisuals(scene), 0);
    }
    return result;
  };
}

install();
