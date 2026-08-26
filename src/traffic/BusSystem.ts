import { RoadNetwork, RoadClass, roadWidth } from './RoadNetwork';
import { VehicleStore, VehicleState } from './VehicleStore';
import { TrafficSystem } from './TrafficSystem';

export interface BusStop {
  id: number; x: number; z: number; node: number; routes: number[];
  roadX: number; roadZ: number; edgeFrom: number; edgeTo: number; edgeT: number;
  /** 道路Edgeの向き。停留所標識・上屋を道路と平行に描画するために使う。 */
  heading: number;
  /** 道路中心から見て停留所がある側。+1/-1。 */
  side: number;
}
export interface BusRoute {
  id: number;
  stopSeq: number[];
  kind?: 'grid' | 'rail-feeder';
  stationId?: number;
}
interface BusRuntime { vehicle: number; route: number; seqIdx: number; dwell: number; onboard: number[]; capacity: number; }

/** RailPlanning.RailStationと構造互換。交通層からgeneration層への循環importを避ける。 */
export interface RailBusStationTarget {
  id: number;
  x: number;
  z: number;
  /** RailStationKind: Central=0, SubCenter=1, Local=2, Terminal=3 */
  kind: number;
  roadNode: number;
  busStopId: number;
}

/** Inspector等へ公開するバス運行状態。配列はコピーを返して外部変更を防ぐ。 */
export interface BusStatusSnapshot {
  busId: number;
  vehicleId: number;
  routeId: number;
  sequenceIndex: number;
  targetStopId: number;
  dwellRemaining: number;
  capacity: number;
  onboard: number[];
  routeStops: number[];
}

/** 路線バス。停留所は実道路Edge上の停止点と、歩行者用の歩道側座標を分離して保持する。 */
export class BusSystem {
  stops: BusStop[] = []; routes: BusRoute[] = []; buses: BusRuntime[] = [];
  readonly dwellSeconds = 8;
  private alightMap = new Map<number, number>();
  constructor(private net: RoadNetwork, private vs: VehicleStore, private traffic: TrafficSystem, _seed = 777) {}

  build(size: number): void {
    const lines = 3;
    for (let axis = 0; axis < 2; axis++) for (let k = 0; k < lines; k++) {
      const frac = (k + 1) / (lines + 1); this.makeLine(axis === 0, frac * size, size);
    }
    for (const r of this.routes) this.spawnRouteFleet(r.id);
  }

  /**
   * Phase 4: 鉄道駅とバス網を接続する。
   * 中央駅/副都心駅には新しいフィーダー路線を作り、一般駅は近隣既存停留所へ紐付ける。
   * build()後に呼べるよう、追加路線分のバスだけその場でspawnする。
   */
  addRailStationFeeders(stations: RailBusStationTarget[]): void {
    if (stations.length === 0 || this.stops.length === 0) return;
    for (const station of stations) {
      const nearby = this.nearestStop(station.x, station.z, 480);
      if (nearby >= 0) station.busStopId = nearby;
      // RailStationKind Central/SubCenterのみ専用フィーダー路線を持つ。
      if (station.kind !== 0 && station.kind !== 1) continue;
      const routeId = this.makeStationFeeder(station);
      if (routeId >= 0) this.spawnRouteFleet(routeId, true);
    }
  }

  private makeLine(horizontal: boolean, coord: number, size: number): void {
    const band = 60; const cand: number[] = [];
    for (const n of this.net.nodes) {
      const cross = horizontal ? n.z : n.x; if (Math.abs(cross - coord) > band) continue;
      let hasSurface = false;
      for (const eid of n.edges) {
        const rc = this.net.edges[eid].roadClass;
        if (rc !== RoadClass.Highway && rc !== RoadClass.Path) { hasSurface = true; break; }
      }
      if (hasSurface) cand.push(n.id); void size;
    }
    if (cand.length < 4) return;
    cand.sort((a, b) => (horizontal ? this.net.nodes[a].x - this.net.nodes[b].x : this.net.nodes[a].z - this.net.nodes[b].z));

    const stopNodes: number[] = []; let lastPos = -Infinity;
    for (const id of cand) {
      const p = horizontal ? this.net.nodes[id].x : this.net.nodes[id].z;
      if (p - lastPos >= 250) { stopNodes.push(id); lastPos = p; }
    }
    if (stopNodes.length < 3) return;

    const routeId = this.routes.length, stopStart = this.stops.length, stopSeq: number[] = [], usedEdges = new Set<string>();
    const side = (routeId & 1) === 0 ? 1 : -1;
    for (const nodeId of stopNodes) {
      const stop = this.createStop(nodeId, horizontal, routeId, side, usedEdges); if (!stop) continue;
      stop.id = this.stops.length; this.stops.push(stop); stopSeq.push(stop.id);
    }
    if (stopSeq.length < 2) { this.stops.length = stopStart; return; }
    const loop = stopSeq.slice(); for (let i = stopSeq.length - 2; i >= 1; i--) loop.push(stopSeq[i]);
    this.routes.push({ id: routeId, stopSeq: loop, kind: 'grid' });
  }

  private makeStationFeeder(station: RailBusStationTarget): number {
    const routeId = this.routes.length;
    const stationStop = this.ensureStationStop(station, routeId);
    if (stationStop < 0) return -1;
    station.busStopId = stationStop;

    // 駅から0.45～2.4kmの既存停留所を、元路線がなるべく重複しないよう選ぶ。
    const candidates = this.stops
      .filter((s) => s.id !== stationStop)
      .map((s) => ({ s, d: Math.hypot(s.x - station.x, s.z - station.z) }))
      .filter((v) => v.d >= 450 && v.d <= 2400)
      .sort((a, b) => Math.abs(a.d - 1350) - Math.abs(b.d - 1350));

    const chosen: BusStop[] = [];
    const usedBaseRoutes = new Set<number>();
    for (const c of candidates) {
      const baseRoute = c.s.routes.find((r) => this.routes[r]?.kind !== 'rail-feeder') ?? -1;
      if (baseRoute >= 0 && usedBaseRoutes.has(baseRoute)) continue;
      if (chosen.some((s) => Math.hypot(s.x - c.s.x, s.z - c.s.z) < 300)) continue;
      chosen.push(c.s); if (baseRoute >= 0) usedBaseRoutes.add(baseRoute);
      if (chosen.length >= 4) break;
    }
    if (chosen.length < 2) {
      for (const c of candidates) {
        if (chosen.includes(c.s)) continue;
        chosen.push(c.s); if (chosen.length >= 3) break;
      }
    }
    if (chosen.length < 2) return -1;

    // 駅を始点に角度順で回る循環路線。停留所間の実走行はTrafficSystemのA*へ任せる。
    chosen.sort((a, b) => Math.atan2(a.z - station.z, a.x - station.x) - Math.atan2(b.z - station.z, b.x - station.x));
    const stopSeq = [stationStop, ...chosen.map((s) => s.id)];
    for (const sid of stopSeq) {
      const stop = this.stops[sid]; if (!stop.routes.includes(routeId)) stop.routes.push(routeId);
    }
    this.routes.push({ id: routeId, stopSeq, kind: 'rail-feeder', stationId: station.id });
    return routeId;
  }

  private ensureStationStop(station: RailBusStationTarget, routeId: number): number {
    const near = this.nearestStop(station.x, station.z, 140);
    if (near >= 0) {
      if (!this.stops[near].routes.includes(routeId)) this.stops[near].routes.push(routeId);
      return near;
    }
    const node = station.roadNode >= 0 ? station.roadNode : this.nearestSurfaceNode(station.x, station.z);
    if (node < 0) return -1;
    const stop = this.createStopAtNode(node, routeId, (routeId & 1) === 0 ? 1 : -1);
    if (!stop) return -1;
    stop.id = this.stops.length; this.stops.push(stop); return stop.id;
  }

  private nearestSurfaceNode(x: number, z: number): number {
    let best = -1, bestD = Infinity;
    for (const n of this.net.nodes) {
      let surface = false;
      for (const eid of n.edges) {
        const rc = this.net.edges[eid].roadClass;
        if (rc !== RoadClass.Highway && rc !== RoadClass.Path) { surface = true; break; }
      }
      if (!surface) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bestD) { bestD = d; best = n.id; }
    }
    return best;
  }

  private createStopAtNode(nodeId: number, routeId: number, side: number): BusStop | null {
    const n = this.net.nodes[nodeId]; if (!n) return null;
    const edges = n.edges.map((eid) => this.net.edges[eid]).filter((e) => e.roadClass !== RoadClass.Highway && e.roadClass !== RoadClass.Path);
    if (edges.length === 0) return null;
    const rank = (rc: RoadClass): number => rc === RoadClass.Arterial ? 0 : rc === RoadClass.Collector ? 1 : rc === RoadClass.Local ? 2 : 3;
    edges.sort((a, b) => rank(a.roadClass) - rank(b.roadClass) || b.length - a.length);
    return this.stopFromEdge(nodeId, edges[0], routeId, side, 0.34);
  }

  private createStop(nodeId: number, horizontal: boolean, routeId: number, side: number, used: Set<string>): BusStop | null {
    const n = this.net.nodes[nodeId];
    const edges = n.edges.map((eid) => this.net.edges[eid]).filter((e) => {
      if (e.roadClass === RoadClass.Highway || e.roadClass === RoadClass.Path) return false;
      const b = this.net.nodes[e.to], dx = b.x - n.x, dz = b.z - n.z;
      return horizontal ? Math.abs(dx) >= Math.abs(dz) : Math.abs(dz) > Math.abs(dx);
    });
    if (edges.length === 0) return null;
    edges.sort((ea, eb) => {
      const a = this.net.nodes[ea.to], b = this.net.nodes[eb.to];
      const da = horizontal ? a.x - n.x : a.z - n.z, db = horizontal ? b.x - n.x : b.z - n.z;
      const ap = da > 0 ? 0 : 1, bp = db > 0 ? 0 : 1; return ap - bp || Math.abs(db) - Math.abs(da);
    });
    const edge = edges.find((e) => !used.has(e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`));
    if (!edge) return null;
    const key = edge.from < edge.to ? `${edge.from}_${edge.to}` : `${edge.to}_${edge.from}`; used.add(key);
    return this.stopFromEdge(nodeId, edge, routeId, side, 0.38);
  }

  private stopFromEdge(nodeId: number, edge: { from: number; to: number; lanes: number }, routeId: number, side: number, t: number): BusStop {
    const a = this.net.nodes[edge.from], b = this.net.nodes[edge.to]; let dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const roadX = a.x + (b.x - a.x) * t, roadZ = a.z + (b.z - a.z) * t;
    const px = dz, pz = -dx, off = roadWidth(edge.lanes) / 2 + 1.55;
    return {
      id: -1, x: roadX + px * off * side, z: roadZ + pz * off * side, node: nodeId, routes: [routeId],
      roadX, roadZ, edgeFrom: edge.from, edgeTo: edge.to, edgeT: t,
      heading: Math.atan2(dz, dx), side,
    };
  }

  private spawnRouteFleet(routeId: number, feeder = false): void {
    const r = this.routes[routeId]; if (!r || r.stopSeq.length < 2) return;
    const nBus = feeder ? (r.stopSeq.length >= 4 ? 2 : 1) : Math.min(4, Math.max(2, Math.floor(r.stopSeq.length / 4)));
    for (let b = 0; b < nBus; b++) this.spawnBusOnRoute(r.id, Math.floor((b / nBus) * r.stopSeq.length));
  }

  private spawnBusOnRoute(routeId: number, startSeq: number): void {
    const route = this.routes[routeId]; const s0 = this.stops[route.stopSeq[startSeq]];
    const v = this.vs.spawnBus(this.buses.length, s0.roadX, s0.roadZ); if (v < 0) return;
    const busId = this.buses.length; this.vs.busId[v] = busId;
    this.traffic.placeAtEdgePoint(v, s0.edgeFrom, s0.edgeTo, s0.edgeT);
    this.buses.push({ vehicle: v, route: routeId, seqIdx: startSeq, dwell: 0, onboard: [], capacity: 30 });
    this.departToNextStop(busId);
  }

  private departToNextStop(busId: number): void {
    const bus = this.buses[busId], route = this.routes[bus.route];
    const nextSeq = (bus.seqIdx + 1) % route.stopSeq.length, nextStop = this.stops[route.stopSeq[nextSeq]], v = bus.vehicle;
    let ok = this.traffic.dispatchFromCurrentToEdgePoint(v, nextStop.edgeFrom, nextStop.edgeTo, nextStop.edgeT);
    if (!ok) ok = this.traffic.dispatchToEdgePoint(v, this.vs.posX[v], this.vs.posZ[v], nextStop.edgeFrom, nextStop.edgeTo, nextStop.edgeT);
    if (!ok) this.traffic.placeAtEdgePoint(v, nextStop.edgeFrom, nextStop.edgeTo, nextStop.edgeT);
    bus.seqIdx = nextSeq;
  }

  update(dt: number, onAlight: (agent: number, stop: BusStop) => void, takeBoarders: (stop: BusStop, routeId: number, freeSeats: number) => number[]): void {
    const vs = this.vs;
    for (let b = 0; b < this.buses.length; b++) {
      const bus = this.buses[b], v = bus.vehicle;
      if (bus.dwell > 0) { bus.dwell -= dt; if (bus.dwell <= 0) this.departToNextStop(b); continue; }
      if (vs.state[v] === VehicleState.Arrived) {
        const route = this.routes[bus.route], stop = this.stops[route.stopSeq[bus.seqIdx]];
        // 車両座標はTrafficSystemが道路Edge上の停止点へ正確に置く。歩道側stop.x/zへは移さない。
        vs.speed[v] = 0;
        for (let k = bus.onboard.length - 1; k >= 0; k--) {
          const ag = bus.onboard[k]; if (this.alightMap.get(ag) === stop.id) { bus.onboard.splice(k, 1); this.alightMap.delete(ag); onAlight(ag, stop); }
        }
        const free = bus.capacity - bus.onboard.length;
        if (free > 0) { const boarders = takeBoarders(stop, bus.route, free); for (const ag of boarders) bus.onboard.push(ag); }
        bus.dwell = this.dwellSeconds;
      }
    }
  }

  syncOnboard(setPos: (agent: number, x: number, z: number) => void): void {
    for (const bus of this.buses) { const v = bus.vehicle; for (const ag of bus.onboard) setPos(ag, this.vs.posX[v], this.vs.posZ[v]); }
  }
  nearestStop(x: number, z: number, maxDist = 400): number { let best = -1, bestD = maxDist * maxDist; for (const s of this.stops) { const d = (s.x - x) ** 2 + (s.z - z) ** 2; if (d < bestD) { bestD = d; best = s.id; } } return best; }
  sharedRoute(boardStop: number, alightStop: number): number { if (boardStop < 0 || alightStop < 0 || boardStop === alightStop) return -1; const a = this.stops[boardStop].routes, b = this.stops[alightStop].routes; for (const r of a) if (b.includes(r)) return r; return -1; }
  stopById(id: number): BusStop { return this.stops[id]; }
  get busCount(): number { return this.buses.length; }
  onboardCount(busId: number): number { return this.buses[busId]?.onboard.length ?? 0; }
  busCapacity(busId: number): number { return this.buses[busId]?.capacity ?? 30; }
  setAlight(agent: number, stopId: number): void { this.alightMap.set(agent, stopId); }
  alightStopFor(agent: number): number { return this.alightMap.get(agent) ?? -1; }

  busStatus(busId: number): BusStatusSnapshot | null {
    const bus = this.buses[busId]; if (!bus) return null;
    const route = this.routes[bus.route]; if (!route) return null;
    return {
      busId,
      vehicleId: bus.vehicle,
      routeId: bus.route,
      sequenceIndex: bus.seqIdx,
      targetStopId: route.stopSeq[bus.seqIdx] ?? -1,
      dwellRemaining: Math.max(0, bus.dwell),
      capacity: bus.capacity,
      onboard: bus.onboard.slice(),
      routeStops: route.stopSeq.slice(),
    };
  }
}
