import * as THREE from 'three';
import { EnhancedRenderer } from './EnhancedRenderer';
import { FirstPersonController } from './FirstPersonController';
import { UniversalInspector } from './UniversalInspector';
import { World } from '../world/World';
import { GenerationType } from '../power/PowerTypes';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

interface VisualAnchor {
  x: number;
  z: number;
  height: number;
}

interface Part {
  matrix: THREE.Matrix4;
}

let latestWorld: World | null = null;
let latestController: FirstPersonController | null = null;
let latestInspector: UniversalInspector | null = null;
const anchorsByWorld = new WeakMap<World, Map<string, VisualAnchor>>();

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function hashText(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function matrix(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  yaw = 0,
  pitch = 0,
): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
}

function clearOfCity(world: World, x: number, z: number, width: number, depth: number): boolean {
  const margin = 5;
  if (x - width * 0.5 < 4 || z - depth * 0.5 < 4 || x + width * 0.5 > world.city.sizeMeters - 4 || z + depth * 0.5 > world.city.sizeMeters - 4) return false;
  for (const building of world.city.buildings) {
    const bw = building.width * 0.5 + width * 0.5 + margin;
    const bd = building.depth * 0.5 + depth * 0.5 + margin;
    if (Math.abs(building.x - x) < bw && Math.abs(building.z - z) < bd) return false;
  }
  for (const lot of world.city.parkingLots) {
    const lw = lot.width * 0.5 + width * 0.5 + 2;
    const ld = lot.depth * 0.5 + depth * 0.5 + 2;
    if (Math.abs(lot.x - x) < lw && Math.abs(lot.z - z) < ld) return false;
  }
  return true;
}

function chooseAnchor(
  world: World,
  key: string,
  preferredX: number,
  preferredZ: number,
  width: number,
  depth: number,
  initialOffset: number,
): { x: number; z: number } {
  const seed = hashText(key);
  const start = (seed % 16) / 16 * Math.PI * 2;
  const distances = initialOffset <= 0
    ? [0, 18, 32, 48, 66]
    : [initialOffset, initialOffset + 14, initialOffset + 28, initialOffset + 44, initialOffset + 62];
  for (const distance of distances) {
    const steps = distance === 0 ? 1 : 16;
    for (let i = 0; i < steps; i++) {
      const angle = start + i / steps * Math.PI * 2;
      const x = clamp(preferredX + Math.cos(angle) * distance, width * 0.5 + 5, world.city.sizeMeters - width * 0.5 - 5);
      const z = clamp(preferredZ + Math.sin(angle) * distance, depth * 0.5 + 5, world.city.sizeMeters - depth * 0.5 - 5);
      if (clearOfCity(world, x, z, width, depth)) return { x, z };
    }
  }
  return {
    x: clamp(preferredX, width * 0.5 + 5, world.city.sizeMeters - width * 0.5 - 5),
    z: clamp(preferredZ, depth * 0.5 + 5, world.city.sizeMeters - depth * 0.5 - 5),
  };
}

function intendedGenerationPosition(world: World, type: GenerationType, id: string): { x: number; z: number } {
  const system = world.power;
  const index = Math.max(0, Number(id.slice(id.lastIndexOf('-') + 1)) || 0);
  const count = type === GenerationType.Thermal ? system.config.thermalPlantCount : system.config.solarPlantCount;
  const anchor = index % 2 ? world.city.planning.logisticsCenter : world.city.planning.industrialCenter;
  const angle = index / Math.max(1, count) * Math.PI * 2 + (type === GenerationType.Thermal ? 0.45 : 1.2);
  const radius = type === GenerationType.Thermal
    ? Math.max(160, world.city.sizeMeters * (0.012 + (index % 3) * 0.004))
    : Math.max(280, world.city.sizeMeters * (0.025 + (index % 4) * 0.006));
  return {
    x: clamp(anchor.x + Math.cos(angle) * radius, 0, world.city.sizeMeters),
    z: clamp(anchor.z + Math.sin(angle) * radius, 0, world.city.sizeMeters),
  };
}

function addInstances(
  root: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  parts: Part[],
  castShadow = true,
): void {
  if (!parts.length) return;
  const mesh = new THREE.InstancedMesh(geometry, material, parts.length);
  parts.forEach((part, i) => mesh.setMatrixAt(i, part.matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.updateMatrixWorld(true);
  mesh.computeBoundingSphere();
  root.add(mesh);
}

function buildPowerFacilities(scene: THREE.Scene, world: World): void {
  const existing = scene.getObjectByName('city-sim-power-facilities');
  if (existing) scene.remove(existing);

  const system = world.power;
  const anchors = new Map<string, VisualAnchor>();
  anchorsByWorld.set(world, anchors);
  const root = new THREE.Group();
  root.name = 'city-sim-power-facilities';
  root.userData.citySimPowerFacilities = true;

  const grounds: Part[] = [];
  const buildingWalls: Part[] = [];
  const buildingRoofs: Part[] = [];
  const equipment: Part[] = [];
  const transformerBodies: Part[] = [];
  const transformerTops: Part[] = [];
  const stacks: Part[] = [];
  const coolingTowers: Part[] = [];
  const solarPanels: Part[] = [];

  for (const facility of system.generationFacilities) {
    const thermal = facility.type === GenerationType.Thermal;
    const footprintW = thermal ? 72 : 76;
    const footprintD = thermal ? 54 : 58;
    const intended = intendedGenerationPosition(world, facility.type, facility.id);
    const p = chooseAnchor(world, `generation:${facility.id}`, intended.x, intended.z, footprintW, footprintD, 0);
    const yaw = (hashText(facility.id) % 4) * Math.PI * 0.5;

    if (thermal) {
      grounds.push({ matrix: matrix(p.x, 0.12, p.z, 72, 0.24, 54, yaw) });
      buildingWalls.push({ matrix: matrix(p.x - 7, 8.0, p.z, 42, 16, 28, yaw) });
      buildingWalls.push({ matrix: matrix(p.x + 18, 4.6, p.z + 11, 20, 9.2, 16, yaw) });
      buildingRoofs.push({ matrix: matrix(p.x - 7, 16.25, p.z, 43, 0.5, 29, yaw) });
      equipment.push({ matrix: matrix(p.x - 5, 18.0, p.z - 4, 14, 3.4, 8, yaw) });
      stacks.push({ matrix: matrix(p.x + 22, 19, p.z - 12, 2.4, 38, 2.4) });
      stacks.push({ matrix: matrix(p.x + 28, 17, p.z - 12, 2.2, 34, 2.2) });
      coolingTowers.push({ matrix: matrix(p.x + 20, 8.5, p.z + 17, 6.0, 17, 6.0) });
      anchors.set(`generation:${facility.id}`, { x: p.x, z: p.z, height: 38 });
    } else {
      grounds.push({ matrix: matrix(p.x, 0.10, p.z, 76, 0.20, 58, yaw) });
      buildingWalls.push({ matrix: matrix(p.x - 27, 3.0, p.z + 20, 15, 6, 10, yaw) });
      buildingRoofs.push({ matrix: matrix(p.x - 27, 6.15, p.z + 20, 15.5, 0.3, 10.5, yaw) });
      for (let rz = 0; rz < 4; rz++) {
        for (let rx = 0; rx < 6; rx++) {
          const lx = -22 + rx * 8.8;
          const lz = -18 + rz * 9.2;
          const cos = Math.cos(yaw), sin = Math.sin(yaw);
          const x = p.x + lx * cos + lz * sin;
          const z = p.z - lx * sin + lz * cos;
          solarPanels.push({ matrix: matrix(x, 1.45, z, 7.2, 0.25, 4.8, yaw, -0.20) });
        }
      }
      anchors.set(`generation:${facility.id}`, { x: p.x, z: p.z, height: 8 });
    }
  }

  for (const substation of system.substations) {
    const p = chooseAnchor(world, `substation:${substation.id}`, substation.x, substation.z, 24, 18, 18);
    const yaw = (hashText(substation.id) % 4) * Math.PI * 0.5;
    grounds.push({ matrix: matrix(p.x, 0.08, p.z, 24, 0.16, 18, yaw) });
    buildingWalls.push({ matrix: matrix(p.x - 5, 2.5, p.z, 9, 5, 8, yaw) });
    buildingRoofs.push({ matrix: matrix(p.x - 5, 5.12, p.z, 9.5, 0.24, 8.5, yaw) });
    transformerBodies.push({ matrix: matrix(p.x + 4, 1.7, p.z - 4, 4.4, 3.4, 3.4, yaw) });
    transformerBodies.push({ matrix: matrix(p.x + 4, 1.7, p.z + 4, 4.4, 3.4, 3.4, yaw) });
    transformerTops.push({ matrix: matrix(p.x + 4, 3.55, p.z - 4, 4.8, 0.35, 3.8, yaw) });
    transformerTops.push({ matrix: matrix(p.x + 4, 3.55, p.z + 4, 4.8, 0.35, 3.8, yaw) });
    anchors.set(`substation:${substation.id}`, { x: p.x, z: p.z, height: 7 });
  }

  for (const connection of system.externalConnections) {
    const p = chooseAnchor(world, `external:${connection.id}`, connection.x, connection.z, 22, 16, 16);
    const yaw = (hashText(connection.id) % 4) * Math.PI * 0.5;
    grounds.push({ matrix: matrix(p.x, 0.08, p.z, 22, 0.16, 16, yaw) });
    buildingWalls.push({ matrix: matrix(p.x - 3, 2.8, p.z, 11, 5.6, 8, yaw) });
    buildingRoofs.push({ matrix: matrix(p.x - 3, 5.72, p.z, 11.5, 0.24, 8.5, yaw) });
    transformerBodies.push({ matrix: matrix(p.x + 6, 1.8, p.z, 5, 3.6, 4.2, yaw) });
    transformerTops.push({ matrix: matrix(p.x + 6, 3.78, p.z, 5.4, 0.36, 4.6, yaw) });
    anchors.set(`external:${connection.id}`, { x: p.x, z: p.z, height: 7 });
  }

  addInstances(root, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x777d80, roughness: 0.96 }), grounds, false);
  addInstances(root, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8d969b, roughness: 0.78, metalness: 0.08 }), buildingWalls);
  addInstances(root, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x4f5960, roughness: 0.72, metalness: 0.18 }), buildingRoofs);
  addInstances(root, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x646e73, roughness: 0.6, metalness: 0.28 }), equipment);
  addInstances(root, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x65715e, roughness: 0.62, metalness: 0.34 }), transformerBodies);
  addInstances(root, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x343c3d, roughness: 0.55, metalness: 0.42 }), transformerTops);
  addInstances(root, new THREE.CylinderGeometry(1, 1, 1, 12), new THREE.MeshStandardMaterial({ color: 0xb6b8b5, roughness: 0.68, metalness: 0.12 }), stacks);
  addInstances(root, new THREE.CylinderGeometry(0.74, 1, 1, 16), new THREE.MeshStandardMaterial({ color: 0x9da3a2, roughness: 0.8, metalness: 0.05 }), coolingTowers);
  addInstances(root, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x263e53, roughness: 0.34, metalness: 0.34 }), solarPanels);

  scene.add(root);
}

function findPowerAnchor(world: World, title: string): VisualAnchor | null {
  const map = anchorsByWorld.get(world);
  if (!map) return null;
  for (const facility of world.power.generationFacilities) {
    if (title.includes(facility.id)) return map.get(`generation:${facility.id}`) ?? null;
  }
  for (const connection of world.power.externalConnections) {
    if (title.includes(connection.id)) return map.get(`external:${connection.id}`) ?? null;
  }
  for (const substation of world.power.substations) {
    if (title.includes(substation.id)) return map.get(`substation:${substation.id}`) ?? null;
  }
  return null;
}

function closeMenuNormally(main: HTMLElement): void {
  const overlay = main.parentElement;
  if (!overlay || overlay.style.display === 'none') return;
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((item) => item.textContent?.trim() === 'MENU  F10');
  button?.click();
}

function jumpToAnchor(anchor: VisualAnchor, main: HTMLElement): void {
  const controller = latestController as unknown as AnyHost | null;
  if (!controller) return;
  closeMenuNormally(main);
  const inspector = latestInspector as unknown as AnyHost | null;
  if (inspector) {
    inspector.followKind = 'none';
    inspector.followId = -1;
  }
  controller.setFollowTarget?.(null);
  const camera = controller.camera as THREE.PerspectiveCamera | undefined;
  const distance = Math.max(48, anchor.height * 1.7);
  if (camera) {
    camera.position.set(anchor.x - distance, Math.max(22, anchor.height + 18), anchor.z - distance);
    camera.lookAt(anchor.x, Math.max(2, anchor.height * 0.38), anchor.z);
    controller.syncFreeAnglesFromCamera?.();
  } else {
    controller.setPosition?.(anchor.x - distance, Math.max(22, anchor.height + 18), anchor.z - distance);
  }
}

function handlePowerJump(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.textContent?.trim() !== 'ジャンプ') return;
  const main = target.closest('main') as HTMLElement | null;
  if (!main || main.querySelector('h1')?.textContent?.trim() !== '電力') return;
  const row = target.parentElement;
  const title = row?.firstElementChild?.textContent?.trim() ?? '';
  const world = latestWorld;
  if (!world || !title) return;
  const anchor = findPowerAnchor(world, title);
  if (!anchor) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  jumpToAnchor(anchor, main);
}

const worldProto = World.prototype as unknown as AnyHost;
if (!worldProto.__citySimPowerFacilityRenderingV1024) {
  const previousPopulate = worldProto.populate as AnyMethod;
  worldProto.populate = function populateWithPowerFacilityRendering(this: World, ...args: any[]): any {
    latestWorld = this;
    return previousPopulate.apply(this, args);
  };
  worldProto.__citySimPowerFacilityRenderingV1024 = true;
}

const rendererProto = EnhancedRenderer.prototype as unknown as AnyHost;
if (!rendererProto.__citySimPowerFacilityRenderingV1024) {
  const previousBuildStatic = rendererProto.buildStatic as AnyMethod;
  rendererProto.buildStatic = function buildStaticWithPowerFacilities(this: EnhancedRenderer, ...args: any[]): any {
    const result = previousBuildStatic.apply(this, args);
    const world = latestWorld;
    const scene = (this as unknown as AnyHost).sceneRef as THREE.Scene | undefined;
    if (world && scene) buildPowerFacilities(scene, world);
    return result;
  };
  rendererProto.__citySimPowerFacilityRenderingV1024 = true;
}

const controllerProto = FirstPersonController.prototype as unknown as AnyHost;
if (!controllerProto.__citySimPowerFacilityRenderingV1024) {
  const previousSetPosition = controllerProto.setPosition as AnyMethod;
  controllerProto.setPosition = function setPositionCapturePowerFacilityController(this: FirstPersonController, ...args: any[]): any {
    latestController = this;
    return previousSetPosition.apply(this, args);
  };
  controllerProto.__citySimPowerFacilityRenderingV1024 = true;
}

const inspectorProto = UniversalInspector.prototype as unknown as AnyHost;
if (!inspectorProto.__citySimPowerFacilityRenderingV1024) {
  const previousUpdate = inspectorProto.update as AnyMethod;
  inspectorProto.update = function updateCapturePowerFacilityInspector(this: UniversalInspector, ...args: any[]): any {
    latestInspector = this;
    return previousUpdate.apply(this, args);
  };
  inspectorProto.__citySimPowerFacilityRenderingV1024 = true;
}

document.addEventListener('click', handlePowerJump, true);
