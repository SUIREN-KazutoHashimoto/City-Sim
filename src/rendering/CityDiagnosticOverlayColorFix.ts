import * as THREE from 'three';
import { OverlayManager } from './CityDiagnosticOverlay';

interface OverlayManagerInternals {
  trafficMaterial: THREE.MeshBasicMaterial;
  buildingMaterial: THREE.MeshBasicMaterial;
  powerLineMaterial: THREE.MeshBasicMaterial;
  assetMaterial: THREE.MeshBasicMaterial;
  trafficMesh: THREE.InstancedMesh;
  buildingMesh: THREE.InstancedMesh;
  powerLineMesh: THREE.InstancedMesh | null;
  assetMesh: THREE.InstancedMesh | null;
}

const normalizedManagers = new WeakSet<OverlayManager>();
const fallbackColor = new THREE.Color(0x63788e);

function normalizeMaterial(material: THREE.MeshBasicMaterial): void {
  // Diagnostic colors are supplied by InstancedMesh.instanceColor and should
  // remain literal regardless of scene fog, tone mapping, or world depth.
  material.color.set(0xffffff);
  material.vertexColors = false;
  material.fog = false;
  material.toneMapped = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.polygonOffset = false;
  material.needsUpdate = true;
}

function ensureInstanceColors(mesh: THREE.InstancedMesh | null): void {
  if (!mesh) return;

  // Create instanceColor before the first render so Three.js compiles the
  // instancing-color shader path even for meshes colored only after selection.
  if (!mesh.instanceColor) {
    for (let index = 0; index < mesh.count; index++) mesh.setColorAt(index, fallbackColor);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
}

function normalizeManager(manager: OverlayManager): void {
  if (normalizedManagers.has(manager)) return;
  normalizedManagers.add(manager);

  const internals = manager as unknown as OverlayManagerInternals;
  normalizeMaterial(internals.trafficMaterial);
  normalizeMaterial(internals.buildingMaterial);
  normalizeMaterial(internals.powerLineMaterial);
  normalizeMaterial(internals.assetMaterial);

  ensureInstanceColors(internals.trafficMesh);
  ensureInstanceColors(internals.buildingMesh);
  ensureInstanceColors(internals.powerLineMesh);
  ensureInstanceColors(internals.assetMesh);
}

const proto = OverlayManager.prototype as unknown as Record<string, unknown>;
if (!proto.__machiSimDiagnosticOverlayColorV113) {
  const previousSetOpacity = proto.setOpacity as OverlayManager['setOpacity'];
  proto.setOpacity = function patchedDiagnosticOverlayOpacity(this: OverlayManager, opacity: number): void {
    previousSetOpacity.call(this, opacity);
    normalizeManager(this);
  };

  const previousSetMode = proto.setMode as OverlayManager['setMode'];
  proto.setMode = function patchedDiagnosticOverlayMode(this: OverlayManager, mode: Parameters<OverlayManager['setMode']>[0]): void {
    previousSetMode.call(this, mode);
    normalizeManager(this);
  };

  proto.__machiSimDiagnosticOverlayColorV113 = true;
}
