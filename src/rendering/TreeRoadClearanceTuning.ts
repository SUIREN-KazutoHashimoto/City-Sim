import * as THREE from 'three';
import { EnhancedRenderer } from './EnhancedRenderer';
import { RoadClass, roadWidth, type RoadNetwork } from '../traffic/RoadNetwork';

type AnyRenderer = any;
type AnyMethod = (...args: any[]) => any;
interface Segment { ax: number; az: number; bx: number; bz: number; half: number; }

const CELL = 120;

function key(x: number, z: number): string { return `${x},${z}`; }

function roadIndex(net: RoadNetwork): Map<string, Segment[]> {
  const buckets = new Map<string, Segment[]>();
  const seen = new Set<string>();
  for (const edge of net.edges) {
    if (edge.roadClass === RoadClass.Path) continue;
    const pair = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const a = net.nodes[edge.from], b = net.nodes[edge.to];
    if (!a || !b) continue;
    const seg: Segment = { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: roadWidth(Math.max(1, edge.lanes)) * 0.5 + 1.8 };
    const minX = Math.floor((Math.min(a.x, b.x) - seg.half) / CELL), maxX = Math.floor((Math.max(a.x, b.x) + seg.half) / CELL);
    const minZ = Math.floor((Math.min(a.z, b.z) - seg.half) / CELL), maxZ = Math.floor((Math.max(a.z, b.z) + seg.half) / CELL);
    for (let gx = minX; gx <= maxX; gx++) for (let gz = minZ; gz <= maxZ; gz++) {
      const k = key(gx, gz); let list = buckets.get(k); if (!list) { list = []; buckets.set(k, list); } list.push(seg);
    }
  }
  return buckets;
}

function pointSegmentDistance(x: number, z: number, s: Segment): number {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1e-6) return Math.hypot(x - s.ax, z - s.az);
  const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / d2));
  return Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
}

function onRoad(index: Map<string, Segment[]>, x: number, z: number): boolean {
  const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
  for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iz = gz - 1; iz <= gz + 1; iz++) {
    for (const seg of index.get(key(ix, iz)) ?? []) if (pointSegmentDistance(x, z, seg) <= seg.half) return true;
  }
  return false;
}

function filterStreetTrees(renderer: AnyRenderer, index: Map<string, Segment[]>): void {
  const trunks = renderer.treeTrunkRecords as Array<{ x?: number; z?: number }> | undefined;
  const crowns = renderer.treeCrownRecords as Array<{ x?: number; z?: number }> | undefined;
  if (!trunks || !crowns || trunks.length !== crowns.length) return;
  const keptT: any[] = [], keptC: any[] = [];
  for (let i = 0; i < trunks.length; i++) {
    const t = trunks[i];
    if (t.x == null || t.z == null || onRoad(index, t.x, t.z)) continue;
    keptT.push(t); keptC.push(crowns[i]);
  }
  renderer.treeTrunkRecords = keptT;
  renderer.treeCrownRecords = keptC;
}

function compactForestTrees(renderer: AnyRenderer, index: Map<string, Segment[]>): void {
  const trunk = renderer.__forestTrunkMesh as THREE.InstancedMesh | undefined;
  const crown = renderer.__forestCrownMesh as THREE.InstancedMesh | undefined;
  if (!trunk || !crown) return;
  const tm = new THREE.Matrix4(), cm = new THREE.Matrix4(), p = new THREE.Vector3();
  let out = 0;
  const count = Math.min(trunk.count, crown.count);
  for (let i = 0; i < count; i++) {
    trunk.getMatrixAt(i, tm); p.setFromMatrixPosition(tm);
    if (onRoad(index, p.x, p.z)) continue;
    crown.getMatrixAt(i, cm);
    if (out !== i) { trunk.setMatrixAt(out, tm); crown.setMatrixAt(out, cm); }
    out++;
  }
  trunk.count = out; crown.count = out;
  trunk.instanceMatrix.needsUpdate = true; crown.instanceMatrix.needsUpdate = true;
}

const proto = EnhancedRenderer.prototype as unknown as Record<string, any>;
if (!proto.__citySimTreeRoadClearanceV081) {
  const previousBuildStatic = proto.buildStatic as AnyMethod;
  proto.buildStatic = function buildStaticWithoutRoadTrees(this: AnyRenderer, buildings: any[], net: RoadNetwork, sidewalk: any, lots: any[]): void {
    previousBuildStatic.call(this, buildings, net, sidewalk, lots);
    const index = roadIndex(net);
    filterStreetTrees(this, index);
    compactForestTrees(this, index);
  };
  proto.__citySimTreeRoadClearanceV081 = true;
}
