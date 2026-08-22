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

// --- 一人称カメラ操作(左ドラッグ視点 + WASDQE) ---
// 上空スポーンなので、初期は少し下(pitch < 0)を向けて街を見下ろす
const controller = new FirstPersonController(camera, renderer.domElement, 0, -0.9);
controller.setPosition(SIZE / 2, SPAWN_ALT, SIZE / 2);
controller.followDistance = 12;
// ホイール: 自由移動中は移動速度、追跡中は追跡距離を調整
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

// --- Ctrl押下中のホバーで対象を調査するインスペクタ ---
const inspector = new Inspector(world, gfx, camera, renderer.domElement);

// --- 時間帯グラフ + 速度コントロール(右上ダッシュボード) ---
const dashboard = new Dashboard(world, world.clock);

// --- Tab でシミュレーションの一時停止 / 再開 ---
let paused = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') {
    e.preventDefault(); // フォーカス移動を抑制
    paused = !paused;
  }
  // Space/Ctrl は上下移動に使うため、既定のスクロール等を抑制
  if (e.code === 'Space') e.preventDefault();
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

  // 固定ステップでシミュレーションを進める(一時停止中はスキップ)
  if (!paused) {
    const steps = world.clock.advance(dt);
    for (let s = 0; s < steps; s++) world.step(world.clock.fixedStep);
    // 描画同期(停止中は座標が動かないので更新不要)
    gfx.syncAgents(world.store);
    // 時間帯グラフのサンプリング(ゲーム内時刻ビン単位で記録)
    dashboard.sample();
  }

  // 追跡対象の連携: インスペクタが追跡中ならカメラを対象に追従させる
  controller.setFollowTarget(inspector.getFollowPosition());

  // カメラ更新(一人称)は停止中も有効(街を見て回れる)
  controller.update(dt);

  // ホバー調査 & 追跡ステータス表示
  inspector.update();

  renderer.render(scene, camera);

  // ダッシュボード(時間帯グラフ)は毎フレーム再描画(現在時刻マーカーを滑らかに)
  dashboard.draw();

  if (now - lastStats > 250) {
    lastStats = now;
    hud.textContent =
      `FPS ${fps.toFixed(0)}   ${world.clock.format()}   ${paused ? '⏸ PAUSED' : '▶ running'}  ×${dashboard.speedLabel}\n` +
      `agents ${st.agents}  buildings ${st.buildings}\n` +
      `road nodes ${st.nodes}  POIs ${st.pois}\n` +
      `urban threshold ${world.city.urbanThreshold.toFixed(3)}\n` +
      `${controller.isFollowing ? `following #, dist ${controller.followDistance.toFixed(0)}m` : `speed ${controller.moveSpeed.toFixed(0)} m/s`}  ${controller.isDragging ? '● looking' : '○ inspect mode'}\n` +
      `[WASD=move  Q/Space=up  E/Ctrl=down  LShift=sprint  LMB+drag=look]\n` +
      `[Tab=pause  [ ]=speed  release LMB=inspect  MMB on agent=follow]`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
