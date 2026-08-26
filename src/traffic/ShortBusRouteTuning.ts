import { AStar } from './AStar';
import { BusSystem, type BusRoute, type BusStop, type RailBusStationTarget } from './BusSystem';
import type { RoadNetwork } from './RoadNetwork';

type AnyBus = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const MAX_ROUTE_METERS = 5_000;
const TARGET_ROUTE_METERS = 4_600;
const MIN_BASE_SEGMENTS = 4;

function edgeLength(net: RoadNetwork, from: number, to: number): number {
  const edge = net.edgeBetween(from, to);
  return edge?.length ?? Math.hypot(net.nodes[to].x - net.nodes[from].x, net.nodes[to].z - net.nodes[from].z);
}

function nodePathLength(net: RoadNetwork, astar: AStar, from: number, to: number): number {
  if (from === to) return 0;
  const path = astar.findPath(from, to);
  if (path.length < 2) return Infinity;
  let length = 0;
  for (let i = 0; i + 1 < path.length; i++) length += edgeLength(net, path[i], path[i + 1]);
  return length;
}

function legLength(net: RoadNetwork, astar: AStar, a: BusStop, b: BusStop): number {
  const trunk = nodePathLength(net, astar, a.node, b.node);
  if (!Number.isFinite(trunk)) return Infinity;
  const na = net.nodes[a.node], nb = net.nodes[b.node];
  return trunk
    + Math.hypot(a.roadX - na.x, a.roadZ - na.z)
    + Math.hypot(b.roadX - nb.x, b.roadZ - nb.z);
}

function loopLength(net: RoadNetwork, astar: AStar, stops: readonly BusStop[], seq: readonly number[]): number {
  if (seq.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < seq.length; i++) {
    const a = stops[seq[i]], b = stops[seq[(i + 1) % seq.length]];
    if (!a || !b) return Infinity;
    const length = legLength(net, astar, a, b);
    if (!Number.isFinite(length)) return Infinity;
    total += length;
  }
  return total;
}

function outwardStops(route: BusRoute): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const stopId of route.stopSeq) {
    if (seen.has(stopId)) break;
    seen.add(stopId);
    result.push(stopId);
  }
  return result;
}

function outAndBack(stopIds: readonly number[]): number[] {
  const loop = [...stopIds];
  for (let i = stopIds.length - 2; i >= 1; i--) loop.push(stopIds[i]);
  return loop;
}

function splitBaseRoute(net: RoadNetwork, astar: AStar, stops: readonly BusStop[], route: BusRoute): number[][] {
  const outward = outwardStops(route);
  if (outward.length < 2) return [];
  const cumulative = new Array<number>(outward.length).fill(0);
  for (let i = 1; i < outward.length; i++) {
    const leg = legLength(net, astar, stops[outward[i - 1]], stops[outward[i]]);
    cumulative[i] = Number.isFinite(leg) ? cumulative[i - 1] + leg : Infinity;
  }
  const total = cumulative[cumulative.length - 1];
  if (!Number.isFinite(total) || total <= 0) return [];

  const targetOneWay = Math.max(600, Math.min(TARGET_ROUTE_METERS * 0.5, total / MIN_BASE_SEGMENTS));
  const segments: number[][] = [];
  let start = 0;
  while (start < outward.length - 1) {
    let end = start + 1;
    while (end + 1 < outward.length && cumulative[end + 1] - cumulative[start] <= targetOneWay) end++;
    const part = outward.slice(start, end + 1);
    let loop = outAndBack(part);
    while (part.length > 2 && loopLength(net, astar, stops, loop) > MAX_ROUTE_METERS) {
      part.pop(); end--; loop = outAndBack(part);
    }
    if (loopLength(net, astar, stops, loop) <= MAX_ROUTE_METERS) segments.push(loop);
    start = Math.max(start + 1, end);
  }
  return segments;
}

function rebuildGridRoutes(bus: AnyBus, size: number): void {
  const lines = 3;
  for (let axis = 0; axis < 2; axis++) for (let k = 0; k < lines; k++) {
    bus.makeLine(axis === 0, ((k + 1) / (lines + 1)) * size, size);
  }
  const generated = [...bus.routes] as BusRoute[];
  if (generated.length === 0) return;
  const astar = new AStar(bus.net as RoadNetwork, 'drive');
  const shortRoutes: BusRoute[] = [];
  for (const source of generated) {
    for (const stopSeq of splitBaseRoute(bus.net, astar, bus.stops, source)) {
      shortRoutes.push({ id: shortRoutes.length, stopSeq, kind: 'grid' });
    }
  }

  bus.routes.length = 0;
  for (const stop of bus.stops as BusStop[]) stop.routes.length = 0;
  for (const route of shortRoutes) {
    route.id = bus.routes.length;
    bus.routes.push(route);
    for (const stopId of new Set(route.stopSeq)) {
      const stop = bus.stops[stopId] as BusStop | undefined;
      if (stop && !stop.routes.includes(route.id)) stop.routes.push(route.id);
    }
  }
}

function fitFeeder(bus: AnyBus, routeId: number): number {
  const route = bus.routes[routeId] as BusRoute | undefined;
  if (!route || route.stopSeq.length < 2) return -1;
  const astar = new AStar(bus.net as RoadNetwork, 'drive');
  if (loopLength(bus.net, astar, bus.stops, route.stopSeq) <= MAX_ROUTE_METERS) return routeId;

  let seq = [...route.stopSeq];
  while (seq.length > 2 && loopLength(bus.net, astar, bus.stops, seq) > MAX_ROUTE_METERS) {
    let best: number[] | null = null, bestLength = Infinity;
    for (let i = 1; i < seq.length; i++) {
      const candidate = seq.filter((_id, index) => index !== i);
      const length = loopLength(bus.net, astar, bus.stops, candidate);
      if (length < bestLength) { best = candidate; bestLength = length; }
    }
    if (!best) break;
    seq = best;
  }
  if (loopLength(bus.net, astar, bus.stops, seq) > MAX_ROUTE_METERS) return -1;

  for (const stop of bus.stops as BusStop[]) {
    const index = stop.routes.indexOf(routeId);
    if (index >= 0) stop.routes.splice(index, 1);
  }
  route.stopSeq = seq;
  for (const stopId of new Set(seq)) {
    const stop = bus.stops[stopId] as BusStop | undefined;
    if (stop && !stop.routes.includes(routeId)) stop.routes.push(routeId);
  }
  return routeId;
}

const proto = BusSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimShortBusNetworkV082) {
  proto.build = function buildShortLocalBusNetwork(this: AnyBus, size: number): void {
    rebuildGridRoutes(this, size);
    for (const route of this.routes as BusRoute[]) this.spawnRouteFleet(route.id);
    const astar = new AStar(this.net as RoadNetwork, 'drive');
    const lengths = (this.routes as BusRoute[]).map((route) => Math.round(loopLength(this.net, astar, this.stops, route.stopSeq)));
    console.info('[City-Sim] short bus routes', {
      routes: this.routes.length,
      maxMeters: lengths.length ? Math.max(...lengths) : 0,
      averageMeters: lengths.length ? Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length) : 0,
      buses: this.buses.length,
    });
  };

  const previousMakeStationFeeder = proto.makeStationFeeder as AnyMethod;
  proto.makeStationFeeder = function makeShortStationFeeder(this: AnyBus, station: RailBusStationTarget): number {
    const routeId = previousMakeStationFeeder.call(this, station) as number;
    if (routeId < 0) return routeId;
    if (fitFeeder(this, routeId) >= 0) return routeId;
    if (routeId === this.routes.length - 1) this.routes.pop();
    for (const stop of this.stops as BusStop[]) {
      const index = stop.routes.indexOf(routeId);
      if (index >= 0) stop.routes.splice(index, 1);
    }
    return -1;
  };

  proto.spawnRouteFleet = function spawnThreeOrFourBuses(this: AnyBus, routeId: number, _feeder = false): void {
    const route = this.routes[routeId] as BusRoute | undefined;
    if (!route || route.stopSeq.length < 2) return;
    const astar = new AStar(this.net as RoadNetwork, 'drive');
    const meters = loopLength(this.net, astar, this.stops, route.stopSeq);
    const nBus = meters >= 3_200 || route.stopSeq.length >= 7 ? 4 : 3;
    for (let index = 0; index < nBus; index++) {
      this.spawnBusOnRoute(routeId, Math.floor((index / nBus) * route.stopSeq.length));
    }
  };

  proto.__citySimShortBusNetworkV082 = true;
}
