import * as THREE from 'three';
import { roadWidth, crosswalkSetback, CROSSWALK_DEPTH, type RoadNetwork } from '../traffic/RoadNetwork';
import type { SignalSystem } from '../traffic/SignalSystem';
import { InstancedRenderer } from './InstancedRenderer';

type SignalRef = { node: number; axis: 0 | 1; edge: number };
type AnyRenderer = Record<string, any>;

const proto = InstancedRenderer.prototype as unknown as AnyRenderer;

function setPose(
  self: AnyRenderer,
  mesh: THREE.InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
): void {
  self.dummy.position.set(x, y, z);
  self.dummy.scale.setScalar(1);
  self.dummy.quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
  self.dummy.updateMatrix();
  mesh.setMatrixAt(index, self.dummy.matrix);
}

function hideInstance(self: AnyRenderer, mesh: THREE.InstancedMesh, index: number): void {
  setPose(self, mesh, index, 0, -1000, 0, 0);
}

/**
 * 歩行者信号だけは車道方向ではなく、横断歩道の横断方向へ向ける。
 * 横断歩道の両端へ1基ずつ配置し、互いに向かい合う。
 */
proto.buildSignals = function crosswalkFacingSignals(this: AnyRenderer, net: RoadNetwork, signals: SignalSystem): void {
  const refs: SignalRef[] = [];
  for (const nodeId of signals.nodeIds) {
    const node = net.nodes[nodeId];
    if (!node) continue;
    for (const edgeId of node.edges) {
      const edge = net.edges[edgeId];
      if (!edge) continue;
      refs.push({ node: nodeId, axis: net.axisOf(node.id, edge.to), edge: edgeId });
    }
  }
  this.signalRefs = refs;

  const vehicleCount = Math.max(1, refs.length);
  const pedestrianCount = Math.max(1, refs.length * 2);
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.8, metalness: 0.3 });
  const housingMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.7 });

  const poleMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.11, 0.13, 6, 6), poleMaterial, vehicleCount,
  );
  const vehHousing = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.55, 1.7, 0.55), housingMaterial, vehicleCount,
  );
  const pedPoleMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.09, 0.11, 3.4, 6), poleMaterial, pedestrianCount,
  );
  const pedHousing = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.55, 1.05, 0.35), housingMaterial, pedestrianCount,
  );
  for (const mesh of [poleMesh, vehHousing, pedPoleMesh, pedHousing]) mesh.frustumCulled = false;

  const lampGeo = new THREE.SphereGeometry(0.2, 8, 8);
  const mkVehicleLamp = (): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial(), vehicleCount);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(vehicleCount * 3), 3);
    mesh.frustumCulled = false;
    return mesh;
  };
  const lampR = mkVehicleLamp(), lampY = mkVehicleLamp(), lampG = mkVehicleLamp();

  const pedLampGeo = new THREE.BoxGeometry(0.3, 0.3, 0.1);
  const mkPedLamp = (): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(pedLampGeo, new THREE.MeshBasicMaterial(), pedestrianCount);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pedestrianCount * 3), 3);
    mesh.frustumCulled = false;
    return mesh;
  };
  const lampDont = mkPedLamp(), lampWalk = mkPedLamp();

  if (!refs.length) {
    for (const mesh of [poleMesh, vehHousing, lampR, lampY, lampG]) hideInstance(this, mesh, 0);
    for (const mesh of [pedPoleMesh, pedHousing, lampDont, lampWalk]) hideInstance(this, mesh, 0);
  }

  for (let k = 0; k < refs.length; k++) {
    const ref = refs[k];
    const node = net.nodes[ref.node];
    const edge = net.edges[ref.edge];
    const neighbor = edge ? net.nodes[edge.to] : null;
    if (!node || !edge || !neighbor) continue;

    let towardX = neighbor.x - node.x;
    let towardZ = neighbor.z - node.z;
    const length = Math.hypot(towardX, towardZ) || 1;
    towardX /= length;
    towardZ /= length;

    // 車両信号は従来どおり道路の進行方向を見る。
    const inwardX = -towardX;
    const inwardZ = -towardZ;
    const lateralX = inwardZ;
    const lateralZ = -inwardX;
    const rw = roadWidth(edge.lanes);
    const vehicleLongitudinal = crosswalkSetback(rw) + CROSSWALK_DEPTH * 0.5 + 0.7;
    const sideOffset = rw * 0.5 + 1.2;
    const bx = node.x - inwardX * vehicleLongitudinal + lateralX * sideOffset;
    const bz = node.z - inwardZ * vehicleLongitudinal + lateralZ * sideOffset;
    const hx = bx - lateralX * 1.1;
    const hz = bz - lateralZ * 1.1;
    const vehicleFacing = Math.atan2(-inwardZ, -inwardX);
    const vehicleLampX = -inwardX * 0.3;
    const vehicleLampZ = -inwardZ * 0.3;

    setPose(this, poleMesh, k, bx, 3, bz, vehicleFacing);
    setPose(this, vehHousing, k, hx, 5.6, hz, vehicleFacing);
    setPose(this, lampR, k, hx + vehicleLampX, 6.1, hz + vehicleLampZ, vehicleFacing);
    setPose(this, lampY, k, hx + vehicleLampX, 5.6, hz + vehicleLampZ, vehicleFacing);
    setPose(this, lampG, k, hx + vehicleLampX, 5.1, hz + vehicleLampZ, vehicleFacing);

    // 横断歩道中心。歩行者信号は道路に直角な横断方向を向く。
    const crossX = node.x + towardX * crosswalkSetback(rw);
    const crossZ = node.z + towardZ * crosswalkSetback(rw);
    const pedSide = rw * 0.5 + 1.15;
    const aX = crossX + lateralX * pedSide;
    const aZ = crossZ + lateralZ * pedSide;
    const bX = crossX - lateralX * pedSide;
    const bZ = crossZ - lateralZ * pedSide;

    // BoxGeometryの薄いZ面を正面として、互いの待機場所へ向ける。
    const aFrontX = -lateralX;
    const aFrontZ = -lateralZ;
    const bFrontX = lateralX;
    const bFrontZ = lateralZ;
    const aYaw = Math.atan2(aFrontX, aFrontZ);
    const bYaw = Math.atan2(bFrontX, bFrontZ);
    const lampFaceOffset = 0.19;
    const p0 = k * 2;
    const p1 = p0 + 1;

    setPose(this, pedPoleMesh, p0, aX, 1.7, aZ, aYaw);
    setPose(this, pedHousing, p0, aX, 2.7, aZ, aYaw);
    setPose(this, lampDont, p0, aX + aFrontX * lampFaceOffset, 2.95, aZ + aFrontZ * lampFaceOffset, aYaw);
    setPose(this, lampWalk, p0, aX + aFrontX * lampFaceOffset, 2.45, aZ + aFrontZ * lampFaceOffset, aYaw);

    setPose(this, pedPoleMesh, p1, bX, 1.7, bZ, bYaw);
    setPose(this, pedHousing, p1, bX, 2.7, bZ, bYaw);
    setPose(this, lampDont, p1, bX + bFrontX * lampFaceOffset, 2.95, bZ + bFrontZ * lampFaceOffset, bYaw);
    setPose(this, lampWalk, p1, bX + bFrontX * lampFaceOffset, 2.45, bZ + bFrontZ * lampFaceOffset, bYaw);
  }

  for (const mesh of [poleMesh, vehHousing, pedPoleMesh, pedHousing, lampR, lampY, lampG, lampDont, lampWalk]) {
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }
  this.lampR = lampR;
  this.lampY = lampY;
  this.lampG = lampG;
  this.lampWalk = lampWalk;
  this.lampDont = lampDont;
};

proto.syncSignals = function syncCrosswalkFacingSignals(this: AnyRenderer, signals: SignalSystem): void {
  if (!this.lampR) return;
  const refs = this.signalRefs as SignalRef[];
  for (let k = 0; k < refs.length; k++) {
    const { node, axis } = refs[k];
    const vehicleColor = signals.vehicleColor(node, axis);
    this.lampR.setColorAt(k, vehicleColor === 'red' ? this.onR : this.offR);
    this.lampY.setColorAt(k, vehicleColor === 'yellow' ? this.onY : this.offY);
    this.lampG.setColorAt(k, vehicleColor === 'green' ? this.onG : this.offG);

    const pedestrianColor = signals.pedColor(node, axis);
    const walk = pedestrianColor === 'walk';
    const p0 = k * 2;
    const p1 = p0 + 1;
    this.lampWalk.setColorAt(p0, walk ? this.onWalk : this.offWalk);
    this.lampWalk.setColorAt(p1, walk ? this.onWalk : this.offWalk);
    this.lampDont.setColorAt(p0, walk ? this.offDont : this.onDont);
    this.lampDont.setColorAt(p1, walk ? this.offDont : this.onDont);
  }
  for (const mesh of [this.lampR, this.lampY, this.lampG, this.lampWalk, this.lampDont] as THREE.InstancedMesh[]) {
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
};
