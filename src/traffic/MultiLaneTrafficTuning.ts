import { roadWidth, crosswalkSetback, CROSSWALK_DEPTH, type RoadNetwork } from './RoadNetwork';
import { TrafficSystem } from './TrafficSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';

export interface VehicleLaneInfo {
  lane: number;
  lanes: number;
  offset: number;
}

type AnyTraffic = any;
type AnyMethod = (...args: any[]) => any;

interface LaneRuntime {
  lane: Uint8Array;
  lanes: Uint8Array;
  assigned: Uint8Array;
}

interface LaneScratch {
  activeEdges: number[];
  edgeLanes: Array<number[][] | undefined>;
}

const runtimeByVehicles = new WeakMap<VehicleStore, LaneRuntime>();
const scratchByTraffic = new WeakMap<object, LaneScratch>();
const LANE_WIDTH = 3.5;

function laneRuntime(vs: VehicleStore): LaneRuntime {
  let runtime = runtimeByVehicles.get(vs);
  if (runtime) return runtime;
  runtime = {
    lane: new Uint8Array(vs.capacity),
    lanes: new Uint8Array(vs.capacity),
    assigned: new Uint8Array(vs.capacity),
  };
  runtimeByVehicles.set(vs, runtime);
  return runtime;
}

function laneScratch(self: AnyTraffic): LaneScratch {
  let scratch = scratchByTraffic.get(self as object);
  const edgeCount = (self.net as RoadNetwork).edges.length;
  if (!scratch || scratch.edgeLanes.length !== edgeCount) {
    scratch = { activeEdges: [], edgeLanes: new Array(edgeCount) };
    scratchByTraffic.set(self as object, scratch);
  }
  return scratch;
}

function clampLane(lane: number, lanes: number): number {
  return Math.max(0, Math.min(Math.max(0, lanes - 1), Math.trunc(lane)));
}

/** lane 0 = centre-line side, highest lane = curb/outside side. */
export function laneCenterOffset(lanes: number, lane: number): number {
  const count = Math.max(1, Math.trunc(lanes));
  return LANE_WIDTH * (clampLane(lane, count) + 0.5);
}

function turnLane(self: AnyTraffic, v: number, lanes: number): number | null {
  if (lanes <= 1) return 0;
  const vs = self.vs as VehicleStore;
  const net = self.net as RoadNetwork;
  const path = vs.paths[v];
  const cursor = vs.pathCursor[v];
  if (!path || cursor <= 0 || cursor + 1 >= path.length) return null;

  const a = net.nodes[path[cursor - 1]];
  const b = net.nodes[path[cursor]];
  const c = net.nodes[path[cursor + 1]];
  if (!a || !b || !c) return null;
  const inX = b.x - a.x, inZ = b.z - a.z;
  const outX = c.x - b.x, outZ = c.z - b.z;
  const inLen = Math.hypot(inX, inZ), outLen = Math.hypot(outX, outZ);
  if (inLen < 1 || outLen < 1) return null;
  const dot = (inX * outX + inZ * outZ) / (inLen * outLen);
  const cross = (inX * outZ - inZ * outX) / (inLen * outLen);
  if (dot < -0.55) return 0;
  if (Math.abs(cross) < 0.24) return null;
  return cross > 0 ? 0 : lanes - 1;
}

function stableLane(v: number, edgeId: number, lanes: number): number {
  let x = (Math.imul(v + 1, 0x9e3779b1) ^ Math.imul(edgeId + 1, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16;
  return lanes > 0 ? x % lanes : 0;
}

function chooseLane(self: AnyTraffic, v: number, oldLane: number, oldLanes: number): number {
  const vs = self.vs as VehicleStore;
  const net = self.net as RoadNetwork;
  const edgeId = vs.edge[v];
  const edge = edgeId >= 0 ? net.edges[edgeId] : null;
  const lanes = Math.max(1, edge?.lanes ?? 1);
  if (lanes <= 1) return 0;

  const forcedTurnLane = turnLane(self, v, lanes);
  if (forcedTurnLane != null) return forcedTurnLane;

  if (vs.isBus[v] || vs.isTruck[v]) return lanes - 1;

  if (oldLanes > 1) {
    const normalized = clampLane(oldLane, oldLanes) / Math.max(1, oldLanes - 1);
    return clampLane(Math.round(normalized * (lanes - 1)), lanes);
  }
  return stableLane(v, edgeId, lanes);
}

function assignCurrentLane(self: AnyTraffic, v: number, oldLane = 0, oldLanes = 1): void {
  const vs = self.vs as VehicleStore;
  const runtime = laneRuntime(vs);
  const edge = vs.edge[v] >= 0 ? (self.net as RoadNetwork).edges[vs.edge[v]] : null;
  const lanes = Math.max(1, edge?.lanes ?? 1);
  runtime.lane[v] = chooseLane(self, v, oldLane, oldLanes);
  runtime.lanes[v] = lanes;
  runtime.assigned[v] = 1;
}

function ensureLane(self: AnyTraffic, v: number): VehicleLaneInfo {
  const vs = self.vs as VehicleStore;
  const runtime = laneRuntime(vs);
  const edge = vs.edge[v] >= 0 ? (self.net as RoadNetwork).edges[vs.edge[v]] : null;
  const lanes = Math.max(1, edge?.lanes ?? 1);
  if (!runtime.assigned[v] || runtime.lanes[v] !== lanes || runtime.lane[v] >= lanes) {
    assignCurrentLane(self, v, runtime.lane[v], Math.max(1, runtime.lanes[v] || 1));
  }
  const lane = clampLane(runtime.lane[v], lanes);
  return { lane, lanes, offset: laneCenterOffset(lanes, lane) };
}

export function vehicleLaneInfo(vs: VehicleStore, vehicle: number): VehicleLaneInfo | null {
  const runtime = runtimeByVehicles.get(vs);
  if (!runtime || vehicle < 0 || vehicle >= vs.count || runtime.assigned[vehicle] !== 1) return null;
  const lanes = Math.max(1, runtime.lanes[vehicle] || 1);
  const lane = clampLane(runtime.lane[vehicle], lanes);
  return { lane, lanes, offset: laneCenterOffset(lanes, lane) };
}

function rebuildLaneOccupants(self: AnyTraffic): LaneScratch {
  const net = self.net as RoadNetwork;
  const vs = self.vs as VehicleStore;
  const scratch = laneScratch(self);

  for (const edgeId of scratch.activeEdges) {
    const groups = scratch.edgeLanes[edgeId];
    if (groups) for (const group of groups) group.length = 0;
    scratch.edgeLanes[edgeId] = undefined;
    net.edges[edgeId].occupants.length = 0;
  }
  scratch.activeEdges.length = 0;

  for (let v = 0; v < vs.count; v++) {
    if (vs.state[v] !== VehicleState.Driving) continue;
    const edgeId = vs.edge[v];
    if (edgeId < 0 || edgeId >= net.edges.length) continue;
    const info = ensureLane(self, v);
    let groups = scratch.edgeLanes[edgeId];
    if (!groups) {
      groups = Array.from({ length: info.lanes }, () => [] as number[]);
      scratch.edgeLanes[edgeId] = groups;
      scratch.activeEdges.push(edgeId);
    }
    while (groups.length < info.lanes) groups.push([]);
    groups[info.lane].push(v);
    net.edges[edgeId].occupants.push(v);
  }

  for (const edgeId of scratch.activeEdges) {
    const groups = scratch.edgeLanes[edgeId];
    if (!groups) continue;
    for (const group of groups) group.sort((a, b) => vs.segT[a] - vs.segT[b]);
    net.edges[edgeId].occupants.sort((a, b) => vs.segT[a] - vs.segT[b]);
  }
  return scratch;
}

const proto = TrafficSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimMultiLaneV073) {
  const previousEnterEdge = proto.enterEdge as AnyMethod;
  proto.enterEdge = function enterEdgeWithLane(this: AnyTraffic, v: number, from: number, to: number): void {
    const vs = this.vs as VehicleStore;
    const runtime = laneRuntime(vs);
    const oldLane = runtime.lane[v] ?? 0;
    const oldLanes = Math.max(1, runtime.lanes[v] || 1);
    previousEnterEdge.call(this, v, from, to);
    assignCurrentLane(this, v, oldLane, oldLanes);
  };

  const previousPlaceAtEdgePoint = proto.placeAtEdgePoint as AnyMethod;
  proto.placeAtEdgePoint = function placeAtEdgePointWithLane(this: AnyTraffic, ...args: any[]): boolean {
    const vehicle = Number(args[0]);
    const ok = previousPlaceAtEdgePoint.apply(this, args) as boolean;
    if (ok && Number.isFinite(vehicle)) assignCurrentLane(this, vehicle, 0, 1);
    return ok;
  };

  proto.updateWorldPos = function updateWorldPosWithActualLane(this: AnyTraffic, v: number): void {
    const vs = this.vs as VehicleStore;
    const net = this.net as RoadNetwork;
    const nf = net.nodes[vs.fromNode[v]], nt = net.nodes[vs.toNode[v]];
    if (!nf || !nt) return;
    const t = vs.segT[v];
    let dx = nt.x - nf.x, dz = nt.z - nf.z;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length; dz /= length;
    const rx = dz, rz = -dx;
    const info = ensureLane(this, v);
    const cx = nf.x + (nt.x - nf.x) * t;
    const cz = nf.z + (nt.z - nf.z) * t;
    vs.posX[v] = cx + rx * info.offset;
    vs.posZ[v] = cz + rz * info.offset;
    const targetHeading = Math.atan2(dz, dx);
    vs.heading[v] = this.visualHeading(v, targetHeading);
  };

  proto.update = function updateWithLaneSeparatedTraffic(this: AnyTraffic, dt: number): void {
    const vs = this.vs as VehicleStore;
    const net = this.net as RoadNetwork;
    const scratch = rebuildLaneOccupants(this);

    for (const edgeId of scratch.activeEdges) {
      const edge = net.edges[edgeId];
      const groups = scratch.edgeLanes[edgeId];
      if (!groups) continue;

      for (const occ of groups) {
        for (let k = 0; k < occ.length; k++) {
          const v = occ[k];
          if (vs.state[v] !== VehicleState.Driving) continue;
          const isTerminal = vs.pathCursor[v] + 1 >= vs.paths[v].length;
          const terminalT = isTerminal ? Math.max(0.02, Math.min(1, this.arrivalT[v] || 1)) : 1;
          const remaining = (terminalT - vs.segT[v]) * vs.segLen[v];
          if (isTerminal && remaining <= 0.55) { this.arrive(v, terminalT); continue; }

          let gapLead = Infinity, leadSpeed = 0;
          if (k + 1 < occ.length) {
            const lead = occ[k + 1];
            gapLead = (vs.segT[lead] - vs.segT[v]) * vs.segLen[v] - vs.length[lead];
            leadSpeed = vs.speed[lead];
          }

          let gapStop = Infinity;
          if (isTerminal) gapStop = Math.max(0.1, remaining + vs.s0[v]);
          else {
            const axis = net.axisOf(vs.fromNode[v], vs.toNode[v]);
            const redOrPed = !this.signals.vehicleGreen(vs.toNode[v], axis)
              || (this.pedBlockedFn ? this.pedBlockedFn(vs.toNode[v]) : false);
            if (redOrPed) {
              const rw = roadWidth(edge?.lanes ?? 1);
              const stopOffset = crosswalkSetback(rw) + CROSSWALK_DEPTH * 0.5 + 0.8 + vs.length[v] * 0.5;
              const toStopLine = (1 - vs.segT[v]) * vs.segLen[v] - stopOffset;
              if (toStopLine > 0.5) gapStop = toStopLine;
            }
          }

          const aLead = this.idm(v, Math.max(0.1, gapLead), leadSpeed);
          const aStop = gapStop < Infinity ? this.idm(v, Math.max(0.1, gapStop), 0) : aLead;
          const accel = Math.min(aLead, aStop);
          vs.accel[v] = accel;
          vs.speed[v] = Math.max(0, vs.speed[v] + accel * dt);
          const nextT = vs.segT[v] + (vs.speed[v] * dt) / vs.segLen[v];
          if (isTerminal && nextT >= terminalT) { this.arrive(v, terminalT); continue; }
          vs.segT[v] = nextT;
          if (vs.segT[v] >= 1) this.advanceEdge(v);
          this.updateWorldPos(v);
        }
      }
    }
  };

  proto.__citySimMultiLaneV073 = true;
}
