import * as THREE from 'three';
import { Building } from '../generation/CityGenerator';
import { RoadNetwork } from '../traffic/RoadNetwork';
import { AgentStore, AgentState } from '../agents/AgentStore';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { SignalSystem, SignalMode } from '../traffic/SignalSystem';
import { POICategory } from '../world/POI';

/**
 * 描画層: GPU インスタンシング。建物/歩行者/車両/信号灯を各1ドローで描画。
 */
export class InstancedRenderer {
  private buildingMesh!: THREE.InstancedMesh;
  private agentMesh!: THREE.InstancedMesh;
  private vehicleMesh!: THREE.InstancedMesh;
  private vehSignalMesh!: THREE.InstancedMesh;  // 車道信号灯
  private pedSignalMesh!: THREE.InstancedMesh;  // 歩行者信号灯
  private dummy = new THREE.Object3D();

  // 信号灯インスタンス → (nodeId, axis) の対応表(車道用/歩行者用で共通の並び)
  private signalRefs: { node: number; axis: 0 | 1 }[] = [];
  private colGreen = new THREE.Color(0x36e05a);
  private colYellow = new THREE.Color(0xf2c14e);
  private colRed = new THREE.Color(0xe0402f);
  private colWalk = new THREE.Color(0x5ad1ff);   // 歩行者・青(進める)
  private colDont = new THREE.Color(0xe0603a);    // 歩行者・赤(止まれ)

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

  /**
   * 横断歩道マーキングを描画する。
   * 各信号交差点の「接続する各道路方向」に、ゼブラ(縞)の帯を1枚ずつ敷く。
   * ゼブラの縞は車の進行方向に平行、道路幅いっぱいに並べる(現実の横断歩道と同じ)。
   * スクランブル交差点には追加で斜め横断の縞(×字)も描く。
   * すべて静的なので生成時に1メッシュへまとめる(1ドロー)。
   */
  buildCrosswalks(net: RoadNetwork, signals: SignalSystem): void {
    const stripes: THREE.Matrix4[] = [];
    const y = 0.13; // 車道(0.1)より僅かに上へ描いて z-fighting を避ける

    const STRIPE_W = 0.55;    // 縞の幅(進行方向に直交)
    const STRIPE_GAP = 0.55;  // 縞の間隔
    const CROSS_DEPTH = 4.5;  // 横断歩道の奥行き(進行方向)

    const addBand = (cx: number, cz: number, dirX: number, dirZ: number, roadW: number) => {
      // dir = 車の進行方向(この帯を横切る向き)。perp = 縞が並ぶ向き(道路幅方向)。
      const L = Math.hypot(dirX, dirZ) || 1;
      const dx = dirX / L, dz = dirZ / L;
      const px = -dz, pz = dx; // 直交
      const angle = Math.atan2(dz, dx);
      const half = roadW / 2 - 0.3;
      const pitch = STRIPE_W + STRIPE_GAP;
      const n = Math.max(1, Math.floor((roadW - 0.6) / pitch));
      const start = -((n - 1) * pitch) / 2;
      for (let k = 0; k < n; k++) {
        const off = start + k * pitch;
        if (Math.abs(off) > half) continue;
        const sx = cx + px * off;
        const sz = cz + pz * off;
        const m = new THREE.Matrix4();
        m.compose(
          new THREE.Vector3(sx, y, sz),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
          // 進行方向(x)= 横断歩道の奥行き, 幅(z)= 縞1本の幅
          new THREE.Vector3(CROSS_DEPTH, 0.06, STRIPE_W),
        );
        stripes.push(m);
      }
    };

    for (const nodeId of signals.nodeIds) {
      const node = net.nodes[nodeId];
      const scramble = signals.modeOf(nodeId) === SignalMode.Scramble;

      // 接続する各道路方向へ横断歩道を1枚(交差点の手前=セットバック位置に)
      for (const edgeId of node.edges) {
        const e = net.edges[edgeId];
        const nb = net.nodes[e.to];
        let dxx = nb.x - node.x, dzz = nb.z - node.z;
        const L = Math.hypot(dxx, dzz) || 1;
        dxx /= L; dzz /= L;
        const roadW = 3.5 * e.lanes * 2;
        // 交差点中心から道路方向へセットバックした位置に横断歩道を置く
        const setback = 7 + roadW * 0.25;
        const cx = node.x + dxx * setback;
        const cz = node.z + dzz * setback;
        // この道路を「横切る」向き = 道路に直交する歩行者の進む向き。
        // ゼブラの縞は車進行方向(dxx,dzz)に平行に並ぶので dir=道路方向を渡す。
        addBand(cx, cz, dxx, dzz, roadW);
      }

      // スクランブル: 交差点中央に斜め横断のゼブラ(×字)
      if (scramble) {
        const diagLen = 10;
        addBand(node.x, node.z, 0.707, 0.707, diagLen);
        addBand(node.x, node.z, 0.707, -0.707, diagLen);
      }
    }

    if (stripes.length === 0) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // 少し発光させて夜でも視認できる白線
    const mat = new THREE.MeshStandardMaterial({
      color: 0xdadfe6, roughness: 0.9, emissive: 0x2a2d33, emissiveIntensity: 0.3,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, stripes.length);
    stripes.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
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

  /**
   * 各信号交差点に「車道信号灯」と「歩行者信号灯」を軸ごとに設置。
   * 車道信号は高い位置の球、歩行者信号は低い位置の小さな箱で見分けやすくする。
   * 色は毎フレーム syncSignals で更新する。
   */
  buildSignals(net: RoadNetwork, signals: SignalSystem): void {
    this.signalRefs = [];
    for (const node of signals.nodeIds) {
      this.signalRefs.push({ node, axis: 0 });
      this.signalRefs.push({ node, axis: 1 });
    }
    const count = Math.max(1, this.signalRefs.length);

    // --- 車道信号灯(高所の球)---
    const vGeo = new THREE.SphereGeometry(0.7, 8, 8);
    const vMat = new THREE.MeshBasicMaterial();
    const vMesh = new THREE.InstancedMesh(vGeo, vMat, count);
    vMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    vMesh.frustumCulled = false;

    // --- 歩行者信号灯(低所の小箱)---
    const pGeo = new THREE.BoxGeometry(0.9, 0.9, 0.4);
    const pMat = new THREE.MeshBasicMaterial();
    const pMesh = new THREE.InstancedMesh(pGeo, pMat, count);
    pMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    pMesh.frustumCulled = false;

    for (let k = 0; k < this.signalRefs.length; k++) {
      const { node, axis } = this.signalRefs[k];
      const n = net.nodes[node];
      // 軸方向へ少しずらして「その道路に面した信号」らしく配置
      const ax = axis === 0 ? 5 : 0;
      const az = axis === 1 ? 5 : 0;

      // 車道信号: 交差点の先、高さ6.5
      this.dummy.position.set(n.x + ax, 6.5, n.z + az);
      this.dummy.scale.setScalar(1);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      vMesh.setMatrixAt(k, this.dummy.matrix);

      // 歩行者信号: 交差点の角(直交方向へオフセット)、低め高さ2.6
      const px = axis === 0 ? 0 : 5;
      const pz = axis === 1 ? 0 : 5;
      this.dummy.position.set(n.x + px, 2.6, n.z + pz);
      this.dummy.updateMatrix();
      pMesh.setMatrixAt(k, this.dummy.matrix);
    }
    vMesh.instanceMatrix.needsUpdate = true;
    pMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(vMesh);
    this.scene.add(pMesh);
    this.vehSignalMesh = vMesh;
    this.pedSignalMesh = pMesh;
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

  /** 車道信号・歩行者信号の灯色を現在の位相で更新。 */
  syncSignals(signals: SignalSystem): void {
    const vMesh = this.vehSignalMesh, pMesh = this.pedSignalMesh;
    if (!vMesh || !pMesh) return;
    for (let k = 0; k < this.signalRefs.length; k++) {
      const { node, axis } = this.signalRefs[k];
      // 車道信号
      const vc = signals.vehicleColor(node, axis);
      vMesh.setColorAt(k, vc === 'green' ? this.colGreen : vc === 'yellow' ? this.colYellow : this.colRed);
      // 歩行者信号
      const pc = signals.pedColor(node, axis);
      pMesh.setColorAt(k, pc === 'walk' ? this.colWalk : this.colDont);
    }
    if (vMesh.instanceColor) vMesh.instanceColor.needsUpdate = true;
    if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
  }
}
