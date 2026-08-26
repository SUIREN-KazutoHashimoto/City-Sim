import * as THREE from 'three';

export const MAP_CARDINAL_DIRECTIONS = Object.freeze({
  north: Object.freeze({ x: 1, z: 0 }),
  east: Object.freeze({ x: 0, z: 1 }),
  south: Object.freeze({ x: -1, z: 0 }),
  west: Object.freeze({ x: 0, z: -1 }),
});

type AnyRenderer = THREE.WebGLRenderer & Record<string, any>;
type RenderMethod = (scene: THREE.Scene, camera: THREE.Camera) => void;
type SunVisual = { light: THREE.DirectionalLight; disk: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> };

const sunByScene = new WeakMap<THREE.Scene, SunVisual>();

function ensureSunVisual(scene: THREE.Scene): SunVisual | null {
  const cached = sunByScene.get(scene);
  if (cached && cached.light.parent) return cached;
  let light: THREE.DirectionalLight | null = null;
  scene.traverse((object: THREE.Object3D) => {
    if (!light && object instanceof THREE.DirectionalLight) light = object;
  });
  if (!light) return null;
  const material = new THREE.MeshBasicMaterial({
    color: 0xfff4cf,
    fog: false,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const disk = new THREE.Mesh(new THREE.CircleGeometry(1, 48), material);
  disk.name = 'visible-sun-disk';
  disk.frustumCulled = false;
  disk.renderOrder = -100;
  scene.add(disk);
  const visual = { light, disk };
  sunByScene.set(scene, visual);
  console.info('[City-Sim] map orientation', { north: '+X', east: '+Z', south: '-X', west: '-Z' });
  return visual;
}

function syncSunVisual(visual: SunVisual, camera: THREE.Camera): void {
  if (!(camera instanceof THREE.PerspectiveCamera)) { visual.disk.visible = false; return; }
  const target = visual.light.target.position;
  const direction = new THREE.Vector3().subVectors(visual.light.position, target);
  const length = direction.length();
  if (length < 1e-6) { visual.disk.visible = false; return; }
  direction.multiplyScalar(1 / length);
  const daylight = visual.light.intensity > 0.28 && direction.y > 0.01;
  visual.disk.visible = daylight;
  if (!daylight) return;
  const distance = Math.max(2500, camera.far * 0.78);
  visual.disk.position.copy(camera.position).addScaledVector(direction, distance);
  visual.disk.quaternion.copy(camera.quaternion);
  const radius = distance * 0.0062;
  visual.disk.scale.setScalar(radius);
  visual.disk.material.color.copy(visual.light.color).lerp(new THREE.Color(0xffefbd), 0.30);
  visual.disk.material.opacity = THREE.MathUtils.clamp((visual.light.intensity - 0.20) / 0.65, 0.45, 1);
}

const proto = THREE.WebGLRenderer.prototype as unknown as Record<string, any>;
if (!proto.__citySimVisibleSunV068) {
  const previousRender = proto.render as RenderMethod;
  proto.render = function renderWithVisibleSun(this: AnyRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const visual = ensureSunVisual(scene);
    if (visual) syncSunVisual(visual, camera);
    previousRender.call(this, scene, camera);
  };
  proto.__citySimVisibleSunV068 = true;
}
