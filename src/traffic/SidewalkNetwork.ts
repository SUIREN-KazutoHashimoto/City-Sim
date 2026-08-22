import { dist } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { RoadNetwork, edgeAxis } from './RoadNetwork';
import { PathGraph } from './AStar';

/**
 * ============================================================================
 *  SidewalkNetwork — 歩行者専用の独立グラフ(歩道ネットワーク)
 * ============================================================================
 * 車道(RoadNetwork)とは *独立した* 歩行者用グラフ。初期状態では車道から
 * 自動生成する(各車道の脇に歩道が並走する近似)が、グラフとして独立しているため
 * 将来:
 *   ・歩道橋(道路をまたぐ歩行者専用エッジ)
 *   ・歩行者専用道(公園の遊歩道・商店街のアーケード)
 *   ・地下通路
 * を、車道グラフに影響を与えずにノード/エッジとして追加できる。
 *
 * 各歩道ノードは、対応する車道交差点(roadNode)を参照する。信号のあるroadNodeでは
 * 歩行者は *歩行者信号* を見て横断する。roadNode = -1 のノード(歩道橋・専用道の
 * 途中点など)は信号と無関係に通行できる。
 *
 * PathGraph を実装するため、車道と同じ AStar をそのまま歩行者経路探索に使える。
 */
export interface SidewalkNode {
  id: number;
  x: number;
  z: number;
  edges: number[];
  /** 対応する車道ノードID(信号参照用)。-1 = 車道と無関係(歩道橋/専用道)。 */
  roadNode: number;
  /** 平面交差点か(信号・横断が絡む) / 立体交差(歩道橋)か。 */
  gradeSeparated: boolean;
}

export interface SidewalkEdge {
  id: number;
  from: number;
  to: number;
  length: number;
  /** AStar 互換(歩行速度)。歩道の種別で将来変える余地。 */
  speedLimit: number;
  /** true = 車道の平面横断を伴う(信号の影響を受ける) / false = 歩道橋等で分離。 */
  crossing: boolean;
}

export class SidewalkNetwork implements PathGraph {
  nodes: SidewalkNode[] = [];
  edges: SidewalkEdge[] = [];
  private nodeGrid = new SpatialHashGrid(120);

  /** 車道ノードID → 歩道ノードID の対応(自動生成時に構築)。 */
  private sidewalkOfRoad: Int32Array;

  constructor(road: RoadNetwork) {
    this.sidewalkOfRoad = new Int32Array(road.nodes.length).fill(-1);
    this.buildFromRoad(road);
  }

  /** 車道グラフから歩道グラフを自動生成(1:1近似)。 */
  private buildFromRoad(road: RoadNetwork): void {
    // 車道ノードごとに歩道ノードを作る
    for (const rn of road.nodes) {
      const id = this.addNode(rn.x, rn.z, rn.id, false);
      this.sidewalkOfRoad[rn.id] = id;
    }
    // 車道エッジ(無向)ごとに歩道エッジ(双方向)を作る。平面横断フラグを付与。
    const done = new Set<number>();
    for (const e of road.edges) {
      const key = e.from < e.to ? e.from * 1e6 + e.to : e.to * 1e6 + e.from;
      if (done.has(key)) continue;
      done.add(key);
      const a = this.sidewalkOfRoad[e.from];
      const b = this.sidewalkOfRoad[e.to];
      this.connect(a, b, true);
    }
  }

  addNode(x: number, z: number, roadNode = -1, gradeSeparated = false): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, edges: [], roadNode, gradeSeparated });
    this.nodeGrid.insert(id, x, z);
    return id;
  }

  /** 双方向の歩道エッジを1本追加する。crossing=平面横断(信号影響)か。 */
  connect(a: number, b: number, crossing: boolean): void {
    const na = this.nodes[a], nb = this.nodes[b];
    const len = dist(na.x, na.z, nb.x, nb.z);
    this.pushEdge(a, b, len, crossing);
    this.pushEdge(b, a, len, crossing);
  }

  /**
   * 歩道橋を追加する(将来のAPI例)。2つの歩道ノードを立体交差エッジで結ぶ。
   * crossing=false のため信号と無関係に通行できる。
   */
  addFootbridge(a: number, b: number): void {
    this.nodes[a].gradeSeparated = true;
    this.nodes[b].gradeSeparated = true;
    this.connect(a, b, false);
  }

  private pushEdge(from: number, to: number, length: number, crossing: boolean): void {
    const id = this.edges.length;
    this.edges.push({ id, from, to, length, speedLimit: 1.4, crossing });
    this.nodes[from].edges.push(id);
  }

  heuristic(a: number, b: number): number {
    const na = this.nodes[a], nb = this.nodes[b];
    return dist(na.x, na.z, nb.x, nb.z);
  }

  /** 歩道エッジ from→to の進行軸(0=東西, 1=南北)。歩行者信号の判定に使う。 */
  axisOf(from: number, to: number): 0 | 1 {
    const nf = this.nodes[from], nt = this.nodes[to];
    return edgeAxis(nt.x - nf.x, nt.z - nf.z);
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
