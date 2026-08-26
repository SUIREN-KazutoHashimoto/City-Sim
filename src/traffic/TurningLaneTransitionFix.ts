import { TrafficSystem } from './TrafficSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';
import type { RoadNetwork } from './RoadNetwork';
import { vehicleLaneInfo } from './MultiLaneTrafficTuning';

type AnyTraffic = any;
type AnyMethod = (...args: any[]) => any;

const laneOverridesByTraffic = new WeakMap<object, Map<number, number>>();

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
if (!proto.__citySimTurningLaneTransitionV077) {
  const previousEnterEdge = proto.enterEdge as AnyMethod;
  proto.enterEdge = function enterEdgeWithTurningLaneConvergence(this: AnyTraffic, ...args: any[]): void {
    const from = Number(args[1]), to = Number(args[2]);
    const edge = this.net.edgeBetween(from, to);
    const overrides = laneOverridesByTraffic.get(this as object);
    const originalLanes = edge ? overrides?.get(edge.id) : undefined;
    if (!edge || originalLanes == null) {
      previousEnterEdge.apply(this, args);
      return;
    }

    // The intersection may fan several incoming turn lanes into fewer outgoing lanes. Let the
    // multi-lane enterEdge logic see the real outgoing lane count so it clamps to a valid lane.
    const inflated = edge.lanes;
    edge.lanes = originalLanes;
    try { previousEnterEdge.apply(this, args); }
    finally { edge.lanes = inflated; }
  };

  const previousUpdate = proto.update as AnyMethod;
  proto.update = function updateWithTurningLaneConvergence(this: AnyTraffic, dt: number): void {
    const net = this.net as RoadNetwork;
    const vs = this.vs as VehicleStore;
    const overrides = new Map<number, number>();

    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving || !isIntersectionTurn(net, vs, v)) continue;
      const info = vehicleLaneInfo(vs, v);
      if (!info) continue;
      const path = vs.paths[v], cursor = vs.pathCursor[v];
      if (!path || cursor + 1 >= path.length) continue;
      const next = net.edgeBetween(path[cursor], path[cursor + 1]);
      if (!next || info.lane < next.lanes) continue;

      if (!overrides.has(next.id)) overrides.set(next.id, next.lanes);
      next.lanes = Math.max(next.lanes, info.lane + 1);
    }

    if (overrides.size === 0) {
      previousUpdate.call(this, dt);
      return;
    }

    laneOverridesByTraffic.set(this as object, overrides);
    try {
      // MultiLaneTrafficTuning now treats the outgoing edge as lane-compatible for this update,
      // so a turning vehicle is not trapped by the straight-road lane-reduction guard forever.
      previousUpdate.call(this, dt);
    } finally {
      for (const [edgeId, lanes] of overrides) {
        const edge = net.edges[edgeId];
        if (edge) edge.lanes = lanes;
      }
      laneOverridesByTraffic.delete(this as object);
    }
  };

  proto.__citySimTurningLaneTransitionV077 = true;
}
