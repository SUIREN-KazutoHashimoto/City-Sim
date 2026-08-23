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
import { TrainLiveryOverlay } from './rendering/TrainLiveryOverlay';
import { VehicleVisualSmoother } from './rendering/VehicleVisualSmoother';
import { reserveRailStationClearance } from './generation/RailStationClearance';
import { loadCityConfig, resolveCitySeed } from './config/CityConfigLoader';

async function bootstrap(): Promise<void> {
  const runtime = await loadCityConfig();
  const seed = resolveCitySeed(runtime.seed);
  const SIZE = Math.sqrt(runtime.areaKm2 * 1_000_000);

  console.info('[City-Sim] city config', { ...runtime, resolvedSeed: seed, sizeMeters: SIZE });

  const world = new World(
    { seed, sizeMeters: SIZE, urbanRatioTarget: runtime.urbanRatioTarget, blockSize: runtime.blockSize, planning: runtime.planning },
    runtime.agentCapacity,
    runtime.vehicleCapacity,
  );
  // TODは計画駅位置で生成時に反映済み。道路完成後に実駅位置を確定し、駅構内空地を人口生成前に確保する。
  const rail = world.city.planning.rail;
  rail.alignToRoadNetwork(world.city.net);
  const railClearance = reserveRailStationClearance(world.city, rail);
  console.info('[City-Sim] rail station clearance', railClearance);
  world.bus.addRailStationFeeders(rail.stations);
  world.populate(runtime.population);

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
  const trainLivery = new TrainLiveryOverlay(scene, railRenderer);
  gfx.buildAgents(world.store.capacity);
  // Inspectorは透明proxyへraycastする。visible=falseでもRaycasterは拾えるが、
  // 動的InstancedMeshの自動boundingSphereが初回未配置状態で固定されないよう都市全体のSphereを明示する。
  gfx.buildings.visible = false; gfx.agents.visible = false;
  gfx.buildVehicles(world.vehicles.capacity);
  const hitSphere = new THREE.Sphere(new THREE.Vector3(SIZE / 2, 0, SIZE / 2), Math.max(SIZE * 2, 20_000));
  gfx.agents.boundingSphere = hitSphere.clone();
  gfx.vehicles.boundingSphere = hitSphere.clone();
  gfx.buildSignals(world.city.net, world.signals);
  gfx.buildCrosswalks(world.city.net, world.signals);
  gfx.buildStopLines(world.city.net, world.signals);
  // EnhancedRendererの旧固定方向バス停は使わず、道路heading/side対応Rendererを使用する。
  buildAlignedBusStops(scene, world.bus.stops);
  gfx.buildGates(world.city.gateNodes.map((n) => ({ x: world.city.net.nodes[n].x, z: world.city.net.nodes[n].z })));
  gfx.updateLod(camera.position, true);

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

  async function runSimulationBatch(): Promise<void> {
    if (simBusy || paused || pendingReal <= 0) return;
    const real = Math.min(0.25, pendingReal); pendingReal -= real;
    const steps = world.clock.advance(real); if (steps <= 0) return;
    simBusy = true; const start = performance.now();
    try {
      await world.stepBatchAsync(world.clock.stepDt, steps);
      simMs = performance.now() - start;
      dashboard.sample();
    } catch (err) {
      simMs = performance.now() - start;
      console.error('[City-Sim] simulation batch failed', err);
    } finally {
      simBusy = false;
      if (!paused && pendingReal > 0.001) setTimeout(() => { void runSimulationBatch(); }, 0);
    }
  }

  let prev = performance.now();
  function frame(now: number): void {
    const dt = (now - prev) / 1000; prev = now; fps += (1 / Math.max(dt, 1e-4) - fps) * 0.1;
    if (!paused) { pendingReal = Math.min(0.5, pendingReal + Math.min(dt, 0.1)); void runSimulationBatch(); }

    // SIM値とは別の実時間補間poseを、camera/Inspector/render/lightの間だけVehicleStoreへ適用する。
    vehicleVisuals.update(world.vehicles, dt); vehicleVisuals.apply(world.vehicles);
    try {
      const renderDt = Math.min(dt, 0.1);
      // 列車の運行元時刻も車/バスと同じWorld時計へ戻す。
      // 最終表示だけTrainLiveryOverlayで一次指数補間し、二次系のばね挙動を画面へ出さない。
      railRenderer.update(world.clock.totalSeconds, renderDt);
      trainLivery.sync(renderDt);
      controller.setFollowTarget(inspector.getFollowTarget()); controller.update(dt); dashboard.draw();

      const renderStarted = performance.now();
      let mark = renderStarted;
      gfx.updateLod(camera.position); const lodMs = performance.now() - mark;
      mark = performance.now(); gfx.syncAgents(world.store, world.clock.totalSeconds, camera.position); const agentsMs = performance.now() - mark;
      mark = performance.now(); gfx.syncVehicles(world.vehicles, world.clock.hourF, now / 1000, camera.position); const vehiclesMs = performance.now() - mark;

      // hover/追跡候補判定は、そのフレームで更新済みの動的proxyに対して行う。
      inspector.update();

      mark = performance.now(); gfx.syncSignals(world.signals); const signalsMs = performance.now() - mark;
      mark = performance.now(); updateEnvironment(); gfx.updateNightLighting(world.clock.hourF, camera.position, world.vehicles); const lightingMs = performance.now() - mark;
      performanceMonitor.beginGpu(); mark = performance.now(); renderer.render(scene, camera); const webglMs = performance.now() - mark; performanceMonitor.endGpu();
      const renderProfile: RenderProfileSample = { totalMs: performance.now() - renderStarted, lodMs, agentsMs, vehiclesMs, signalsMs, lightingMs, webglMs };
      const lod = gfx.getLodStats();
      performanceMonitor.update(now, dt * 1000, fps, renderProfile, lod, pendingReal, simBusy);

      const c = world.clock; const hh = String(c.hour).padStart(2, '0'), mm = String(c.minute).padStart(2, '0'), ss = String(c.second).padStart(2, '0');
      clockEl.innerHTML = `<span class="icon">${clockIcon(c.hour)}</span><span>${hh}:${mm}<span style="font-size:13px;opacity:.7">:${ss}</span></span><span class="day">DAY ${c.day}</span>${paused ? '<span class="day">⏸ PAUSED</span>' : ''}`;
      if (now - lastStats > 250) {
        lastStats = now; const dv = world.stats();
        const threadText = world.simulationWorkerCount > 0 ? `${world.simulationWorkerCount} workers/SAB` : 'single-thread fallback';
        const followKind = controller.isFollowingTrain ? '列車' : controller.isFollowingVehicle ? '車両' : controller.isFollowingAgent ? '市民' : '対象';
        const followText = controller.isFollowing
          ? controller.isFirstPerson ? `追跡中 ${followKind}一人称` : `追跡中 ${followKind} dist ${controller.followDistance.toFixed(0)}m`
          : `speed ${controller.moveSpeed.toFixed(0)} m/s`;
        hud.textContent = `FPS ${fps.toFixed(0)}   sim ${simMs.toFixed(1)}ms ${simBusy ? 'BUSY' : 'idle'}   ×${dashboard.speedLabel}\ncity ${runtime.areaKm2.toFixed(0)}km²  urban ${(runtime.urbanRatioTarget * 100).toFixed(0)}%  seed ${seed}\nplan CBD+${runtime.planning.subCenters} sub  arterial ${runtime.planning.arterialSpacing}m  collector ${runtime.planning.collectorSpacing}m\n🚆 鉄道 ${rail.lines.length}路線/${rail.stations.length}駅  列車${railRenderer.trainCount}編成  鉄道信号${railRenderer.signalCount}  信号待ち${railRenderer.waitingTrainCount}\n駅間${runtime.planning.railStationSpacing.toFixed(0)}m  TOD半径${runtime.planning.railInfluenceRadius.toFixed(0)}m  駅用除去 建物${railClearance.buildingsRemoved}/駐車${railClearance.parkingLotsRemoved}\nagents ${st.agents}/${runtime.population}  車 走行${dv.vehiclesDriving}/所有${dv.vehiclesTotal}  🚌${dv.buses}台/${dv.busRoutes}路線\nLOD 建物 ${lod.buildings.join('/')}  人 ${lod.agents.join('/')}  車 ${lod.vehicles.join('/')}\nSIM ${threadText}  shared=${world.sharedAgentMemory ? 'yes' : 'no'}\nbuildings ${st.buildings}  駐車場 ${st.parkingLots}  特殊施設 ${world.city.facilities.length}  公園 ${world.city.parks.length}\n停留所 ${dv.busStops}  信号 ${st.signals}\n📦 トラック${dv.trucks}台/ゲート${dv.gates}  棚切れ ${dv.storesEmpty}/${dv.stores}\n${followText}  ${controller.isDragging ? '● looking' : '○ inspect'}\n[WASD=move E/Space=up Q/Ctrl=down LShift=sprint LMB=drag]\n[Tab=pause  [ ]=speed  P=perf  G=activity graph  V=追跡一人称/三人称  MMB=人/車/列車を追跡]`;
      }
    } finally {
      vehicleVisuals.restore(world.vehicles);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

bootstrap().catch((err: unknown) => {
  console.error('[City-Sim] startup failed', err);
  const app = document.getElementById('app');
  if (app) {
    const message = err instanceof Error ? err.message : String(err);
    app.innerHTML = `<pre style="padding:24px;color:#ffb4b4;background:#1a1111;white-space:pre-wrap">City-Sim startup failed\n${message}</pre>`;
  }
});
