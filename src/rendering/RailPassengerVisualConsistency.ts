import * as THREE from 'three';
import { AgentState } from '../agents/AgentStore';
import { EnhancedRenderer } from './EnhancedRenderer';

type AnyRenderer = Record<string, any>;
type AnyStore = Record<string, any>;

const proto = EnhancedRenderer.prototype as unknown as AnyRenderer;
const originalSyncAgents = proto.syncAgents as (store: AnyStore, simTime?: number, cameraPos?: THREE.Vector3) => void;
const fallbackClothes = [0x315d89, 0x8a3f4c, 0x476f51, 0x7b5b91, 0xb07b3f, 0x52606e, 0x8a795a, 0x5d7b83]
  .map((c) => new THREE.Color(c));
const rawMatrix = new THREE.Matrix4();
const rawPosition = new THREE.Vector3();
const rawQuaternion = new THREE.Quaternion();
const rawScale = new THREE.Vector3();

function ensureNormalRailPassengerMeshes(renderer: AnyRenderer, body: THREE.InstancedMesh): THREE.InstancedMesh | null {
  if (!renderer.__railPassengerVisualNormalized) {
    renderer.__railPassengerVisualNormalized = true;
    body.geometry = new THREE.BoxGeometry(0.48, 0.76, 0.30);
    const material = body.material as THREE.MeshStandardMaterial;
    if (material && !Array.isArray(material)) {
      material.color.set(0xffffff);
      material.roughness = 0.82;
    }
    if (!body.instanceColor || body.instanceColor.count < body.instanceMatrix.count) {
      body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(body.instanceMatrix.count * 3), 3);
    }
  }

  const required = body.instanceMatrix.count * 2;
  let legs = renderer.__railPassengerLegs as THREE.InstancedMesh | undefined;
  if (legs && renderer.__railPassengerLegCapacity >= required) return legs;
  const scene = renderer.sceneRef as THREE.Scene | undefined;
  if (!scene) return null;
  if (legs) scene.remove(legs);
  legs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.17, 0.72, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.9 }),
    Math.max(2, required),
  );
  legs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  legs.frustumCulled = false;
  legs.castShadow = true;
  scene.add(legs);
  renderer.__railPassengerLegs = legs;
  renderer.__railPassengerLegCapacity = Math.max(2, required);
  return legs;
}

function isRailStationPassenger(state: number): boolean {
  return state === AgentState.ToRailStation || state === AgentState.WaitingTrain;
}

proto.syncAgents = function syncAgentsWithConsistentRailPassengers(
  this: EnhancedRenderer,
  store: AnyStore,
  simTime = 0,
  cameraPos?: THREE.Vector3,
): void {
  originalSyncAgents.call(this, store, simTime, cameraPos);
  const renderer = this as unknown as AnyRenderer;
  const body = renderer.__railPassengerBody as THREE.InstancedMesh | undefined;
  const head = renderer.__railPassengerHead as THREE.InstancedMesh | undefined;
  if (!body || !head) return;
  const legs = ensureNormalRailPassengerMeshes(renderer, body);
  if (!legs) return;

  const clothes = (renderer.clothes as THREE.Color[] | undefined) ?? fallbackClothes;
  const pose = renderer.pose as (
    mesh: THREE.InstancedMesh, index: number, x: number, z: number, heading: number,
    localX: number, y: number, localZ: number, sx: number, sy: number, sz: number, roll: number,
  ) => void;
  if (typeof pose !== 'function') return;

  let instance = 0;
  let legInstance = 0;
  for (let agent = 0; agent < store.count && instance < body.count; agent++) {
    if (!isRailStationPassenger(store.state[agent])) continue;

    // RailPassengerIntegrationは駅構内AgentをAgent ID順に詰める。
    // 現在のinstance位置と一致するAgentだけを採用すれば、地上から駅へ向かっている途中のAgentは除外できる。
    body.getMatrixAt(instance, rawMatrix);
    rawMatrix.decompose(rawPosition, rawQuaternion, rawScale);
    const x = store.posX[agent] as number;
    const z = store.posZ[agent] as number;
    if (Math.abs(rawPosition.x - x) > 0.035 || Math.abs(rawPosition.z - z) > 0.035) continue;

    const baseY = rawPosition.y - 0.74;
    const heading = store.heading[agent] as number;
    pose.call(renderer, body, instance, x, z, heading, 0, baseY + 1.14, 0, 1, 1, 1, 0);
    pose.call(renderer, head, instance, x, z, heading, 0, baseY + 1.72, 0, 1, 1, 1, 0);
    const color = clothes[(agent * 7 + store.occupation[agent]) % clothes.length];
    body.setColorAt(instance, color);

    const moving = Math.hypot(store.velX[agent], store.velZ[agent]);
    const swing = moving > 0.05
      ? Math.sin(simTime * (5.0 + store.maxSpeed[agent]) + agent * 0.73) * 0.48
      : 0;
    pose.call(renderer, legs, legInstance++, x, z, heading, 0, baseY + 0.52, -0.11, 1, 1, 1, swing);
    pose.call(renderer, legs, legInstance++, x, z, heading, 0, baseY + 0.52, 0.11, 1, 1, 1, -swing);
    instance++;
  }

  body.count = instance;
  head.count = instance;
  legs.count = legInstance;
  body.instanceMatrix.needsUpdate = true;
  head.instanceMatrix.needsUpdate = true;
  legs.instanceMatrix.needsUpdate = true;
  if (body.instanceColor) body.instanceColor.needsUpdate = true;
};
