import { AgentState } from '../agents/AgentStore';
import { VehicleState } from '../traffic/VehicleStore';
import { PerformanceMonitor, type RenderProfileSample } from '../rendering/PerformanceMonitor';
import type { RenderingLodStats } from '../rendering/EnhancedRenderer';
import type { World } from '../world/World';

const APP_VERSION = '0.1.3';
const AUTO_PARAM = 'citysim-benchmark';
const SAMPLE_INTERVAL_MS = 250;

interface PhaseSpec { label: string; speedLabel: string; scale: number; durationMs: number; }
const PHASES: PhaseSpec[] = [
  { label: 'cold-1m-s', speedLabel: '1m/s', scale: 60, durationMs: 30_000 },
  { label: '3m-s', speedLabel: '3m/s', scale: 180, durationMs: 10_000 },
  { label: '10m-s', speedLabel: '10m/s', scale: 600, durationMs: 10_000 },
  { label: '30m-s', speedLabel: '30m/s', scale: 1800, durationMs: 10_000 },
  { label: '1h-s', speedLabel: '1h/s', scale: 3600, durationMs: 10_000 },
  { label: '30s-s', speedLabel: '30s/s', scale: 30, durationMs: 10_000 },
  { label: '5x', speedLabel: '5×', scale: 5, durationMs: 10_000 },
  { label: '1x', speedLabel: '1×', scale: 1, durationMs: 10_000 },
];

interface MonitorInternals {
  world: World;
  profiler: { latest: Record<string, number> };
  gpu: { latestMs: number; gl: WebGL2RenderingContext };
  summary: HTMLDivElement;
}
interface LatestFrame {
  monitor: PerformanceMonitor;
  frameMs: number;
  fps: number;
  render: RenderProfileSample;
  lod: RenderingLodStats;
  backlogSec: number;
  simBusy: boolean;
}
interface BenchmarkSample {
  wallMs: number;
  phaseIndex: number;
  phase: string;
  targetScale: number;
  simTimeSeconds: number;
  frame: { frameMs: number; fps: number; gpuMs: number | null; backlogSec: number; simBusy: boolean };
  render: RenderProfileSample & { preRenderMs: number };
  sim: Record<string, number>;
  lod: RenderingLodStats;
  states: { agents: Record<string, number>; vehicles: Record<string, number>; activePedestrians: number };
  hudText: string;
  performanceText: string;
}
interface NumericStats { n: number; mean: number; min: number; p50: number; p95: number; max: number; }

let latestFrame: LatestFrame | null = null;
let harnessInstalled = false;

function installPerformanceTap(): void {
  if (harnessInstalled) return;
  harnessInstalled = true;
  const original = PerformanceMonitor.prototype.update;
  PerformanceMonitor.prototype.update = function(
    this: PerformanceMonitor,
    now: number,
    frameMs: number,
    fps: number,
    render: RenderProfileSample,
    lod: RenderingLodStats,
    backlogSec: number,
    simBusy: boolean,
  ): void {
    latestFrame = { monitor: this, frameMs, fps, render, lod, backlogSec, simBusy };
    original.call(this, now, frameMs, fps, render, lod, backlogSec, simBusy);
  };
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
function finite(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function stats(values: number[]): NumericStats {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, mean: 0, min: 0, p50: 0, p95: 0, max: 0 };
  const q = (p: number): number => v[Math.min(v.length - 1, Math.max(0, Math.floor((v.length - 1) * p)))];
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, min: v[0], p50: q(0.5), p95: q(0.95), max: v[v.length - 1] };
}
function nestedNumber(sample: BenchmarkSample, path: string): number {
  let value: unknown = sample;
  for (const part of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

class BenchmarkHarness {
  private readonly root = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly status = document.createElement('span');
  private running = false;
  private cancelled = false;
  private samples: BenchmarkSample[] = [];
  private phaseSummaries: unknown[] = [];
  private startedAt = '';
  private benchmarkStartWall = 0;

  install(): void {
    const versionEl = document.getElementById('app-version');
    if (versionEl) versionEl.textContent = `City Sim v${APP_VERSION}`;

    this.root.style.cssText = 'position:fixed;left:8px;bottom:36px;z-index:31;display:flex;align-items:center;gap:7px;font:11px/1.2 ui-monospace,monospace;color:#cdd7e5;background:rgba(8,12,18,.78);border:1px solid rgba(52,68,91,.72);border-radius:6px;padding:5px 7px;user-select:none';
    this.button.textContent = 'BENCH';
    this.button.title = 'Fresh 100-second standard benchmark; reloads the same city and downloads one JSON report.';
    this.button.style.cssText = 'padding:3px 8px;font:600 11px ui-monospace,monospace;cursor:pointer;border-radius:4px;border:1px solid #4d6685;background:#21344d;color:#e7eef8';
    this.status.textContent = '100s standard'; this.status.style.opacity = '.72';
    this.root.append(this.button, this.status); document.body.appendChild(this.root);
    this.button.onclick = () => { if (this.running) this.cancelled = true; else this.requestFreshRun(); };

    const url = new URL(window.location.href);
    if (url.searchParams.get(AUTO_PARAM) === '1') {
      url.searchParams.delete(AUTO_PARAM);
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      void this.waitAndRun();
    }
  }

  private requestFreshRun(): void {
    const url = new URL(window.location.href);
    url.searchParams.set(AUTO_PARAM, '1');
    window.location.href = url.toString();
  }

  private async waitAndRun(): Promise<void> {
    this.status.textContent = 'preparing…';
    const deadline = performance.now() + 15_000;
    while ((!latestFrame || !this.findSpeedButton('1m/s')) && performance.now() < deadline) await sleep(50);
    if (!latestFrame) { this.status.textContent = 'failed: no perf monitor'; return; }
    await this.run();
  }

  private findSpeedButton(label: string): HTMLButtonElement | null {
    return ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined) ?? null;
  }

  private setSpeed(label: string): boolean {
    const button = this.findSpeedButton(label); if (!button) return false;
    button.click(); return true;
  }

  private countStates(world: World): BenchmarkSample['states'] {
    const agents: Record<string, number> = {};
    const vehicles: Record<string, number> = {};
    const agentNames = AgentState as unknown as Record<number, string>;
    const vehicleNames = VehicleState as unknown as Record<number, string>;
    let activePedestrians = 0;
    for (let i = 0; i < world.store.count; i++) {
      const state = world.store.state[i]; const name = agentNames[state] ?? `State${state}`;
      agents[name] = (agents[name] ?? 0) + 1;
      if (state === AgentState.Traveling || state === AgentState.ToVehicle || state === AgentState.ToBusStop || state === AgentState.WaitingBus) activePedestrians++;
    }
    for (let i = 0; i < world.vehicles.count; i++) {
      const state = world.vehicles.state[i]; const name = vehicleNames[state] ?? `State${state}`;
      vehicles[name] = (vehicles[name] ?? 0) + 1;
    }
    return { agents, vehicles, activePedestrians };
  }

  private capture(phaseIndex: number, phase: PhaseSpec): BenchmarkSample | null {
    const frame = latestFrame; if (!frame) return null;
    const internals = frame.monitor as unknown as MonitorInternals;
    const preRenderMs = frame.render.railOpsMs + frame.render.railVisualMs + frame.render.liveryMs + frame.render.vehicleVisualMs + frame.render.preRenderOtherMs;
    return {
      wallMs: performance.now() - this.benchmarkStartWall,
      phaseIndex,
      phase: phase.label,
      targetScale: phase.scale,
      simTimeSeconds: internals.world.clock.totalSeconds,
      frame: { frameMs: frame.frameMs, fps: frame.fps, gpuMs: finite(internals.gpu.latestMs), backlogSec: frame.backlogSec, simBusy: frame.simBusy },
      render: { ...frame.render, preRenderMs },
      sim: { ...internals.profiler.latest },
      lod: { buildings: [...frame.lod.buildings] as [number, number, number, number], agents: [...frame.lod.agents] as [number, number], vehicles: [...frame.lod.vehicles] as [number, number] },
      states: this.countStates(internals.world),
      hudText: document.getElementById('hud')?.textContent ?? '',
      performanceText: internals.summary?.textContent ?? '',
    };
  }

  private summarize(samples: BenchmarkSample[], spec: PhaseSpec, wallSeconds: number, simAdvanced: number): unknown {
    const metric = (path: string): NumericStats => stats(samples.map((s) => nestedNumber(s, path)));
    return {
      label: spec.label, speedLabel: spec.speedLabel, targetScale: spec.scale, wallSeconds, simAdvanced,
      effectiveSimRate: wallSeconds > 0 ? simAdvanced / wallSeconds : 0,
      targetAchievementPct: spec.scale > 0 && wallSeconds > 0 ? (simAdvanced / wallSeconds / spec.scale) * 100 : 0,
      metrics: {
        fps: metric('frame.fps'), frameMs: metric('frame.frameMs'), gpuMs: metric('frame.gpuMs'), lagSeconds: metric('frame.backlogSec'),
        renderMs: metric('render.totalMs'), preRenderMs: metric('render.preRenderMs'), railOpsMs: metric('render.railOpsMs'), railBacklogSec: metric('render.railBacklogSec'),
        simMs: metric('sim.totalMs'), agentWorkerMs: metric('sim.workerMs'), agentMs: metric('sim.agentMs'), trafficMs: metric('sim.trafficMs'),
        pedWorkerWallMs: metric('sim.pedWorkerMs'), pedWorkerCoreMs: metric('sim.pedWorkerCoreMs'), pedReturnMs: metric('sim.pedWorkerReturnMs'), pedWakeMs: metric('sim.pedWorkerWakeMs'),
        poiWorkerMs: metric('sim.poiWorkerMs'), poiComputeMs: metric('sim.poiWorkerComputeMs'), poiReturnMs: metric('sim.poiWorkerReturnMs'),
        astarWalkMs: metric('sim.astarWalkMs'), astarWalkCount: metric('sim.astarWalkCount'),
        idleAgents: metric('states.agents.Idle'), routingAgents: metric('states.agents.Routing'), engagedAgents: metric('states.agents.Engaged'), activePedestrians: metric('states.activePedestrians'),
      },
    };
  }

  private environment(frame: LatestFrame): unknown {
    const internals = frame.monitor as unknown as MonitorInternals;
    const gl = internals.gpu.gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: nav.deviceMemory ?? null,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      webgl: {
        vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION), shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      },
      jsHeap: perf.memory ? { ...perf.memory } : null,
    };
  }

  private async run(): Promise<void> {
    if (this.running || !latestFrame) return;
    this.running = true; this.cancelled = false; this.samples = []; this.phaseSummaries = [];
    this.startedAt = new Date().toISOString(); this.benchmarkStartWall = performance.now();
    this.button.textContent = 'STOP';
    const monitor = latestFrame.monitor as unknown as MonitorInternals;
    const initialHud = document.getElementById('hud')?.textContent ?? '';
    const initialWorldStats = monitor.world.stats();
    const initialActivity = monitor.world.activitySnapshot();

    for (let p = 0; p < PHASES.length && !this.cancelled; p++) {
      const phase = PHASES[p];
      if (!this.setSpeed(phase.speedLabel)) { this.status.textContent = `missing ${phase.speedLabel}`; this.cancelled = true; break; }
      const phaseStartWall = performance.now(); const phaseStartSim = monitor.world.clock.totalSeconds;
      while (!this.cancelled && performance.now() - phaseStartWall < phase.durationMs) {
        const sample = this.capture(p, phase); if (sample) this.samples.push(sample);
        const elapsed = performance.now() - phaseStartWall;
        const remaining = Math.max(0, Math.ceil((phase.durationMs - elapsed) / 1000));
        this.status.textContent = `${p + 1}/${PHASES.length} ${phase.speedLabel} ${remaining}s`;
        await sleep(SAMPLE_INTERVAL_MS);
      }
      const last = this.capture(p, phase); if (last) this.samples.push(last);
      const wallSeconds = Math.max(0.001, (performance.now() - phaseStartWall) / 1000);
      const simAdvanced = monitor.world.clock.totalSeconds - phaseStartSim;
      const phaseSamples = this.samples.filter((s) => s.phaseIndex === p);
      this.phaseSummaries.push(this.summarize(phaseSamples, phase, wallSeconds, simAdvanced));
    }

    const report = {
      schema: 'city-sim-benchmark-v1', appVersion: APP_VERSION, startedAt: this.startedAt, finishedAt: new Date().toISOString(),
      aborted: this.cancelled, plan: PHASES, environment: this.environment(latestFrame!),
      initial: { hudText: initialHud, worldStats: initialWorldStats, activity: initialActivity },
      final: { hudText: document.getElementById('hud')?.textContent ?? '', worldStats: monitor.world.stats(), activity: monitor.world.activitySnapshot(), states: this.countStates(monitor.world) },
      phaseSummaries: this.phaseSummaries, samples: this.samples,
    };
    this.download(report);
    this.running = false; this.button.textContent = 'BENCH';
    this.status.textContent = this.cancelled ? 'partial JSON saved' : 'JSON saved';
  }

  private download(report: unknown): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `city-sim-benchmark-v${APP_VERSION}-${stamp}.json`; document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

installPerformanceTap();
new BenchmarkHarness().install();
