import * as THREE from 'three';
import { World } from './world/World';
import { EnhancedRenderer } from './rendering/EnhancedRenderer';
import { FirstPersonController } from './rendering/FirstPersonController';
import { Inspector } from './rendering/Inspector';
import { Dashboard } from './rendering/Dashboard';
import { PerformanceMonitor, type RenderProfileSample } from './rendering/PerformanceMonitor';
import { buildAlignedBusStops } from './rendering/BusStopRenderer';
import { buildSpecialFacilityVisuals } from './rendering/SpecialFacilityRenderer';
import { RailRenderer } from './rendering/RailRenderer';
import { RailFrameScheduler } from './rendering/RailFrameScheduler';
import { TrainLiveryOverlay } from './rendering/TrainLiveryOverlay';
import { VehicleVisualSmoother } from './rendering/VehicleVisualSmoother';
import { reserveRailStationClearance } from './generation/RailStationClearance';
import { loadCityConfig, resolveCitySeed } from './config/CityConfigLoader';
import { BootScreen } from './boot/BootScreen';
import { BOOT_START_SECONDS, preRollWorld } from './boot/PreRoll';
import { APP_VERSION } from './version';

interface SchedulerSnapshot {
  batchId: number;
  completedSimSeconds: number;
  pendingRealSeconds: number;
  clockPendingSimSeconds: number;
  speedRebaseCount: number;
  rebasedRealSeconds: number;
  railInputSeconds: number;
  railProcessedSeconds: number;
  railBacklogSeconds: number;
  requestedPopulation: number;
  actualPopulation: number;
}

interface BenchmarkSchedulerControl {
  snapshot: () => SchedulerSnapshot;
  hold: () => void;
  resume: () => void;
  rebaseSpeed: () => void;
  waitForIdle: (timeoutMs?: number) => Promise<boolean>;
}

declare global {
  interface Window {
    __CITY_SIM_BENCH_HOLD__?: boolean;
    __CITY_SIM_SCHEDULER__?: BenchmarkSchedulerControl;
  }
}

const versionEl = document.getElementById('app-version');
if (versionEl) versionEl.textContent = `City Sim v${APP_VERSION}`;
const boot = new BootScreen();

async function bootstrap(): Promise<void> {
  boot.update('設定を読み込んでいます', '都市サイズ・人口・道路計画を確認しています', 0.03);
  await boot.paint();

  const runtime = await loadCityConfig();
  const seed = resolveCitySeed(runtime.seed);
  const SIZE = Math.sqrt(runtime.areaKm2 * 1_000_000);

  console.info('[City-Sim] city config', { ...runtime, resolvedSeed: seed, sizeMeters: SIZE });
  boot.update('都市を生成しています', `道路・建物・POIを生成中  seed ${seed}`, 0.10);
  await boot.paint();

  const world = new World(
    { seed, sizeMeters: SIZE, urbanRatioTarget: runtime.urbanRatioTarget, blockSize: runtime.blockSize, planning: runtime.planning },
    runtime.agentCapacity,
    runtime.vehicleCapacity,
  );
  const rail = world.city.planning.rail;
  rail.alignToRoadNetwork(world.city.net);
  const railClearance = reserveRailStationClearance(world.city, rail);
  console.info('[City-Sim] rail station clearance', railClearance);
  world.bus.addRailStationFeeders(rail.stations);

  boot.update('市民を配置しています', `${runtime.population.toLocaleString()}人の住居・職場・所有車を割り当てています`, 0.28);
  await boot.paint();
  world.populate(runtime.population);

  // Start earlier than the visible game clock and run the real simulation while the loading screen
  // is visible. This consumes the one-time all-Idle decision/routing burst before the first frame.
  world.clock.setBootstrapTime(BOOT_START_SECONDS);
  await preRollWorld(world, ({ progress, currentSeconds, batches }) => {
    const hh = String(Math.floor((currentSeconds / 3600) % 24)).padStart(2, '0');
    const mm = String(Math.floor((currentSeconds / 60) % 60)).padStart(2, '0');
    boot.update(
      '都市を安定化しています',
      `内部シミュレーション ${hh}:${mm} → 08:00  batch ${batches}`,
      0.34 + progress * 0.42,
    );
  });

  boot.update('描画データを構築しています', '建物・道路・鉄道・車両の表示データを準備しています', 0.80);
  await boot.paint();

  const app = document.getElementById('app')!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const daySky = new THREE.Color(0x9fb4cc), duskSky = new THREE.Color(0x6d7085), nightSky = new THREE.Color(0x091321);
  const currentSky = daySky.clone();
  scene.background = currentSky;
  const fogNear = Math.max(800, SIZE * 0.12), fogFar = Math.max(3000, SIZE * 0.75);
  scene.fog = new THREE.Fog(currentSky.clone(), fogNear, fogFar);

  const cameraFar = Math.max(8000, SIZE * 1.8);
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, cameraFar);
  const SPAWN_ALT = THREE.MathUtils.clamp(SIZE * 0.06, 450, 1200);
  camera.position.set(SIZE / 2, SPAWN_ALT, SIZE / 2);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(SIZE / 2 + 600, 1200, SIZE / 2 + 400); sun.castShadow = true;
  sun.target.position.set(SIZE / 2, 0, SIZE / 2);
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 100; sun.shadow.camera.far = Math.max(3000, SIZE * 0.5);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  const shadowSpan = Math.max(800, SIZE * 0.12);
  sc.left = -shadowSpan; sc.right = shadowSpan; sc.top = shadowSpan; sc.bottom = -shadowSpan;
  const hemi = new THREE.HemisphereLight(0xbdd7ff, 0x3a3a30, 0.6);
  scene.add(sun); scene.add(sun.target); scene.add(hemi);

  const gfx = new EnhancedRenderer(scene);
  gfx.buildStatic(world.city.buildings, world.city.net, world.sidewalk, world.city.parkingLots);
  buildSpecialFacilityVisuals(scene, world.city.facilities, world.city.parks);
  const railRenderer = new RailRenderer(scene, rail, world.city.net); railRenderer.build();
  const railScheduler = new RailFrameScheduler(railRenderer);
  const trainLivery = new TrainLiveryOverlay(scene, railRenderer);
  gfx.buildAgents(world.store.capacity);
  gfx.buildings.visible = false; gfx.agents.visible = false;
  gfx.buildVehicles(world.vehicles.capacity);
  const hitSphere = new THREE.Sphere(new THREE.Vector3(SIZE / 2, 0, SIZE / 2), Math.max(SIZE * 2, 20_000));
  gfx.agents.boundingSphere = hitSphere.clone();
  gfx.vehicles.boundingSphere = hitSphere.clone();
  gfx.buildSignals(world.city.net, world.signals);
  gfx.buildCrosswalks(world.city.net, world.signals);
  gfx.buildStopLines(world.city.net, world.signals);
  buildAlignedBusStops(scene, world.bus.stops);
  gfx.buildGates(world.city.gateNodes.map((n) => ({ x: world.city.net.nodes[n].x, z: world.city.net.nodes[n].z })));
  gfx.updateLod(camera.position, true);

  boot.update('操作系を準備しています', 'HUD・追跡カメラ・性能モニタを初期化しています', 0.93);
  await boot.paint();

  const controller = new FirstPersonController(camera, renderer.domElement, 0, -0.9);
  controller.setPosition(SIZE / 2, SPAWN_ALT, SIZE / 2);
  controller.followDistance = 12;
  const vehicleVisuals = new VehicleVisualSmoother(world.vehicles.capacity);
  renderer.domElement.addEventListener('wheel', (e) => {
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    if (controller.isFollowing) controller.followDistance = THREE.MathUtils.clamp(controller.followDistance * f, 3, 120);
    else controller.moveSpeed = THREE.MathUtils.clamp(controller.moveSpeed * f, 2, 800);
  });
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });

  const inspector = new Inspector(world, gfx, railRenderer, camera, renderer.domElement);
  const dashboard = new Dashboard(world, world.clock);
  const performanceMonitor = new PerformanceMonitor(world, renderer);
  let paused = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') { e.preventDefault(); paused = !paused; }
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyV') controller.toggleFollowView();
  });

  const hud = document.getElementById('hud')!; const clockEl = document.getElementById('clock')!;
  let fps = 60, lastStats = 0; const st = world.stats();
  let simBusy = false, pendingReal = 0, simMs = 0;
  let completedSimSeconds = 0, effectiveCompletedSimSeconds = 0, effectiveSimRate = 0;
  let completedBatchCount = 0;
  let speedSampleAt = performance.now(), speedSampleCompleted = 0;
  let observedSpeedEpoch = world.clock.speedEpoch;
  let speedRebaseCount = 0, rebasedRealSeconds = 0;
  let schedulerHold = window.__CITY_SIM_BENCH_HOLD__ === true;
  let railPendingCompletedSeconds = 0;
  let railInputSecondsTotal = 0, railProcessedSecondsTotal = 0, railBacklogSeconds = 0;
  let lastFollowLodMs = -Infinity;
  let wasFollowingForLod = false;

  function clockIcon(h: number): string { if (h >= 5 && h < 7) return '🌅'; if (h >= 7 && h < 17) return '☀️'; if (h >= 17 && h < 19) return '🌇'; if (h >= 19 && h < 22) return '🌆'; return '🌙'; }

  function updateEnvironment(): void {
    const phase = world.clock.dayPhase;
    const solar = Math.sin((phase - 0.25) * Math.PI * 2);
    const daylight = THREE.MathUtils.clamp((solar + 0.12) / 1.12, 0, 1);
    const twilight = THREE.MathUtils.clamp(1 - Math.abs(solar) * 3.2, 0, 1) * (1 - daylight * 0.5);
    currentSky.copy(nightSky).lerp(duskSky, twilight).lerp(daySky, daylight);
    scene.background = currentSky; if (scene.fog) scene.fog.color.copy(currentSky);
    sun.intensity = 0.12 + daylight * 2.25;
    hemi.intensity = 0.18 + daylight * 0.48 + twilight * 0.12;
    const a = phase * Math.PI * 2;
    const orbitX = Math.max(1200, SIZE * 0.38), orbitZ = Math.max(900, SIZE * 0.29);
    sun.position.set(SIZE / 2 + Math.cos(a) * orbitX, 100 + Math.max(0.08, solar) * Math.max(1350, SIZE * 0.18), SIZE / 2 + Math.sin(a) * orbitZ);
    sun.color.set(daylight > 0.25 ? 0xffffff : 0xffb46b);
  }

  function maxRealSecondsPerBatch(): number {
    const scale = world.clock.timeScale;
    if (scale <= 60) return 0.25;
    if (scale <= 180) return 0.5;
    return 1.0;
  }

  function totalRealLagSeconds(): number {
    return pendingReal + world.clock.pendingRealSeconds;
  }

  function rebasePendingReal(now = performance.now()): void {
    rebasedRealSeconds += Math.max(0, pendingReal);
    pendingReal = 0;
    observedSpeedEpoch = world.clock.speedEpoch;
    speedRebaseCount++;
    effectiveSimRate = 0;
    speedSampleAt = now;
    speedSampleCompleted = effectiveCompletedSimSeconds;
  }

  function renderIntervalMs(): number {
    if (paused) return 0;
    const lag = totalRealLagSeconds();
    if (lag < 0.05) return 0;

    const scale = world.clock.timeScale;
    let interval = 0;
    if (scale >= 1800) interval = 100;
    else if (scale >= 600) interval = 1000 / 15;
    else if (scale >= 180) interval = 1000 / 30;

    if (lag >= 5) interval = Math.max(interval, 1000 / 15);
    else if (lag >= 1) interval = Math.max(interval, 1000 / 20);
    else if (lag >= 0.1) interval = Math.max(interval, 1000 / 30);
    return interval;
  }

  async function runSimulationBatch(): Promise<void> {
    const hasClockDebt = world.clock.pendingSimSeconds >= world.clock.fixedStep;
    if (simBusy || paused || schedulerHold || (pendingReal <= 0 && !hasClockDebt)) return;
    const real = pendingReal > 0 ? Math.min(maxRealSecondsPerBatch(), pendingReal) : 0;
    pendingReal -= real;
    const batchSpeedEpoch = world.clock.speedEpoch;
    const steps = world.clock.advance(real); if (steps <= 0) return;
    const batchSimSeconds = world.clock.stepDt * steps;
    simBusy = true; const start = performance.now();
    try {
      await world.stepBatchAsync(world.clock.stepDt, steps);
      completedSimSeconds += batchSimSeconds;
      if (batchSpeedEpoch === world.clock.speedEpoch) effectiveCompletedSimSeconds += batchSimSeconds;
      completedBatchCount++;
      railPendingCompletedSeconds += batchSimSeconds;
      railInputSecondsTotal += batchSimSeconds;
      simMs = performance.now() - start;
      dashboard.sample();
    } catch (err) {
      simMs = performance.now() - start;
      console.error('[City-Sim] simulation batch failed', err);
    } finally {
      simBusy = false;
      const stillHasWork = pendingReal > 0.001 || world.clock.pendingSimSeconds >= world.clock.fixedStep;
      if (!paused && !schedulerHold && stillHasWork) setTimeout(() => { void runSimulationBatch(); }, 0);
    }
  }

  const schedulerSnapshot = (): SchedulerSnapshot => ({
    batchId: completedBatchCount,
    completedSimSeconds,
    pendingRealSeconds: pendingReal,
    clockPendingSimSeconds: world.clock.pendingSimSeconds,
    speedRebaseCount,
    rebasedRealSeconds,
    railInputSeconds: railInputSecondsTotal,
    railProcessedSeconds: railProcessedSecondsTotal,
    railBacklogSeconds,
    requestedPopulation: runtime.population,
    actualPopulation: world.store.count,
  });

  window.__CITY_SIM_SCHEDULER__ = {
    snapshot: schedulerSnapshot,
    hold: () => {
      schedulerHold = true;
      rebasedRealSeconds += Math.max(0, pendingReal);
      pendingReal = 0;
    },
    resume: () => {
      pendingReal = 0;
      observedSpeedEpoch = world.clock.speedEpoch;
      effectiveSimRate = 0;
      speedSampleAt = performance.now();
      speedSampleCompleted = effectiveCompletedSimSeconds;
      schedulerHold = false;
    },
    rebaseSpeed: () => rebasePendingReal(),
    waitForIdle: async (timeoutMs = 15_000): Promise<boolean> => {
      const deadline = performance.now() + Math.max(0, timeoutMs);
      while (simBusy && performance.now() < deadline) await new Promise<void>((resolve) => window.setTimeout(resolve, 1));
      return !simBusy;
    },
  };

  let prev = performance.now(), lastRenderedAt = prev;
  function frame(now: number): void {
    const wallDt = (now - prev) / 1000; prev = now;

    if (world.clock.speedEpoch !== observedSpeedEpoch) rebasePendingReal(now);

    if (!paused && !schedulerHold) {
      pendingReal += Math.min(Math.max(0, wallDt), 1.0);
      void runSimulationBatch();
    }

    if (now - speedSampleAt >= 500) {
      const elapsed = Math.max(1e-6, (now - speedSampleAt) / 1000);
      effectiveSimRate = (effectiveCompletedSimSeconds - speedSampleCompleted) / elapsed;
      speedSampleAt = now; speedSampleCompleted = effectiveCompletedSimSeconds;
    }

    const minRenderInterval = renderIntervalMs();
    if (minRenderInterval > 0 && now - lastRenderedAt < minRenderInterval) {
      requestAnimationFrame(frame);
      return;
    }

    const dt = Math.max(1e-4, (now - lastRenderedAt) / 1000); lastRenderedAt = now;
    fps += (1 / dt - fps) * 0.1;

    let mark = performance.now();
    vehicleVisuals.update(world.vehicles, dt); vehicleVisuals.apply(world.vehicles);
    const vehicleVisualMs = performance.now() - mark;
    try {
      const renderDt = Math.min(dt, 0.1);
      const railInputSeconds = paused ? 0 : railPendingCompletedSeconds;
      if (!paused) railPendingCompletedSeconds = 0;
      const railProfile = railScheduler.update(railInputSeconds, world.clock.timeScale, paused);
      railProcessedSecondsTotal += railProfile.processedSeconds;
      railBacklogSeconds = railProfile.backlogSeconds;
      mark = performance.now(); trainLivery.sync(renderDt); const liveryMs = performance.now() - mark;
      mark = performance.now();
      const followTarget = inspector.getFollowTarget();
      controller.setFollowTarget(followTarget); controller.update(dt); dashboard.draw();
      const preRenderOtherMs = performance.now() - mark;

      const renderStarted = performance.now();
      mark = renderStarted;
      const followingNow = controller.isFollowing;
      const followChanged = followingNow !== wasFollowingForLod;
      const shouldUpdateLod = !followingNow || followChanged || now - lastFollowLodMs >= 500;
      if (shouldUpdateLod) {
        gfx.updateLod(camera.position, followChanged);
        if (followingNow) lastFollowLodMs = now;
      }
      wasFollowingForLod = followingNow;
      const lodMs = performance.now() - mark;

      mark = performance.now(); gfx.syncAgents(world.store, world.clock.totalSeconds, camera.position); const agentsMs = performance.now() - mark;
      mark = performance.now(); gfx.syncVehicles(world.vehicles, world.clock.hourF, now / 1000, camera.position); const vehiclesMs = performance.now() - mark;

      inspector.update();

      mark = performance.now(); gfx.syncSignals(world.signals); const signalsMs = performance.now() - mark;
      mark = performance.now(); updateEnvironment(); gfx.updateNightLighting(world.clock.hourF, camera.position, world.vehicles); const lightingMs = performance.now() - mark;
      performanceMonitor.beginGpu(); mark = performance.now(); renderer.render(scene, camera); const webglMs = performance.now() - mark; performanceMonitor.endGpu();
      const renderProfile: RenderProfileSample = {
        totalMs: performance.now() - renderStarted,
        lodMs, agentsMs, vehiclesMs, signalsMs, lightingMs, webglMs,
        railOpsMs: railProfile.operationsMs,
        railVisualMs: railProfile.visualsMs,
        railSteps: railProfile.steps,
        railStepSeconds: railProfile.averageStepSeconds,
        railBacklogSec: railProfile.backlogSeconds,
        liveryMs,
        vehicleVisualMs,
        preRenderOtherMs,
      };
      const lod = gfx.getLodStats();
      const totalLag = totalRealLagSeconds();
      performanceMonitor.update(now, dt * 1000, fps, renderProfile, lod, totalLag, simBusy);

      const c = world.clock; const hh = String(c.hour).padStart(2, '0'), mm = String(c.minute).padStart(2, '0'), ss = String(c.second).padStart(2, '0');
      clockEl.innerHTML = `<span class="icon">${clockIcon(c.hour)}</span><span>${hh}:${mm}<span style="font-size:13px;opacity:.7">:${ss}</span></span><span class="day">DAY ${c.day}</span>${paused ? '<span class="day">⏸ PAUSED</span>' : ''}`;
      if (now - lastStats > 250) {
        lastStats = now; const dv = world.stats();
        const threadText = world.simulationWorkerCount > 0 ? `${world.simulationWorkerCount} workers/SAB` : 'single-thread fallback';
        const followKind = controller.isFollowingTrain ? '列車' : controller.isFollowingVehicle ? '車両' : controller.isFollowingAgent ? '市民' : '対象';
        const followText = controller.isFollowing
          ? controller.isFirstPerson ? `追跡中 ${followKind}一人称` : `追跡中 ${followKind} dist ${controller.followDistance.toFixed(0)}m`
          : `speed ${controller.moveSpeed.toFixed(0)} m/s`;
        hud.textContent = `FPS ${fps.toFixed(0)}   sim ${simMs.toFixed(1)}ms ${simBusy ? 'BUSY' : 'idle'}   ×${dashboard.speedLabel}\ntarget ${world.clock.timeScale.toFixed(0)} sim-s/s  effective ${effectiveSimRate.toFixed(0)} sim-s/s  lag ${totalLag.toFixed(2)} real-s\ncity ${runtime.areaKm2.toFixed(0)}km²  urban ${(runtime.urbanRatioTarget * 100).toFixed(0)}%  seed ${seed}\nplan CBD+${runtime.planning.subCenters} sub  arterial ${runtime.planning.arterialSpacing}m  collector ${runtime.planning.collectorSpacing}m\n🚆 鉄道 ${rail.lines.length}路線/${rail.stations.length}駅  列車${railRenderer.trainCount}編成  鉄道信号${railRenderer.signalCount}  信号待ち${railRenderer.waitingTrainCount}\n駅間${runtime.planning.railStationSpacing.toFixed(0)}m  TOD半径${runtime.planning.railInfluenceRadius.toFixed(0)}m  駅用除去 建物${railClearance.buildingsRemoved}/駐車${railClearance.parkingLotsRemoved}\nagents ${st.agents}/${runtime.population}  車 走行${dv.vehiclesDriving}/所有${dv.vehiclesTotal}  🚌${dv.buses}台/${dv.busRoutes}路線\nLOD 建物 ${lod.buildings.join('/')}  人 ${lod.agents.join('/')}  車 ${lod.vehicles.join('/')}\nSIM ${threadText}  shared=${world.sharedAgentMemory ? 'yes' : 'no'}  batch ${completedBatchCount}\nRail input ${railInputSecondsTotal.toFixed(0)}s  processed ${railProcessedSecondsTotal.toFixed(0)}s  backlog ${railBacklogSeconds.toFixed(1)}s\nbuildings ${st.buildings}  駐車場 ${st.parkingLots}  特殊施設 ${world.city.facilities.length}  公園 ${world.city.parks.length}\n停留所 ${dv.busStops}  信号 ${st.signals}\n📦 トラック${dv.trucks}台/ゲート${dv.gates}  棚切れ ${dv.storesEmpty}/${dv.stores}\n${followText}  ${controller.isDragging ? '● looking' : '○ inspect'}\n[WASD=move E/Space=up Q/Ctrl=down LShift=sprint LMB=drag]\n[Tab=pause  [ ]=speed  P=perf  G=activity graph  V=追跡一人称/三人称  MMB=人/車/列車を追跡]`;
      }
    } catch (err) {
      console.error('[City-Sim] render frame failed; continuing next frame', err);
    } finally {
      vehicleVisuals.restore(world.vehicles);
    }
    requestAnimationFrame(frame);
  }

  boot.finish();
  window.dispatchEvent(new Event('citysim-ready'));
  requestAnimationFrame(frame);
}

bootstrap().catch((err: unknown) => {
  console.error('[City-Sim] startup failed', err);
  const message = err instanceof Error ? err.message : String(err);
  boot.fail(message);
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = `<pre style="padding:24px;color:#ffb4b4;background:#1a1111;white-space:pre-wrap">City-Sim startup failed\n${message}</pre>`;
  }
});
