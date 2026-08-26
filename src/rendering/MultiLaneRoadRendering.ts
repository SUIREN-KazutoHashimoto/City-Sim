import * as THREE from 'three';
import { InstancedRenderer } from './InstancedRenderer';
import { RoadClass, type RoadNetwork } from '../traffic/RoadNetwork';

const LANE_WIDTH = 3.5;
type AnyRenderer = any;
type BuildRoadsMethod = (this: AnyRenderer, net: RoadNetwork) => void;

function lineMatrix(
  a: { x: number; z: number },
  b: { x: number; z: number },
  lateralOffset: number,
): THREE.Matrix4 | null {
  let dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 12) return null;
  dx /= length; dz /= length;
  const rx = dz, rz = -dx;
  const visibleLength = Math.max(1, length - 12);
  const mx = (a.x + b.x) * 0.5 + rx * lateralOffset;
  const mz = (a.z + b.z) * 0.5 + rz * lateralOffset;
  const heading = Math.atan2(b.z - a.z, b.x - a.x);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(mx, 0.125, mz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -heading, 0)),
    new THREE.Vector3(visibleLength, 0.035, 0.13),
  );
}

const proto = InstancedRenderer.prototype as unknown as Record<string, any>;
if (!proto.__citySimMultiLaneMarkingsV073) {
  const previousBuildRoads = proto.buildRoads as BuildRoadsMethod;
  proto.buildRoads = function buildRoadsWithLaneMarkings(this: AnyRenderer, net: RoadNetwork): void {
    previousBuildRoads.call(this, net);
    const scene = (this.scene ?? this.sceneRef) as THREE.Scene | undefined;
    if (!scene) return;

    const matrices: THREE.Matrix4[] = [];
    const drawn = new Set<string>();
    for (const edge of net.edges) {
      if (edge.roadClass === RoadClass.Path || edge.lanes <= 1) continue;
      const key = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = net.nodes[edge.from], b = net.nodes[edge.to];
      if (!a || !b) continue;
      for (let laneBoundary = 1; laneBoundary < edge.lanes; laneBoundary++) {
        const offset = laneBoundary * LANE_WIDTH;
        const positive = lineMatrix(a, b, offset);
        const negative = lineMatrix(a, b, -offset);
        if (positive) matrices.push(positive);
        if (negative) matrices.push(negative);
      }
    }
    if (matrices.length === 0) return;

    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe7e7e2, roughness: 0.92 }),
      matrices.length,
    );
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    scene.add(mesh);
    this.__multiLaneMarkings = mesh;
  };
  proto.__citySimMultiLaneMarkingsV073 = true;
}
