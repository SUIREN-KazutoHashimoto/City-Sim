import * as THREE from 'three';
import { Building } from '../generation/CityGenerator';
import { RoadNetwork } from '../traffic/RoadNetwork';
import { AgentStore, AgentState } from '../agents/AgentStore';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { SignalSystem } from '../traffic/SignalSystem';
import { POICategory } from '../world/POI';

/**
 * 描画層: GPU インスタンシング。建物/歩行者/車両/信号灯を各1ドローで描画。
 */
export class InstancedRenderer {
  private buildingMesh!: THREE.InstancedMesh;
  private agentMesh!: THREE.InstancedMesh;
  private vehicleMesh!: THREE.InstancedMesh;
  private signalMesh!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();

  // 信号灯インスタンス → (nodeId, axis) の対応表
  private signalRefs: { node: number; axis: 0 | 1 }[] = [];
  private colGreen = new THREE.Color(0x36e05a);
  private colYellow = new THREE.Color(0xf2c14e);
  private colRed = new THREE.Color(0xe0402f);

  private readonly categoryColor: Record<number, THREE.Color> = {
    [POICategory.Home]:   new THREE.Color(0x8fa9c6),
    [POICategory.Work]:   new THREE.Color(0x6f7f95),
    [POICategory.Food]:   new THREE.Color(0xc98b5a),
    [POICategory.Retail]: new THREE.Color(0xb9a06a),
    [POICategory.Leisure]:new THREE.Color(0x7cba8f),
  };
  private readonly carColors = [
    0xd94f4f, 0x4f7fd9, 0xe0e0e0, 0x2b2b2b, 0xd9b64f, 0x54b07a, 0x8a6fd9,
  ].map((c) => new THREE.Color(c));

  constructor(private scene: THREE.Scene) {}

  get buildings(): THREE.InstancedMesh { return this.buildingMesh; }
  get agents(): THREE.InstancedMesh { return this.agentMesh; }

  buildStatic(buildings: Building[], net: RoadNetwork): void {
    this.buildBuildings(buildings);
    this.buildRoads(net);
    this.buildGround();
  }

  private buildBuildings(buildings: Building[]): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(geo, mat, buildings.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(buildings.length * 3), 3);
    const floorHeight = 3.2;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      this.dummy.position.set(b.x, 0, b.z);
      this.dummy.scale.set(b.width, b.floors * floorHeight, b.depth);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
      mesh.setColorAt(i, this.categoryColor[b.category] ?? new THREE.Color(0x9aa5b1));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.buildingMesh = mesh;
  }

  private buildRoads(net: RoadNetwork): void {
    const drawn = new Set<string>();
    const boxes: THREE.Matrix4[] = [];
    const sidewalks: THREE.Matrix4[] = [];
    for (const e of net.edges) {
      const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = net.nodes[e.from], b = net.nodes[e.to];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const angle = Math.atan2(b.z - a.z, b.x - a.x);
      const roadW = 3.5 * e.lanes * 2;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(mx, 0.05, mz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
        new THREE.Vector3(e.length, 0.1, roadW),
      );
      boxes.push(m);
      // 歩道: 車道の両脇に薄い帯(明るいグレー)
      const sw = new THREE.Matrix4();
      sw.compose(
        new THREE.Vector3(mx, 0.08, mz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
        new THREE.Vector3(e.length, 0.12, roadW + 5),
      );
      sidewalks.push(sw);
    }
    // 歩道(下)→車道(上)の順で重ねる
    const swGeo = new THREE.BoxGeometry(1, 1, 1);
    const swMat = new THREE.MeshStandardMaterial({ color: 0x555b63, roughness: 1 });
    const swMesh = new THREE.InstancedMesh(swGeo, swMat, sidewalks.length);
    sidewalks.forEach((m, i) => swMesh.setMatrixAt(i, m));
    swMesh.instanceMatrix.needsUpdate = true;
    swMesh.receiveShadow = true;
    this.scene.add(swMesh);

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 1 });
    const mesh = new THREE.InstancedMesh(geo, mat, boxes.length);
    boxes.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildGround(): void {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x14361f, roughness: 1 });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.scale.set(1e5, 1e5, 1);
    ground.position.set(0, -0.05, 0);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  buildAgents(capacity: number): void {
    const geo = new THREE.CapsuleGeometry(0.25, 1.1, 4, 8);
    geo.translate(0, 0.8, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe0d5c0, roughness: 0.7 });
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.agentMesh = mesh;
  }

  buildVehicles(capacity: number): void {
    const geo = new THREE.BoxGeometry(4.4, 1.5, 2.0);
    geo.translate(0, 0.75, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 });
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.vehicleMesh = mesh;
  }

  /** 信号灯を各交差点に2基(軸ごと)設置。色は毎フレーム更新。 */
  buildSignals(net: RoadNetwork, signals: SignalSystem): void {
    this.signalRefs = [];
    for (const node of signals.nodeIds) {
      this.signalRefs.push({ node, axis: 0 });
      this.signalRefs.push({ node, axis: 1 });
    }
    const geo = new THREE.SphereGeometry(0.7, 8, 8);
    // 発光風の見た目にするため unlit(Basic)。instanceColor で灯色を出す。
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, this.signalRefs.length));
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.signalRefs.length) * 3), 3);
    mesh.frustumCulled = false;
    // 位置は固定(交差点上、軸で高さを変えて2灯を判別しやすく)
    for (let k = 0; k < this.signalRefs.length; k++) {
      const { node, axis } = this.signalRefs[k];
      const n = net.nodes[node];
      this.dummy.position.set(n.x, axis === 0 ? 6.5 : 5.0, n.z);
      this.dummy.scale.setScalar(1);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(k, this.dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this.signalMesh = mesh;
  }

  syncAgents(store: AgentStore): void {
    const mesh = this.agentMesh;
    let n = 0;
    for (let i = 0; i < store.count; i++) {
      const st = store.state[i];
      if (st === AgentState.Driving || st === AgentState.Engaged) continue;
      this.dummy.position.set(store.posX[i], 0, store.posZ[i]);
      this.dummy.rotation.set(0, -store.heading[i], 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(n++, this.dummy.matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  syncVehicles(vs: VehicleStore): void {
    const mesh = this.vehicleMesh;
    let n = 0;
    for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving) continue;
      this.dummy.position.set(vs.posX[v], 0, vs.posZ[v]);
      this.dummy.rotation.set(0, -vs.heading[v], 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(n, this.dummy.matrix);
      mesh.setColorAt(n, this.carColors[v % this.carColors.length]);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** 信号灯の色を現在の位相で更新。 */
  syncSignals(signals: SignalSystem): void {
    const mesh = this.signalMesh;
    if (!mesh) return;
    for (let k = 0; k < this.signalRefs.length; k++) {
      const { node, axis } = this.signalRefs[k];
      const c = signals.color(node, axis);
      const col = c === 'green' ? this.colGreen : c === 'yellow' ? this.colYellow : this.colRed;
      mesh.setColorAt(k, col);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
