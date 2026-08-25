import * as THREE from 'three';
import { AgentState, type AgentStore } from '../agents/AgentStore';
import { visitorPresentationInfo } from '../world/VisitorPresentation';
import '../world/RailPassengerIntegration';
import { EnhancedRenderer } from './EnhancedRenderer';

type AnyRenderer = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const MAX_VISITORS = 7000;
const PURPOSE_COLORS = {
  shopping: [0x9a5c34, 0xc58a45, 0x6a4a37],
  tourism: [0x315f6f, 0x2f7b78, 0x486b55],
  hotel: [0x3e4f78, 0x5d4f7f, 0x51495f],
} as const;

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function writePart(
  mesh: THREE.InstancedMesh,
  dummy: THREE.Object3D,
  index: number,
  x: number,
  y: number,
  z: number,
  heading: number,
  sx: number,
  sy: number,
  sz: number,
  color: THREE.Color,
): void {
  dummy.position.set(x, y, z);
  dummy.rotation.set(0, -heading, 0);
  dummy.scale.set(sx, sy, sz);
  dummy.updateMatrix();
  mesh.setMatrixAt(index, dummy.matrix);
  mesh.setColorAt(index, color);
}

function gearMode(agent: number, purpose: 'shopping' | 'tourism' | 'hotel'): 'backpack' | 'suitcase' | 'both' {
  const r = hash01(Math.imul(agent + 1, 2654435761) ^ (purpose === 'hotel' ? 0x71 : purpose === 'tourism' ? 0x43 : 0x29));
  if (purpose === 'hotel') return r < 0.20 ? 'backpack' : r < 0.84 ? 'suitcase' : 'both';
  if (purpose === 'tourism') return r < 0.64 ? 'backpack' : r < 0.90 ? 'suitcase' : 'both';
  return r < 0.52 ? 'backpack' : r < 0.90 ? 'suitcase' : 'both';
}

function renderGear(renderer: AnyRenderer, store: AgentStore, cameraPos?: THREE.Vector3): void {
  const mesh = renderer.__visitorTravelGear as THREE.InstancedMesh | undefined;
  const dummy = renderer.__visitorTravelGearDummy as THREE.Object3D | undefined;
  if (!mesh || !dummy) return;

  const useDistance = !!cameraPos;
  const camX = cameraPos?.x ?? 0;
  const camZ = cameraPos?.z ?? 0;
  const maxD2 = EnhancedRenderer.LOD0_DISTANCE ** 2;
  let count = 0;

  for (let i = 0; i < store.count && count < mesh.instanceMatrix.count; i++) {
    const info = visitorPresentationInfo(store, i);
    if (!info) continue;
    const state = store.state[i] as AgentState;
    if (state === AgentState.Driving || state === AgentState.Engaged || state === AgentState.OnBus || state === AgentState.OnTrain) continue;

    const internalRail = state === AgentState.ToRailStation || state === AgentState.WaitingTrain || Number(state) === 13;
    if (internalRail && !info.onHighSpeedPlatform) continue;

    const x = store.posX[i], z = store.posZ[i];
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 1e6 || Math.abs(z) > 1e6) continue;
    const dx = x - camX, dz = z - camZ;
    if (useDistance && dx * dx + dz * dz > maxD2) continue;

    const h = Number.isFinite(store.heading[i]) ? store.heading[i] : 0;
    const baseY = info.platformY ?? 0;
    const fx = Math.cos(h), fz = Math.sin(h);
    const px = -fz, pz = fx;
    const side = (i & 1) === 0 ? 1 : -1;
    const colors = PURPOSE_COLORS[info.purpose];
    const color = new THREE.Color(colors[Math.floor(hash01(i * 3571 + 19) * colors.length) % colors.length]);
    const mode = gearMode(i, info.purpose);

    if (mode === 'backpack' || mode === 'both') {
      writePart(mesh, dummy, count++, x - fx * 0.22, baseY + 1.18, z - fz * 0.22, h, 0.36, 0.54, 0.20, color);
      if (count >= mesh.instanceMatrix.count) break;
    }

    if (mode === 'suitcase' || mode === 'both') {
      const sx = x - fx * 0.42 + px * 0.34 * side;
      const sz = z - fz * 0.42 + pz * 0.34 * side;
      writePart(mesh, dummy, count++, sx, baseY + 0.36, sz, h, 0.34, 0.62, 0.23, color);
      if (count >= mesh.instanceMatrix.count) break;
      writePart(mesh, dummy, count++, sx, baseY + 0.83, sz, h, 0.055, 0.36, 0.055, color);
      if (count >= mesh.instanceMatrix.count) break;
    }
  }

  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

const proto = EnhancedRenderer.prototype as unknown as Record<string, any>;
if (!proto.__citySimVisitorTravelGearV066) {
  const previousBuild = proto.buildAgents as AnyMethod;
  proto.buildAgents = function buildAgentsWithVisitorTravelGear(this: AnyRenderer, capacity: number): void {
    previousBuild.call(this, capacity);
    const scene = this.sceneRef as THREE.Scene | undefined;
    if (!scene) return;

    const previous = this.__visitorTravelGear as THREE.InstancedMesh | undefined;
    if (previous) {
      scene.remove(previous);
      previous.geometry.dispose();
      if (Array.isArray(previous.material)) previous.material.forEach((m) => m.dispose());
      else previous.material.dispose();
    }

    const gearCapacity = Math.max(1, Math.min(MAX_VISITORS, capacity) * 3);
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.02 }),
      gearCapacity,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(gearCapacity * 3), 3);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'visitor-travel-gear';
    mesh.count = 0;
    scene.add(mesh);
    this.__visitorTravelGear = mesh;
    this.__visitorTravelGearDummy = new THREE.Object3D();
  };

  const previousSync = proto.syncAgents as AnyMethod;
  proto.syncAgents = function syncAgentsWithVisitorTravelGear(
    this: AnyRenderer,
    store: AgentStore,
    simTime = 0,
    cameraPos?: THREE.Vector3,
  ): void {
    previousSync.call(this, store, simTime, cameraPos);
    renderGear(this, store, cameraPos);
  };

  proto.__citySimVisitorTravelGearV066 = true;
}
