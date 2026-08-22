import { RoadNetwork, roadWidth, crosswalkSetback, CROSSWALK_DEPTH } from './RoadNetwork';
import { AStar } from './AStar';
import { VehicleStore, VehicleState } from './VehicleStore';
import { SignalSystem } from './SignalSystem';

/**
 * ============================================================================
 *  TrafficSystem — IDM(Intelligent Driver Model)+ 信号制御による車両交通
 * ============================================================================
 * 各車両は経路(ノード列)に沿ってエッジ上を進み、
 *   ・同一エッジ上の前方車との車間(IDM)
 *   ・進行先ノードが赤信号なら停止線(=エッジ終端)
 * の両制約のうち厳しい方に従って加減速する。これにより信号待ちの車列・
 * 発進波・渋滞が創発する。
 */
export class TrafficSystem {
  private astar: AStar;

  constructor(private net: RoadNetwork, private vs: VehicleStore, private signals: SignalSystem) {
    this.astar = new AStar(net, 'drive');
  }

  dispatch(vehicle: number, sx: number, sz: number, gx: number, gz: number): boolean {
    const startNode = this.net.nearestNode(sx, sz);
    const goalNode = this.net.nearestNode(gx, gz);
    if (startNode < 0 || goalNode < 0 || startNode === goalNode) return false;
    const path = this.astar.findPath(startNode, goalNode);
    if (path.length < 2) return false;
    const vs = this.vs;
    vs.paths[vehicle] = Int32Array.from(path);
    vs.pathCursor[vehicle] = 1;
    this.enterEdge(vehicle, path[0], path[1]);
    vs.state[vehicle] = VehicleState.Driving;
    return true;
  }

  private enterEdge(v: number, from: number, to: number): void {
    const vs = this.vs;
    const edgeId = this.findEdge(from, to);
    vs.fromNode[v] = from;
    vs.toNode[v] = to;
    vs.edge[v] = edgeId;
    vs.segT[v] = 0;
    const nf = this.net.nodes[from], nt = this.net.nodes[to];
    vs.segLen[v] = Math.max(1, Math.hypot(nt.x - nf.x, nt.z - nf.z));
    const limit = edgeId >= 0 ? this.net.edges[edgeId].speedLimit : 12;
    vs.maxSpeed[v] = limit * (0.9 + Math.random() * 0.2);
  }

  private findEdge(from: number, to: number): number {
    for (const eid of this.net.nodes[from].edges) {
      if (this.net.edges[eid].to === to) return eid;
    }
    return -1;
  }

  update(dt: number): void {
    const vs = this.vs;
    this.rebuildOccupants();

    for (let e = 0; e < this.net.edges.length; e++) {
      const edge = this.net.edges[e];
      const occ = edge.occupants;
      if (occ.length === 0) continue;

      for (let k = 0; k < occ.length; k++) {
        const v = occ[k];
        if (vs.state[v] !== VehicleState.Driving) continue;

        const isTerminalEdge = vs.pathCursor[v] + 1 >= vs.paths[v].length;
        const remaining = (1 - vs.segT[v]) * vs.segLen[v];

        // 目的地に十分近づいたら到着(IDM の永久停止回避)
        if (isTerminalEdge && remaining < 4) {
          vs.state[v] = VehicleState.Arrived;
          vs.speed[v] = 0; vs.segT[v] = 1;
          this.updateWorldPos(v);
          continue;
        }

        // (1) 前方車制約
        let gapLead = Infinity, leadSpeed = 0;
        if (k + 1 < occ.length) {
          const lead = occ[k + 1];
          gapLead = (vs.segT[lead] - vs.segT[v]) * vs.segLen[v] - vs.length[lead];
          leadSpeed = vs.speed[lead];
        }

        // (2) 信号制約: 進行先ノードが赤(または黄)なら *停止線* を停止目標に。
        //     停止線は交差点中心から crosswalkSetback + 横断歩道半分 手前にある。
        //     終端(目的地)エッジは駐車扱いで信号無視。中間エッジのみ信号を見る。
        let gapStop = Infinity;
        if (!isTerminalEdge) {
          const axis = this.net.axisOf(vs.fromNode[v], vs.toNode[v]);
          if (!this.signals.vehicleGreen(vs.toNode[v], axis)) {
            const edge = vs.edge[v] >= 0 ? this.net.edges[vs.edge[v]] : null;
            const rw = roadWidth(edge ? edge.lanes : 1);
            // 停止線までの距離 = 交差点までの残り - (横断歩道手前までのオフセット)
            const stopOffset = crosswalkSetback(rw) + CROSSWALK_DEPTH * 0.5 + 0.8;
            const toStopLine = remaining - stopOffset;
            // ジレンマゾーン処理: 既に停止線を越えて進入している車は、そのまま
            // 交差点を通過させる(交差点内で凍結させない)。まだ手前の車だけ停止。
            if (toStopLine > 0.5) gapStop = toStopLine;
          }
        }

        // 両制約で IDM を評価し、より保守的(小さい)加速度を採用
        const aLead = this.idmAccel(v, Math.max(0.1, gapLead), leadSpeed);
        const aStop = gapStop < Infinity ? this.idmAccel(v, Math.max(0.1, gapStop), 0) : aLead;
        const a = Math.min(aLead, aStop);

        vs.accel[v] = a;
        vs.speed[v] = Math.max(0, vs.speed[v] + a * dt);

        const advance = (vs.speed[v] * dt) / vs.segLen[v];
        vs.segT[v] += advance;

        if (vs.segT[v] >= 1) this.advanceEdge(v);
        this.updateWorldPos(v);
      }
    }
  }

  private idmAccel(v: number, gap: number, leadSpeed: number): number {
    const vs = this.vs;
    const sp = vs.speed[v];
    const v0 = vs.maxSpeed[v];
    const a = vs.aMax[v], b = vs.bComf[v];
    const dv = sp - leadSpeed;
    const sStar = vs.s0[v] + Math.max(0, sp * vs.t0[v] + (sp * dv) / (2 * Math.sqrt(a * b)));
    const free = 1 - Math.pow(sp / v0, 4);
    const interact = (sStar / gap) * (sStar / gap);
    return a * (free - interact);
  }

  private advanceEdge(v: number): void {
    const vs = this.vs;
    const path = vs.paths[v];
    const nextCursor = vs.pathCursor[v] + 1;
    if (nextCursor >= path.length) {
      vs.state[v] = VehicleState.Arrived;
      vs.speed[v] = 0; vs.segT[v] = 1;
      return;
    }
    const from = path[vs.pathCursor[v]];
    const to = path[nextCursor];
    vs.pathCursor[v] = nextCursor;
    const carry = vs.speed[v];
    this.enterEdge(v, from, to);
    vs.speed[v] = carry;
  }

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
