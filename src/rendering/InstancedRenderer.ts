import * as THREE from 'three';
import { Building } from '../generation/CityGenerator';
import { RoadNetwork } from '../traffic/RoadNetwork';
import { AgentStore } from '../agents/AgentStore';
import { POICategory } from '../world/POI';

/**
 * ============================================================================
 *  描画層: GPU インスタンシング
 * ============================================================================
 *  - 建物: 1個のBoxGeometryを InstancedMesh で全棟ぶん描画(1ドローコール)
 *  - 歩行者: 同様に InstancedMesh。座標は AgentStore の TypedArray から毎フレーム転送。
 *  - 道路: セグメントを1つのメッシュにまとめて描画。
 *
 * 「ハリボテ回避」の方針:
 *   本ファイルはまず"正しい量とスケール感"を出す土台。質感は
 *   ・用途別マテリアル(色分け→将来テクスチャアトラス)
 *   ・階数に応じた高さ
 *   ・窓の格子ノーマル/エミッシブ(夜景)
 *   を段階的に足す。距離が遠い建物はビルボード・インポスターへ置換(LOD)。
 */
export class InstancedRenderer {
  private buildingMesh!: THREE.InstancedMesh;
  private agentMesh!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();

  private readonly categoryColor: Record<number, THREE.Color> = {
    [POICategory.Home]:   new THREE.Color(0x8fa9c6),
    [POICategory.Work]:   new THREE.Color(0x6f7f95),
    [POICategory.Food]:   new THREE.Color(0xc98b5a),
    [POICategory.Retail]: new THREE.Color(0xb9a06a),
    [POICategory.Leisure]:new THREE.Color(0x7cba8f),
  };

  constructor(private scene: THREE.Scene) {}

  buildStatic(buildings: Building[], net: RoadNetwork): void {
    this.buildBuildings(buildings);
    this.buildRoads(net);
    this.buildGround();
  }

  private buildBuildings(buildings: Building[]): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0); // 底面を原点に
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
    // 各エッジ(片方向のみ描画)を薄い箱で表現。まとめて1メッシュに。
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
    mesh.frustumCulled = false; // 位置が毎フレーム変わるため自前管理
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.agentMesh = mesh;
  }

  /** AgentStore の座標を InstancedMesh に転送(描画LOD: 近傍のみ本体表示)。 */
  syncAgents(store: AgentStore): void {
    const mesh = this.agentMesh;
    for (let i = 0; i < store.count; i++) {
      this.dummy.position.set(store.posX[i], 0, store.posZ[i]);
      this.dummy.rotation.y = -store.heading[i];
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    }
    mesh.count = store.count;
    mesh.instanceMatrix.needsUpdate = true;
  }
}
