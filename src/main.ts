import * as THREE from 'three';
import { World } from './world/World';
import { InstancedRenderer } from './rendering/InstancedRenderer';
import { FirstPersonController } from './rendering/FirstPersonController';
import { Inspector } from './rendering/Inspector';
import { Dashboard } from './rendering/Dashboard';

/**
 * エントリポイント: three.js のセットアップ + 固定ステップのシミュレーションループ。
 *
 * ループ構造(可変フレーム→固定シミュレーション):
 *   requestAnimationFrame ごとに、経過実時間から clock.advance() で
 *   実行すべき固定ステップ数を得て world.step() を回す。描画は毎フレーム1回。
 *   → フレームレートが揺れても挙動(物理/AI)は決定論的で安定する。
 */

// --- 初期フェーズ設定: 10km² / 市街地 約1/3 ---
const SIZE = Math.sqrt(10_000_000); // ≈ 3162 m 四方 = 10km²
const world = new World(
  { seed: 12345, sizeMeters: SIZE, urbanRatioTarget: 1 / 3, blockSize: 90 },
  20_000,  // エージェント収容上限
  6_000,   // 車両収容上限
);
world.populate(4000);

// --- three.js ---
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4cc);
scene.fog = new THREE.Fog(0x9fb4cc, 800, 3000);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 8000);
// 初期スポーンは上空(街を俯瞰しながら降下していける)
const SPAWN_ALT = 450;
camera.position.set(SIZE / 2, SPAWN_ALT, SIZE / 2);

const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(600, 1200, 400);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 100; sun.shadow.camera.far = 3000;
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -800; sc.right = 800; sc.top = 800; sc.bottom = -800;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x3a3a30, 0.6));

// --- 描画バインド ---
const gfx = new InstancedRenderer(scene);
gfx.buildStatic(world.city.buildings, world.city.net);
gfx.buildAgents(world.store.capacity);
gfx.buildVehicles(world.vehicles.capacity);

// --- 一人称カメラ操作(左ドラッグ視点 + WASDQE) ---
const controller = new FirstPersonController(camera, renderer.domElement, 0, -0.9);
controller.setPosition(SIZE / 2, SPAWN_ALT, SIZE / 2);
controller.followDistance = 12;
renderer.domElement.addEventListener('wheel', (e) => {
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  if (controller.isFollowing) {
    controller.followDistance = THREE.MathUtils.clamp(controller.followDistance * f, 3, 120);
  } else {
    controller.moveSpeed = THREE.MathUtils.clamp(controller.moveSpeed * f, 2, 400);
  }
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- インスペクタ & ダッシュボード ---
const inspector = new Inspector(world, gfx, camera, renderer.domElement);
const dashboard = new Dashboard(world, world.clock);

// --- Tab で一時停止 / 再開 ---
let paused = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') { e.preventDefault(); paused = !paused; }
  if (e.code === 'Space') e.preventDefault();
});

// --- HUD / 時計 ---
const hud = document.getElementById('hud')!;
const clockEl = document.getElementById('clock')!;
let fps = 60, lastStats = 0;
const st = world.stats();

// ゲーム内時刻に応じた簡単な情景アイコン
function clockIcon(hour: number): string {
  if (hour >= 5 && hour < 7) return '🌅';
  if (hour >= 7 && hour < 17) return '☀️';
  if (hour >= 17 && hour < 19) return '🌇';
  if (hour >= 19 && hour < 22) return '🌆';
  return '🌙';
}

// --- メインループ ---
let prev = performance.now();
function frame(now: number): void {
  const dt = (now - prev) / 1000;
  prev = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.1;

  if (!paused) {
    const steps = world.clock.advance(dt);
    for (let s = 0; s < steps; s++) world.step(world.clock.fixedStep);
    gfx.syncAgents(world.store);
    gfx.syncVehicles(world.vehicles);
    dashboard.sample();
  }

  controller.setFollowTarget(inspector.getFollowPosition());
  controller.update(dt);
  inspector.update();
  dashboard.draw();

  renderer.render(scene, camera);

  // 現在時刻(大きく常時表示、秒まで)
  const c = world.clock;
  const hh = String(c.hour).padStart(2, '0');
  const mm = String(c.minute).padStart(2, '0');
  const ss = String(c.second).padStart(2, '0');
  clockEl.innerHTML =
    `<span class="icon">${clockIcon(c.hour)}</span>` +
    `<span>${hh}:${mm}<span style="font-size:13px;opacity:.7">:${ss}</span></span>` +
    `<span class="day">DAY ${c.day}</span>` +
    `${paused ? '<span class="day">⏸ PAUSED</span>' : ''}`;

  if (now - lastStats > 250) {
    lastStats = now;
    hud.textContent =
      `FPS ${fps.toFixed(0)}   ×${dashboard.speedLabel}\n` +
      `agents ${st.agents}  vehicles ${world.vehicles.count}\n` +
      `buildings ${st.buildings}  POIs ${st.pois}  nodes ${st.nodes}\n` +
      `${controller.isFollowing ? `following #, dist ${controller.followDistance.toFixed(0)}m` : `speed ${controller.moveSpeed.toFixed(0)} m/s`}  ${controller.isDragging ? '● looking' : '○ inspect mode'}\n` +
      `[WASD=move  E/Space=up  Q/Ctrl=down  LShift=sprint  LMB+drag=look]\n` +
      `[Tab=pause  [ ]=speed  release LMB=inspect  MMB on agent=follow]`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
