import { RoadNetwork } from './RoadNetwork';
import { AStar } from './AStar';
import { VehicleStore, VehicleState } from './VehicleStore';

/**
 * ============================================================================
 *  TrafficSystem — IDM(Intelligent Driver Model)による車両交通
 * ============================================================================
 * 「交通網がまともに動く」の中身。各車両は経路(ノード列)に沿ってエッジ上を進み、
 * 同一エッジ上の前方車との車間に応じて IDM で加減速する。これにより
 *   ・前が詰まれば減速し、空けば加速
 *   ・信号(赤)を前方の"仮想停止車"として扱い停止
 *   ・渋滞・追従波が創発的に発生
 * する。横方向(車線変更)は将来拡張とし、まず縦方向の追従を正しく解く。
 *
 * データ構造:
 *   各エッジ e.occupants に「そのエッジ上の車両index」を segT 昇順で保持し、
 *   前方車探索を O(隣接) にする。毎ステップ再構築(車両数は歩行者より桁少)。
 */
export class TrafficSystem {
  private astar: AStar;

  constructor(private net: RoadNetwork, private vs: VehicleStore) {
    this.astar = new AStar(net);
  }

  /**
   * 車両に start→goal(ワールド座標)の経路を割り当てて走行開始させる。
   * 成功で true。到達不能や経路長<2 は false(呼び出し側は徒歩へフォールバック)。
   */
  dispatch(vehicle: number, sx: number, sz: number, gx: number, gz: number): boolean {
    const startNode = this.net.nearestNode(sx, sz);
    const goalNode = this.net.nearestNode(gx, gz);
    if (startNode < 0 || goalNode < 0 || startNode === goalNode) return false;
    const path = this.astar.findPath(startNode, goalNode);
    if (path.length < 2) return false;

    const vs = this.vs;
    vs.paths[vehicle] = Int32Array.from(path);
    vs.pathCursor[vehicle] = 1; // path[0]=現在地, path[1]=次の目標ノード
    this.enterEdge(vehicle, path[0], path[1]);
    vs.state[vehicle] = VehicleState.Driving;
    return true;
  }

  /** 車両を指定エッジ(from→to)の先頭に載せる。 */
  private enterEdge(v: number, from: number, to: number): void {
    const vs = this.vs;
    const edgeId = this.findEdge(from, to);
    vs.fromNode[v] = from;
    vs.toNode[v] = to;
    vs.edge[v] = edgeId;
    vs.segT[v] = 0;
    const nf = this.net.nodes[from], nt = this.net.nodes[to];
    vs.segLen[v] = Math.max(1, Math.hypot(nt.x - nf.x, nt.z - nf.z));
    // 希望速度 = 道路制限 × 個体差(0.9-1.1)
    const limit = edgeId >= 0 ? this.net.edges[edgeId].speedLimit : 12;
    vs.maxSpeed[v] = limit * (0.9 + Math.random() * 0.2);
  }

  private findEdge(from: number, to: number): number {
    for (const eid of this.net.nodes[from].edges) {
      if (this.net.edges[eid].to === to) return eid;
    }
    return -1;
  }

  /** 毎固定ステップ呼ぶ。全車両を IDM で前進させる。dt = 固定ステップ秒。 */
  update(dt: number): void {
    const vs = this.vs;
    // 1. エッジ占有リストを再構築(segT昇順)
    this.rebuildOccupants();

    // 2. 各エッジ内で前方車との車間から IDM 加速度を計算し、速度・位置を更新
    for (let e = 0; e < this.net.edges.length; e++) {
      const edge = this.net.edges[e];
      const occ = edge.occupants;
      if (occ.length === 0) continue;
      // occ は segT 昇順 → occ[k+1] が occ[k] の前方車
      for (let k = 0; k < occ.length; k++) {
        const v = occ[k];
        if (vs.state[v] !== VehicleState.Driving) continue;

        // 経路の最終エッジかどうか(= このエッジの終点が目的地ノード)
        const isTerminalEdge = vs.pathCursor[v] + 1 >= vs.paths[v].length;
        const remaining = (1 - vs.segT[v]) * vs.segLen[v];

        // 目的地に十分近づいたら「到着」。IDM は停止車間 s0 手前で止まり続けるため、
        // 終端では明示的に到着判定して降車させる(Zeno 的な永久停止の回避)。
        if (isTerminalEdge && remaining < 4) {
          vs.state[v] = VehicleState.Arrived;
          vs.speed[v] = 0;
          vs.segT[v] = 1;
          this.updateWorldPos(v);
          continue;
        }

        // 前方車とのギャップ(m)と相対速度
        let gap = Infinity, leadSpeed = 0;
        if (k + 1 < occ.length) {
          const lead = occ[k + 1];
          gap = (vs.segT[lead] - vs.segT[v]) * vs.segLen[v] - vs.length[lead];
          leadSpeed = vs.speed[lead];
        } else if (isTerminalEdge) {
          // 最終エッジ: 終点(目的地)を停止目標として扱う。
          gap = remaining;
        } else {
          // 中間エッジ: 交差点は流れる前提で先まで見通す。
          gap = remaining + 40;
        }
        const a = this.idmAccel(v, Math.max(0.1, gap), leadSpeed);
        vs.accel[v] = a;
        vs.speed[v] = Math.max(0, vs.speed[v] + a * dt);

        // 位置(segT)を前進
        const advance = (vs.speed[v] * dt) / vs.segLen[v];
        vs.segT[v] += advance;

        // エッジ端に到達したら次エッジへ / 目的地なら降車
        if (vs.segT[v] >= 1) this.advanceEdge(v);

        // ワールド座標を更新
        this.updateWorldPos(v);
      }
    }
  }

  /** IDM 加速度式。 */
  private idmAccel(v: number, gap: number, leadSpeed: number): number {
    const vs = this.vs;
    const sp = vs.speed[v];
    const v0 = vs.maxSpeed[v];
    const a = vs.aMax[v], b = vs.bComf[v];
    const dv = sp - leadSpeed; // 接近速度
    // 望ましい車間 s*
    const sStar = vs.s0[v] + Math.max(0, sp * vs.t0[v] + (sp * dv) / (2 * Math.sqrt(a * b)));
    const free = 1 - Math.pow(sp / v0, 4);
    const interact = (sStar / gap) * (sStar / gap);
    return a * (free - interact);
  }

  /** segT>=1 到達時: 次エッジへ載せ替える、または目的地なら Arrived。 */
  private advanceEdge(v: number): void {
    const vs = this.vs;
    const path = vs.paths[v];
    const nextCursor = vs.pathCursor[v] + 1;
    if (nextCursor >= path.length) {
      // 経路終端 = 目的地到達
      vs.state[v] = VehicleState.Arrived;
      vs.speed[v] = 0;
      vs.segT[v] = 1;
      return;
    }
    const from = path[vs.pathCursor[v]];
    const to = path[nextCursor];
    vs.pathCursor[v] = nextCursor;
    const carry = vs.speed[v]; // 速度を保って交差点通過
    this.enterEdge(v, from, to);
    vs.speed[v] = carry;
  }

  /** segT からワールド座標・向きを更新。 */
  private updateWorldPos(v: number): void {
    const vs = this.vs;
    const nf = this.net.nodes[vs.fromNode[v]];
    const nt = this.net.nodes[vs.toNode[v]];
    if (!nf || !nt) return;
    const t = vs.segT[v];
    vs.posX[v] = nf.x + (nt.x - nf.x) * t;
    vs.posZ[v] = nf.z + (nt.z - nf.z) * t;
    vs.heading[v] = Math.atan2(nt.z - nf.z, nt.x - nf.x);
  }

  /** 全エッジの occupants を作り直し、各エッジ内で segT 昇順にソート。 */
  private rebuildOccupants(): void {
    const edges = this.net.edges;
    for (let e = 0; e < edges.length; e++) edges[e].occupants.length = 0;
    const vs = this.vs;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving) continue;
      const e = vs.edge[v];
      if (e >= 0) edges[e].occupants.push(v);
    }
    for (let e = 0; e < edges.length; e++) {
      const occ = edges[e].occupants;
      if (occ.length > 1) occ.sort((a, b) => vs.segT[a] - vs.segT[b]);
    }
  }
}
