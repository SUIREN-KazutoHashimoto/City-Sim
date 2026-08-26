import * as THREE from 'three';
import { EnhancedRenderer } from './EnhancedRenderer';
import { TrainLiveryOverlay } from './TrainLiveryOverlay';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

interface RailLodMeta {
  cx: number;
  cz: number;
  radius: number;
  maxDistance: number;
}

const RAIL_ROOT_NAME = 'render-filter:rail';
const STATIC_CHUNK_SIZE = 640;
const STATIC_FINE_DISTANCE = 2_200;
const STATIC_MEDIUM_DISTANCE = 3_800;
const STATIC_COARSE_DISTANCE = 6_500;
const STATIC_HYSTERESIS = 180;
const TRAIN_DETAIL_DISTANCE = 1_700;
const TRAIN_ACCENT_DISTANCE = 3_200;
const TRAIN_BODY_DISTANCE = 6_200;
const TRAIN_LIGHT_DISTANCE = 950;
const HSR_DETAIL_DISTANCE = 2_400;
const HSR_ACCENT_DISTANCE = 4_200;
const HSR_NOSE_DISTANCE = 6_500;
const HSR_BODY_DISTANCE = 8_000;

const cameraByScene = new WeakMap<THREE.Scene, THREE.Vector3>();
const processedStatic = new WeakSet<THREE.Object3D>();
const tempMatrix = new THREE.Matrix4();
const tempPosition = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();
const tempScale = new THREE.Vector3();
const tempColor = new THREE.Color();

function horizontalDistanceSq(a: THREE.Vector3, x: number, z: number): number {
  const dx = a.x - x;
  const dz = a.z - z;
  return dx * dx + dz * dz;
}

function railRoot(scene: THREE.Scene): THREE.Group | null {
  const root = scene.children.find((child) => child instanceof THREE.Group && child.name === RAIL_ROOT_NAME);
  return root instanceof THREE.Group ? root : null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * 0.5)] ?? 0;
}

function staticDistanceFor(mesh: THREE.InstancedMesh): number {
  const mins: number[] = [];
  const mids: number[] = [];
  const maxs: number[] = [];
  const samples = Math.min(mesh.count, 64);
  const stride = Math.max(1, Math.floor(mesh.count / Math.max(1, samples)));
  for (let i = 0; i < mesh.count && mins.length < samples; i += stride) {
    mesh.getMatrixAt(i, tempMatrix);
    tempMatrix.decompose(tempPosition, tempQuaternion, tempScale);
    const dims = [Math.abs(tempScale.x), Math.abs(tempScale.y), Math.abs(tempScale.z)].sort((a, b) => a - b);
    mins.push(dims[0] ?? 0);
    mids.push(dims[1] ?? 0);
    maxs.push(dims[2] ?? 0);
  }
  const min = median(mins);
  const mid = median(mids);
  const max = median(maxs);
  if (min <= 0.20 && mid <= 0.55) return STATIC_FINE_DISTANCE;
  if ((min <= 0.45 && mid <= 1.25) || max < 10) return STATIC_MEDIUM_DISTANCE;
  return STATIC_COARSE_DISTANCE;
}

function cloneStaticChunk(source: THREE.InstancedMesh, matrices: THREE.Matrix4[], meta: RailLodMeta, key: string): THREE.InstancedMesh {
  const chunk = new THREE.InstancedMesh(source.geometry, source.material, matrices.length);
  for (let i = 0; i < matrices.length; i++) chunk.setMatrixAt(i, matrices[i]);
  chunk.instanceMatrix.needsUpdate = true;
  chunk.position.copy(source.position);
  chunk.quaternion.copy(source.quaternion);
  chunk.scale.copy(source.scale);
  chunk.matrixAutoUpdate = source.matrixAutoUpdate;
  chunk.castShadow = source.castShadow;
  chunk.receiveShadow = source.receiveShadow;
  chunk.renderOrder = source.renderOrder;
  chunk.layers.mask = source.layers.mask;
  chunk.frustumCulled = true;
  chunk.name = source.name ? `${source.name}:rail-lod:${key}` : `rail-lod:${key}`;
  chunk.userData.__citySimRailLodChunk = meta;
  chunk.computeBoundingBox();
  chunk.computeBoundingSphere();
  processedStatic.add(chunk);
  return chunk;
}

function partitionStaticMesh(source: THREE.InstancedMesh): void {
  if (processedStatic.has(source)) return;
  processedStatic.add(source);
  if (!source.parent || source.count < 8) return;
  if (source.instanceMatrix.usage !== THREE.StaticDrawUsage) return;
  if (source.instanceColor) return;

  const groups = new Map<string, { matrices: THREE.Matrix4[]; sx: number; sz: number; count: number; maxR2: number }>();
  for (let i = 0; i < source.count; i++) {
    source.getMatrixAt(i, tempMatrix);
    tempMatrix.decompose(tempPosition, tempQuaternion, tempScale);
    if (!Number.isFinite(tempPosition.x) || !Number.isFinite(tempPosition.z)) continue;
    const gx = Math.floor(tempPosition.x / STATIC_CHUNK_SIZE);
    const gz = Math.floor(tempPosition.z / STATIC_CHUNK_SIZE);
    const key = `${gx}:${gz}`;
    let group = groups.get(key);
    if (!group) {
      group = { matrices: [], sx: 0, sz: 0, count: 0, maxR2: 0 };
      groups.set(key, group);
    }
    group.matrices.push(tempMatrix.clone());
    group.sx += tempPosition.x;
    group.sz += tempPosition.z;
    group.count++;
  }
  if (!groups.size) return;

  const maxDistance = staticDistanceFor(source);
  const parent = source.parent;
  source.updateMatrixWorld(true);

  for (const [key, group] of groups) {
    const cxLocal = group.sx / Math.max(1, group.count);
    const czLocal = group.sz / Math.max(1, group.count);
    for (const matrix of group.matrices) {
      matrix.decompose(tempPosition, tempQuaternion, tempScale);
      const dx = tempPosition.x - cxLocal;
      const dz = tempPosition.z - czLocal;
      group.maxR2 = Math.max(group.maxR2, dx * dx + dz * dz);
    }
    tempPosition.set(cxLocal, 0, czLocal).applyMatrix4(source.matrixWorld);
    const meta: RailLodMeta = {
      cx: tempPosition.x,
      cz: tempPosition.z,
      radius: Math.sqrt(group.maxR2) + 80,
      maxDistance,
    };
    parent.add(cloneStaticChunk(source, group.matrices, meta, key));
  }
  parent.remove(source);
}

function ensureStaticRailChunks(scene: THREE.Scene): void {
  const root = railRoot(scene);
  if (!root) return;
  const candidates: THREE.InstancedMesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.InstancedMesh && !processedStatic.has(object)) candidates.push(object);
  });
  for (const mesh of candidates) partitionStaticMesh(mesh);
}

function updateStaticRailLod(scene: THREE.Scene, camera: THREE.Vector3): void {
  ensureStaticRailChunks(scene);
  const root = railRoot(scene);
  if (!root) return;
  root.traverse((object) => {
    const meta = object.userData.__citySimRailLodChunk as RailLodMeta | undefined;
    if (!meta) return;
    const hysteresis = object.visible ? STATIC_HYSTERESIS : -STATIC_HYSTERESIS;
    const limit = Math.max(0, meta.maxDistance + meta.radius + hysteresis);
    object.visible = horizontalDistanceSq(camera, meta.cx, meta.cz) <= limit * limit;
  });
}

function copyMatrix(source: THREE.InstancedMesh, src: number, target: THREE.InstancedMesh, dst: number): void {
  source.getMatrixAt(src, tempMatrix);
  target.setMatrixAt(dst, tempMatrix);
}

function copyColor(source: THREE.InstancedMesh, src: number, target: THREE.InstancedMesh, dst: number): void {
  if (!source.instanceColor || !target.instanceColor) return;
  source.getColorAt(src, tempColor);
  target.setColorAt(dst, tempColor);
}

function compactPanelPair(mesh: THREE.InstancedMesh, sourceCar: number, dst: number, withColor: boolean): number {
  for (let side = 0; side < 2; side++) {
    const src = sourceCar * 2 + side;
    if (src >= mesh.count) continue;
    copyMatrix(mesh, src, mesh, dst);
    if (withColor) copyColor(mesh, src, mesh, dst);
    dst++;
  }
  return dst;
}

function compactMeshByDistance(mesh: THREE.InstancedMesh, camera: THREE.Vector3, maxDistance: number): void {
  const original = mesh.count;
  let out = 0;
  const maxD2 = maxDistance * maxDistance;
  for (let i = 0; i < original; i++) {
    mesh.getMatrixAt(i, tempMatrix);
    tempMatrix.decompose(tempPosition, tempQuaternion, tempScale);
    if (horizontalDistanceSq(camera, tempPosition.x, tempPosition.z) > maxD2) continue;
    if (out !== i) copyMatrix(mesh, i, mesh, out);
    out++;
  }
  mesh.count = out;
  mesh.instanceMatrix.needsUpdate = true;
}

function applyConventionalTrainLod(overlay: TrainLiveryOverlay, camera: THREE.Vector3): void {
  const host = overlay as unknown as AnyHost;
  const shell = host.shell as THREE.InstancedMesh | null | undefined;
  const windows = host.windows as THREE.InstancedMesh | null | undefined;
  const route = host.routeStripes as THREE.InstancedMesh | null | undefined;
  const service = host.serviceStripes as THREE.InstancedMesh | null | undefined;
  const lamps = host.headlampMesh as THREE.InstancedMesh | null | undefined;
  if (!shell || !windows || !route || !service) return;

  const originalShellCount = shell.count;
  let shellOut = 0;
  let windowOut = 0;
  let accentOut = 0;
  let nearestD2 = Number.POSITIVE_INFINITY;
  const detailD2 = TRAIN_DETAIL_DISTANCE * TRAIN_DETAIL_DISTANCE;
  const accentD2 = TRAIN_ACCENT_DISTANCE * TRAIN_ACCENT_DISTANCE;
  const bodyD2 = TRAIN_BODY_DISTANCE * TRAIN_BODY_DISTANCE;

  for (let i = 0; i < originalShellCount; i++) {
    shell.getMatrixAt(i, tempMatrix);
    tempMatrix.decompose(tempPosition, tempQuaternion, tempScale);
    const d2 = horizontalDistanceSq(camera, tempPosition.x, tempPosition.z);
    nearestD2 = Math.min(nearestD2, d2);
    if (d2 > bodyD2) continue;

    if (shellOut !== i) {
      copyMatrix(shell, i, shell, shellOut);
      copyColor(shell, i, shell, shellOut);
    }
    shellOut++;

    if (d2 <= detailD2) windowOut = compactPanelPair(windows, i, windowOut, false);
    if (d2 <= accentD2) {
      accentOut = compactPanelPair(route, i, accentOut, true);
      compactPanelPair(service, i, accentOut - 2, true);
    }
  }

  shell.count = shellOut;
  windows.count = windowOut;
  route.count = accentOut;
  service.count = accentOut;
  for (const mesh of [shell, windows, route, service]) mesh.instanceMatrix.needsUpdate = true;
  if (shell.instanceColor) shell.instanceColor.needsUpdate = true;
  if (route.instanceColor) route.instanceColor.needsUpdate = true;
  if (service.instanceColor) service.instanceColor.needsUpdate = true;
  shell.castShadow = nearestD2 <= detailD2;
  windows.castShadow = nearestD2 <= detailD2;

  if (lamps) compactMeshByDistance(lamps, camera, TRAIN_DETAIL_DISTANCE);
  const pool = host.headlightPool as THREE.SpotLight[] | undefined;
  if (Array.isArray(pool)) {
    const maxD2 = TRAIN_LIGHT_DISTANCE * TRAIN_LIGHT_DISTANCE;
    for (const light of pool) {
      if (!(light instanceof THREE.SpotLight) || light.intensity <= 0) continue;
      if (horizontalDistanceSq(camera, light.position.x, light.position.z) > maxD2) light.intensity = 0;
    }
  }
}

function highSpeedParts(): { body?: THREE.InstancedMesh; windows?: THREE.InstancedMesh; stripe?: THREE.InstancedMesh; nose?: THREE.InstancedMesh } {
  const adapter = latestHighSpeedRailInspectionSource() as unknown as AnyHost | null;
  if (!adapter) return {};
  const source = (adapter.source ?? adapter) as AnyHost;
  return {
    body: source.carBody instanceof THREE.InstancedMesh ? source.carBody : undefined,
    windows: source.carWindow instanceof THREE.InstancedMesh ? source.carWindow : undefined,
    stripe: source.carStripe instanceof THREE.InstancedMesh ? source.carStripe : undefined,
    nose: adapter.noseMesh instanceof THREE.InstancedMesh ? adapter.noseMesh : undefined,
  };
}

function applyHighSpeedTrainLod(camera: THREE.Vector3): void {
  const { body, windows, stripe, nose } = highSpeedParts();
  if (!body) return;
  let nearestD2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < body.count; i++) {
    body.getMatrixAt(i, tempMatrix);
    tempMatrix.decompose(tempPosition, tempQuaternion, tempScale);
    nearestD2 = Math.min(nearestD2, horizontalDistanceSq(camera, tempPosition.x, tempPosition.z));
  }
  body.visible = nearestD2 <= HSR_BODY_DISTANCE * HSR_BODY_DISTANCE;
  body.castShadow = nearestD2 <= HSR_DETAIL_DISTANCE * HSR_DETAIL_DISTANCE;
  if (windows) {
    windows.visible = nearestD2 <= HSR_DETAIL_DISTANCE * HSR_DETAIL_DISTANCE;
    windows.castShadow = windows.visible;
  }
  if (stripe) stripe.visible = nearestD2 <= HSR_ACCENT_DISTANCE * HSR_ACCENT_DISTANCE;
  if (nose) {
    nose.visible = nearestD2 <= HSR_NOSE_DISTANCE * HSR_NOSE_DISTANCE;
    nose.castShadow = nearestD2 <= HSR_DETAIL_DISTANCE * HSR_DETAIL_DISTANCE;
  }
}

function install(): void {
  const enhancedProto = EnhancedRenderer.prototype as unknown as AnyHost;
  if (!enhancedProto.__citySimRailRenderLodV054) {
    const previousUpdateLod = enhancedProto.updateLod as AnyMethod;
    enhancedProto.updateLod = function railAwareUpdateLod(this: EnhancedRenderer, camera: THREE.Vector3, ...args: any[]): any {
      const result = previousUpdateLod.call(this, camera, ...args);
      const scene = (this as unknown as AnyHost).sceneRef as THREE.Scene | undefined;
      if (scene instanceof THREE.Scene) {
        let stored = cameraByScene.get(scene);
        if (!stored) { stored = new THREE.Vector3(); cameraByScene.set(scene, stored); }
        stored.copy(camera);
        updateStaticRailLod(scene, camera);
        applyHighSpeedTrainLod(camera);
      }
      return result;
    };
    enhancedProto.__citySimRailRenderLodV054 = true;
  }

  const overlayProto = TrainLiveryOverlay.prototype as unknown as AnyHost;
  if (!overlayProto.__citySimTrainRenderLodV054) {
    const previousSync = overlayProto.sync as AnyMethod;
    overlayProto.sync = function lodAwareTrainSync(this: TrainLiveryOverlay, ...args: any[]): any {
      const result = previousSync.apply(this, args);
      const scene = (this as unknown as AnyHost).scene as THREE.Scene | undefined;
      if (scene instanceof THREE.Scene) {
        const camera = cameraByScene.get(scene);
        if (camera) {
          applyConventionalTrainLod(this, camera);
          applyHighSpeedTrainLod(camera);
        }
      }
      return result;
    };
    overlayProto.__citySimTrainRenderLodV054 = true;
  }
}

install();
