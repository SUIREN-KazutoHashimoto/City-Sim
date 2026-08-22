import { dist } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { RoadNetwork, roadWidth, edgeAxis } from './RoadNetwork';
import { PathGraph } from './AStar';

/** 車道の脇に物理分離した歩行者グラフ(交差点コーナーノード方式)。 */
export interface SidewalkNode { id: number; x: number; z: number; edges: number[]; roadNode: number; }
export interface SidewalkEdge {
  id: number; from: number; to: number; length: number; speedLimit: number;
  crossing: boolean; axis: 0 | 1; roadLanes: number;
}
const SW_HALF = 1.5;

export class SidewalkNetwork implements PathGraph {
  nodes: SidewalkNode[] = [];
  edges: SidewalkEdge[] = [];
  private nodeGrid = new SpatialHashGrid(60);
  constructor(road: RoadNetwork) { this.build(road); }
  private addNode(x: number, z: number, roadNode: number): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, edges: [], roadNode });
    this.nodeGrid.insert(id, x, z);
    return id;
  }
  private addEdge(a: number, b: number, crossing: boolean, roadLanes: number): void {
    const na = this.nodes[a], nb = this.nodes[b];
    const len = dist(na.x, na.z, nb.x, nb.z);
    const axis = edgeAxis(nb.x - na.x, nb.z - na.z);
    const push = (from: number, to: number) => {
      const id = this.edges.length;
      this.edges.push({ id, from, to, length: len, speedLimit: 1.4, crossing, axis, roadLanes });
      this.nodes[from].edges.push(id);
    };
    push(a, b); push(b, a);
  }
  private build(road: RoadNetwork): void {
    type EP = { node: number; lanes: number };
    const atRoadNode: EP[][] = road.nodes.map(() => []);
    const done = new Set<number>();
    for (const e of road.edges) {
      const key = e.from < e.to ? e.from * 1e6 + e.to : e.to * 1e6 + e.from;
      if (done.has(key)) continue;
      done.add(key);
      const a = road.nodes[e.from], b = road.nodes[e.to];
      let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const px = dz, pz = -dx;
      const off = roadWidth(e.lanes) / 2 + SW_HALF;
      const inset = roadWidth(e.lanes) / 2 + 2;
      for (const side of [1, -1]) {
        const ox = px * off * side, oz = pz * off * side;
        const na = this.addNode(a.x + dx * inset + ox, a.z + dz * inset + oz, e.from);
        const nb = this.addNode(b.x - dx * inset + ox, b.z - dz * inset + oz, e.to);
        this.addEdge(na, nb, false, e.lanes);
        atRoadNode[e.from].push({ node: na, lanes: e.lanes });
        atRoadNode[e.to].push({ node: nb, lanes: e.lanes });
      }
    }
    for (let rn = 0; rn < road.nodes.length; rn++) {
      const eps = atRoadNode[rn];
      const cx = road.nodes[rn].x, cz = road.nodes[rn].z;
      for (let a = 0; a < eps.length; a++)
        for (let b = a + 1; b < eps.length; b++) {
          const pa = this.nodes[eps[a].node], pb = this.nodes[eps[b].node];
          const d = dist(pa.x, pa.z, pb.x, pb.z);
          const maxLanes = Math.max(eps[a].lanes, eps[b].lanes);
          if (d > roadWidth(maxLanes) + SW_HALF * 2 + 6) continue;
          const mx = (pa.x + pb.x) / 2, mz = (pa.z + pb.z) / 2;
          const crossing = Math.hypot(mx - cx, mz - cz) < roadWidth(maxLanes) / 2;
          this.addEdge(eps[a].node, eps[b].node, crossing, maxLanes);
        }
    }
  }
  heuristic(a: number, b: number): number { const na = this.nodes[a], nb = this.nodes[b]; return dist(na.x, na.z, nb.x, nb.z); }
  edgeBetween(from: number, to: number): SidewalkEdge | undefined {
    for (const eid of this.nodes[from].edges) if (this.edges[eid].to === to) return this.edges[eid];
    return undefined;
  }
  nearestNode(x: number, z: number): number {
    let best = -1, bestD = Infinity;
    const check = (id: number) => { const n = this.nodes[id]; const d = (n.x - x) ** 2 + (n.z - z) ** 2; if (d < bestD) { bestD = d; best = id; } };
    for (const r of [80, 200, 600, 2000]) { this.nodeGrid.queryNeighbors(x, z, r, check); if (best >= 0) break; }
    return best;
  }
}
