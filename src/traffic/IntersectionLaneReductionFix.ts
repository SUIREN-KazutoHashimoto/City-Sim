import { RoadClass, type RoadNetwork } from './RoadNetwork';
import { TrafficSystem } from './TrafficSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';
import { vehicleLaneInfo } from './MultiLaneTrafficTuning';

type AnyTraffic = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

function isSurfaceIntersection(net: RoadNetwork, nodeId: number): boolean {
  const node = net.nodes[nodeId];
  if (!node) return false;
  let surfaceBranches = 0;
  for (const edgeId of node.edges) {
    const edge = net.edges[edgeId];
    if (!edge || edge.roadClass === RoadClass.Path) continue;
    surfaceBranches++;
  }
  return node.hasSignal || surfaceBranches >= 3;
}

/**
 * At an intersection throat, outgoing roads may legitimately have fewer lanes than the incoming
 * road. Vehicles already beside the intersection must be allowed to fan into the real downstream
 * lanes instead of every outer-lane vehicle stopping at the merge line and mutually blocking the
 * junction. The real lane count is restored as soon as enterEdge() assigns the downstream lane.
 */
const proto = TrafficSystem.prototype as unknown as AnyTraffic;
if (!proto.__citySimIntersectionLaneReductionV102) {
  const previousUpdate = proto.update as AnyMethod;
  proto.update = function updateWithIntersectionLaneReduction(this: AnyTraffic, dt: number): void {
    const net = this.net as RoadNetwork;
    const vs = this.vs as VehicleStore;
    const virtualLanes = new Map<number, number>();

    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving) continue;
      const info = vehicleLaneInfo(vs, v);
      if (!info) continue;
      const path = vs.paths[v];
      const cursor = vs.pathCursor[v];
      if (!path || cursor < 0 || cursor + 1 >= path.length) continue;
      const junction = path[cursor];
      if (!isSurfaceIntersection(net, junction)) continue;
      const next = net.edgeBetween(path[cursor], path[cursor + 1]);
      if (!next || info.lane < next.lanes) continue;
      virtualLanes.set(next.id, Math.max(virtualLanes.get(next.id) ?? next.lanes, info.lane + 1));
    }

    if (!virtualLanes.size) {
      previousUpdate.call(this, dt);
      return;
    }

    const netAny = net as unknown as Record<string, any>;
    const hadOwn = Object.prototype.hasOwnProperty.call(netAny, 'edgeBetween');
    const own = netAny.edgeBetween;
    const real = net.edgeBetween.bind(net);
    netAny.edgeBetween = (from: number, to: number): any => {
      const edge = real(from, to);
      if (!edge) return edge;
      const lanes = virtualLanes.get(edge.id);
      return lanes != null && lanes > edge.lanes ? { ...edge, lanes } : edge;
    };

    try {
      previousUpdate.call(this, dt);
    } finally {
      if (hadOwn) netAny.edgeBetween = own;
      else delete netAny.edgeBetween;
    }
  };
  proto.__citySimIntersectionLaneReductionV102 = true;
}
