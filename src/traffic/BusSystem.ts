import { RoadNetwork, RoadClass } from './RoadNetwork';
import { VehicleStore, VehicleState } from './VehicleStore';
import { TrafficSystem } from './TrafficSystem';

export interface BusStop { id: number; x: number; z: number; node: number; routes: number[]; }
export interface BusRoute { id: number; stopSeq: number[]; }
interface BusRuntime { vehicle: number; route: number; seqIdx: number; dwell: number; onboard: number[]; capacity: number; }

/** 路線バス。既存IDM交通の上で走り、停留所は道の途中(交差点でない)に置く。 */
export class BusSystem {
  stops: BusStop[] = []; routes: BusRoute[] = []; buses: BusRuntime[] = [];
  readonly dwellSeconds = 8;
  private alightMap = new Map<number, number>();
  constructor(private net: RoadNetwork, private vs: VehicleStore, private traffic: TrafficSystem, _seed = 777) {}

  build(size: number): void {
    const lines = 3;
    for (let axis = 0; axis < 2; axis++) for (let k = 0; k < lines; k++) { const frac = (k + 1) / (lines + 1); this.makeLine(axis === 0, frac * size, size); }
    for (const r of this.routes) { const stops = r.stopSeq; if (stops.length < 2) continue; const nBus = Math.min(4, Math.max(2, Math.floor(stops.length / 4))); for (let b = 0; b < nBus; b++) this.spawnBusOnRoute(r.id, Math.floor((b / nBus) * stops.length)); }
  }
  private makeLine(horizontal: boolean, coord: number, size: number): void {
    const band = 60; const cand: number[] = [];
    for (const n of this.net.nodes) {
      const cross = horizontal ? n.z : n.x; if (Math.abs(cross - coord) > band) continue;
      let hasSurface = false; for (const eid of n.edges) if (this.net.edges[eid].roadClass !== RoadClass.Highway) { hasSurface = true; break; }
      if (!hasSurface) continue; cand.push(n.id); void size;
    }
    if (cand.length < 4) return;
    cand.sort((a, b) => (horizontal ? this.net.nodes[a].x - this.net.nodes[b].x : this.net.nodes[a].z - this.net.nodes[b].z));
    const stopNodes: number[] = []; let lastPos = -Infinity;
    for (const id of cand) { const p = horizontal ? this.net.nodes[id].x : this.net.nodes[id].z; if (p - lastPos >= 250) { stopNodes.push(id); lastPos = p; } }
    if (stopNodes.length < 3) return;
    const routeId = this.routes.length; const stopSeq: number[] = [];
    for (let s = 0; s + 1 < stopNodes.length; s++) {
      const a = this.net.nodes[stopNodes[s]], b = this.net.nodes[stopNodes[s + 1]];
      if (Math.hypot(b.x - a.x, b.z - a.z) > 500) continue; // ハイウェイまたぎは停留所を置かない
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const rw = 7; const px = dz, pz = -dx;
      const sx = mx + px * (rw / 2 + 1.2), sz = mz + pz * (rw / 2 + 1.2);
      const sid = this.stops.length;
      this.stops.push({ id: sid, x: sx, z: sz, node: stopNodes[s + 1], routes: [routeId] });
      stopSeq.push(sid);
    }
    if (stopSeq.length < 2) return;
    const loop = stopSeq.slice(); for (let i = stopSeq.length - 2; i >= 1; i--) loop.push(stopSeq[i]);
    this.routes.push({ id: routeId, stopSeq: loop });
  }
  private spawnBusOnRoute(routeId: number, startSeq: number): void {
    const route = this.routes[routeId]; const s0 = this.stops[route.stopSeq[startSeq]];
    const v = this.vs.spawnBus(this.buses.length, s0.x, s0.z); if (v < 0) return;
    const busId = this.buses.length; this.vs.busId[v] = busId;
    this.buses.push({ vehicle: v, route: routeId, seqIdx: startSeq, dwell: this.dwellSeconds, onboard: [], capacity: 30 });
    this.departToNextStop(busId);
  }
  private departToNextStop(busId: number): void {
    const bus = this.buses[busId]; const route = this.routes[bus.route];
    const nextSeq = (bus.seqIdx + 1) % route.stopSeq.length; const nextStop = this.stops[route.stopSeq[nextSeq]]; const v = bus.vehicle;
    const gx = this.net.nodes[nextStop.node].x, gz = this.net.nodes[nextStop.node].z;
    if (!this.traffic.dispatch(v, this.vs.posX[v], this.vs.posZ[v], gx, gz)) { this.vs.posX[v] = nextStop.x; this.vs.posZ[v] = nextStop.z; this.vs.state[v] = VehicleState.Arrived; }
    bus.seqIdx = nextSeq;
  }
  update(dt: number, onAlight: (agent: number, stop: BusStop) => void, takeBoarders: (stop: BusStop, routeId: number, freeSeats: number) => number[]): void {
    const vs = this.vs;
    for (let b = 0; b < this.buses.length; b++) {
      const bus = this.buses[b]; const v = bus.vehicle;
      if (bus.dwell > 0) { bus.dwell -= dt; if (bus.dwell <= 0) this.departToNextStop(b); continue; }
      if (vs.state[v] === VehicleState.Arrived) {
        const route = this.routes[bus.route]; const stop = this.stops[route.stopSeq[bus.seqIdx]];
        vs.posX[v] = stop.x; vs.posZ[v] = stop.z; vs.speed[v] = 0;
        for (let k = bus.onboard.length - 1; k >= 0; k--) { const ag = bus.onboard[k]; if (this.alightMap.get(ag) === stop.id) { bus.onboard.splice(k, 1); this.alightMap.delete(ag); onAlight(ag, stop); } }
        const free = bus.capacity - bus.onboard.length;
        if (free > 0) { const boarders = takeBoarders(stop, bus.route, free); for (const ag of boarders) bus.onboard.push(ag); }
        bus.dwell = this.dwellSeconds; vs.speed[v] = 0;
      }
    }
  }
  syncOnboard(setPos: (agent: number, x: number, z: number) => void): void { for (const bus of this.buses) { const v = bus.vehicle; for (const ag of bus.onboard) setPos(ag, this.vs.posX[v], this.vs.posZ[v]); } }
  nearestStop(x: number, z: number, maxDist = 400): number { let best = -1, bestD = maxDist * maxDist; for (const s of this.stops) { const d = (s.x - x) ** 2 + (s.z - z) ** 2; if (d < bestD) { bestD = d; best = s.id; } } return best; }
  sharedRoute(boardStop: number, alightStop: number): number { if (boardStop < 0 || alightStop < 0 || boardStop === alightStop) return -1; const a = this.stops[boardStop].routes, b = this.stops[alightStop].routes; for (const r of a) if (b.includes(r)) return r; return -1; }
  stopById(id: number): BusStop { return this.stops[id]; }
  get busCount(): number { return this.buses.length; }
  onboardCount(busId: number): number { return this.buses[busId].onboard.length; }
  busCapacity(busId: number): number { return this.buses[busId].capacity; }
  setAlight(agent: number, stopId: number): void { this.alightMap.set(agent, stopId); }
}
