import { TrafficSystem } from './TrafficSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';
import type { RoadNetwork } from './RoadNetwork';
import { vehicleLaneInfo } from './MultiLaneTrafficTuning';

type AnyTraffic = any;
type AnyMethod = (...args: any[]) => any;

function isIntersectionTurn(net: RoadNetwork, vs: VehicleStore, vehicle: number): boolean {
  const path = vs.paths[vehicle];
  const cursor = vs.pathCursor[vehicle];
  if (!path || cursor <= 0 || cursor + 1 >= path.length) return false;
  const a = net.nodes[path[cursor - 1]], b = net.nodes[path[cursor]], c = net.nodes[path[cursor + 1]];
  if (!a || !b || !c) return false;
  const inX = b.x - a.x, inZ = b.z - a.z, outX = c.x - b.x, outZ = c.z - b.z;
  const inLen = Math.hypot(inX, inZ), outLen = Math.hypot(outX, outZ);
  if (inLen < 1 || outLen < 1) return false;
  const dot = (inX * outX + inZ * outZ) / (inLen * outLen);
  const cross = (inX * outZ - inZ * outX) / (inLen * outLen);
  return dot < -0.55 || Math.abs(cross) >= 0.24;
}

const proto = TrafficSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimTurningLaneTransitionV079) {
  const previousUpdate = proto.update as AnyMethod;
  proto.update = function updateWithTurningLaneConvergence(this: AnyTraffic, dt: number): void {
    const net = this.net as RoadNetwork;
    const vs = this.vs as VehicleStore;
    const virtualLanes = new Map<number, number>();

    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving || !isIntersectionTurn(net, vs, v)) continue;
      const info = vehicleLaneInfo(vs, v);
      if (!info) continue;
      const path = vs.paths[v], cursor = vs.pathCursor[v];
      if (!path || cursor + 1 >= path.length) continue;
      const next = net.edgeBetween(path[cursor], path[cursor + 1]);
      if (!next || info.lane < next.lanes) continue;
      virtualLanes.set(next.id, Math.max(virtualLanes.get(next.id) ?? next.lanes, info.lane + 1));
    }

    if (virtualLanes.size === 0) {
      previousUpdate.call(this, dt);
      return;
    }

    // MultiLaneTrafficTuning asks edgeBetween() only to decide whether a vehicle must merge before
    // the next edge. For a genuine intersection turn, expose a virtual fan-in lane count only to
    // that lookup. The actual RoadEdge is never mutated, so vehicles already on the outgoing road
    // keep their real lane geometry and occupancy for the whole frame.
    const netAny = net as unknown as Record<string, any>;
    const hadOwnEdgeBetween = Object.prototype.hasOwnProperty.call(netAny, 'edgeBetween');
    const previousOwnEdgeBetween = netAny.edgeBetween;
    const realEdgeBetween = net.edgeBetween.bind(net);
    netAny.edgeBetween = (from: number, to: number): any => {
      const edge = realEdgeBetween(from, to);
      if (!edge) return edge;
      const lanes = virtualLanes.get(edge.id);
      return lanes != null && lanes > edge.lanes ? { ...edge, lanes } : edge;
    };

    try {
      // The straight-road 3→1 merge guard still applies everywhere else. At the intersection the
      // turn can converge into the real outgoing lane, and enterEdge then clamps to that real count.
      previousUpdate.call(this, dt);
    } finally {
      if (hadOwnEdgeBetween) netAny.edgeBetween = previousOwnEdgeBetween;
      else delete netAny.edgeBetween;
    }
  };

  proto.__citySimTurningLaneTransitionV079 = true;
}
