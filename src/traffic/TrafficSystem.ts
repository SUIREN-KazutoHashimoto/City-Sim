import { RoadNetwork, roadWidth, crosswalkSetback, CROSSWALK_DEPTH, laneOffset } from './RoadNetwork';
import { AStar } from './AStar';
import { VehicleStore, VehicleState } from './VehicleStore';
import { SignalSystem } from './SignalSystem';

interface EdgePointRoute { path: number[]; targetT: number; cost: number; }

export class TrafficSystem {
  private astar: AStar;
  private arrivalT: Float32Array;
  pedBlockedFn: ((node: number) => boolean) | null = null;

  constructor(private net: RoadNetwork, private vs: VehicleStore, private signals: SignalSystem) {
    this.astar = new AStar(net, 'drive');
    this.arrivalT = new Float32Array(vs.capacity); this.arrivalT.fill(1);
  }

  dispatch(vehicle: number, sx: number, sz: number, gx: number, gz: number): boolean {
    const startNode = this.net.nearestNode(sx, sz), goalNode = this.net.nearestNode(gx, gz);
    if (startNode < 0 || goalNode < 0 || startNode === goalNode) return false;
    const path = this.astar.findPath(startNode, goalNode);
    if (path.length < 2) return false;
    const vs = this.vs;
    vs.paths[vehicle] = Int32Array.from(path); vs.pathCursor[vehicle] = 1; vs.parkPOI[vehicle] = -1; vs.speed[vehicle] = 0;
    this.arrivalT[vehicle] = 1;
    this.enterEdge(vehicle, path[0], path[1]); vs.state[vehicle] = VehicleState.Driving;
    return true;
  }

  /** 任意の実道路Edge上の点を目的地として走行させる。バス停などノード間停止に使用する。 */
  dispatchToEdgePoint(vehicle: number, sx: number, sz: number, edgeFrom: number, edgeTo: number, t: number): boolean {
    const startNode = this.net.nearestNode(sx, sz); if (startNode < 0) return false;
    const route = this.bestRouteToEdgePoint(startNode, edgeFrom, edgeTo, t); if (!route || route.path.length < 2) return false;
    const vs = this.vs;
    vs.paths[vehicle] = Int32Array.from(route.path); vs.pathCursor[vehicle] = 1; vs.parkPOI[vehicle] = -1; vs.speed[vehicle] = 0;
    this.arrivalT[vehicle] = route.targetT;
    this.enterEdge(vehicle, route.path[0], route.path[1]); vs.state[vehicle] = VehicleState.Driving;
    return true;
  }

  /** 現在走行中/停車中のEdge位置を保持したまま次のEdge上目的地へ出発する。 */
  dispatchFromCurrentToEdgePoint(vehicle: number, edgeFrom: number, edgeTo: number, t: number): boolean {
    const vs = this.vs; const curFrom = vs.fromNode[vehicle], curTo = vs.toNode[vehicle], curT = vs.segT[vehicle];
    if (curFrom < 0 || curTo < 0 || this.findEdge(curFrom, curTo) < 0) {
      return this.dispatchToEdgePoint(vehicle, vs.posX[vehicle], vs.posZ[vehicle], edgeFrom, edgeTo, t);
    }
    if (curFrom === edgeFrom && curTo === edgeTo && t > curT + 0.01) {
      vs.paths[vehicle] = Int32Array.from([curFrom, curTo]); vs.pathCursor[vehicle] = 1; vs.speed[vehicle] = 0; vs.parkPOI[vehicle] = -1;
      this.arrivalT[vehicle] = t; vs.state[vehicle] = VehicleState.Driving; return true;
    }
    if (curFrom === edgeTo && curTo === edgeFrom && (1 - t) > curT + 0.01) {
      vs.paths[vehicle] = Int32Array.from([curFrom, curTo]); vs.pathCursor[vehicle] = 1; vs.speed[vehicle] = 0; vs.parkPOI[vehicle] = -1;
      this.arrivalT[vehicle] = 1 - t; vs.state[vehicle] = VehicleState.Driving; return true;
    }
    const route = this.bestRouteToEdgePoint(curTo, edgeFrom, edgeTo, t); if (!route) return false;
    const full = [curFrom, ...route.path];
    if (full.length < 3) return false;
    vs.paths[vehicle] = Int32Array.from(full); vs.pathCursor[vehicle] = 1; vs.speed[vehicle] = 0; vs.parkPOI[vehicle] = -1;
    this.arrivalT[vehicle] = route.targetT; vs.state[vehicle] = VehicleState.Driving;
    return true;
  }

  /** 車両を実道路Edge上へ正確に配置する。 */
  placeAtEdgePoint(vehicle: number, edgeFrom: number, edgeTo: number, t: number): boolean {
    let from = edgeFrom, to = edgeTo, targetT = t, edgeId = this.findEdge(from, to);
    if (edgeId < 0) { from = edgeTo; to = edgeFrom; targetT = 1 - t; edgeId = this.findEdge(from, to); }
    if (edgeId < 0) return false;
    const vs = this.vs; const nf = this.net.nodes[from], nt = this.net.nodes[to];
    vs.fromNode[vehicle] = from; vs.toNode[vehicle] = to; vs.edge[vehicle] = edgeId; vs.segT[vehicle] = Math.max(0.02, Math.min(0.98, targetT));
    vs.segLen[vehicle] = Math.max(1, Math.hypot(nt.x - nf.x, nt.z - nf.z)); vs.speed[vehicle] = 0; vs.accel[vehicle] = 0;
    vs.paths[vehicle] = Int32Array.from([from, to]); vs.pathCursor[vehicle] = 1; this.arrivalT[vehicle] = vs.segT[vehicle];
    vs.state[vehicle] = VehicleState.Arrived; this.updateWorldPos(vehicle); return true;
  }

  private bestRouteToEdgePoint(startNode: number, edgeFrom: number, edgeTo: number, t: number): EdgePointRoute | null {
    const candidates: EdgePointRoute[] = [];
    const add = (from: number, to: number, targetT: number) => {
      const edgeId = this.findEdge(from, to); if (edgeId < 0) return;
      const trunk = startNode === from ? [from] : this.astar.findPath(startNode, from); if (trunk.length === 0) return;
      const path = trunk.slice(); if (path[path.length - 1] !== from) return; path.push(to);
      const edge = this.net.edges[edgeId];
      candidates.push({ path, targetT, cost: this.routeCost(trunk) + (edge.length / edge.speedLimit) * targetT });
    };
    add(edgeFrom, edgeTo, Math.max(0.05, Math.min(0.95, t)));
    add(edgeTo, edgeFrom, Math.max(0.05, Math.min(0.95, 1 - t)));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.cost - b.cost); return candidates[0];
  }

  private routeCost(path: number[]): number {
    let cost = 0;
    for (let i = 0; i + 1 < path.length; i++) { const e = this.findEdge(path[i], path[i + 1]); if (e >= 0) cost += this.net.edges[e].length / this.net.edges[e].speedLimit; }
    return cost;
  }

  private enterEdge(v: number, from: number, to: number): void {
    const vs = this.vs; const edgeId = this.findEdge(from, to);
    vs.fromNode[v] = from; vs.toNode[v] = to; vs.edge[v] = edgeId; vs.segT[v] = 0;
    const nf = this.net.nodes[from], nt = this.net.nodes[to]; vs.segLen[v] = Math.max(1, Math.hypot(nt.x - nf.x, nt.z - nf.z));
    const limit = edgeId >= 0 ? this.net.edges[edgeId].speedLimit : 12; vs.maxSpeed[v] = limit * (0.9 + Math.random() * 0.2);
  }

  private findEdge(from: number, to: number): number { for (const eid of this.net.nodes[from].edges) if (this.net.edges[eid].to === to) return eid; return -1; }

  update(dt: number): void {
    const vs = this.vs; this.rebuildOccupants();
    for (let e = 0; e < this.net.edges.length; e++) {
      const occ = this.net.edges[e].occupants; if (occ.length === 0) continue;
      for (let k = 0; k < occ.length; k++) {
        const v = occ[k]; if (vs.state[v] !== VehicleState.Driving) continue;
        const isTerminal = vs.pathCursor[v] + 1 >= vs.paths[v].length;
        const terminalT = isTerminal ? Math.max(0.02, Math.min(1, this.arrivalT[v] || 1)) : 1;
        let remaining = (terminalT - vs.segT[v]) * vs.segLen[v];
        if (isTerminal && remaining <= 0.55) { this.arrive(v, terminalT); continue; }

        let gapLead = Infinity, leadSpeed = 0;
        if (k + 1 < occ.length) { const lead = occ[k + 1]; gapLead = (vs.segT[lead] - vs.segT[v]) * vs.segLen[v] - vs.length[lead]; leadSpeed = vs.speed[lead]; }
        let gapStop = Infinity;
        if (isTerminal) gapStop = Math.max(0.1, remaining + vs.s0[v]);
        else {
          const axis = this.net.axisOf(vs.fromNode[v], vs.toNode[v]);
          const redOrPed = !this.signals.vehicleGreen(vs.toNode[v], axis) || (this.pedBlockedFn ? this.pedBlockedFn(vs.toNode[v]) : false);
          if (redOrPed) {
            const edge = vs.edge[v] >= 0 ? this.net.edges[vs.edge[v]] : null; const rw = roadWidth(edge ? edge.lanes : 1);
            const stopOffset = crosswalkSetback(rw) + CROSSWALK_DEPTH * 0.5 + 0.8 + vs.length[v] * 0.5;
            const toStopLine = (1 - vs.segT[v]) * vs.segLen[v] - stopOffset; if (toStopLine > 0.5) gapStop = toStopLine;
          }
        }
        const aLead = this.idm(v, Math.max(0.1, gapLead), leadSpeed);
        const aStop = gapStop < Infinity ? this.idm(v, Math.max(0.1, gapStop), 0) : aLead;
        const a = Math.min(aLead, aStop); vs.accel[v] = a; vs.speed[v] = Math.max(0, vs.speed[v] + a * dt);
        const nextT = vs.segT[v] + (vs.speed[v] * dt) / vs.segLen[v];
        if (isTerminal && nextT >= terminalT) { this.arrive(v, terminalT); continue; }
        vs.segT[v] = nextT;
        if (vs.segT[v] >= 1) this.advanceEdge(v);
        this.updateWorldPos(v);
      }
    }
  }

  private arrive(v: number, t: number): void {
    const vs = this.vs; vs.state[v] = VehicleState.Arrived; vs.speed[v] = 0; vs.accel[v] = 0; vs.segT[v] = t; this.updateWorldPos(v);
  }

  private idm(v: number, gap: number, leadSpeed: number): number {
    const vs = this.vs, sp = vs.speed[v], v0 = Math.max(0.1, vs.maxSpeed[v]), a = vs.aMax[v], b = vs.bComf[v]; const dv = sp - leadSpeed;
    const sStar = vs.s0[v] + Math.max(0, sp * vs.t0[v] + (sp * dv) / (2 * Math.sqrt(a * b)));
    return a * (1 - Math.pow(sp / v0, 4) - (sStar / gap) * (sStar / gap));
  }

  private advanceEdge(v: number): void {
    const vs = this.vs, path = vs.paths[v], next = vs.pathCursor[v] + 1;
    if (next >= path.length) { this.arrive(v, 1); return; }
    const from = path[vs.pathCursor[v]], to = path[next]; vs.pathCursor[v] = next; const carry = vs.speed[v]; this.enterEdge(v, from, to); vs.speed[v] = carry;
  }

  /** -PI..PIの最短角度差。Uターンでも連続回転させる。 */
  private angleDelta(from: number, to: number): number {
    let d = to - from; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d;
  }

  /**
   * Edge切替直後のheadingを前Edge→現Edgeへ距離ベースで補間する。
   * 車体位置は道路Edge上のままなので交通判定を変えず、見た目と追跡カメラだけ滑らかに旋回する。
   */
  private visualHeading(v: number, targetHeading: number): number {
    const vs = this.vs, path = vs.paths[v], cursor = vs.pathCursor[v];
    if (cursor < 2 || cursor >= path.length) return targetHeading;
    const pa = this.net.nodes[path[cursor - 2]], pb = this.net.nodes[path[cursor - 1]];
    if (!pa || !pb) return targetHeading;
    const prevHeading = Math.atan2(pb.z - pa.z, pb.x - pa.x);
    const turnDistance = vs.isBus[v] ? 18 : vs.isTruck[v] ? 15 : 10;
    const distanceIntoEdge = Math.max(0, vs.segT[v] * vs.segLen[v]);
    let u = Math.min(1, distanceIntoEdge / Math.max(1, turnDistance));
    u = u * u * (3 - 2 * u); // smoothstep
    return prevHeading + this.angleDelta(prevHeading, targetHeading) * u;
  }

  private updateWorldPos(v: number): void {
    const vs = this.vs; const nf = this.net.nodes[vs.fromNode[v]], nt = this.net.nodes[vs.toNode[v]]; if (!nf || !nt) return;
    const t = vs.segT[v]; let dx = nt.x - nf.x, dz = nt.z - nf.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const rx = dz, rz = -dx; const edge = vs.edge[v] >= 0 ? this.net.edges[vs.edge[v]] : null; const off = laneOffset(edge ? edge.lanes : 1);
    const cx = nf.x + (nt.x - nf.x) * t, cz = nf.z + (nt.z - nf.z) * t;
    vs.posX[v] = cx + rx * off; vs.posZ[v] = cz + rz * off;
    const targetHeading = Math.atan2(dz, dx); vs.heading[v] = this.visualHeading(v, targetHeading);
  }

  private rebuildOccupants(): void {
    const edges = this.net.edges; for (let e = 0; e < edges.length; e++) edges[e].occupants.length = 0;
    const vs = this.vs; for (let v = 0; v < vs.count; v++) { if (vs.state[v] !== VehicleState.Driving) continue; const e = vs.edge[v]; if (e >= 0) edges[e].occupants.push(v); }
    for (let e = 0; e < edges.length; e++) { const occ = edges[e].occupants; if (occ.length > 1) occ.sort((a, b) => vs.segT[a] - vs.segT[b]); }
  }
}
