import * as THREE from 'three';
import { World } from './world/World';
import { EnhancedRenderer } from './rendering/EnhancedRenderer';
import { FirstPersonController } from './rendering/FirstPersonController';
import { Inspector } from './rendering/Inspector';
import { Dashboard } from './rendering/Dashboard';
import { loadCityConfig, resolveCitySeed } from './config/CityConfigLoader';

async function bootstrap(): Promise<void> {
  const runtime = await loadCityConfig();
  const seed = resolveCitySeed(runtime.seed);
  const SIZE = Math.sqrt(runtime.areaKm2 * 1_000_000);

  console.info('[City-Sim] city config', { ...runtime, resolvedSeed: seed, sizeMeters: SIZE });

  const world = new World(
    { seed, sizeMeters: SIZE, urbanRatioTarget: runtime.urbanRatioTarget, blockSize: runtime.blockSize },
    runtime.agentCapacity,
    runtime.vehicleCapacity,
  );
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
  gfx.buildAgents(world.store.capacity);
  // Inspectorはinvisible meshにもraycastできるため、hit proxyはGPU描画から外す。
  gfx.buildings.visible = false; gfx.agents.visible = false;
  gfx.buildVehicles(world.vehicles.capacity);
  gfx.buildSignals(world.city.net, world.signals);
  gfx.buildCrosswalks(world.city.net, world.signals);
  gfx.buildStopLines(world.city.net, world.signals);
  gfx.buildBusStops(world.bus.stops);
  gfx.buildGates(world.city.gateNodes.map((n) => ({ x: world.city.net.nodes[n].x, z: world.city.net.nodes[n].z })));
  gfx.updateLod(camera.position, true);

  const controller = new FirstPersonController(camera, renderer.domElement, 0, -0.9);
  controller.setPosition(SIZE / 2, SPAWN_ALT, SIZE / 2);
  controller.followDistance = 12;
  renderer.domElement.addEventListener('wheel', (e) => {
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    if (controller.isFollowing) controller.followDistance = THREE.MathUtils.clamp(controller.followDistance * f, 3, 120);
    else controller.moveSpeed = THREE.MathUtils.clamp(controller.moveSpeed * f, 2, 800);
  });
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });

  const inspector = new Inspector(world, gfx, camera, renderer.domElement);
  const dashboard = new Dashboard(world, world.clock);
  let paused = false;
  window.addEventListener('keydown', (e) => { if (e.code === 'Tab') { e.preventDefault(); paused = !paused; } if (e.code === 'Space') e.preventDefault(); });

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
      dashboard.sample();
    } catch (err) {
      console.error('[City-Sim] simulation batch failed', err);
    } finally {
      simMs = performance.now() - start; simBusy = false;
      if (!paused && pendingReal > 0.001) setTimeout(() => { void runSimulationBatch(); }, 0);
    }
  }

  let prev = performance.now();
  function frame(now: number): void {
    const dt = (now - prev) / 1000; prev = now; fps += (1 / Math.max(dt, 1e-4) - fps) * 0.1;
    if (!paused) { pendingReal = Math.min(0.5, pendingReal + Math.min(dt, 0.1)); void runSimulationBatch(); }

    gfx.updateLod(camera.position);
    gfx.syncAgents(world.store, world.clock.totalSeconds, camera.position);
    gfx.syncVehicles(world.vehicles, world.clock.hourF, now / 1000, camera.position);
    gfx.syncSignals(world.signals);
    updateEnvironment();
    gfx.updateNightLighting(world.clock.hourF, camera.position, world.vehicles);

    controller.setFollowTarget(inspector.getFollowPosition()); controller.update(dt); inspector.update(); dashboard.draw();
    renderer.render(scene, camera);
    const c = world.clock; const hh = String(c.hour).padStart(2, '0'), mm = String(c.minute).padStart(2, '0'), ss = String(c.second).padStart(2, '0');
    clockEl.innerHTML = `<span class="icon">${clockIcon(c.hour)}</span><span>${hh}:${mm}<span style="font-size:13px;opacity:.7">:${ss}</span></span><span class="day">DAY ${c.day}</span>${paused ? '<span class="day">⏸ PAUSED</span>' : ''}`;
    if (now - lastStats > 250) {
      lastStats = now; const dv = world.stats(), lod = gfx.getLodStats();
      const threadText = world.simulationWorkerCount > 0 ? `${world.simulationWorkerCount} workers/SAB` : 'single-thread fallback';
      hud.textContent = `FPS ${fps.toFixed(0)}   sim ${simMs.toFixed(1)}ms ${simBusy ? 'BUSY' : 'idle'}   ×${dashboard.speedLabel}\ncity ${runtime.areaKm2.toFixed(0)}km²  urban ${(runtime.urbanRatioTarget * 100).toFixed(0)}%  seed ${seed}\nagents ${st.agents}/${runtime.population}  車 走行${dv.vehiclesDriving}/所有${dv.vehiclesTotal}  🚌${dv.buses}台/${dv.busRoutes}路線\nLOD 建物 ${lod.buildings.join('/')}  人 ${lod.agents.join('/')}  車 ${lod.vehicles.join('/')}\nSIM ${threadText}  shared=${world.sharedAgentMemory ? 'yes' : 'no'}\nbuildings ${st.buildings}  駐車場 ${st.parkingLots}  停留所 ${dv.busStops}  信号 ${st.signals}\n📦 トラック${dv.trucks}台/ゲート${dv.gates}  棚切れ ${dv.storesEmpty}/${dv.stores}\n${controller.isFollowing ? `追跡中 dist ${controller.followDistance.toFixed(0)}m` : `speed ${controller.moveSpeed.toFixed(0)} m/s`}  ${controller.isDragging ? '● looking' : '○ inspect'}\n[WASD=move E/Space=up Q/Ctrl=down LShift=sprint LMB=drag]\n[Tab=pause  [ ]=speed  release LMB=inspect  MMB=人/車を追跡]`;
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
