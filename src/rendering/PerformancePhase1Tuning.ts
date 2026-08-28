import type * as THREE from 'three';
import { VehicleState } from '../traffic/VehicleStore';
import { TrafficSystem } from '../traffic/TrafficSystem';
import { EnhancedRenderer } from './EnhancedRenderer';
import { OverlayManager } from './CityDiagnosticOverlay';
import { PerformanceMonitor } from './PerformanceMonitor';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

interface TrafficOccupancyCache { previousEdge: Int32Array; }
interface RenderSyncState {
  agentAt: number; vehicleAt: number; lightingAt: number;
  agentX: number; agentZ: number; vehicleX: number; vehicleZ: number; lightingX: number; lightingZ: number;
}
interface MethodSwitch { host: AnyHost; name: string; wrapped: AnyMethod; base: AnyMethod; }
interface MonitorSwitchState { profiling: boolean; methods: MethodSwitch[]; }

const trafficCaches = new WeakMap<object, TrafficOccupancyCache>();
const renderStates = new WeakMap<object, RenderSyncState>();
const monitorStates = new WeakMap<PerformanceMonitor, MonitorSwitchState>();
const monitors = new Set<PerformanceMonitor>();
let developerDiagnostics = false;

function renderState(host: object): RenderSyncState {
  let state = renderStates.get(host);
  if (!state) {
    state = { agentAt: -Infinity, vehicleAt: -Infinity, lightingAt: -Infinity, agentX: Infinity, agentZ: Infinity, vehicleX: Infinity, vehicleZ: Infinity, lightingX: Infinity, lightingZ: Infinity };
    renderStates.set(host, state);
  }
  return state;
}

function movedEnough(camera: THREE.Vector3 | undefined, x: number, z: number, threshold: number): boolean {
  if (!camera || !Number.isFinite(x) || !Number.isFinite(z)) return true;
  const dx = camera.x - x, dz = camera.z - z; return dx * dx + dz * dz >= threshold * threshold;
}

function insertByProgress(occupants: number[], vehicle: number, segT: Float32Array): void {
  const t = segT[vehicle]; let lo = 0, hi = occupants.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (segT[occupants[mid]] <= t) lo = mid + 1; else hi = mid; }
  occupants.splice(lo, 0, vehicle);
}

function installIncrementalTrafficOccupancy(): void {
  const proto = TrafficSystem.prototype as unknown as AnyHost;
  if (proto.__machiSimIncrementalTrafficOccupancyV116) return;
  const fallback = proto.rebuildOccupants as AnyMethod | undefined; if (typeof fallback !== 'function') return;

  proto.rebuildOccupants = function incrementalRebuildOccupants(this: AnyHost): void {
    const vs = this.vs as { capacity: number; count: number; state: Uint8Array; edge: Int32Array; segT: Float32Array };
    const edges = this.net?.edges as Array<{ occupants: number[] }> | undefined;
    const activeEdges = this.activeEdges as number[] | undefined, edgeSeen = this.edgeSeen as Uint8Array | undefined;
    if (!vs || !edges || !activeEdges || !edgeSeen) { fallback.call(this); return; }

    let cache = trafficCaches.get(this);
    if (!cache || cache.previousEdge.length !== vs.capacity) { cache = { previousEdge: new Int32Array(vs.capacity) }; cache.previousEdge.fill(-1); trafficCaches.set(this, cache); }

    for (let i = 0; i < activeEdges.length; i++) edgeSeen[activeEdges[i]] = 0;
    let activeWrite = 0;
    for (let i = 0; i < activeEdges.length; i++) {
      const edgeId = activeEdges[i], occupants = edges[edgeId]?.occupants; if (!occupants) continue;
      let write = 0;
      for (let k = 0; k < occupants.length; k++) {
        const vehicle = occupants[k];
        if (vehicle >= 0 && vehicle < vs.count && vs.state[vehicle] === VehicleState.Driving && vs.edge[vehicle] === edgeId) occupants[write++] = vehicle;
      }
      occupants.length = write; if (write <= 0) continue;
      let inverted = false; for (let k = 1; k < write; k++) if (vs.segT[occupants[k - 1]] > vs.segT[occupants[k]]) { inverted = true; break; }
      if (inverted) occupants.sort((a, b) => vs.segT[a] - vs.segT[b]);
      edgeSeen[edgeId] = 1; activeEdges[activeWrite++] = edgeId;
    }
    activeEdges.length = activeWrite;

    for (let vehicle = 0; vehicle < vs.count; vehicle++) {
      const edgeId = vs.state[vehicle] === VehicleState.Driving ? vs.edge[vehicle] : -1;
      if (cache.previousEdge[vehicle] === edgeId) continue;
      cache.previousEdge[vehicle] = edgeId; if (edgeId < 0 || !edges[edgeId]) continue;
      if (edgeSeen[edgeId] === 0) { edgeSeen[edgeId] = 1; activeEdges.push(edgeId); }
      const occupants = edges[edgeId].occupants; if (occupants.indexOf(vehicle) < 0) insertByProgress(occupants, vehicle, vs.segT);
    }
  };
  proto.__machiSimIncrementalTrafficOccupancyV116 = true;
}

function installAdaptiveRenderSync(): void {
  const proto = EnhancedRenderer.prototype as unknown as AnyHost;
  if (proto.__machiSimAdaptiveRenderSyncV116) return;
  const previousAgents = proto.syncAgents as AnyMethod | undefined;
  if (typeof previousAgents === 'function') proto.syncAgents = function adaptiveSyncAgents(this: AnyHost, store: { count: number }, simTime = 0, cameraPos?: THREE.Vector3): void {
    if (!cameraPos || store.count < 12_000) { previousAgents.call(this, store, simTime, cameraPos); return; }
    const state = renderState(this), now = performance.now();
    if (now - state.agentAt < 24 && !movedEnough(cameraPos, state.agentX, state.agentZ, 20)) return;
    state.agentAt = now; state.agentX = cameraPos.x; state.agentZ = cameraPos.z; previousAgents.call(this, store, simTime, cameraPos);
  };

  const previousVehicles = proto.syncVehicles as AnyMethod | undefined;
  if (typeof previousVehicles === 'function') proto.syncVehicles = function adaptiveSyncVehicles(this: AnyHost, vehicles: { count: number }, hourF = 12, blinkTime = 0, cameraPos?: THREE.Vector3): void {
    if (!cameraPos || vehicles.count < 4_000) { previousVehicles.call(this, vehicles, hourF, blinkTime, cameraPos); return; }
    const state = renderState(this), now = performance.now();
    if (now - state.vehicleAt < 18 && !movedEnough(cameraPos, state.vehicleX, state.vehicleZ, 24)) return;
    state.vehicleAt = now; state.vehicleX = cameraPos.x; state.vehicleZ = cameraPos.z; previousVehicles.call(this, vehicles, hourF, blinkTime, cameraPos);
  };

  const previousLighting = proto.updateNightLighting as AnyMethod | undefined;
  if (typeof previousLighting === 'function') proto.updateNightLighting = function adaptiveNightLighting(this: AnyHost, hourF: number, cameraPos: THREE.Vector3, vehicles: { count: number }): void {
    if (vehicles.count < 4_000) { previousLighting.call(this, hourF, cameraPos, vehicles); return; }
    const state = renderState(this), now = performance.now();
    if (now - state.lightingAt < 40 && !movedEnough(cameraPos, state.lightingX, state.lightingZ, 35)) return;
    state.lightingAt = now; state.lightingX = cameraPos.x; state.lightingZ = cameraPos.z; previousLighting.call(this, hourF, cameraPos, vehicles);
  };
  proto.__machiSimAdaptiveRenderSyncV116 = true;
}

function addSwitch(methods: MethodSwitch[], host: AnyHost | null | undefined, name: string): void {
  if (!host) return; const wrapped = host[name] as AnyMethod | undefined, base = (Object.getPrototypeOf(host) as AnyHost | null)?.[name] as AnyMethod | undefined;
  if (typeof wrapped === 'function' && typeof base === 'function' && wrapped !== base) methods.push({ host, name, wrapped, base });
}

function ensureMonitor(monitor: PerformanceMonitor): MonitorSwitchState {
  let state = monitorStates.get(monitor); if (state) return state;
  const internal = monitor as unknown as AnyHost, world = internal.world as AnyHost, methods: MethodSwitch[] = [];
  addSwitch(methods, world, 'stepBatchAsync'); addSwitch(methods, world, 'stepCore'); addSwitch(methods, world, 'stepCoreAsync');
  addSwitch(methods, world, 'computePedBlocks'); addSwitch(methods, world, 'buildTravelerIndex'); addSwitch(methods, world, 'handleArrivedVehicles'); addSwitch(methods, world, 'processParallelActivityExits'); addSwitch(methods, world, 'beginTrip');
  addSwitch(methods, world.brain, 'plan'); addSwitch(methods, world.signals, 'update'); addSwitch(methods, world.traffic, 'update');
  addSwitch(methods, world.bus, 'update'); addSwitch(methods, world.bus, 'syncOnboard'); addSwitch(methods, world.logistics, 'update');
  addSwitch(methods, world.agentWorkers, 'updateAgentBatch'); addSwitch(methods, world.poiWorkers, 'findBestBatch'); addSwitch(methods, world.pedWorkers, 'flush');
  addSwitch(methods, world.city?.poi, 'findBest'); addSwitch(methods, world.city?.poi, 'findNearestFree'); addSwitch(methods, world.city?.poi, 'reserve'); addSwitch(methods, world.city?.poi, 'release');
  addSwitch(methods, world.walkAstar, 'findPath'); addSwitch(methods, world.traffic?.astar, 'findPath');
  state = { profiling: true, methods }; monitorStates.set(monitor, state); monitors.add(monitor);
  internal.visible = false; if (internal.root instanceof HTMLElement) internal.root.style.display = 'none';
  return state;
}

function setProfiling(monitor: PerformanceMonitor, enabled: boolean): void {
  const state = ensureMonitor(monitor); if (state.profiling === enabled) return;
  for (const method of state.methods) method.host[method.name] = enabled ? method.wrapped : method.base;
  state.profiling = enabled;
}

function syncMonitor(monitor: PerformanceMonitor): boolean {
  const internal = monitor as unknown as AnyHost; const enabled = Boolean(internal.visible) || developerDiagnostics;
  setProfiling(monitor, enabled); return enabled;
}

function installOnDemandProfiler(): void {
  const proto = PerformanceMonitor.prototype as unknown as AnyHost;
  if (proto.__machiSimOnDemandProfilerV116) return;
  const previousBegin = proto.beginGpu as AnyMethod, previousEnd = proto.endGpu as AnyMethod, previousUpdate = proto.update as AnyMethod;
  proto.beginGpu = function onDemandBeginGpu(this: PerformanceMonitor): void { if (syncMonitor(this)) previousBegin.call(this); };
  proto.endGpu = function onDemandEndGpu(this: PerformanceMonitor): void { const state = ensureMonitor(this); if (state.profiling) previousEnd.call(this); };
  proto.update = function onDemandPerformanceUpdate(this: PerformanceMonitor, ...args: any[]): void { if (syncMonitor(this)) previousUpdate.apply(this, args); };
  proto.__machiSimOnDemandProfilerV116 = true;

  const overlay = OverlayManager.prototype as unknown as AnyHost, previousVisibility = overlay.applyModeVisibility as AnyMethod | undefined;
  if (typeof previousVisibility === 'function' && !overlay.__machiSimProfilerOverlaySwitchV116) {
    overlay.applyModeVisibility = function profilerAwareOverlayVisibility(this: AnyHost, ...args: any[]): any {
      const result = previousVisibility.apply(this, args), next = this.modeValue === 'developer-diagnostics';
      if (developerDiagnostics !== next) { developerDiagnostics = next; for (const monitor of monitors) syncMonitor(monitor); }
      return result;
    };
    overlay.__machiSimProfilerOverlaySwitchV116 = true;
  }
}

installIncrementalTrafficOccupancy();
installAdaptiveRenderSync();
installOnDemandProfiler();
