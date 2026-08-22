import { dist } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';

export enum RoadClass { Highway = 0, Arterial = 1, Local = 2, Path = 3 }

export interface RoadNode {
  id: number; x: number; z: number;
  edges: number[]; hasSignal: boolean;
}
export interface RoadEdge {
  id: number; from: number; to: number;
  length: number; lanes: number; speedLimit: number;
  roadClass: RoadClass; occupants: number[];
}

const SPEED_BY_CLASS: Record<RoadClass, number> = {
  [RoadClass.Highway]: 27, [RoadClass.Arterial]: 16,
  [RoadClass.Local]: 11, [RoadClass.Path]: 1.4,
};

export function edgeAxis(dx: number, dz: number): 0 | 1 {
  return Math.abs(dx) >= Math.abs(dz) ? 0 : 1;
}
export function roadWidth(lanes: number): number { return 3.5 * lanes * 2; }
export function crosswalkSetback(rw: number): number { return 7 + rw * 0.25; }
export const CROSSWALK_DEPTH = 4.5;

export class RoadNetwork {
  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  private nodeGrid = new SpatialHashGrid(120);

  addNode(x: number, z: number, hasSignal = false): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, edges: [], hasSignal });
    this.nodeGrid.insert(id, x, z);
    return id;
  }
  connect(a: number, b: number, roadClass: RoadClass, lanes = 1): void {
    const na = this.nodes[a], nb = this.nodes[b];
    const len = dist(na.x, na.z, nb.x, nb.z);
    const speed = SPEED_BY_CLASS[roadClass];
    this.pushEdge(a, b, len, lanes, speed, roadClass);
    this.pushEdge(b, a, len, lanes, speed, roadClass);
  }
  private pushEdge(from: number, to: number, length: number, lanes: number,
                   speedLimit: number, roadClass: RoadClass): void {
    const id = this.edges.length;
    this.edges.push({ id, from, to, length, lanes, speedLimit, roadClass, occupants: [] });
    this.nodes[from].edges.push(id);
  }
  heuristic(a: number, b: number): number {
    const na = this.nodes[a], nb = this.nodes[b];
    return dist(na.x, na.z, nb.x, nb.z);
  }
  axisOf(from: number, to: number): 0 | 1 {
    const nf = this.nodes[from], nt = this.nodes[to];
    return edgeAxis(nt.x - nf.x, nt.z - nf.z);
  }
  edgeBetween(from: number, to: number): RoadEdge | undefined {
    for (const eid of this.nodes[from].edges)
      if (this.edges[eid].to === to) return this.edges[eid];
    return undefined;
  }
  nearestNode(x: number, z: number): number {
    let best = -1, bestD = Infinity;
    const check = (id: number) => {
      const n = this.nodes[id];
      const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
      if (d < bestD) { bestD = d; best = id; }
    };
    for (const r of [150, 400, 1000, 3000]) {
      this.nodeGrid.queryNeighbors(x, z, r, check);
      if (best >= 0) break;
    }
    return best;
  }
}
