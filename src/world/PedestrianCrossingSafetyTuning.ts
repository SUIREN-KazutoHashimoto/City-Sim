import { AgentState } from '../agents/AgentStore';
import { roadWidth, crosswalkSetback, CROSSWALK_DEPTH } from '../traffic/RoadNetwork';
import type { SidewalkEdge } from '../traffic/SidewalkNetwork';
import { VehicleState } from '../traffic/VehicleStore';
import { World } from './World';

type AnyWorld = any;
type AnyMethod = (...args: any[]) => any;

interface CrossingCandidate {
  roadNode: number;
  axis: 0 | 1;
  edge: SidewalkEdge;
  entryX: number;
  entryZ: number;
  endCursor: number;
}

interface CrossingRuntime {
  activeNode: Int32Array;
  activeEndCursor: Uint16Array;
  activeAgents: Set<number>;
}

const runtimeByWorld = new WeakMap<object, CrossingRuntime>();

function runtime(world: AnyWorld): CrossingRuntime {
  let value = runtimeByWorld.get(world as object);
  if (value) return value;
  value = {
    activeNode: new Int32Array(world.store.capacity).fill(-1),
    activeEndCursor: new Uint16Array(world.store.capacity),
    activeAgents: new Set<number>(),
  };
  runtimeByWorld.set(world as object, value);
  return value;
}

function currentCrossing(world: AnyWorld, agent: number): CrossingCandidate | null {
  const s = world.store;
  const path = world.walkPaths[agent] as Int32Array | undefined;
  if (!path || s.pathHandle[agent] <= 0 || path.length < 2) return null;
  const cursor = s.pathCursor[agent];
  if (cursor + 1 >= path.length) return null;
  const edge = world.sidewalk.edgeBetween(path[cursor], path[cursor + 1]) as SidewalkEdge | undefined;
  if (!edge || !edge.crossing) return null;
  const entry = world.sidewalk.nodes[path[cursor]];
  const exit = world.sidewalk.nodes[path[cursor + 1]];
  const roadNode = entry?.roadNode >= 0 ? entry.roadNode : exit?.roadNode ?? -1;
  if (roadNode < 0 || !entry) return null;
  return { roadNode, axis: edge.axis, edge, entryX: entry.x, entryZ: entry.z, endCursor: cursor + 1 };
}

function clearActive(world: AnyWorld, agent: number): void {
  const rt = runtime(world);
  rt.activeNode[agent] = -1;
  rt.activeEndCursor[agent] = 0;
  rt.activeAgents.delete(agent);
}

function markActive(world: AnyWorld, agent: number, crossing: CrossingCandidate): void {
  const rt = runtime(world);
  rt.activeNode[agent] = crossing.roadNode;
  rt.activeEndCursor[agent] = crossing.endCursor;
  rt.activeAgents.add(agent);
}

function markPedBlock(world: AnyWorld, roadNode: number): void {
  if (roadNode < 0 || roadNode >= world.pedBlock.length || world.pedBlock[roadNode] === 1) return;
  world.pedBlock[roadNode] = 1;
  world.pedBlockedNodes.push(roadNode);
}

function markVehBlock(world: AnyWorld, roadNode: number): void {
  if (roadNode < 0 || roadNode >= world.vehBlock.length || world.vehBlock[roadNode] === 1) return;
  world.vehBlock[roadNode] = 1;
  world.vehBlockedNodes.push(roadNode);
}

function pedestrianCanEnter(world: AnyWorld, crossing: CrossingCandidate): boolean {
  const signalized = world.signals.modeOf(crossing.roadNode) !== null;
  if (signalized && !world.signals.pedWalk(crossing.roadNode, crossing.axis)) return false;
  return world.vehBlock[crossing.roadNode] !== 1;
}

const proto = World.prototype as unknown as Record<string, any>;
if (!proto.__citySimPedestrianCrossingSafetyV074) {
  // Rebuild vehicle/pedestrian conflict flags with crossing occupancy that persists for the whole
  // crossing, not just while the pedestrian is approaching the first curb node.
  proto.computePedBlocks = function computePedBlocksSafely(this: AnyWorld): void {
    for (let i = 0; i < this.pedBlockedNodes.length; i++) this.pedBlock[this.pedBlockedNodes[i]] = 0;
    for (let i = 0; i < this.vehBlockedNodes.length; i++) this.vehBlock[this.vehBlockedNodes[i]] = 0;
    this.pedBlockedNodes.length = 0;
    this.vehBlockedNodes.length = 0;

    const vs = this.vehicles;
    const net = this.city.net;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving) continue;
      const edge = vs.edge[v] >= 0 ? net.edges[vs.edge[v]] : null;
      const lanes = Math.max(1, edge?.lanes ?? 1);
      const rw = roadWidth(lanes);
      // Only vehicles that have actually entered the crosswalk/intersection conflict zone block
      // pedestrian entry. A vehicle correctly stopped at the stop line must not deadlock pedestrians.
      const conflictDistance = crosswalkSetback(rw) + CROSSWALK_DEPTH * 0.5 + vs.length[v] * 0.5;
      const toDistance = Math.max(0, (1 - vs.segT[v]) * vs.segLen[v]);
      const fromDistance = Math.max(0, vs.segT[v] * vs.segLen[v]);
      if (toDistance < conflictDistance) markVehBlock(this, vs.toNode[v]);
      if (fromDistance < conflictDistance) markVehBlock(this, vs.fromNode[v]);
    }

    const rt = runtime(this);
    for (const agent of [...rt.activeAgents]) {
      if (agent < 0 || agent >= this.store.count) { clearActive(this, agent); continue; }
      const state = this.store.state[agent];
      const moving = state === AgentState.Traveling || state === AgentState.ToVehicle || state === AgentState.ToBusStop;
      if (!moving || this.store.pathCursor[agent] > rt.activeEndCursor[agent]) {
        clearActive(this, agent);
        continue;
      }
      markPedBlock(this, rt.activeNode[agent]);
    }

    this.forEachMovingPedestrian((agent: number) => {
      if (rt.activeNode[agent] >= 0) return;
      const crossing = currentCrossing(this, agent);
      if (!crossing) return;
      const d = Math.hypot(this.store.posX[agent] - crossing.entryX, this.store.posZ[agent] - crossing.entryZ);
      if (d > 6) return;
      if (!pedestrianCanEnter(this, crossing)) return;
      // The pedestrian is committed to a permitted crossing; approaching vehicles must yield.
      markPedBlock(this, crossing.roadNode);
    });
  };

  const previousWalkStep = proto.walkStep as AnyMethod;
  proto.walkStep = function walkStepWithCrossingGate(this: AnyWorld, agent: number, dt: number, deferMovement: boolean): void {
    const rt = runtime(this);
    if (rt.activeNode[agent] >= 0 && this.store.pathCursor[agent] > rt.activeEndCursor[agent]) clearActive(this, agent);

    const crossing = rt.activeNode[agent] >= 0 ? null : currentCrossing(this, agent);
    if (crossing) {
      const d = Math.hypot(this.store.posX[agent] - crossing.entryX, this.store.posZ[agent] - crossing.entryZ);
      if (d <= 6 && !pedestrianCanEnter(this, crossing)) {
        this.store.waiting[agent] = 1;
        this.store.velX[agent] = 0;
        this.store.velZ[agent] = 0;
        return;
      }
    }

    const oldCursor = this.store.pathCursor[agent];
    previousWalkStep.call(this, agent, dt, deferMovement);

    if (crossing && this.store.pathCursor[agent] > oldCursor) markActive(this, agent, crossing);
    if (rt.activeNode[agent] >= 0 && this.store.pathCursor[agent] > rt.activeEndCursor[agent]) clearActive(this, agent);
  };

  proto.__citySimPedestrianCrossingSafetyV074 = true;
}
