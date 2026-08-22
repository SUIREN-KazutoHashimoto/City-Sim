import * as THREE from 'three';
import { Building, ParkingLot } from '../generation/CityGenerator';
import { RoadNetwork, roadWidth, crosswalkSetback, CROSSWALK_DEPTH } from '../traffic/RoadNetwork';
import { SidewalkNetwork } from '../traffic/SidewalkNetwork';
import { AgentStore, AgentState } from '../agents/AgentStore';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { SignalSystem, SignalMode } from '../traffic/SignalSystem';
import { POICategory } from '../world/POI';

/** 描画層: GPUインスタンシング。建物/歩道/駐車場/歩行者/車両/信号/横断歩道/停止線。 */
export class InstancedRenderer {
  private buildingMesh!: THREE.InstancedMesh;
  private agentMesh!: THREE.InstancedMesh;
  private vehicleMesh!: THREE.InstancedMesh;
  private vehSignalMesh!: THREE.InstancedMesh;
  private pedSignalMesh!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();

  private agentMap = new Int32Array(0);
  private vehicleMap = new Int32Array(0);
  private signalRefs: { node: number; axis: 0 | 1 }[] = [];

  private colGreen = new THREE.Color(0x36e05a);
  private colYellow = new THREE.Color(0xf2c14e);
  private colRed = new THREE.Color(0xe0402f);
  private colWalk = new THREE.Color(0x5ad1ff);
  private colDont = new THREE.Color(0xe0603a);

  private readonly categoryColor: Record<number, THREE.Color> = {
    [POICategory.Home]: new THREE.Color(0x8fa9c6),
    [POICategory.Work]: new THREE.Color(0x6f7f95),
    [POICategory.Food]: new THREE.Color(0xc98b5a),
    [POICategory.Retail]: new THREE.Color(0xb9a06a),
    [POICategory.Leisure]: new THREE.Color(0x7cba8f),
  };
  private readonly carColors = [
    0xd94f4f, 0x4f7fd9, 0xe0e0e0, 0x2b2b2b, 0xd9b64f, 0x54b07a, 0x8a6fd9,
  ].map((c) => new THREE.Color(c));

  constructor(private scene: THREE.Scene) {}

  get buildings(): THREE.InstancedMesh { return this.buildingMesh; }
  get agents(): THREE.InstancedMesh { return this.agentMesh; }
  get vehicles(): THREE.InstancedMesh { return this.vehicleMesh; }
  agentIndexOf(id: number): number { return id >= 0 && id < this.agentMap.length ? this.agentMap[id] : -1; }
  vehicleIndexOf(id: number): number { return id >= 0 && id < this.vehicleMap.length ? this.vehicleMap[id] : -1; }

  buildStatic(buildings: Building[], net: RoadNetwork, sidewalk: SidewalkNetwork, lots: ParkingLot[]): void {
    this.buildGround();
    this.buildRoads(net);
    this.buildSidewalks(sidewalk);
    this.buildParking(lots);
    this.buildBuildings(buildings);
  }

  private buildGround(): void {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c3a24, roughness: 1 });
    const g = new THREE.Mesh(geo, mat);
    g.rotation.x = -Math.PI / 2; g.scale.set(1e5, 1e5, 1); g.position.set(0, -0.05, 0);
    g.receiveShadow = true; this.scene.add(g);
  }

  private buildRoads(net: RoadNetwork): void {
    const drawn = new Set<string>();
    const boxes: THREE.Matrix4[] = [];
    for (const e of net.edges) {
      const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = net.nodes[e.from], b = net.nodes[e.to];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const angle = Math.atan2(b.z - a.z, b.x - a.x);
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(mx, 0.05, mz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
        new THREE.Vector3(e.length, 0.1, roadWidth(e.lanes)));
      boxes.push(m);
    }
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 1 }), boxes.length);
    boxes.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /** 歩道: 歩道グラフの非横断エッジを明るいベージュの細い帯で描く。 */
  private buildSidewalks(sw: SidewalkNetwork): void {
    const boxes: THREE.Matrix4[] = [];
    const drawn = new Set<number>();
    for (const e of sw.edges) {
      const key = e.from < e.to ? e.from * 1e6 + e.to : e.to * 1e6 + e.from;
      if (drawn.has(key)) continue;
      drawn.add(key);
      if (e.crossing) continue; // 横断部は車道上なので描かない
      const a = sw.nodes[e.from], b = sw.nodes[e.to];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const angle = Math.atan2(b.z - a.z, b.x - a.x);
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(mx, 0.09, mz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
        new THREE.Vector3(e.length + 3, 0.12, 3.0));
      boxes.push(m);
    }
    if (boxes.length === 0) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xb0a58f, roughness: 1 }), boxes.length);
    boxes.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildParking(lots: ParkingLot[]): void {
    if (lots.length === 0) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 1 }), lots.length);
    lots.forEach((lot, i) => {
      this.dummy.position.set(lot.x, 0.07, lot.z);
      this.dummy.scale.set(lot.width, 0.1, lot.depth);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildBuildings(buildings: Building[]): void {
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo,
      new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 }), buildings.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(buildings.length * 3), 3);
    const fh = 3.2;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      this.dummy.position.set(b.x, 0, b.z);
      this.dummy.scale.set(b.width, b.floors * fh, b.depth);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
      mesh.setColorAt(i, this.categoryColor[b.category] ?? new THREE.Color(0x9aa5b1));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.scene.add(mesh); this.buildingMesh = mesh;
  }

  buildAgents(capacity: number): void {
    const geo = new THREE.CapsuleGeometry(0.25, 1.1, 4, 8); geo.translate(0, 0.8, 0);
    const mesh = new THREE.InstancedMesh(geo,
      new THREE.MeshStandardMaterial({ color: 0xe0d5c0, roughness: 0.7 }), capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.castShadow = true;
    this.scene.add(mesh); this.agentMesh = mesh;
  }

  buildVehicles(capacity: number): void {
    const geo = new THREE.BoxGeometry(4.4, 1.5, 2.0); geo.translate(0, 0.75, 0);
    const mesh = new THREE.InstancedMesh(geo,
      new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }), capacity);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.castShadow = true;
    this.scene.add(mesh); this.vehicleMesh = mesh;
  }

  buildSignals(net: RoadNetwork, signals: SignalSystem): void {
    this.signalRefs = [];
    for (const node of signals.nodeIds) { this.signalRefs.push({ node, axis: 0 }); this.signalRefs.push({ node, axis: 1 }); }
    const count = Math.max(1, this.signalRefs.length);
    const vMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 8, 8), new THREE.MeshBasicMaterial(), count);
    vMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    vMesh.frustumCulled = false;
    const pMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.9, 0.4), new THREE.MeshBasicMaterial(), count);
    pMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    pMesh.frustumCulled = false;
    for (let k = 0; k < this.signalRefs.length; k++) {
      const { node, axis } = this.signalRefs[k];
      const n = net.nodes[node];
      const ax = axis === 0 ? 5 : 0, az = axis === 1 ? 5 : 0;
      this.dummy.position.set(n.x + ax, 6.5, n.z + az);
      this.dummy.scale.setScalar(1); this.dummy.rotation.set(0, 0, 0); this.dummy.updateMatrix();
      vMesh.setMatrixAt(k, this.dummy.matrix);
      const px = axis === 0 ? 0 : 5, pz = axis === 1 ? 0 : 5;
      this.dummy.position.set(n.x + px, 2.6, n.z + pz); this.dummy.updateMatrix();
      pMesh.setMatrixAt(k, this.dummy.matrix);
    }
    vMesh.instanceMatrix.needsUpdate = true; pMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(vMesh); this.scene.add(pMesh);
    this.vehSignalMesh = vMesh; this.pedSignalMesh = pMesh;
  }

  buildCrosswalks(net: RoadNetwork, signals: SignalSystem): void {
    const stripes: THREE.Matrix4[] = [];
    const y = 0.13, SW = 0.55, GAP = 0.55;
    const addBand = (cx: number, cz: number, dirX: number, dirZ: number, roadW: number) => {
      const L = Math.hypot(dirX, dirZ) || 1; const dx = dirX / L, dz = dirZ / L;
      const px = -dz, pz = dx; const angle = Math.atan2(dz, dx);
      const half = roadW / 2 - 0.3, pitch = SW + GAP;
      const n = Math.max(1, Math.floor((roadW - 0.6) / pitch));
      const start = -((n - 1) * pitch) / 2;
      for (let k = 0; k < n; k++) {
        const off = start + k * pitch; if (Math.abs(off) > half) continue;
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(cx + px * off, y, cz + pz * off),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
          new THREE.Vector3(CROSSWALK_DEPTH, 0.06, SW));
        stripes.push(m);
      }
    };
    for (const nodeId of signals.nodeIds) {
      const node = net.nodes[nodeId];
      const scramble = signals.modeOf(nodeId) === SignalMode.Scramble;
      for (const edgeId of node.edges) {
        const e = net.edges[edgeId], nb = net.nodes[e.to];
        let dxx = nb.x - node.x, dzz = nb.z - node.z; const L = Math.hypot(dxx, dzz) || 1;
        dxx /= L; dzz /= L;
        const roadW = roadWidth(e.lanes); const setback = crosswalkSetback(roadW);
        addBand(node.x + dxx * setback, node.z + dzz * setback, dxx, dzz, roadW);
      }
      if (scramble) { addBand(node.x, node.z, 0.707, 0.707, 10); addBand(node.x, node.z, 0.707, -0.707, 10); }
    }
    if (stripes.length === 0) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xdadfe6, roughness: 0.9, emissive: 0x2a2d33, emissiveIntensity: 0.3 }), stripes.length);
    stripes.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true; this.scene.add(mesh);
  }

  buildStopLines(net: RoadNetwork, signals: SignalSystem): void {
    const bars: THREE.Matrix4[] = [];
    for (const nodeId of signals.nodeIds) {
      const node = net.nodes[nodeId];
      for (const edgeId of node.edges) {
        const e = net.edges[edgeId], nb = net.nodes[e.to];
        let dxx = nb.x - node.x, dzz = nb.z - node.z; const L = Math.hypot(dxx, dzz) || 1;
        dxx /= L; dzz /= L;
        const roadW = roadWidth(e.lanes);
        const setback = crosswalkSetback(roadW) + CROSSWALK_DEPTH * 0.5 + 0.8;
        const angle = Math.atan2(dzz, dxx);
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(node.x + dxx * setback, 0.14, node.z + dzz * setback),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
          new THREE.Vector3(0.6, 0.06, roadW - 0.6));
        bars.push(m);
      }
    }
    if (bars.length === 0) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe6ebf0, roughness: 0.9, emissive: 0x2a2d33, emissiveIntensity: 0.25 }), bars.length);
    bars.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true; this.scene.add(mesh);
  }

  syncAgents(store: AgentStore): void {
    const mesh = this.agentMesh;
    if (this.agentMap.length < store.capacity) this.agentMap = new Int32Array(store.capacity);
    let n = 0;
    for (let i = 0; i < store.count; i++) {
      const st = store.state[i];
      if (st === AgentState.Driving || st === AgentState.Engaged) continue;
      this.dummy.position.set(store.posX[i], 0, store.posZ[i]);
      this.dummy.rotation.set(0, -store.heading[i], 0);
      this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
      mesh.setMatrixAt(n, this.dummy.matrix); this.agentMap[n] = i; n++;
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
  }

  /** 走行中+駐車中の車両を描画(駐車場に停まる車も見える)。 */
  syncVehicles(vs: VehicleStore): void {
    const mesh = this.vehicleMesh;
    if (this.vehicleMap.length < vs.capacity) this.vehicleMap = new Int32Array(vs.capacity);
    let n = 0;
    for (let v = 0; v < vs.count; v++) {
      const st = vs.state[v];
      if (st !== VehicleState.Driving && st !== VehicleState.Parked) continue;
      this.dummy.position.set(vs.posX[v], 0, vs.posZ[v]);
      this.dummy.rotation.set(0, -vs.heading[v], 0);
      this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
      mesh.setMatrixAt(n, this.dummy.matrix);
      mesh.setColorAt(n, this.carColors[vs.colorIdx[v] % this.carColors.length]);
      this.vehicleMap[n] = v; n++;
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  syncSignals(signals: SignalSystem): void {
    const vMesh = this.vehSignalMesh, pMesh = this.pedSignalMesh;
    if (!vMesh || !pMesh) return;
    for (let k = 0; k < this.signalRefs.length; k++) {
      const { node, axis } = this.signalRefs[k];
      const vc = signals.vehicleColor(node, axis);
      vMesh.setColorAt(k, vc === 'green' ? this.colGreen : vc === 'yellow' ? this.colYellow : this.colRed);
      const pc = signals.pedColor(node, axis);
      pMesh.setColorAt(k, pc === 'walk' ? this.colWalk : this.colDont);
    }
    if (vMesh.instanceColor) vMesh.instanceColor.needsUpdate = true;
    if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
  }
}
