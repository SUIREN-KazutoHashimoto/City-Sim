import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';

type TrainService = 'local' | 'rapid' | 'limited';

interface TrainRunLike {
  id: number;
  lineId: number;
  service: TrainService;
  carCount: number;
}

interface RailLineLike { id: number; }
interface SmoothLineLike { length: number; }
interface StaticPartLike { matrix: THREE.Matrix4; }

interface FormationRuntime {
  scene: THREE.Scene;
  rail: { lines: RailLineLike[] };
  smoothLines: Map<number, SmoothLineLike>;
  trainRuns: TrainRunLike[];
  trainInstanceToRun: number[];
  trainBody: THREE.InstancedMesh | null;
  trainStripe: THREE.InstancedMesh | null;
  trainCabin: THREE.InstancedMesh | null;
  buildTrains: () => void;
  buildDepots: () => void;
  trainRouteColor: (lineId: number) => THREE.Color;
  lineTrackY: (lineId: number) => number;
  sampleSmooth: (smooth: SmoothLineLike, distance: number) => { x: number; z: number; heading: number } | null;
  pushTrackSegment: (a: { x: number; z: number }, b: { x: number; z: number }, y: number, ballast: StaticPartLike[], rails: StaticPartLike[], width: number) => void;
  addStatic: (geometry: THREE.BufferGeometry, material: THREE.Material, parts: StaticPartLike[]) => THREE.InstancedMesh | null;
  matrix: (x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY?: number) => THREE.Matrix4;
}

interface FormationPrototype extends Partial<FormationRuntime> {
  __citySimFormationV027?: boolean;
}

const DEPOT_TRACKS = 4;
const DEPOT_TRACK_GAP = 4.4;
const DEPOT_SIDE_OFFSET = 13.0;
const DEPOT_EXTENSION_END = 620;

function formationCars(service: TrainService): number {
  return service === 'limited' ? 7 : service === 'rapid' ? 9 : 11;
}

function disposeMesh(scene: THREE.Scene, mesh: THREE.InstancedMesh | null): void {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
  else mesh.material.dispose();
}

function rebuildTrainMeshes(rt: FormationRuntime): void {
  disposeMesh(rt.scene, rt.trainBody);
  disposeMesh(rt.scene, rt.trainStripe);
  disposeMesh(rt.scene, rt.trainCabin);

  let cap = 0;
  for (const run of rt.trainRuns) cap += run.carCount;
  const box = new THREE.BoxGeometry(1, 1, 1);
  rt.trainBody = new THREE.InstancedMesh(
    box.clone(),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.18, vertexColors: true }),
    cap,
  );
  rt.trainStripe = new THREE.InstancedMesh(
    box.clone(),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.10, vertexColors: true }),
    cap,
  );
  rt.trainCabin = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.22, vertexColors: true }),
    cap,
  );

  rt.trainInstanceToRun.length = 0;
  let idx = 0;
  for (const run of rt.trainRuns) {
    const route = rt.trainRouteColor(run.lineId);
    for (let car = 0; car < run.carCount; car++) {
      rt.trainInstanceToRun[idx] = run.id;
      rt.trainBody.setColorAt(idx, new THREE.Color(run.service === 'local' ? 0xdfe5e8 : 0xf5f7f9));
      rt.trainStripe.setColorAt(idx, route);
      rt.trainCabin.setColorAt(idx, route.clone().lerp(new THREE.Color(0x102235), 0.72));
      idx++;
    }
  }

  for (const mesh of [rt.trainBody, rt.trainStripe, rt.trainCabin]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    rt.scene.add(mesh);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * Apply the requested 7/9/11-car formations before the first visual update. The base renderer builds
 * its fleet first; this wrapper then changes consist lengths and recreates the three instanced train
 * meshes with enough capacity for the longer formations.
 */
export function prepareRailFormationTuning(): void {
  const proto = RailRenderer.prototype as unknown as FormationPrototype;
  if (proto.__citySimFormationV027) return;
  proto.__citySimFormationV027 = true;

  const baseBuildTrains = proto.buildTrains;
  if (baseBuildTrains) {
    proto.buildTrains = function (this: FormationRuntime): void {
      baseBuildTrains.call(this);
      for (const run of this.trainRuns) run.carCount = formationCars(run.service);
      if (this.trainRuns.length) rebuildTrainMeshes(this);
    };
  }

  const baseBuildDepots = proto.buildDepots;
  if (baseBuildDepots) {
    proto.buildDepots = function (this: FormationRuntime): void {
      baseBuildDepots.call(this);
      const ballast: StaticPartLike[] = [];
      const rails: StaticPartLike[] = [];
      const apron: StaticPartLike[] = [];

      for (const line of this.rail.lines) {
        const smooth = this.smoothLines.get(line.id);
        if (!smooth || smooth.length <= 0) continue;
        const y = this.lineTrackY(line.id);
        for (const end of [0, 1] as const) {
          const base = this.sampleSmooth(smooth, end === 0 ? 0 : smooth.length);
          if (!base) continue;
          const outward = end === 0 ? -1 : 1;
          const sideSign = ((line.id + end) & 1) === 0 ? 1 : -1;
          for (let track = 0; track < DEPOT_TRACKS; track++) {
            const off = sideSign * (DEPOT_SIDE_OFFSET + track * DEPOT_TRACK_GAP);
            let prev: { x: number; z: number } | null = null;
            for (let along = 224; along <= DEPOT_EXTENSION_END; along += 8) {
              const q = {
                x: base.x + Math.cos(base.heading) * outward * along - Math.sin(base.heading) * off,
                z: base.z + Math.sin(base.heading) * outward * along + Math.cos(base.heading) * off,
              };
              if (prev) this.pushTrackSegment(prev, q, y, ballast, rails, 3.2);
              prev = q;
            }
          }
          const apronAlong = 390;
          const ax = base.x + Math.cos(base.heading) * outward * apronAlong - Math.sin(base.heading) * sideSign * 20;
          const az = base.z + Math.sin(base.heading) * outward * apronAlong + Math.cos(base.heading) * sideSign * 20;
          apron.push({ matrix: this.matrix(ax, y - 0.20, az, 460, 0.18, 34, -base.heading) });
        }
      }

      const box = new THREE.BoxGeometry(1, 1, 1);
      this.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), ballast);
      this.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), rails);
      this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x555b60, roughness: 0.96 }), apron);
    };
  }
}
