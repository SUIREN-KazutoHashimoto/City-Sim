import * as THREE from 'three';
import { AgentState } from '../agents/AgentStore';
import { VehicleState } from '../traffic/VehicleStore';
import { World } from '../world/World';
import type { RenderingLodStats } from './EnhancedRenderer';

export interface RenderProfileSample {
  totalMs: number;
  lodMs: number;
  agentsMs: number;
  vehiclesMs: number;
  signalsMs: number;
  lightingMs: number;
  webglMs: number;
  railOpsMs: number;
  railVisualMs: number;
  railSteps: number;
  railStepSeconds: number;
  railBacklogSec: number;
  liveryMs: number;
  vehicleVisualMs: number;
  preRenderOtherMs: number;
}

interface SimProfile {
  totalMs: number;
  workerMs: number;
  poiWorkerMs: number;
  poiWorkerComputeMs: number;
  poiWorkerReturnMs: number;
  poiWorkerRounds: number;
  pedWorkerMs: number;
  pedWorkerPrepMs: number;
  pedWorkerIndexMs: number;
  pedWorkerAvoidMoveMs: number;
  pedWorkerBarrierMs: number;
  pedWorkerCoreMs: number;
  pedWorkerWakeMs: number;
  pedWorkerReturnMs: number;
  pedWorkerRounds: number;
  agentMs: number;
  pedBlocksMs: number;
  trafficMs: number;
  signalsMs: number;
  busMs: number;
  logisticsMs: number;
  pedIndexMs: number;
  pedestrianMs: number;
  arrivalsMs: number;
  activityMs: number;
  poiFindBestMs: number;
  poiParkingMs: number;
  poiMutationMs: number;
  otherMs: number;
  steps: number;
  decisions: number;
  tripStarts: number;
  poiFindBestCount: number;
  poiParkingCount: number;
  poiMutationCount: number;
  astarWalkMs: number;
  astarWalkCount: number;
  astarWalkMaxMs: number;
  astarVehicleMs: number;
  astarVehicleCount: number;
  astarVehicleMaxMs: number;
}

interface HistorySample {
  frameMs: number;
  renderMs: number;
  preRenderMs: number;
  gpuMs: number;
  simMs: number;
  workerMs: number;
  agentMs: number;
  pedestrianMs: number;
  trafficMs: number;
  signalsMs: number;
  busMs: number;
  logisticsMs: number;
  activityMs: number;
  otherMs: number;
  visibleAgents: number;
  visibleVehicles: number;
  activePedestrians: number;
  drivingVehicles: number;
}

interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number; }
interface PedTiming { prepMs: number; indexMs: number; avoidMoveMs: number; barrierMs: number; totalMs: number; wakeMs: number; returnMs: number; }
interface POITiming { totalMs: number; computeMs: number; returnMs: number; workers: number; }

interface WorldInternals {
  stepCore: (dtSec: number, updateNeeds: boolean, updateActivities: boolean, updateDecisions: boolean) => void;
  stepCoreAsync: (dtSec: number, updateNeeds: boolean, updateActivities: boolean, updateDecisions: boolean) => Promise<void>;
  computePedBlocks: () => void;
  buildTravelerIndex: () => void;
  handleArrivedVehicles: () => void;
  processParallelActivityExits: (now: number) => void;
  beginTrip: (agent: number) => void;
  brain: { plan: (...args: unknown[]) => unknown };
  walkAstar: { findPath: (start: number, goal: number) => number[] };
  agentWorkers: { updateAgentBatch: (dt: number, now: number, count?: number) => Promise<void> };
  poiWorkers: { findBestBatch: (queries: readonly unknown[]) => Promise<Int32Array>; readonly latestTiming: POITiming };
  pedWorkers: { flush: (dt: number) => Promise<void>; readonly latestTiming: PedTiming; readonly completionMode: 'atomics' | 'message' };
}

interface TrafficInternals { astar: { findPath: (start: number, goal: number) => number[] }; }

const emptySim = (): SimProfile => ({
  totalMs: 0, workerMs: 0, poiWorkerMs: 0, poiWorkerComputeMs: 0, poiWorkerReturnMs: 0, poiWorkerRounds: 0, pedWorkerMs: 0,
  pedWorkerPrepMs: 0, pedWorkerIndexMs: 0, pedWorkerAvoidMoveMs: 0, pedWorkerBarrierMs: 0, pedWorkerCoreMs: 0,
  pedWorkerWakeMs: 0, pedWorkerReturnMs: 0, pedWorkerRounds: 0,
  agentMs: 0, pedBlocksMs: 0, trafficMs: 0, signalsMs: 0, busMs: 0, logisticsMs: 0,
  pedIndexMs: 0, pedestrianMs: 0, arrivalsMs: 0, activityMs: 0, poiFindBestMs: 0, poiParkingMs: 0, poiMutationMs: 0, otherMs: 0, steps: 0,
  decisions: 0, tripStarts: 0, poiFindBestCount: 0, poiParkingCount: 0, poiMutationCount: 0,
  astarWalkMs: 0, astarWalkCount: 0, astarWalkMaxMs: 0, astarVehicleMs: 0, astarVehicleCount: 0, astarVehicleMaxMs: 0,
});

class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  private active: WebGLQuery | null = null;
  private readonly pending: WebGLQuery[] = [];
  latestMs = Number.NaN;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = typeof this.gl.createQuery === 'function' ? this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null : null;
  }
  begin(): void { if (!this.ext || this.active || this.pending.length > 6) return; const q = this.gl.createQuery(); if (!q) return; this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q); this.active = q; }
  end(): void { if (!this.ext || !this.active) return; this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.pending.push(this.active); this.active = null; }
  poll(): void {
    if (!this.ext || this.pending.length === 0) return;
    const query = this.pending[0], available = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE) as boolean;
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean; if (!available) return;
    this.pending.shift(); if (!disjoint) this.latestMs = (this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number) / 1_000_000; this.gl.deleteQuery(query);
  }
}

class SimulationProfiler {
  latest: SimProfile = emptySim();
  private current: SimProfile = emptySim();
  private inBatch = false;
  private agentPhaseStart = 0;
  private pedestrianPhaseStart = 0;
  private activityPhaseStart = 0;

  constructor(private readonly world: World) { this.install(); }

  private install(): void {
    const w = this.world as unknown as WorldInternals;
    const originalBatch = this.world.stepBatchAsync.bind(this.world);
    this.world.stepBatchAsync = async (dtSec: number, steps: number): Promise<void> => {
      this.current = emptySim(); this.inBatch = true; const started = performance.now();
      try { await originalBatch(dtSec, steps); }
      finally {
        this.current.totalMs = performance.now() - started;
        const covered = this.current.workerMs + this.current.poiWorkerMs + this.current.agentMs + this.current.pedBlocksMs + this.current.trafficMs +
          this.current.busMs + this.current.logisticsMs + this.current.pedIndexMs + this.current.pedestrianMs + this.current.arrivalsMs + this.current.activityMs + this.current.signalsMs;
        this.current.otherMs = Math.max(0, this.current.totalMs - covered);
        this.latest = { ...this.current }; this.inBatch = false;
      }
    };

    const originalStepCore = w.stepCore.bind(this.world);
    w.stepCore = (dtSec: number, updateNeeds: boolean, updateActivities: boolean, updateDecisions: boolean): void => {
      this.beginStep(); originalStepCore(dtSec, updateNeeds, updateActivities, updateDecisions); this.endStep();
    };
    const originalStepCoreAsync = w.stepCoreAsync.bind(this.world);
    w.stepCoreAsync = async (dtSec: number, updateNeeds: boolean, updateActivities: boolean, updateDecisions: boolean): Promise<void> => {
      this.beginStep(); await originalStepCoreAsync(dtSec, updateNeeds, updateActivities, updateDecisions); this.endStep();
    };

    this.wrapTimed(this.world.signals, 'update', 'signalsMs', () => { this.agentPhaseStart = performance.now(); });
    const originalPedBlocks = w.computePedBlocks.bind(this.world);
    w.computePedBlocks = (): void => {
      const t = performance.now(); if (this.inBatch && this.agentPhaseStart > 0) this.current.agentMs += t - this.agentPhaseStart;
      originalPedBlocks(); if (this.inBatch) this.current.pedBlocksMs += performance.now() - t;
    };
    this.wrapTimed(this.world.traffic, 'update', 'trafficMs');
    this.wrapTimed(this.world.bus, 'update', 'busMs');
    this.wrapTimed(this.world.bus, 'syncOnboard', 'busMs');
    this.wrapTimed(this.world.logistics, 'update', 'logisticsMs');

    const originalIndex = w.buildTravelerIndex.bind(this.world);
    w.buildTravelerIndex = (): void => { const t = performance.now(); originalIndex(); if (this.inBatch) { this.current.pedIndexMs += performance.now() - t; this.pedestrianPhaseStart = performance.now(); } };
    const originalArrivals = w.handleArrivedVehicles.bind(this.world);
    w.handleArrivedVehicles = (): void => {
      const t = performance.now(); if (this.inBatch && this.pedestrianPhaseStart > 0) this.current.pedestrianMs += t - this.pedestrianPhaseStart;
      originalArrivals(); if (this.inBatch) { this.current.arrivalsMs += performance.now() - t; this.activityPhaseStart = performance.now(); }
    };
    const originalParallelExit = w.processParallelActivityExits.bind(this.world);
    w.processParallelActivityExits = (now: number): void => { const t = performance.now(); originalParallelExit(now); if (this.inBatch) this.current.activityMs += performance.now() - t; };

    const originalWorker = w.agentWorkers.updateAgentBatch.bind(w.agentWorkers);
    w.agentWorkers.updateAgentBatch = async (dt: number, now: number, count?: number): Promise<void> => {
      const t = performance.now(); await originalWorker(dt, now, count); if (this.inBatch) this.current.workerMs += performance.now() - t;
    };
    const originalPoiWorker = w.poiWorkers.findBestBatch.bind(w.poiWorkers);
    w.poiWorkers.findBestBatch = async (queries: readonly unknown[]): Promise<Int32Array> => {
      const t = performance.now(); const out = await originalPoiWorker(queries);
      if (this.inBatch) {
        this.current.poiWorkerMs += performance.now() - t;
        const m = w.poiWorkers.latestTiming;
        this.current.poiWorkerComputeMs += m.computeMs;
        this.current.poiWorkerReturnMs += m.returnMs;
        this.current.poiWorkerRounds++;
      }
      return out;
    };
    const originalPedWorker = w.pedWorkers.flush.bind(w.pedWorkers);
    w.pedWorkers.flush = async (dt: number): Promise<void> => {
      const t = performance.now(); await originalPedWorker(dt);
      if (this.inBatch) {
        this.current.pedWorkerMs += performance.now() - t;
        this.current.pedWorkerRounds++;
        const m = w.pedWorkers.latestTiming;
        this.current.pedWorkerPrepMs += m.prepMs;
        this.current.pedWorkerIndexMs += m.indexMs;
        this.current.pedWorkerAvoidMoveMs += m.avoidMoveMs;
        this.current.pedWorkerBarrierMs += m.barrierMs;
        this.current.pedWorkerCoreMs += m.totalMs;
        this.current.pedWorkerWakeMs += m.wakeMs;
        this.current.pedWorkerReturnMs += m.returnMs;
      }
    };

    const originalPlan = w.brain.plan.bind(w.brain);
    w.brain.plan = (...args: unknown[]): unknown => { if (this.inBatch) this.current.decisions++; return originalPlan(...args); };
    const originalBeginTrip = w.beginTrip.bind(this.world);
    w.beginTrip = (agent: number): void => { if (this.inBatch) this.current.tripStarts++; originalBeginTrip(agent); };

    this.wrapCounted(this.world.city.poi, 'findBest', 'poiFindBestMs', 'poiFindBestCount');
    this.wrapCounted(this.world.city.poi, 'findNearestFree', 'poiParkingMs', 'poiParkingCount');
    this.wrapCounted(this.world.city.poi, 'reserve', 'poiMutationMs', 'poiMutationCount');
    this.wrapCounted(this.world.city.poi, 'release', 'poiMutationMs', 'poiMutationCount');

    this.wrapAStar(w.walkAstar, 'walk');
    const traffic = this.world.traffic as unknown as TrafficInternals; this.wrapAStar(traffic.astar, 'vehicle');
  }

  private beginStep(): void {
    this.current.steps++; this.agentPhaseStart = 0; this.pedestrianPhaseStart = 0; this.activityPhaseStart = 0;
  }

  private endStep(): void {
    const ended = performance.now(); if (this.inBatch && this.activityPhaseStart > 0) this.current.activityMs += ended - this.activityPhaseStart;
  }

  private wrapTimed(target: object, method: string, field: keyof SimProfile, after?: () => void): void {
    const obj = target as Record<string, (...args: unknown[]) => unknown>, original = obj[method].bind(target);
    obj[method] = (...args: unknown[]): unknown => { const t = performance.now(); const result = original(...args); if (this.inBatch) (this.current as unknown as Record<string, number>)[field as string] += performance.now() - t; after?.(); return result; };
  }

  private wrapCounted(target: object, method: string, msField: keyof SimProfile, countField: keyof SimProfile): void {
    const obj = target as Record<string, (...args: unknown[]) => unknown>, original = obj[method].bind(target);
    obj[method] = (...args: unknown[]): unknown => {
      const t = performance.now(), result = original(...args);
      if (this.inBatch) {
        const c = this.current as unknown as Record<string, number>; c[msField as string] += performance.now() - t; c[countField as string]++;
      }
      return result;
    };
  }

  private wrapAStar(astar: { findPath: (start: number, goal: number) => number[] }, kind: 'walk' | 'vehicle'): void {
    const original = astar.findPath.bind(astar);
    astar.findPath = (start: number, goal: number): number[] => {
      const t = performance.now(), path = original(start, goal), ms = performance.now() - t;
      if (this.inBatch) {
        if (kind === 'walk') { this.current.astarWalkMs += ms; this.current.astarWalkCount++; this.current.astarWalkMaxMs = Math.max(this.current.astarWalkMaxMs, ms); }
        else { this.current.astarVehicleMs += ms; this.current.astarVehicleCount++; this.current.astarVehicleMaxMs = Math.max(this.current.astarVehicleMaxMs, ms); }
      }
      return path;
    };
  }
}

export class PerformanceMonitor {
  private readonly profiler: SimulationProfiler;
  private readonly gpu: GpuTimer;
  private readonly root: HTMLDivElement;
  private readonly summary: HTMLDivElement;
  private readonly frameCanvas: HTMLCanvasElement;
  private readonly simCanvas: HTMLCanvasElement;
  private readonly loadCanvas: HTMLCanvasElement;
  private readonly history: HistorySample[] = [];
  private lastSampleAt = 0;
  private visible = true;
  private latestRender: RenderProfileSample = {
    totalMs: 0, lodMs: 0, agentsMs: 0, vehiclesMs: 0, signalsMs: 0, lightingMs: 0, webglMs: 0,
    railOpsMs: 0, railVisualMs: 0, railSteps: 0, railStepSeconds: 0, railBacklogSec: 0,
    liveryMs: 0, vehicleVisualMs: 0, preRenderOtherMs: 0,
  };
  private latestLod: RenderingLodStats = { buildings: [0, 0, 0, 0], agents: [0, 0], vehicles: [0, 0] };
  private latestFrameMs = 0; private latestFps = 0; private latestBacklog = 0; private latestSimBusy = false;

  constructor(private readonly world: World, renderer: THREE.WebGLRenderer) {
    this.profiler = new SimulationProfiler(world); this.gpu = new GpuTimer(renderer);
    this.root = document.createElement('div');
    this.root.style.cssText = ['position:fixed', 'top:190px', 'right:8px', 'z-index:16', 'width:430px', 'max-height:calc(100vh - 200px)', 'overflow:auto',
      'font:10px/1.35 ui-monospace,monospace', 'color:#d7e0ec', 'background:rgba(8,12,18,.90)', 'border:1px solid #34445b', 'border-radius:8px', 'padding:8px',
      'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'user-select:none'].join(';'); document.body.appendChild(this.root);
    const title = document.createElement('div'); title.textContent = 'PERFORMANCE  [P=show/hide]'; title.style.cssText = 'font-weight:700;margin-bottom:5px;color:#f0f5fb'; this.root.appendChild(title);
    this.summary = document.createElement('div'); this.summary.style.cssText = 'white-space:pre;margin-bottom:6px'; this.root.appendChild(this.summary);
    this.frameCanvas = this.addCanvas('Frame timing (60 sec)', 414, 88);
    this.addLegend([['Frame', '#d9e1ea'], ['Render', '#63a6ff'], ['Pre', '#6fd0c5'], ['GPU', '#b979ff'], ['SIM', '#ff9a52']]);
    this.simCanvas = this.addCanvas('Simulation breakdown (exclusive)', 414, 92);
    this.addLegend([['Workers', '#9c7bff'], ['Agent', '#4c91e8'], ['Ped', '#49b982'], ['Traffic', '#e7ba42'], ['Bus', '#2f9e44'], ['Logi', '#c7763b'], ['Signal', '#df5b5b'], ['Activity', '#bb79d8'], ['Other', '#66717f']]);
    this.loadCanvas = this.addCanvas('Workload', 414, 82);
    this.addLegend([['Visible A', '#63a6ff'], ['Ped', '#63d69b'], ['Visible V', '#ffcf5a'], ['Driving V', '#ff7d6e']]);
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyP') { this.visible = !this.visible; this.root.style.display = this.visible ? 'block' : 'none'; } });
  }

  beginGpu(): void { this.gpu.begin(); }
  endGpu(): void { this.gpu.end(); }

  update(now: number, frameMs: number, fps: number, render: RenderProfileSample, lod: RenderingLodStats, backlogSec: number, simBusy: boolean): void {
    this.latestFrameMs = frameMs; this.latestFps = fps; this.latestRender = render; this.latestLod = lod; this.latestBacklog = backlogSec; this.latestSimBusy = simBusy; this.gpu.poll();
    if (!this.visible || now - this.lastSampleAt < 250) return; this.lastSampleAt = now;
    let activePedestrians = 0, engaged = 0; const s = this.world.store;
    for (let i = 0; i < s.count; i++) { const st = s.state[i]; if (st === AgentState.Traveling || st === AgentState.ToVehicle || st === AgentState.ToBusStop || st === AgentState.WaitingBus) activePedestrians++; else if (st === AgentState.Engaged) engaged++; }
    let drivingVehicles = 0; const vs = this.world.vehicles; for (let v = 0; v < vs.count; v++) if (vs.state[v] === VehicleState.Driving) drivingVehicles++;
    const p = this.profiler.latest, pedestrianMs = p.pedBlocksMs + p.pedIndexMs + p.pedestrianMs, activityMs = p.arrivalsMs + p.activityMs;
    const preRenderMs = render.railOpsMs + render.railVisualMs + render.liveryMs + render.vehicleVisualMs + render.preRenderOtherMs;
    this.history.push({ frameMs, renderMs: render.totalMs, preRenderMs, gpuMs: this.gpu.latestMs, simMs: p.totalMs, workerMs: p.workerMs + p.poiWorkerMs, agentMs: p.agentMs,
      pedestrianMs, trafficMs: p.trafficMs, busMs: p.busMs, logisticsMs: p.logisticsMs, signalsMs: p.signalsMs, activityMs, otherMs: p.otherMs,
      visibleAgents: lod.agents[0] + lod.agents[1], visibleVehicles: lod.vehicles[0] + lod.vehicles[1], activePedestrians, drivingVehicles });
    if (this.history.length > 240) this.history.shift(); this.draw(activePedestrians, engaged, drivingVehicles);
  }

  private draw(activePedestrians: number, engaged: number, drivingVehicles: number): void {
    const p = this.profiler.latest, r = this.latestRender, gpuText = Number.isFinite(this.gpu.latestMs) ? `${this.gpu.latestMs.toFixed(1)}ms` : 'n/a';
    const pedMs = p.pedBlocksMs + p.pedIndexMs + p.pedestrianMs;
    const pedPrepMs = Math.max(0, p.pedestrianMs - p.pedWorkerMs), actMs = p.arrivalsMs + p.activityMs;
    const pedUsPerStep = activePedestrians > 0 && p.steps > 0 ? ((pedMs * 1000) / (activePedestrians * p.steps)).toFixed(2) : '-';
    const dispatchGap = Math.max(0, p.pedWorkerMs - p.pedWorkerCoreMs);
    const measuredGap = p.pedWorkerWakeMs + p.pedWorkerReturnMs;
    const otherGap = Math.max(0, dispatchGap - measuredGap);
    const completionMode = (this.world as unknown as WorldInternals).pedWorkers.completionMode;
    const preRenderMs = r.railOpsMs + r.railVisualMs + r.liveryMs + r.vehicleVisualMs + r.preRenderOtherMs;
    this.summary.textContent =
`FRAME ${this.latestFrameMs.toFixed(1)}ms  FPS ${this.latestFps.toFixed(0)}  GPU ${gpuText}  backlog ${(this.latestBacklog * 1000).toFixed(0)}ms ${this.latestSimBusy ? 'BUSY' : ''}
PRE ${preRenderMs.toFixed(1)}ms  RailOps ${r.railOpsMs.toFixed(1)}/${r.railSteps}×${r.railStepSeconds.toFixed(1)}s  RailVis ${r.railVisualMs.toFixed(1)}  RailBacklog ${r.railBacklogSec.toFixed(1)}s  Livery ${r.liveryMs.toFixed(1)}  VehSmooth ${r.vehicleVisualMs.toFixed(1)}  Other ${r.preRenderOtherMs.toFixed(1)}
RENDER ${r.totalMs.toFixed(1)}ms  LOD ${r.lodMs.toFixed(1)}  Agent ${r.agentsMs.toFixed(1)}  Vehicle ${r.vehiclesMs.toFixed(1)}  Signal ${r.signalsMs.toFixed(1)}  Light ${r.lightingMs.toFixed(1)}  WebGL ${r.webglMs.toFixed(1)}
SIM ${p.totalMs.toFixed(1)}ms/${p.steps}step  AgentW ${p.workerMs.toFixed(1)}  POIW ${p.poiWorkerMs.toFixed(1)}  Agent ${p.agentMs.toFixed(1)}  Traffic ${p.trafficMs.toFixed(1)}
PED total ${pedMs.toFixed(1)}  Block ${p.pedBlocksMs.toFixed(1)}  MainIndex ${p.pedIndexMs.toFixed(1)}  Path/Signal ${pedPrepMs.toFixed(1)}  WorkerWall ${p.pedWorkerMs.toFixed(1)}
    Worker Prep ${p.pedWorkerPrepMs.toFixed(1)}  Index ${p.pedWorkerIndexMs.toFixed(1)}  Avoid+Move ${p.pedWorkerAvoidMoveMs.toFixed(1)}  Barrier ${p.pedWorkerBarrierMs.toFixed(1)}
    Wake ${p.pedWorkerWakeMs.toFixed(1)}  Return ${p.pedWorkerReturnMs.toFixed(1)}  OtherGap ${otherGap.toFixed(1)}  DispatchGap ${dispatchGap.toFixed(1)}  rounds ${p.pedWorkerRounds} ${completionMode}
    ${pedUsPerStep}us/ped/step  peds ${activePedestrians}
POI WorkerSearch ${p.poiWorkerMs.toFixed(1)}  Compute ${p.poiWorkerComputeMs.toFixed(1)}  Return ${p.poiWorkerReturnMs.toFixed(1)}  rounds ${p.poiWorkerRounds}
    MainSearch ${p.poiFindBestMs.toFixed(1)}/${p.poiFindBestCount}  Parking ${p.poiParkingMs.toFixed(1)}/${p.poiParkingCount}  Reserve/Release ${p.poiMutationMs.toFixed(1)}/${p.poiMutationCount}
    Activity+Arrival ${actMs.toFixed(1)}
SYS Bus ${p.busMs.toFixed(1)}  Logistics ${p.logisticsMs.toFixed(1)}  Signals ${p.signalsMs.toFixed(1)}  Other ${p.otherMs.toFixed(1)}
A* walk ${p.astarWalkMs.toFixed(1)}ms/${p.astarWalkCount} max ${p.astarWalkMaxMs.toFixed(2)}ms   vehicle ${p.astarVehicleMs.toFixed(1)}ms/${p.astarVehicleCount} max ${p.astarVehicleMaxMs.toFixed(2)}ms
LOAD visible A ${this.latestLod.agents.join('/')}  V ${this.latestLod.vehicles.join('/')}  B ${this.latestLod.buildings.join('/')}  ped ${activePedestrians}  engaged ${engaged}  driving ${drivingVehicles}`;
    this.drawLines(this.frameCanvas, [{ key: 'frameMs', color: '#d9e1ea' }, { key: 'renderMs', color: '#63a6ff' }, { key: 'preRenderMs', color: '#6fd0c5' }, { key: 'gpuMs', color: '#b979ff' }, { key: 'simMs', color: '#ff9a52' }], [16.67, 33.33]);
    this.drawStacked(this.simCanvas);
    this.drawLines(this.loadCanvas, [{ key: 'visibleAgents', color: '#63a6ff' }, { key: 'activePedestrians', color: '#63d69b' }, { key: 'visibleVehicles', color: '#ffcf5a' }, { key: 'drivingVehicles', color: '#ff7d6e' }]);
  }

  private addLegend(items: [string, string][]): void {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:7px;flex-wrap:wrap;margin:2px 0 4px;opacity:.78';
    for (const [label, color] of items) { const item = document.createElement('span'); item.style.cssText = 'display:inline-flex;align-items:center;gap:3px'; const sw = document.createElement('span'); sw.style.cssText = `display:inline-block;width:7px;height:7px;border-radius:1px;background:${color}`; item.appendChild(sw); item.appendChild(document.createTextNode(label)); row.appendChild(item); }
    this.root.appendChild(row);
  }
  private addCanvas(labelText: string, width: number, height: number): HTMLCanvasElement { const label = document.createElement('div'); label.textContent = labelText; label.style.cssText = 'opacity:.65;margin:5px 0 2px'; this.root.appendChild(label); const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.style.cssText = `width:${width}px;height:${height}px;display:block;border-radius:4px;background:#0b1017`; this.root.appendChild(canvas); return canvas; }
  private prep(canvas: HTMLCanvasElement): CanvasRenderingContext2D { const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#0b1017'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1; for (let x = 0; x <= canvas.width; x += canvas.width / 6) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); } return ctx; }

  private drawLines(canvas: HTMLCanvasElement, defs: { key: keyof HistorySample; color: string }[], refs: number[] = []): void {
    const ctx = this.prep(canvas), W = canvas.width, H = canvas.height; let max = 1;
    for (const h of this.history) for (const d of defs) { const v = h[d.key] as number; if (Number.isFinite(v)) max = Math.max(max, v); }
    for (const ref of refs) max = Math.max(max, ref * 1.15); max *= 1.08;
    for (const ref of refs) { const y = H - (ref / max) * H; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (const d of defs) { ctx.strokeStyle = d.color; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false; this.history.forEach((h, i) => { const v = h[d.key] as number; if (!Number.isFinite(v)) return; const xx = this.history.length <= 1 ? W : (i / 239) * W, yy = H - (v / max) * H; if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy); }); if (started) ctx.stroke(); }
  }

  private drawStacked(canvas: HTMLCanvasElement): void {
    const ctx = this.prep(canvas), W = canvas.width, H = canvas.height;
    const defs: { key: keyof HistorySample; color: string }[] = [
      { key: 'workerMs', color: '#9c7bff' }, { key: 'agentMs', color: '#4c91e8' }, { key: 'pedestrianMs', color: '#49b982' }, { key: 'trafficMs', color: '#e7ba42' },
      { key: 'busMs', color: '#2f9e44' }, { key: 'logisticsMs', color: '#c7763b' }, { key: 'signalsMs', color: '#df5b5b' }, { key: 'activityMs', color: '#bb79d8' }, { key: 'otherMs', color: '#66717f' },
    ];
    let max = 1; for (const h of this.history) { let total = 0; for (const d of defs) total += h[d.key] as number; max = Math.max(max, total); } max *= 1.08;
    const cumulative = new Array<number>(this.history.length).fill(0);
    for (const d of defs) { ctx.fillStyle = d.color; ctx.beginPath(); let started = false;
      for (let i = 0; i < this.history.length; i++) { const xx = (i / 239) * W, yy = H - ((cumulative[i] + (this.history[i][d.key] as number)) / max) * H; if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy); }
      for (let i = this.history.length - 1; i >= 0; i--) { const xx = (i / 239) * W, yy = H - (cumulative[i] / max) * H; ctx.lineTo(xx, yy); }
      if (started) { ctx.closePath(); ctx.fill(); } for (let i = 0; i < this.history.length; i++) cumulative[i] += this.history[i][d.key] as number;
    }
  }
}
