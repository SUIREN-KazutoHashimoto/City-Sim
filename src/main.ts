import * as THREE from 'three';
import { World } from './world/World';
import { InstancedRenderer } from './rendering/InstancedRenderer';

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
  20_000, // エージェント収容上限
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
camera.position.set(SIZE / 2, 350, SIZE / 2 + 400);
camera.lookAt(SIZE / 2, 0, SIZE / 2);

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

// --- 簡易オービットカメラ操作(マウスドラッグ + ホイール) ---
let dragging = false, px = 0, py = 0;
let yaw = 0, pitch = 0.9, radius = 700;
const target = new THREE.Vector3(SIZE / 2, 0, SIZE / 2);
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; px = e.clientX; py = e.clientY; });
window.addEventListener('pointerup', () => (dragging = false));
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - px) * 0.005;
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - py) * 0.005, 0.2, 1.45);
  px = e.clientX; py = e.clientY;
});
renderer.domElement.addEventListener('wheel', (e) => {
  radius = THREE.MathUtils.clamp(radius * (1 + Math.sign(e.deltaY) * 0.1), 60, 3000);
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- HUD / FPS ---
const hud = document.getElementById('hud')!;
let fps = 60, lastStats = 0;
const st = world.stats();

// --- メインループ ---
let prev = performance.now();
function frame(now: number): void {
  const dt = (now - prev) / 1000;
  prev = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.1;

  // 固定ステップでシミュレーションを進める
  const steps = world.clock.advance(dt);
  for (let s = 0; s < steps; s++) world.step(world.clock.fixedStep);

  // 描画同期
  gfx.syncAgents(world.store);

  // カメラ更新
  camera.position.set(
    target.x + radius * Math.sin(yaw) * Math.sin(pitch),
    target.y + radius * Math.cos(pitch),
    target.z + radius * Math.cos(yaw) * Math.sin(pitch),
  );
  camera.lookAt(target);

  renderer.render(scene, camera);

  if (now - lastStats > 250) {
    lastStats = now;
    hud.textContent =
      `FPS ${fps.toFixed(0)}   ${world.clock.format()}\n` +
      `agents ${st.agents}  buildings ${st.buildings}\n` +
      `road nodes ${st.nodes}  POIs ${st.pois}\n` +
      `urban threshold ${world.city.urbanThreshold.toFixed(3)}\n` +
      `[drag=rotate  wheel=zoom]`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
