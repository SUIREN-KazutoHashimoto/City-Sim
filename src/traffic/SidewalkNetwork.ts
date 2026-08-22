import { dist } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { RoadNetwork, roadWidth, edgeAxis } from './RoadNetwork';
import { PathGraph } from './AStar';

/**
 * ============================================================================
 *  SidewalkNetwork — 車道の *脇* に物理的に分離した歩行者グラフ
 * ============================================================================
 * 旧版は車道ノードを共有し「中心線+オフセット」で歩かせたため、広い道路では
 * 車道上を歩いてしまった。本版は各車道エッジの *両側* に歩道ノードを生成し、
 * 交差点まわりの歩道端点を「角の歩道(normal)」と「横断(crossing)」で結ぶ。
 * これにより歩行者は常に車道の外(歩道帯)を歩き、横断歩道でのみ車道を横切る。
 *
 * PathGraph を実装するので車道と同じ AStar をそのまま使える。
 */
export interface SidewalkNode {
  id: number; x: number; z: number; edges: number[];
  /** 対応する車道交差点ノード(信号参照用)。 */
  roadNode: number;
}
export interface SidewalkEdge {
  id: number; from: number; to: number; length: number; speedLimit: number;
  /** 車道を平面横断するエッジ(信号の影響を受ける)。 */
  crossing: boolean;
  /** 横断する軸(0=東西,1=南北)。crossing のときのみ有効。 */
  axis: 0 | 1;
  roadLanes: number;
}

const SW_HALF = 1.5; // 歩道帯の内側マージン

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
    // 端点情報: 各車道ノードに集まる歩道端点を記録
    type Endpoint = { node: number; side: number; lanes: number };
    const atRoadNode: Endpoint[][] = road.nodes.map(() => []);

    // 1) 各車道エッジ(無向)の両側に歩道レーンを生成
    const done = new Set<number>();
    for (const e of road.edges) {
      const key = e.from < e.to ? e.from * 1e6 + e.to : e.to * 1e6 + e.from;
      if (done.has(key)) continue;
      done.add(key);
      const a = road.nodes[e.from], b = road.nodes[e.to];
      let dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const px = dz, pz = -dx; // 右手方向
      const off = roadWidth(e.lanes) / 2 + SW_HALF;
      const inset = roadWidth(e.lanes) / 2 + 2; // 交差点中心から歩道端点を後退させる

      for (const side of [1, -1]) {
        const ox = px * off * side, oz = pz * off * side;
        const nax = a.x + dx * inset + ox, naz = a.z + dz * inset + oz;
        const nbx = b.x - dx * inset + ox, nbz = b.z - dz * inset + oz;
        const na = this.addNode(nax, naz, e.from);
        const nb = this.addNode(nbx, nbz, e.to);
        this.addEdge(na, nb, false, e.lanes); // 歩道(車道外)を歩く
        atRoadNode[e.from].push({ node: na, side, lanes: e.lanes });
        atRoadNode[e.to].push({ node: nb, side, lanes: e.lanes });
      }
    }

    // 2) 各交差点で歩道端点同士を接続(角の歩道 + 横断)
    for (let rn = 0; rn < road.nodes.length; rn++) {
      const eps = atRoadNode[rn];
      const cx = road.nodes[rn].x, cz = road.nodes[rn].z;
      for (let a = 0; a < eps.length; a++) {
        for (let b = a + 1; b < eps.length; b++) {
          const pa = this.nodes[eps[a].node], pb = this.nodes[eps[b].node];
          const d = dist(pa.x, pa.z, pb.x, pb.z);
          const maxLanes = Math.max(eps[a].lanes, eps[b].lanes);
          const connectMax = roadWidth(maxLanes) + SW_HALF * 2 + 6;
          if (d > connectMax) continue;
          // 接続線分の中点が交差点中心に近い=車道を横切る=横断歩道(信号対象)
          const mx = (pa.x + pb.x) / 2, mz = (pa.z + pb.z) / 2;
          const midToCenter = Math.hypot(mx - cx, mz - cz);
          const crossing = midToCenter < roadWidth(maxLanes) / 2;
          this.addEdge(eps[a].node, eps[b].node, crossing, maxLanes);
        }
      }
    }
  }

  heuristic(a: number, b: number): number {
    const na = this.nodes[a], nb = this.nodes[b];
    return dist(na.x, na.z, nb.x, nb.z);
  }
  edgeBetween(from: number, to: number): SidewalkEdge | undefined {
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
    for (const r of [80, 200, 600, 2000]) {
      this.nodeGrid.queryNeighbors(x, z, r, check);
      if (best >= 0) break;
    }
    return best;
  }
}
