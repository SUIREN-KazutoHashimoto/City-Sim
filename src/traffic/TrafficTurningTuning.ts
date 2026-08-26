import { laneOffset, type RoadNetwork } from './RoadNetwork';
import { TrafficSystem } from './TrafficSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';

type AnyTraffic = Record<string, any>;

interface TurnCurve {
  p0x: number; p0z: number;
  p1x: number; p1z: number;
  p2x: number; p2z: number;
  p3x: number; p3z: number;
  radiusIn: number;
  radiusOut: number;
  angle: number;
}

interface TurnPose { x: number; z: number; heading: number; }

interface UpdateScratch {
  savedMaxSpeed: Float32Array;
  edgeBefore: Int32Array;
  touched: Uint8Array;
}

const proto = TrafficSystem.prototype as unknown as AnyTraffic;
const previousUpdate = proto.update as (dt: number) => void;
const scratchByTraffic = new WeakMap<object, UpdateScratch>();

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function smoothstep(value: number): number { const t = clamp01(value); return t * t * (3 - 2 * t); }

function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function turnRadius(vs: VehicleStore, v: number): number {
  return vs.isBus[v] ? 18 : vs.isTruck[v] ? 15 : 10.5;
}

function lanePoint(net: RoadNetwork, from: number, to: number, distance: number): TurnPose | null {
  const a = net.nodes[from], b = net.nodes[to];
  if (!a || !b) return null;
  let dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.01) return null;
  dx /= length; dz /= length;
  const edge = net.edgeBetween(from, to);
  const offset = laneOffset(edge?.lanes ?? 1);
  const d = Math.max(0, Math.min(length, distance));
  return {
    x: a.x + dx * d + dz * offset,
    z: a.z + dz * d - dx * offset,
    heading: Math.atan2(dz, dx),
  };
}

function buildTurnCurve(self: AnyTraffic, v: number, intersectionIndex: number): TurnCurve | null {
  const net = self.net as RoadNetwork;
  const vs = self.vs as VehicleStore;
  const path = vs.paths[v];
  if (intersectionIndex <= 0 || intersectionIndex + 1 >= path.length) return null;
  const aId = path[intersectionIndex - 1], bId = path[intersectionIndex], cId = path[intersectionIndex + 1];
  const a = net.nodes[aId], b = net.nodes[bId], c = net.nodes[cId];
  if (!a || !b || !c) return null;

  const inLen = Math.hypot(b.x - a.x, b.z - a.z);
  const outLen = Math.hypot(c.x - b.x, c.z - b.z);
  if (inLen < 2 || outLen < 2) return null;
  const inHeading = Math.atan2(b.z - a.z, b.x - a.x);
  const outHeading = Math.atan2(c.z - b.z, c.x - b.x);
  const delta = angleDelta(inHeading, outHeading);
  if (Math.abs(delta) < Math.PI / 12) return null;

  const preferred = turnRadius(vs, v);
  const radiusIn = Math.max(3.5, Math.min(preferred, inLen * 0.38));
  const radiusOut = Math.max(3.5, Math.min(preferred, outLen * 0.38));
  const p0 = lanePoint(net, aId, bId, inLen - radiusIn);
  const p3 = lanePoint(net, bId, cId, radiusOut);
  if (!p0 || !p3) return null;

  // Cubic Bezier keeps the lane tangent continuous at both ends. Using separate control
  // points avoids snapping the lane centre to the intersection node before the vehicle turns.
  const tangentIn = radiusIn * 0.72;
  const tangentOut = radiusOut * 0.72;
  return {
    p0x: p0.x, p0z: p0.z,
    p1x: p0.x + Math.cos(inHeading) * tangentIn,
    p1z: p0.z + Math.sin(inHeading) * tangentIn,
    p2x: p3.x - Math.cos(outHeading) * tangentOut,
    p2z: p3.z - Math.sin(outHeading) * tangentOut,
    p3x: p3.x, p3z: p3.z,
    radiusIn, radiusOut, angle: delta,
  };
}

function curvePose(curve: TurnCurve, value: number): TurnPose {
  const t = clamp01(value), u = 1 - t;
  const x = u * u * u * curve.p0x
    + 3 * u * u * t * curve.p1x
    + 3 * u * t * t * curve.p2x
    + t * t * t * curve.p3x;
  const z = u * u * u * curve.p0z
    + 3 * u * u * t * curve.p1z
    + 3 * u * t * t * curve.p2z
    + t * t * t * curve.p3z;
  const dx = 3 * u * u * (curve.p1x - curve.p0x)
    + 6 * u * t * (curve.p2x - curve.p1x)
    + 3 * t * t * (curve.p3x - curve.p2x);
  const dz = 3 * u * u * (curve.p1z - curve.p0z)
    + 6 * u * t * (curve.p2z - curve.p1z)
    + 3 * t * t * (curve.p3z - curve.p2z);
  return { x, z, heading: Math.atan2(dz, dx) };
}

function curvedPose(self: AnyTraffic, v: number): TurnPose | null {
  const vs = self.vs as VehicleStore;
  const path = vs.paths[v];
  const cursor = vs.pathCursor[v];
  if (cursor <= 0 || cursor >= path.length) return null;

  // Finish the curve from the previous intersection first. This keeps short blocks from
  // blending two turns at once.
  if (cursor >= 2) {
    const previous = buildTurnCurve(self, v, cursor - 1);
    if (previous) {
      const distanceIntoEdge = Math.max(0, vs.segT[v] * vs.segLen[v]);
      if (distanceIntoEdge < previous.radiusOut) {
        const t = 0.5 + 0.5 * distanceIntoEdge / previous.radiusOut;
        return curvePose(previous, t);
      }
    }
  }

  if (cursor + 1 < path.length) {
    const upcoming = buildTurnCurve(self, v, cursor);
    if (upcoming) {
      const distanceToNode = Math.max(0, (1 - vs.segT[v]) * vs.segLen[v]);
      if (distanceToNode < upcoming.radiusIn) {
        const t = 0.5 * (1 - distanceToNode / upcoming.radiusIn);
        return curvePose(upcoming, t);
      }
    }
  }
  return null;
}

function linearPose(self: AnyTraffic, v: number): TurnPose | null {
  const net = self.net as RoadNetwork;
  const vs = self.vs as VehicleStore;
  const from = vs.fromNode[v], to = vs.toNode[v];
  const a = net.nodes[from], b = net.nodes[to];
  if (!a || !b) return null;
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return lanePoint(net, from, to, clamp01(vs.segT[v]) * length);
}

function cornerSpeed(vs: VehicleStore, v: number, angle: number): number {
  const degrees = Math.abs(angle) * 180 / Math.PI;
  const blend = smoothstep((degrees - 18) / 72);
  const gentle = vs.isBus[v] ? 11.0 : vs.isTruck[v] ? 12.0 : 14.0;
  const rightAngle = vs.isBus[v] ? 6.2 : vs.isTruck[v] ? 6.8 : 8.4;
  let speed = gentle + (rightAngle - gentle) * blend;
  if (degrees > 100) speed *= Math.max(0.68, 1 - (degrees - 100) / 250);
  return Math.max(4.4, speed);
}

function turnSpeedCap(self: AnyTraffic, v: number, roadSpeed: number): number {
  const vs = self.vs as VehicleStore;
  const path = vs.paths[v];
  const cursor = vs.pathCursor[v];
  let cap = roadSpeed;

  if (cursor >= 2) {
    const previous = buildTurnCurve(self, v, cursor - 1);
    if (previous) {
      const distanceIntoEdge = Math.max(0, vs.segT[v] * vs.segLen[v]);
      if (distanceIntoEdge < previous.radiusOut) {
        const corner = cornerSpeed(vs, v, previous.angle);
        cap = Math.min(cap, corner + (roadSpeed - corner) * smoothstep(distanceIntoEdge / previous.radiusOut));
      }
    }
  }

  if (cursor + 1 < path.length) {
    const upcoming = buildTurnCurve(self, v, cursor);
    if (upcoming) {
      const distanceToNode = Math.max(0, (1 - vs.segT[v]) * vs.segLen[v]);
      const corner = cornerSpeed(vs, v, upcoming.angle);
      const brakingDistance = Math.max(0, distanceToNode - upcoming.radiusIn);
      const allowable = Math.sqrt(Math.max(0, corner * corner + 2 * Math.max(1.2, vs.bComf[v]) * brakingDistance));
      cap = Math.min(cap, allowable);
    }
  }
  return cap;
}

function scratchFor(self: AnyTraffic, capacity: number): UpdateScratch {
  let scratch = scratchByTraffic.get(self as object);
  if (!scratch || scratch.savedMaxSpeed.length !== capacity) {
    scratch = {
      savedMaxSpeed: new Float32Array(capacity),
      edgeBefore: new Int32Array(capacity),
      touched: new Uint8Array(capacity),
    };
    scratchByTraffic.set(self as object, scratch);
  }
  return scratch;
}

// Replace the old position-on-straight-edge + delayed-heading model. Traffic occupancy remains
// edge-based, but the world/render pose follows the same continuous turn curve as the heading.
proto.updateWorldPos = function updateWorldPosWithCornerArc(this: AnyTraffic, v: number): void {
  const vs = this.vs as VehicleStore;
  const pose = curvedPose(this, v) ?? linearPose(this, v);
  if (!pose) return;
  vs.posX[v] = pose.x;
  vs.posZ[v] = pose.z;
  vs.heading[v] = pose.heading;
};

// Apply a temporary speed target around the upcoming corner. The original IDM/signal logic still
// computes acceleration and following gaps; only its free-road target is lowered during a turn.
proto.update = function updateWithCornerSpeed(this: AnyTraffic, dt: number): void {
  const vs = this.vs as VehicleStore;
  const scratch = scratchFor(this, vs.capacity);
  for (let v = 0; v < vs.count; v++) {
    scratch.touched[v] = 0;
    if (vs.state[v] !== VehicleState.Driving) continue;
    const roadSpeed = vs.maxSpeed[v];
    const cap = turnSpeedCap(this, v, roadSpeed);
    if (cap >= roadSpeed - 0.05) continue;
    scratch.touched[v] = 1;
    scratch.savedMaxSpeed[v] = roadSpeed;
    scratch.edgeBefore[v] = vs.edge[v];
    // Prevent IDM from demanding an unrealistic one-frame brake when a fast vehicle first sees
    // the turn. The target then converges toward the corner speed over subsequent simulation steps.
    const softFloor = vs.speed[v] > cap ? vs.speed[v] / 1.20 : cap;
    vs.maxSpeed[v] = Math.min(roadSpeed, Math.max(cap, softFloor));
  }

  previousUpdate.call(this, dt);

  for (let v = 0; v < vs.count; v++) {
    if (!scratch.touched[v]) continue;
    if (vs.edge[v] === scratch.edgeBefore[v]) vs.maxSpeed[v] = scratch.savedMaxSpeed[v];
    scratch.touched[v] = 0;
  }
};
