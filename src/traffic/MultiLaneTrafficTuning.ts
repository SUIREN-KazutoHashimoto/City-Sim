import { roadWidth, crosswalkSetback, CROSSWALK_DEPTH, type RoadNetwork } from './RoadNetwork';
import { TrafficSystem } from './TrafficSystem';
import { VehicleState, type VehicleStore } from './VehicleStore';
import { setLaneChangeSignal } from './VehicleSignalRuntime';

export interface VehicleLaneInfo {
  lane: number;
  lanes: number;
  offset: number;
  changing: boolean;
  targetLane: number;
  progress: number;
}

type AnyTraffic = any;
type AnyMethod = (...args: any[]) => any;

interface LaneRuntime {
  lane: Uint8Array;
  lanes: Uint8Array;
  assigned: Uint8Array;
  targetLane: Uint8Array;
  changing: Uint8Array;
  progress: Float32Array;
}

interface LaneScratch {
  activeEdges: number[];
  edgeLanes: Array<number[][] | undefined>;
}

const runtimeByVehicles = new WeakMap<VehicleStore, LaneRuntime>();
const scratchByTraffic = new WeakMap<object, LaneScratch>();
const LANE_WIDTH = 3.5;
const CHANGE_SECONDS = 2.2;

function laneRuntime(vs: VehicleStore): LaneRuntime {
  let runtime = runtimeByVehicles.get(vs);
  if (runtime) return runtime;
  runtime = {
    lane: new Uint8Array(vs.capacity),
    lanes: new Uint8Array(vs.capacity),
    assigned: new Uint8Array(vs.capacity),
    targetLane: new Uint8Array(vs.capacity),
    changing: new Uint8Array(vs.capacity),
    progress: new Float32Array(vs.capacity),
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

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
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

function nextEdgeLanes(self: AnyTraffic, v: number): number | null {
  const vs = self.vs as VehicleStore;
  const net = self.net as RoadNetwork;
  const path = vs.paths[v];
  const cursor = vs.pathCursor[v];
  if (!path || cursor < 0 || cursor + 1 >= path.length) return null;
  const edge = net.edgeBetween(path[cursor], path[cursor + 1]);
  return edge ? Math.max(1, edge.lanes) : null;
}

function stableLane(v: number, edgeId: number, lanes: number): number {
  let x = (Math.imul(v + 1, 0x9e3779b1) ^ Math.imul(edgeId + 1, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16;
  return lanes > 0 ? x % lanes : 0;
}

function initialLane(self: AnyTraffic, v: number, lanes: number): number {
  const vs = self.vs as VehicleStore;
  if (lanes <= 1) return 0;
  if (vs.isBus[v] || vs.isTruck[v]) return lanes - 1;
  return stableLane(v, vs.edge[v], lanes);
}

function desiredLane(self: AnyTraffic, v: number, lane: number, lanes: number): number {
  if (lanes <= 1) return 0;
  const forcedTurnLane = turnLane(self, v, lanes);
  if (forcedTurnLane != null) return forcedTurnLane;

  const nextLanes = nextEdgeLanes(self, v);
  if (nextLanes != null && nextLanes < lanes && lane >= nextLanes) return nextLanes - 1;

  const vs = self.vs as VehicleStore;
  if (vs.isBus[v] || vs.isTruck[v]) return lanes - 1;
  return lane;
}

function assignCurrentLane(self: AnyTraffic, v: number, oldLane = 0, oldLanes = 1, wasAssigned = false): void {
  const vs = self.vs as VehicleStore;
  const runtime = laneRuntime(vs);
  const edge = vs.edge[v] >= 0 ? (self.net as RoadNetwork).edges[vs.edge[v]] : null;
  const lanes = Math.max(1, edge?.lanes ?? 1);

  let lane: number;
  if (!wasAssigned) lane = initialLane(self, v, lanes);
  else {
    const source = clampLane(oldLane, Math.max(1, oldLanes));
    lane = clampLane(source, lanes);
  }

  runtime.lane[v] = lane;
  runtime.lanes[v] = lanes;
  runtime.targetLane[v] = lane;
  runtime.changing[v] = 0;
  runtime.progress[v] = 0;
  runtime.assigned[v] = 1;
  setLaneChangeSignal(vs, v, 0);
}

function actualOffset(runtime: LaneRuntime, v: number): number {
  const lanes = Math.max(1, runtime.lanes[v] || 1);
  const lane = clampLane(runtime.lane[v], lanes);
  if (!runtime.changing[v]) return laneCenterOffset(lanes, lane);
  const target = clampLane(runtime.targetLane[v], lanes);
  const from = laneCenterOffset(lanes, lane);
  const to = laneCenterOffset(lanes, target);
  return from + (to - from) * smoothstep(runtime.progress[v]);
}

function ensureLane(self: AnyTraffic, v: number): VehicleLaneInfo {
  const vs = self.vs as VehicleStore;
  const runtime = laneRuntime(vs);
  const edge = vs.edge[v] >= 0 ? (self.net as RoadNetwork).edges[vs.edge[v]] : null;
  const lanes = Math.max(1, edge?.lanes ?? 1);
  if (!runtime.assigned[v] || runtime.lanes[v] !== lanes || runtime.lane[v] >= lanes) {
    const effectiveOld = runtime.changing[v] && runtime.progress[v] >= 0.5 ? runtime.targetLane[v] : runtime.lane[v];
    assignCurrentLane(self, v, effectiveOld, Math.max(1, runtime.lanes[v] || 1), runtime.assigned[v] === 1);
  }
  const lane = clampLane(runtime.lane[v], lanes);
  const targetLane = runtime.changing[v] ? clampLane(runtime.targetLane[v], lanes) : lane;
  return {
    lane,
    lanes,
    offset: actualOffset(runtime, v),
    changing: runtime.changing[v] === 1,
    targetLane,
    progress: runtime.progress[v],
  };
}

export function vehicleLaneInfo(vs: VehicleStore, vehicle: number): VehicleLaneInfo | null {
  const runtime = runtimeByVehicles.get(vs);
  if (!runtime || vehicle < 0 || vehicle >= vs.count || runtime.assigned[vehicle] !== 1) return null;
  const lanes = Math.max(1, runtime.lanes[vehicle] || 1);
  const lane = clampLane(runtime.lane[vehicle], lanes);
  const targetLane = runtime.changing[vehicle] ? clampLane(runtime.targetLane[vehicle], lanes) : lane;
  return {
    lane,
    lanes,
    offset: actualOffset(runtime, vehicle),
    changing: runtime.changing[vehicle] === 1,
    targetLane,
    progress: runtime.progress[vehicle],
  };
}

function advanceLaneChanges(self: AnyTraffic, dt: number): void {
  const vs = self.vs as VehicleStore;
  const runtime = laneRuntime(vs);
  for (let v = 0; v < vs.count; v++) {
    if (!runtime.changing[v]) continue;
    if (vs.state[v] !== VehicleState.Driving) {
      runtime.changing[v] = 0;
      runtime.progress[v] = 0;
      runtime.targetLane[v] = runtime.lane[v];
      setLaneChangeSignal(vs, v, 0);
      continue;
    }
    if (vs.speed[v] > 0.5) runtime.progress[v] = Math.min(1, runtime.progress[v] + dt / CHANGE_SECONDS);
    if (runtime.progress[v] < 1) continue;
    runtime.lane[v] = runtime.targetLane[v];
    runtime.changing[v] = 0;
    runtime.progress[v] = 0;
    setLaneChangeSignal(vs, v, 0);
  }
}

function rebuildLaneOccupants(self: AnyTraffic): LaneScratch {
  const net = self.net as RoadNetwork;
  const vs = self.vs as VehicleStore;
  const runtime = laneRuntime(vs);
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
    if (runtime.changing[v] && info.targetLane !== info.lane) groups[info.targetLane].push(v);
    net.edges[edgeId].occupants.push(v);
  }

  for (const edgeId of scratch.activeEdges) {
    const groups = scratch.edgeLanes[edgeId];
    if (!groups) continue;
    for (const group of groups) group.sort((a: number, b: number) => vs.segT[a] - vs.segT[b]);
    net.edges[edgeId].occupants.sort((a: number, b: number) => vs.segT[a] - vs.segT[b]);
  }
  return scratch;
}

function safeToEnterLane(self: AnyTraffic, v: number, targetLane: number, groups: number[][]): boolean {
  const vs = self.vs as VehicleStore;
  const target = groups[targetLane] ?? [];
  const t = vs.segT[v];
  let ahead = Infinity, behind = Infinity, behindSpeed = 0;
  for (const other of target) {
    if (other === v || vs.state[other] !== VehicleState.Driving) continue;
    const delta = (vs.segT[other] - t) * vs.segLen[v];
    if (delta >= 0 && delta < ahead) ahead = delta - vs.length[other];
    if (delta < 0 && -delta < behind) { behind = -delta - vs.length[v]; behindSpeed = vs.speed[other]; }
  }
  const needAhead = Math.max(8, vs.speed[v] * 1.15);
  const needBehind = Math.max(7, behindSpeed * 0.95);
  return ahead > needAhead && behind > needBehind;
}

function startNeededLaneChanges(self: AnyTraffic, scratch: LaneScratch): void {
  const vs = self.vs as VehicleStore;
  const runtime = laneRuntime(vs);
  for (let v = 0; v < vs.count; v++) {
    if (vs.state[v] !== VehicleState.Driving || runtime.changing[v]) continue;
    const edgeId = vs.edge[v];
    if (edgeId < 0) continue;
    const lanes = Math.max(1, runtime.lanes[v] || 1);
    if (lanes <= 1) continue;
    const lane = clampLane(runtime.lane[v], lanes);
    const wanted = clampLane(desiredLane(self, v, lane, lanes), lanes);
    if (wanted === lane) continue;

    // One maneuver may only move to an adjacent lane. If the final target is two lanes away,
    // a second independent maneuver can begin only after this one has fully completed.
    const target = lane + (wanted > lane ? 1 : -1);
    const groups = scratch.edgeLanes[edgeId];
    if (!groups || !safeToEnterLane(self, v, target, groups)) continue;

    runtime.targetLane[v] = target;
    runtime.changing[v] = 1;
    runtime.progress[v] = 0;
    // lane index grows toward the curb/right side; renderer sign convention is +1=left, -1=right.
    setLaneChangeSignal(vs, v, target < lane ? 1 : -1);
    if (!groups[target].includes(v)) {
      groups[target].push(v);
      groups[target].sort((a: number, b: number) => vs.segT[a] - vs.segT[b]);
    }
  }
}

function leadInGroup(vs: VehicleStore, group: number[], vehicle: number): { gap: number; speed: number } {
  const index = group.indexOf(vehicle);
  if (index < 0 || index + 1 >= group.length) return { gap: Infinity, speed: 0 };
  const lead = group[index + 1];
  return {
    gap: (vs.segT[lead] - vs.segT[vehicle]) * vs.segLen[vehicle] - vs.length[lead],
    speed: vs.speed[lead],
  };
}

const proto = TrafficSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimMultiLaneV074) {
  const previousEnterEdge = proto.enterEdge as AnyMethod;
  proto.enterEdge = function enterEdgeWithLane(this: AnyTraffic, v: number, from: number, to: number): void {
    const vs = this.vs as VehicleStore;
    const runtime = laneRuntime(vs);
    const wasAssigned = runtime.assigned[v] === 1;
    const effectiveOld = runtime.changing[v] && runtime.progress[v] >= 0.5 ? runtime.targetLane[v] : runtime.lane[v];
    const oldLanes = Math.max(1, runtime.lanes[v] || 1);
    previousEnterEdge.call(this, v, from, to);
    assignCurrentLane(this, v, effectiveOld, oldLanes, wasAssigned);
  };

  const previousPlaceAtEdgePoint = proto.placeAtEdgePoint as AnyMethod;
  proto.placeAtEdgePoint = function placeAtEdgePointWithLane(this: AnyTraffic, ...args: any[]): boolean {
    const vehicle = Number(args[0]);
    const ok = previousPlaceAtEdgePoint.apply(this, args) as boolean;
    if (ok && Number.isFinite(vehicle)) assignCurrentLane(this, vehicle, 0, 1, false);
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

    const baseHeading = Math.atan2(dz, dx);
    if (info.changing) {
      const runtime = laneRuntime(vs);
      const from = laneCenterOffset(info.lanes, info.lane);
      const to = laneCenterOffset(info.lanes, info.targetLane);
      const p = Math.max(0, Math.min(1, runtime.progress[v]));
      const lateralSlope = ((to - from) / Math.max(18, vs.speed[v] * CHANGE_SECONDS)) * (6 * p * (1 - p));
      vs.heading[v] = Math.atan2(dz + rz * lateralSlope, dx + rx * lateralSlope);
    } else {
      vs.heading[v] = this.visualHeading(v, baseHeading);
    }
  };

  proto.update = function updateWithLaneSeparatedTraffic(this: AnyTraffic, dt: number): void {
    const vs = this.vs as VehicleStore;
    const net = this.net as RoadNetwork;
    const runtime = laneRuntime(vs);
    advanceLaneChanges(this, dt);
    const scratch = rebuildLaneOccupants(this);
    startNeededLaneChanges(this, scratch);

    for (const edgeId of scratch.activeEdges) {
      const edge = net.edges[edgeId];
      const groups = scratch.edgeLanes[edgeId];
      if (!groups) continue;

      for (let laneIndex = 0; laneIndex < groups.length; laneIndex++) {
        const occ: number[] = groups[laneIndex];
        for (let k = 0; k < occ.length; k++) {
          const v = occ[k];
          if (vs.state[v] !== VehicleState.Driving) continue;
          if (runtime.lane[v] !== laneIndex) continue; // a changing vehicle is also a blocker in target lane, but updates once.

          const isTerminal = vs.pathCursor[v] + 1 >= vs.paths[v].length;
          const terminalT = isTerminal ? Math.max(0.02, Math.min(1, this.arrivalT[v] || 1)) : 1;
          const remaining = (terminalT - vs.segT[v]) * vs.segLen[v];
          if (isTerminal && remaining <= 0.55) { this.arrive(v, terminalT); continue; }

          let lead = leadInGroup(vs, occ, v);
          if (runtime.changing[v]) {
            const targetLane = runtime.targetLane[v];
            const targetGroup = groups[targetLane];
            if (targetGroup) {
              const targetLead = leadInGroup(vs, targetGroup, v);
              if (targetLead.gap < lead.gap) lead = targetLead;
            }
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

          const aLead = this.idm(v, Math.max(0.1, lead.gap), lead.speed);
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

  proto.__citySimMultiLaneV074 = true;
}
