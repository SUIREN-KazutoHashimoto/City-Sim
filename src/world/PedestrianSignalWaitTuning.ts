import { AgentState } from '../agents/AgentStore';
import type { SidewalkEdge } from '../traffic/SidewalkNetwork';
import { World } from './World';

type AnyWorld = any;
type AnyMethod = (...args: any[]) => any;

interface CrossingCandidate {
  roadNode: number;
  axis: 0 | 1;
  entryX: number;
  entryZ: number;
  cursor: number;
}

interface WaitRuntime {
  node: Int32Array;
  axis: Uint8Array;
  cursor: Uint16Array;
  x: Float32Array;
  z: Float32Array;
}

const runtimeByWorld = new WeakMap<object, WaitRuntime>();

function runtime(world: AnyWorld): WaitRuntime {
  let rt = runtimeByWorld.get(world as object);
  if (rt) return rt;
  rt = {
    node: new Int32Array(world.store.capacity).fill(-1),
    axis: new Uint8Array(world.store.capacity).fill(255),
    cursor: new Uint16Array(world.store.capacity),
    x: new Float32Array(world.store.capacity),
    z: new Float32Array(world.store.capacity),
  };
  runtimeByWorld.set(world as object, rt);
  return rt;
}

function candidate(world: AnyWorld, agent: number): CrossingCandidate | null {
  const s = world.store;
  const path = world.walkPaths[agent] as Int32Array | undefined;
  if (!path || s.pathHandle[agent] <= 0 || path.length < 2) return null;
  const cursor = s.pathCursor[agent];
  if (cursor + 1 >= path.length) return null;
  const edge = world.sidewalk.edgeBetween(path[cursor], path[cursor + 1]) as SidewalkEdge | undefined;
  if (!edge?.crossing) return null;
  const entry = world.sidewalk.nodes[path[cursor]];
  const exit = world.sidewalk.nodes[path[cursor + 1]];
  const roadNode = entry?.roadNode >= 0 ? entry.roadNode : exit?.roadNode ?? -1;
  if (!entry || roadNode < 0) return null;
  return { roadNode, axis: edge.axis, entryX: entry.x, entryZ: entry.z, cursor };
}

function movingState(state: number): boolean {
  return state === AgentState.Traveling || state === AgentState.ToVehicle || state === AgentState.ToBusStop;
}

function blocked(world: AnyWorld, crossing: CrossingCandidate): boolean {
  const signalized = world.signals.modeOf(crossing.roadNode) !== null;
  const red = signalized && !world.signals.pedWalk(crossing.roadNode, crossing.axis);
  return red || world.vehBlock[crossing.roadNode] === 1;
}

function clear(rt: WaitRuntime, agent: number): void {
  rt.node[agent] = -1;
  rt.axis[agent] = 255;
  rt.cursor[agent] = 0;
}

function stop(world: AnyWorld, agent: number): void {
  world.store.waiting[agent] = 1;
  world.store.velX[agent] = 0;
  world.store.velZ[agent] = 0;
}

const proto = World.prototype as unknown as Record<string, any>;
if (!proto.__citySimPedestrianSignalWaitV081) {
  const previousWalkStep = proto.walkStep as AnyMethod;
  proto.walkStep = function walkStepWithCommittedSignalWait(this: AnyWorld, agent: number, dt: number, deferMovement: boolean): void {
    const rt = runtime(this);
    const s = this.store;
    if (!movingState(s.state[agent])) clear(rt, agent);

    if (rt.node[agent] >= 0) {
      const current = candidate(this, agent);
      if (!current || current.roadNode !== rt.node[agent] || s.pathCursor[agent] !== rt.cursor[agent]) {
        clear(rt, agent);
      } else if (blocked(this, current)) {
        stop(this, agent);
        return;
      } else {
        clear(rt, agent);
      }
    }

    const crossing = candidate(this, agent);
    if (crossing && blocked(this, crossing)) {
      const dx = crossing.entryX - s.posX[agent], dz = crossing.entryZ - s.posZ[agent];
      const distance = Math.hypot(dx, dz);
      const WAIT_DISTANCE = 1.15;
      if (distance > WAIT_DISTANCE + 0.05) {
        // Keep the route and approach the curb even while the pedestrian signal is red. The older
        // safety layer stopped at 6m, which looked like abandoning the crossing.
        const step = Math.min(Math.max(0, distance - WAIT_DISTANCE), s.maxSpeed[agent] * dt);
        if (distance > 1e-4 && step > 0) {
          const ux = dx / distance, uz = dz / distance;
          s.posX[agent] += ux * step;
          s.posZ[agent] += uz * step;
          s.velX[agent] = ux * (step / Math.max(1e-4, dt));
          s.velZ[agent] = uz * (step / Math.max(1e-4, dt));
          s.heading[agent] = Math.atan2(uz, ux);
          s.waiting[agent] = 0;
        }
        return;
      }
      rt.node[agent] = crossing.roadNode;
      rt.axis[agent] = crossing.axis;
      rt.cursor[agent] = crossing.cursor;
      rt.x[agent] = crossing.entryX;
      rt.z[agent] = crossing.entryZ;
      stop(this, agent);
      return;
    }

    previousWalkStep.call(this, agent, dt, deferMovement);
  };
  proto.__citySimPedestrianSignalWaitV081 = true;
}
