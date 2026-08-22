import { RoadNetwork, roadWidth, crosswalkSetback, CROSSWALK_DEPTH, laneOffset } from './RoadNetwork';
import { AStar } from './AStar';
import { VehicleStore, VehicleState } from './VehicleStore';
import { SignalSystem } from './SignalSystem';
export class TrafficSystem {
  private astar: AStar;
  pedBlockedFn: ((node: number) => boolean) | null = null;
  constructor(private net: RoadNetwork, private vs: VehicleStore, private signals: SignalSystem) { this.astar = new AStar(net, 'drive'); }
  dispatch(vehicle: number, sx: number, sz: number, gx: number, gz: number): boolean {
    const startNode = this.net.nearestNode(sx, sz), goalNode = this.net.nearestNode(gx, gz);
    if (startNode < 0 || goalNode < 0 || startNode === goalNode) return false;
    const path = this.astar.findPath(startNode, goalNode);
    if (path.length < 2) return false;
    const vs = this.vs;
    vs.paths[vehicle] = Int32Array.from(path); vs.pathCursor[vehicle] = 1; vs.parkPOI[vehicle] = -1; vs.speed[vehicle] = 0;
    this.enterEdge(vehicle, path[0], path[1]); vs.state[vehicle] = VehicleState.Driving;
    return true;
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
        const isTerminal = vs.pathCursor[v] + 1 >= vs.paths[v].length; const remaining = (1 - vs.segT[v]) * vs.segLen[v];
        if (isTerminal && remaining < 4) { vs.state[v] = VehicleState.Arrived; vs.speed[v] = 0; vs.segT[v] = 1; this.updateWorldPos(v); continue; }
        let gapLead = Infinity, leadSpeed = 0;
        if (k + 1 < occ.length) { const lead = occ[k + 1]; gapLead = (vs.segT[lead] - vs.segT[v]) * vs.segLen[v] - vs.length[lead]; leadSpeed = vs.speed[lead]; }
        let gapStop = Infinity;
        if (!isTerminal) {
          const axis = this.net.axisOf(vs.fromNode[v], vs.toNode[v]);
          const redOrPed = !this.signals.vehicleGreen(vs.toNode[v], axis) || (this.pedBlockedFn ? this.pedBlockedFn(vs.toNode[v]) : false);
          if (redOrPed) {
            const edge = vs.edge[v] >= 0 ? this.net.edges[vs.edge[v]] : null; const rw = roadWidth(edge ? edge.lanes : 1);
            const stopOffset = crosswalkSetback(rw) + CROSSWALK_DEPTH * 0.5 + 0.8 + vs.length[v] * 0.5;
            const toStopLine = remaining - stopOffset; if (toStopLine > 0.5) gapStop = toStopLine;
          }
        }
        const aLead = this.idm(v, Math.max(0.1, gapLead), leadSpeed);
        const aStop = gapStop < Infinity ? this.idm(v, Math.max(0.1, gapStop), 0) : aLead;
        const a = Math.min(aLead, aStop); vs.accel[v] = a; vs.speed[v] = Math.max(0, vs.speed[v] + a * dt);
        vs.segT[v] += (vs.speed[v] * dt) / vs.segLen[v];
        if (vs.segT[v] >= 1) this.advanceEdge(v);
        this.updateWorldPos(v);
      }
    }
  }
  private idm(v: number, gap: number, leadSpeed: number): number {
    const vs = this.vs; const sp = vs.speed[v], v0 = vs.maxSpeed[v], a = vs.aMax[v], b = vs.bComf[v]; const dv = sp - leadSpeed;
    const sStar = vs.s0[v] + Math.max(0, sp * vs.t0[v] + (sp * dv) / (2 * Math.sqrt(a * b)));
    return a * (1 - Math.pow(sp / v0, 4) - (sStar / gap) * (sStar / gap));
  }
  private advanceEdge(v: number): void {
    const vs = this.vs; const path = vs.paths[v], next = vs.pathCursor[v] + 1;
    if (next >= path.length) { vs.state[v] = VehicleState.Arrived; vs.speed[v] = 0; vs.segT[v] = 1; return; }
    const from = path[vs.pathCursor[v]], to = path[next]; vs.pathCursor[v] = next; const carry = vs.speed[v]; this.enterEdge(v, from, to); vs.speed[v] = carry;
  }
  private updateWorldPos(v: number): void {
    const vs = this.vs; const nf = this.net.nodes[vs.fromNode[v]], nt = this.net.nodes[vs.toNode[v]]; if (!nf || !nt) return;
    const t = vs.segT[v]; let dx = nt.x - nf.x, dz = nt.z - nf.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const rx = dz, rz = -dx; const edge = vs.edge[v] >= 0 ? this.net.edges[vs.edge[v]] : null; const off = laneOffset(edge ? edge.lanes : 1);
    const cx = nf.x + (nt.x - nf.x) * t, cz = nf.z + (nt.z - nf.z) * t;
    vs.posX[v] = cx + rx * off; vs.posZ[v] = cz + rz * off; vs.heading[v] = Math.atan2(dz, dx);
  }
  private rebuildOccupants(): void {
    const edges = this.net.edges; for (let e = 0; e < edges.length; e++) edges[e].occupants.length = 0;
    const vs = this.vs; for (let v = 0; v < vs.count; v++) { if (vs.state[v] !== VehicleState.Driving) continue; const e = vs.edge[v]; if (e >= 0) edges[e].occupants.push(v); }
    for (let e = 0; e < edges.length; e++) { const occ = edges[e].occupants; if (occ.length > 1) occ.sort((a, b) => vs.segT[a] - vs.segT[b]); }
  }
}
