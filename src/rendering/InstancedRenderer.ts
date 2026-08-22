import * as THREE from 'three';
import { Building } from '../generation/CityGenerator';
import { RoadNetwork } from '../traffic/RoadNetwork';
import { AgentStore, AgentState } from '../agents/AgentStore';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { POICategory } from '../world/POI';

/**
 * ============================================================================
 *  描画層: GPU インスタンシング
 * ============================================================================
 *  - 建物 / 歩行者 / 車両 をそれぞれ1個の InstancedMesh で一括描画(各1ドロー)
 *  - 座標は各 Store の TypedArray から毎フレーム転送
 *
 * 「ハリボテ回避」の方針は段階的に:用途別マテリアル→テクスチャアトラス、
 * 階数に応じた高さ、窓のノーマル/夜景エミッシブ、遠景はインポスター(LOD)。
 */
export class InstancedRenderer {
  private buildingMesh!: THREE.InstancedMesh;
  private agentMesh!: THREE.InstancedMesh;
  private vehicleMesh!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();

  private readonly categoryColor: Record<number, THREE.Color> = {
    [POICategory.Home]:   new THREE.Color(0x8fa9c6),
    [POICategory.Work]:   new THREE.Color(0x6f7f95),
    [POICategory.Food]:   new THREE.Color(0xc98b5a),
    [POICategory.Retail]: new THREE.Color(0xb9a06a),
    [POICategory.Leisure]:new THREE.Color(0x7cba8f),
  };

  // 車両の色バリエーション(見分けやすさのため数色をローテーション)
  private readonly carColors = [
    0xd94f4f, 0x4f7fd9, 0xe0e0e0, 0x2b2b2b, 0xd9b64f, 0x54b07a, 0x8a6fd9,
  ].map((c) => new THREE.Color(c));

  constructor(private scene: THREE.Scene) {}

  get buildings(): THREE.InstancedMesh { return this.buildingMesh; }
  get agents(): THREE.InstancedMesh { return this.agentMesh; }
  get vehiclesMesh(): THREE.InstancedMesh { return this.vehicleMesh; }

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
      const c = this.categoryColor[b.category] ?? new THREE.Color(0x9aa5b1);
      mesh.setColorAt(i, c);
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
    for (const e of net.edges) {
      const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = net.nodes[e.from], b = net.nodes[e.to];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const angle = Math.atan2(b.z - a.z, b.x - a.x);
      const width = 3.5 * e.lanes * 2;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(mx, 0.05, mz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
        new THREE.Vector3(e.length, 0.1, width),
      );
      boxes.push(m);
    }
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

  /** 歩行者インスタンスの器を確保。 */
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

  /** 車両インスタンスの器を確保。 */
  buildVehicles(capacity: number): void {
    // シンプルな車体(箱)。将来はキャビン付きの低ポリモデルへ差し替え。
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

  /** AgentStore の座標を歩行者インスタンスへ転送(Driving/Engaged は非表示)。 */
  syncAgents(store: AgentStore): void {
    const mesh = this.agentMesh;
    let n = 0;
    for (let i = 0; i < store.count; i++) {
      const st = store.state[i];
      // 車内(Driving)や滞在中(建物内 Engaged)は歩行者として描かない
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

  /** VehicleStore の座標を車両インスタンスへ転送。 */
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
}
