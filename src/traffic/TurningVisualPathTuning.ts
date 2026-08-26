import { TrafficSystem } from './TrafficSystem';
import type { RoadNetwork } from './RoadNetwork';
import type { VehicleStore } from './VehicleStore';
import { laneCenterOffset, vehicleLaneInfo } from './MultiLaneTrafficTuning';

type AnyTraffic = any;
type AnyMethod = (...args: any[]) => any;

function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const proto = TrafficSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimTurningVisualPathV081) {
  const previousUpdateWorldPos = proto.updateWorldPos as AnyMethod;
  proto.updateWorldPos = function updateWorldPosWithIntersectionCurve(this: AnyTraffic, vehicle: number): void {
    previousUpdateWorldPos.call(this, vehicle);
    const vs = this.vs as VehicleStore;
    const net = this.net as RoadNetwork;
    const path = vs.paths[vehicle];
    const cursor = vs.pathCursor[vehicle];
    if (!path || cursor < 2 || cursor >= path.length) return;

    const a = net.nodes[path[cursor - 2]], b = net.nodes[path[cursor - 1]], c = net.nodes[path[cursor]];
    if (!a || !b || !c) return;
    let inX = b.x - a.x, inZ = b.z - a.z, outX = c.x - b.x, outZ = c.z - b.z;
    const inLen = Math.hypot(inX, inZ), outLen = Math.hypot(outX, outZ);
    if (inLen < 1 || outLen < 1) return;
    inX /= inLen; inZ /= inLen; outX /= outLen; outZ /= outLen;
    const cross = inX * outZ - inZ * outX;
    const dot = inX * outX + inZ * outZ;
    if (Math.abs(cross) < 0.24 || dot < -0.55) return;

    const turnDistance = vs.isBus[vehicle] ? 25 : vs.isTruck[vehicle] ? 21 : 15;
    const distanceIntoEdge = Math.max(0, vs.segT[vehicle] * vs.segLen[vehicle]);
    if (distanceIntoEdge >= turnDistance) return;

    const current = vehicleLaneInfo(vs, vehicle);
    if (!current) return;
    const prevEdge = net.edgeBetween(a.id, b.id);
    const prevLanes = Math.max(1, prevEdge?.lanes ?? 1);
    const prevLane = cross > 0 ? 0 : prevLanes - 1;
    const prevOffset = laneCenterOffset(prevLanes, prevLane);
    const currentOffset = current.offset;
    const prevRx = inZ, prevRz = -inX;
    const currRx = outZ, currRz = -outX;

    const p0x = b.x + prevRx * prevOffset;
    const p0z = b.z + prevRz * prevOffset;
    const p2x = b.x + outX * turnDistance + currRx * currentOffset;
    const p2z = b.z + outZ * turnDistance + currRz * currentOffset;
    const p1x = b.x + (prevRx * prevOffset + currRx * currentOffset) * 0.36;
    const p1z = b.z + (prevRz * prevOffset + currRz * currentOffset) * 0.36;
    const u = Math.max(0, Math.min(1, distanceIntoEdge / turnDistance));
    const om = 1 - u;
    const x = om * om * p0x + 2 * om * u * p1x + u * u * p2x;
    const z = om * om * p0z + 2 * om * u * p1z + u * u * p2z;
    const tx = 2 * om * (p1x - p0x) + 2 * u * (p2x - p1x);
    const tz = 2 * om * (p1z - p0z) + 2 * u * (p2z - p1z);
    if (Math.hypot(tx, tz) < 1e-4) return;

    vs.posX[vehicle] = x;
    vs.posZ[vehicle] = z;
    const target = Math.atan2(tz, tx);
    vs.heading[vehicle] = vs.heading[vehicle] + angleDelta(vs.heading[vehicle], target) * 0.92;
  };
  proto.__citySimTurningVisualPathV081 = true;
}
