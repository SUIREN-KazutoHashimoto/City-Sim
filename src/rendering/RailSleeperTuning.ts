import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

const SLEEPER_SPACING_METERS = 0.60;
const CITY_SLEEPER_LENGTH = 0.18;
const CITY_SLEEPER_HEIGHT = 0.12;
const CITY_SLEEPER_WIDTH = 3.0;
const HSR_TRACK_OFFSET = 2.4;
const HSR_SLEEPER_LENGTH = 0.22;
const HSR_SLEEPER_HEIGHT = 0.12;
const HSR_SLEEPER_WIDTH = 2.9;

interface StaticPartLike {
  matrix: THREE.Matrix4;
}

interface SmoothLineLike {
  line: { id: number };
  length: number;
}

interface CityRailSleeperRuntime {
  pushLineTrack: (
    smooth: SmoothLineLike,
    lane: number,
    ballast: StaticPartLike[],
    rails: StaticPartLike[],
    sleepers: StaticPartLike[],
  ) => void;
  sampleSmooth: (smooth: SmoothLineLike, distance: number) => { x: number; z: number; heading: number } | null;
  trackOffsetAt: (smooth: SmoothLineLike, lane: number, distance: number) => number;
  lineTrackY: (lineId: number) => number;
  matrix: (x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY?: number) => THREE.Matrix4;
}

interface CityRailSleeperPrototype extends Partial<CityRailSleeperRuntime> {
  __citySimSleeperSpacingV025?: boolean;
}

interface HighSpeedSleeperSource {
  __citySimSleeperSpacingV025?: boolean;
  route?: {
    length: number;
    trackY: number;
    heading: number;
  };
  pointAt?: (s: number, offset?: number) => { x: number; z: number };
  rt?: { scene: THREE.Scene };
}

interface HighSpeedInspectionAdapterInternal {
  source?: HighSpeedSleeperSource;
}

function matrixBox(
  x: number,
  y: number,
  z: number,
  length: number,
  height: number,
  width: number,
  heading: number,
): THREE.Matrix4 {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.rotation.y = -heading;
  o.scale.set(length, height, width);
  o.updateMatrix();
  return o.matrix.clone();
}

/**
 * Replace the sparse visual sleeper sampling in RailRenderer with true 0.60 m centres.
 *
 * The original renderer sampled sleepers every 8.5 m purely as a visual optimization. We preserve
 * the existing single InstancedMesh path: each call removes only the sparse sleepers just appended by
 * the base method, then adds 0.60 m centres along the exact smoothed track distance. Rails, ballast,
 * turnout geometry and simulation/interlocking behavior are untouched.
 */
export function prepareRailSleeperSpacing(): void {
  const proto = RailRenderer.prototype as unknown as CityRailSleeperPrototype;
  if (proto.__citySimSleeperSpacingV025) return;
  const basePushLineTrack = proto.pushLineTrack;
  if (!basePushLineTrack) return;
  proto.__citySimSleeperSpacingV025 = true;

  proto.pushLineTrack = function (
    this: CityRailSleeperRuntime,
    smooth: SmoothLineLike,
    lane: number,
    ballast: StaticPartLike[],
    rails: StaticPartLike[],
    sleepers: StaticPartLike[],
  ): void {
    const sleeperStart = sleepers.length;
    basePushLineTrack.call(this, smooth, lane, ballast, rails, sleepers);

    // Remove the base method's 8.5 m visual sleeper samples for this lane only.
    sleepers.length = sleeperStart;

    const y = this.lineTrackY(smooth.line.id);
    const count = Math.floor((smooth.length + 1e-7) / SLEEPER_SPACING_METERS) + 1;
    for (let i = 0; i < count; i++) {
      const s = i * SLEEPER_SPACING_METERS;
      if (s > smooth.length + 1e-7) break;
      const p = this.sampleSmooth(smooth, s);
      if (!p) continue;
      const off = this.trackOffsetAt(smooth, lane, s);
      const x = p.x - Math.sin(p.heading) * off;
      const z = p.z + Math.cos(p.heading) * off;
      sleepers.push({
        matrix: this.matrix(
          x,
          y + 0.17,
          z,
          CITY_SLEEPER_LENGTH,
          CITY_SLEEPER_HEIGHT,
          CITY_SLEEPER_WIDTH,
          -p.heading,
        ),
      });
    }
  };
}

/** Add 0.60 m sleepers to both tracks of the dedicated high-speed viaduct. */
export function installHighSpeedSleeperSpacing(): void {
  const inspection = latestHighSpeedRailInspectionSource();
  const adapter = inspection as unknown as HighSpeedInspectionAdapterInternal;
  const source = adapter?.source;
  if (!source || source.__citySimSleeperSpacingV025) return;

  const route = source.route;
  const pointAt = source.pointAt?.bind(source);
  const scene = source.rt?.scene;
  if (!route || !pointAt || !scene || route.length <= 0) return;

  source.__citySimSleeperSpacingV025 = true;
  const perTrack = Math.floor((route.length + 1e-7) / SLEEPER_SPACING_METERS) + 1;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x54504a, roughness: 0.98 }),
    perTrack * 2,
  );

  let instance = 0;
  for (const trackOffset of [-HSR_TRACK_OFFSET, HSR_TRACK_OFFSET]) {
    for (let i = 0; i < perTrack; i++) {
      const s = i * SLEEPER_SPACING_METERS;
      if (s > route.length + 1e-7) break;
      const p = pointAt(s, trackOffset);
      mesh.setMatrixAt(
        instance++,
        matrixBox(
          p.x,
          route.trackY - HSR_SLEEPER_HEIGHT * 0.5,
          p.z,
          HSR_SLEEPER_LENGTH,
          HSR_SLEEPER_HEIGHT,
          HSR_SLEEPER_WIDTH,
          route.heading,
        ),
      );
    }
  }

  mesh.count = instance;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);
}
