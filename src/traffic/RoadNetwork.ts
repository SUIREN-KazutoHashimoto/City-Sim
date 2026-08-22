import { dist } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';

/**
 * ============================================================================
 *  道路ネットワーク(グラフ)
 * ============================================================================
 * 交差点 = ノード / 道路区間 = エッジ(有向、双方向は2エッジ)。
 * 車両経路探索(A*)と歩道ネットワークの両方の基盤になる。
 * lane 数・制限速度・道路種別を持たせ、都市生成と描画の双方が参照する。
 */

export enum RoadClass {
  Highway = 0,   // 幹線/自動車専用
  Arterial = 1,  // 主要道
  Local = 2,     // 生活道路
  Path = 3,      // 歩行者専用
}

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  edges: number[]; // このノードから出る有向エッジID
  hasSignal: boolean;
}

export interface RoadEdge {
  id: number;
  from: number;
  to: number;
  length: number;
  lanes: number;
  speedLimit: number; // m/s
  roadClass: RoadClass;
  /** IDM/信号制御が参照する「この区間にいる車両index」のリスト(前方車検索用) */
  occupants: number[];
}

const SPEED_BY_CLASS: Record<RoadClass, number> = {
  [RoadClass.Highway]: 27,   // ~100km/h
  [RoadClass.Arterial]: 16,  // ~60km/h
  [RoadClass.Local]: 11,     // ~40km/h
  [RoadClass.Path]: 1.4,     // 歩行
};

export class RoadNetwork {
  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  /** 最寄りノード検索用の空間インデックス(車両の出発/目的ノード解決に使う)。 */
  private nodeGrid = new SpatialHashGrid(120);

  addNode(x: number, z: number, hasSignal = false): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, edges: [], hasSignal });
    this.nodeGrid.insert(id, x, z);
    return id;
  }

  /** 双方向道路を1本(=有向2エッジ)追加する。 */
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

  /** ヒューリスティック用の直線距離。 */
  heuristic(a: number, b: number): number {
    const na = this.nodes[a], nb = this.nodes[b];
    return dist(na.x, na.z, nb.x, nb.z);
  }

  /** (x,z) に最も近いノードIDを返す。見つからなければ -1。 */
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
