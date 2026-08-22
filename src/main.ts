import * as THREE from 'three';
import { World } from './world/World';
import { InstancedRenderer } from './rendering/InstancedRenderer';
import { FirstPersonController } from './rendering/FirstPersonController';
import { Inspector } from './rendering/Inspector';
import { Dashboard } from './rendering/Dashboard';

const SIZE = Math.sqrt(10_000_000);
const world = new World({ seed: 12345, sizeMeters: SIZE, urbanRatioTarget: 1 / 3, blockSize: 90 }, 20_000, 8_000);
world.populate(4000);

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4cc);
scene.fog = new THREE.Fog(0x9fb4cc, 800, 3000);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 8000);
const SPAWN_ALT = 450;
camera.position.set(SIZE / 2, SPAWN_ALT, SIZE / 2);

const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(600, 1200, 400); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 100; sun.shadow.camera.far = 3000;
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -800; sc.right = 800; sc.top = 800; sc.bottom = -800;
scene.add(sun); scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x3a3a30, 0.6));

const gfx = new InstancedRenderer(scene);
gfx.buildStatic(world.city.buildings, world.city.net, world.sidewalk, world.city.parkingLots);
gfx.buildAgents(world.store.capacity);
gfx.buildVehicles(world.vehicles.capacity);
gfx.buildSignals(world.city.net, world.signals);
gfx.buildCrosswalks(world.city.net, world.signals);
gfx.buildStopLines(world.city.net, world.signals);
gfx.buildBusStops(world.bus.stops);
gfx.buildGates(world.city.gateNodes.map((n) => ({ x: world.city.net.nodes[n].x, z: world.city.net.nodes[n].z })));

const controller = new FirstPersonController(camera, renderer.domElement, 0, -0.9);
controller.setPosition(SIZE / 2, SPAWN_ALT, SIZE / 2);
controller.followDistance = 12;
renderer.domElement.addEventListener('wheel', (e) => { const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; if (controller.isFollowing) controller.followDistance = THREE.MathUtils.clamp(controller.followDistance * f, 3, 120); else controller.moveSpeed = THREE.MathUtils.clamp(controller.moveSpeed * f, 2, 400); });
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });

const inspector = new Inspector(world, gfx, camera, renderer.domElement);
const dashboard = new Dashboard(world, world.clock);
let paused = false;
window.addEventListener('keydown', (e) => { if (e.code === 'Tab') { e.preventDefault(); paused = !paused; } if (e.code === 'Space') e.preventDefault(); });

const hud = document.getElementById('hud')!; const clockEl = document.getElementById('clock')!;
let fps = 60, lastStats = 0; const st = world.stats();
function clockIcon(h: number): string { if (h >= 5 && h < 7) return '🌅'; if (h >= 7 && h < 17) return '☀️'; if (h >= 17 && h < 19) return '🌇'; if (h >= 19 && h < 22) return '🌆'; return '🌙'; }

let prev = performance.now();
function frame(now: number): void {
  const dt = (now - prev) / 1000; prev = now; fps += (1 / Math.max(dt, 1e-4) - fps) * 0.1;
  if (!paused) { const steps = world.clock.advance(dt); for (let s = 0; s < steps; s++) world.step(world.clock.stepDt); gfx.syncAgents(world.store); gfx.syncVehicles(world.vehicles); gfx.syncSignals(world.signals); dashboard.sample(); }
  controller.setFollowTarget(inspector.getFollowPosition()); controller.update(dt); inspector.update(); dashboard.draw();
  renderer.render(scene, camera);
  const c = world.clock; const hh = String(c.hour).padStart(2, '0'), mm = String(c.minute).padStart(2, '0'), ss = String(c.second).padStart(2, '0');
  clockEl.innerHTML = `<span class="icon">${clockIcon(c.hour)}</span><span>${hh}:${mm}<span style="font-size:13px;opacity:.7">:${ss}</span></span><span class="day">DAY ${c.day}</span>${paused ? '<span class="day">⏸ PAUSED</span>' : ''}`;
  if (now - lastStats > 250) {
    lastStats = now; const dv = world.stats();
    hud.textContent = `FPS ${fps.toFixed(0)}   ×${dashboard.speedLabel}\nagents ${st.agents}  車 走行${dv.vehiclesDriving}/所有${dv.vehiclesTotal}  🚌${dv.buses}台/${dv.busRoutes}路線\nbuildings ${st.buildings}  駐車場 ${st.parkingLots}  停留所 ${dv.busStops}  信号 ${st.signals}\n📦 トラック${dv.trucks}台/ゲート${dv.gates}  棚切れ ${dv.storesEmpty}/${dv.stores}\n${controller.isFollowing ? `追跡中 dist ${controller.followDistance.toFixed(0)}m` : `speed ${controller.moveSpeed.toFixed(0)} m/s`}  ${controller.isDragging ? '● looking' : '○ inspect'}\n[WASD=move E/Space=up Q/Ctrl=down LShift=sprint LMB=drag]\n[Tab=pause  [ ]=speed  release LMB=inspect  MMB=人/車を追跡]`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
