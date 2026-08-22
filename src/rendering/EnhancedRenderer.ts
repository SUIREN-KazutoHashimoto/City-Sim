import * as THREE from 'three';
import { InstancedRenderer } from './InstancedRenderer';
import { Building, BuildingArchetype, ParkingLot, RoofType } from '../generation/CityGenerator';
import { RoadClass, RoadNetwork, roadWidth } from '../traffic/RoadNetwork';
import { SidewalkNetwork } from '../traffic/SidewalkNetwork';
import { AgentState, AgentStore } from '../agents/AgentStore';
import { VehicleState, VehicleStore } from '../traffic/VehicleStore';
import { POICategory } from '../world/POI';

interface StaticPart { matrix: THREE.Matrix4; color?: THREE.Color; }

/**
 * 既存 InstancedRenderer を互換レイヤとして残しつつ、複合形状と街路ディテールを追加する描画拡張。
 * シミュレーションStoreを変更せず、描画専用のバリエーションはID/Building.styleSeedから決定する。
 */
export class EnhancedRenderer extends InstancedRenderer {
  private readonly sceneRef: THREE.Scene;
  private readonly d = new THREE.Object3D();

  private agentTorso!: THREE.InstancedMesh;
  private agentHead!: THREE.InstancedMesh;
  private agentLegs!: THREE.InstancedMesh;

  private vehicleCabin!: THREE.InstancedMesh;
  private vehicleWheels!: THREE.InstancedMesh;
  private vehicleFrontLamp!: THREE.InstancedMesh;
  private vehicleRearLamp!: THREE.InstancedMesh;

  private readonly residentialPalettes = [0xd8d0c2, 0xc7ced6, 0xe2ddd2, 0xb9b0a4];
  private readonly officePalettes = [0x8795a5, 0x6f7e91, 0xa4abb3, 0x737b82];
  private readonly retailPalettes = [0xc3a77d, 0xb7a58a, 0xd0b58b, 0xa99b87];
  private readonly leisurePalettes = [0x88aa93, 0x8499a9, 0x9b8fa7, 0x9ca77d];
  private readonly clothes = [0x315d89, 0x8a3f4c, 0x476f51, 0x7b5b91, 0xb07b3f, 0x52606e, 0x8a795a, 0x5d7b83].map((c) => new THREE.Color(c));

  constructor(scene: THREE.Scene) { super(scene); this.sceneRef = scene; }

  override buildStatic(buildings: Building[], net: RoadNetwork, sidewalk: SidewalkNetwork, lots: ParkingLot[]): void {
    // 既存building meshは全高のRaycast hit proxyとして残し、描画だけ透明化する。
    // これによりInspectorのinstanceId互換を保ったまま、可視形状は完全に拡張側で構築できる。
    super.buildStatic(buildings, net, sidewalk, lots);
    this.buildings.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    this.buildingDetails(buildings);
    this.buildRoadDetails(net);
    this.buildParkingMarkings(lots);
    this.buildStreetFurniture(sidewalk);
  }

  override buildAgents(capacity: number): void {
    super.buildAgents(capacity);
    // 元のCapsuleはInspectorのRaycast互換のため残すが、可視化は新しい人型パーツに任せる。
    this.agents.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    const torsoMat = new THREE.MeshStandardMaterial({ roughness: 0.82 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xd9b08c, roughness: 0.9 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.9 });
    this.agentTorso = new THREE.InstancedMesh(new THREE.BoxGeometry(0.48, 0.76, 0.30), torsoMat, capacity);
    this.agentTorso.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.agentHead = new THREE.InstancedMesh(new THREE.SphereGeometry(0.23, 7, 5), headMat, capacity);
    this.agentLegs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.17, 0.72, 0.18), legMat, capacity * 2);
    for (const m of [this.agentTorso, this.agentHead, this.agentLegs]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.castShadow = true; this.sceneRef.add(m); }
  }

  override syncAgents(store: AgentStore, simTime = 0): void {
    super.syncAgents(store);
    let n = 0, ln = 0;
    for (let i = 0; i < store.count; i++) {
      const st = store.state[i]; if (st === AgentState.Driving || st === AgentState.Engaged || st === AgentState.OnBus) continue;
      const x = store.posX[i], z = store.posZ[i], h = store.heading[i];
      this.pose(this.agentTorso, n, x, z, h, 0, 1.14, 0, 1, 1, 1, 0);
      this.agentTorso.setColorAt(n, this.clothes[(i * 7 + store.occupation[i]) % this.clothes.length]);
      this.pose(this.agentHead, n, x, z, h, 0, 1.72, 0, 1, 1, 1, 0);
      const moving = Math.hypot(store.velX[i], store.velZ[i]);
      const swing = moving > 0.05 ? Math.sin(simTime * (5.0 + store.maxSpeed[i]) + i * 0.73) * 0.48 : 0;
      this.pose(this.agentLegs, ln++, x, z, h, 0, 0.52, -0.11, 1, 1, 1, swing);
      this.pose(this.agentLegs, ln++, x, z, h, 0, 0.52, 0.11, 1, 1, 1, -swing);
      n++;
    }
    this.agentTorso.count = n; this.agentHead.count = n; this.agentLegs.count = ln;
    this.agentTorso.instanceMatrix.needsUpdate = true; this.agentHead.instanceMatrix.needsUpdate = true; this.agentLegs.instanceMatrix.needsUpdate = true;
    if (this.agentTorso.instanceColor) this.agentTorso.instanceColor.needsUpdate = true;
  }

  override buildVehicles(capacity: number): void {
    super.buildVehicles(capacity);
    this.vehicleCabin = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x26313c, roughness: 0.3, metalness: 0.15 }), capacity);
    this.vehicleWheels = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.95 }), capacity * 2);
    this.vehicleFrontLamp = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xfff2c2, emissive: 0xffd980, emissiveIntensity: 1.1 }), capacity);
    this.vehicleRearLamp = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd92c2c, emissive: 0x8f0909, emissiveIntensity: 1.2 }), capacity);
    for (const m of [this.vehicleCabin, this.vehicleWheels, this.vehicleFrontLamp, this.vehicleRearLamp]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.castShadow = true; this.sceneRef.add(m); }
  }

  override syncVehicles(vs: VehicleStore): void {
    super.syncVehicles(vs);
    let n = 0, wn = 0;
    for (let v = 0; v < vs.count; v++) {
      const st = vs.state[v]; const show = st === VehicleState.Driving || st === VehicleState.Parked || ((vs.isBus[v] || vs.isTruck[v]) && st === VehicleState.Arrived);
      if (!show) continue;
      const x = vs.posX[v], z = vs.posZ[v], h = vs.heading[v];
      let len = vs.length[v] || 4.5, width = 1.9, cabinLen = 2.2, cabinY = 1.35, cabinH = 0.72, cabinX = 0;
      if (vs.isBus[v]) { len = 11; width = 2.45; cabinLen = 9.4; cabinY = 1.85; cabinH = 1.05; }
      else if (vs.isTruck[v]) { len = 9; width = 2.4; cabinLen = 2.4; cabinY = 1.55; cabinH = 1.25; cabinX = len * 0.28; }
      else {
        const type = (v * 13 + vs.colorIdx[v]) & 3;
        if (type === 1) { cabinLen = 2.45; cabinH = 0.82; cabinY = 1.42; }
        else if (type === 2) { cabinLen = 2.25; cabinH = 0.98; cabinY = 1.55; width = 1.98; }
        else if (type === 3) { cabinLen = 2.75; cabinH = 1.0; cabinY = 1.56; width = 2.02; }
      }
      this.pose(this.vehicleCabin, n, x, z, h, cabinX, cabinY, 0, cabinLen, cabinH, width * 0.82, 0);
      const axle = Math.max(1.25, len * 0.29);
      this.pose(this.vehicleWheels, wn++, x, z, h, -axle, 0.38, 0, 0.58, 0.55, width * 1.06, 0);
      this.pose(this.vehicleWheels, wn++, x, z, h, axle, 0.38, 0, 0.58, 0.55, width * 1.06, 0);
      this.pose(this.vehicleFrontLamp, n, x, z, h, len / 2 + 0.04, 0.72, 0, 0.08, 0.20, width * 0.58, 0);
      this.pose(this.vehicleRearLamp, n, x, z, h, -len / 2 - 0.04, 0.72, 0, 0.08, 0.20, width * 0.58, 0);
      n++;
    }
    this.vehicleCabin.count = n; this.vehicleWheels.count = wn; this.vehicleFrontLamp.count = n; this.vehicleRearLamp.count = n;
    for (const m of [this.vehicleCabin, this.vehicleWheels, this.vehicleFrontLamp, this.vehicleRearLamp]) m.instanceMatrix.needsUpdate = true;
  }

  override buildBusStops(stops: { x: number; z: number }[]): void {
    super.buildBusStops(stops);
    const selected = stops.filter((_, i) => i % 2 === 0); if (selected.length === 0) return;
    const roofs: StaticPart[] = [], backs: StaticPart[] = [], benches: StaticPart[] = [];
    for (const s of selected) {
      roofs.push({ matrix: this.matrix(s.x + 1.2, 2.55, s.z, 2.8, 0.15, 1.5) });
      backs.push({ matrix: this.matrix(s.x + 1.2, 1.35, s.z + 0.7, 2.8, 2.2, 0.12) });
      benches.push({ matrix: this.matrix(s.x + 1.2, 0.55, s.z, 1.8, 0.16, 0.5) });
    }
    this.addStatic(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x6b7480, roughness: 0.65, metalness: 0.25 }), roofs);
    this.addStatic(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x506474, roughness: 0.45, transparent: true, opacity: 0.7 }), backs);
    this.addStatic(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x765d46, roughness: 0.9 }), benches);
  }

  private buildingDetails(buildings: Building[]): void {
    const shells: StaticPart[] = [], uppers: StaticPart[] = [], frontPanels: StaticPart[] = [], sidePanels: StaticPart[] = [];
    const roofs: StaticPart[] = [], rooftop: StaticPart[] = [], awnings: StaticPart[] = [];
    const FH = 3.2;
    for (const b of buildings) {
      const [w, dep] = this.dims(b), baseF = this.baseFloors(b), baseH = baseF * FH, totalH = b.floors * FH;
      const main = this.buildingColor(b), accent = main.clone().offsetHSL(0, -0.05, -0.12);
      shells.push({ matrix: this.matrix(b.x, baseH / 2 + 0.02, b.z, w + 0.08, baseH + 0.04, dep + 0.08), color: main });

      const tower = b.archetype === BuildingArchetype.ResidentialTower || b.archetype === BuildingArchetype.OfficeTower || b.archetype === BuildingArchetype.MixedUse;
      const stepped = b.floors > baseF;
      let upperW = w, upperD = dep, upperH = 0, upperY = baseH;
      if (stepped) {
        const shrink = tower ? (b.archetype === BuildingArchetype.MixedUse ? 0.74 : 0.7 + ((b.styleSeed >>> 3) & 7) * 0.015) : 0.82 + ((b.styleSeed >>> 5) & 3) * 0.025;
        upperW = w * shrink;
        upperD = dep * shrink;
        upperH = totalH - baseH; upperY = baseH + upperH / 2;
        uppers.push({ matrix: this.matrix(b.x, upperY, b.z, upperW, upperH, upperD), color: main.clone().offsetHSL(0, 0, 0.035) });
      }

      const facadeH = Math.max(1.2, (stepped ? upperH : baseH) * 0.62);
      const facadeY = stepped ? upperY : baseH * 0.56;
      const fw = stepped ? upperW : w, fd = stepped ? upperD : dep;
      if (b.archetype !== BuildingArchetype.DetachedHouse && b.archetype !== BuildingArchetype.TownHouse) {
        frontPanels.push({ matrix: this.matrix(b.x, facadeY, b.z + fd / 2 + 0.06, fw * 0.76, facadeH, 0.08), color: new THREE.Color(0x334451) });
        sidePanels.push({ matrix: this.matrix(b.x + fw / 2 + 0.06, facadeY, b.z, 0.08, facadeH, fd * 0.76), color: new THREE.Color(0x3b4a54) });
      }

      const roofY = totalH + 0.4;
      if (b.roofType === RoofType.Gable || b.roofType === RoofType.Hip) {
        roofs.push({ matrix: this.matrix(b.x, totalH + 0.85, b.z, (stepped ? upperW : w) * 0.55, 1.7, (stepped ? upperD : dep) * 0.55, Math.PI / 4), color: accent });
      } else if (b.roofType === RoofType.Mechanical || (b.styleSeed & 3) === 0) {
        rooftop.push({ matrix: this.matrix(b.x + fw * 0.12, roofY, b.z - fd * 0.1, fw * 0.28, 0.8, fd * 0.24), color: new THREE.Color(0x62686d) });
      }

      if (b.archetype === BuildingArchetype.SmallShop || b.archetype === BuildingArchetype.RetailBox || b.archetype === BuildingArchetype.CommercialBlock || b.archetype === BuildingArchetype.MixedUse) {
        awnings.push({ matrix: this.matrix(b.x, Math.min(baseH - 0.5, 2.7), b.z + dep / 2 + 0.6, w * 0.58, 0.18, 1.1), color: accent });
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.04 }), shells, true);
    this.addStatic(box, new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.06 }), uppers, true);
    this.addStatic(box, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25 }), frontPanels, true);
    this.addStatic(box, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25 }), sidePanels, true);
    this.addStatic(new THREE.ConeGeometry(1, 1, 4), new THREE.MeshStandardMaterial({ roughness: 0.9 }), roofs, true);
    this.addStatic(box, new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.25 }), rooftop, true);
    this.addStatic(box, new THREE.MeshStandardMaterial({ roughness: 0.75 }), awnings, true);
  }

  private buildRoadDetails(net: RoadNetwork): void {
    const curbs: StaticPart[] = [], medians: StaticPart[] = [], rails: StaticPart[] = []; const done = new Set<string>();
    for (const e of net.edges) {
      const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`; if (done.has(key)) continue; done.add(key);
      if (e.roadClass === RoadClass.Path) continue;
      const a = net.nodes[e.from], b = net.nodes[e.to], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      const ux = dx / L, uz = dz / L, px = -uz, pz = ux, angle = -Math.atan2(dz, dx), rw = roadWidth(e.lanes);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if (e.roadClass !== RoadClass.Highway) {
        for (const side of [-1, 1]) curbs.push({ matrix: this.matrix(mx + px * (rw / 2 + 0.18) * side, 0.19, mz + pz * (rw / 2 + 0.18) * side, e.length, 0.22, 0.26, angle) });
      }
      if (e.roadClass === RoadClass.Arterial && e.lanes >= 2) medians.push({ matrix: this.matrix(mx, 0.18, mz, e.length * 0.9, 0.28, 0.65, angle) });
      if (e.roadClass === RoadClass.Highway) for (const side of [-1, 1]) rails.push({ matrix: this.matrix(mx + px * (rw / 2 + 0.55) * side, 0.68, mz + pz * (rw / 2 + 0.55) * side, e.length, 0.16, 0.14, angle) });
      void ux; void uz;
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x9a958d, roughness: 0.95 }), curbs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777a72, roughness: 0.95 }), medians);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.65, metalness: 0.45 }), rails);
  }

  private buildParkingMarkings(lots: ParkingLot[]): void {
    const marks: StaticPart[] = []; const MAX = 30000;
    for (const lot of lots) {
      for (let i = 0; i < lot.capacity && marks.length + 2 <= MAX; i++) {
        marks.push({ matrix: this.matrix(lot.slotX[i] - 1.25, 0.135, lot.slotZ[i], 0.07, 0.035, 2.45) });
        marks.push({ matrix: this.matrix(lot.slotX[i] + 1.25, 0.135, lot.slotZ[i], 0.07, 0.035, 2.45) });
      }
      if (marks.length >= MAX) break;
    }
    this.addStatic(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xd7d7d2 }), marks);
  }

  private buildStreetFurniture(sw: SidewalkNetwork): void {
    const poles: StaticPart[] = [], lamps: StaticPart[] = [], trunks: StaticPart[] = [], crowns: StaticPart[] = [];
    const done = new Set<number>(); let seq = 0;
    for (const e of sw.edges) {
      const key = e.from < e.to ? e.from * 1_000_000 + e.to : e.to * 1_000_000 + e.from; if (done.has(key)) continue; done.add(key);
      if (e.crossing || e.length < 8) continue; const a = sw.nodes[e.from], b = sw.nodes[e.to];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      const px = -dz / L, pz = dx / L, side = (key & 1) ? 1 : -1;
      if (seq % 5 === 0 && poles.length < 1800) {
        const x = mx + px * 1.1 * side, z = mz + pz * 1.1 * side;
        poles.push({ matrix: this.matrix(x, 2.4, z, 0.13, 4.8, 0.13) });
        lamps.push({ matrix: this.matrix(x, 4.82, z, 0.65, 0.18, 0.32) });
      }
      if (seq % 11 === 3 && trunks.length < 900) {
        const x = mx - px * 1.0 * side, z = mz - pz * 1.0 * side;
        trunks.push({ matrix: this.matrix(x, 1.05, z, 0.28, 2.1, 0.28) });
        crowns.push({ matrix: this.matrix(x, 2.75, z, 1.35, 1.55, 1.35) });
      }
      seq++;
    }
    this.addStatic(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0x4f555c, roughness: 0.7, metalness: 0.35 }), poles);
    this.addStatic(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffe4a3, emissive: 0xffc760, emissiveIntensity: 0.7 }), lamps);
    this.addStatic(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0x66503a, roughness: 1 }), trunks);
    this.addStatic(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x416d46, roughness: 1 }), crowns);
  }

  private baseFloors(b: Building): number {
    switch (b.archetype) {
      case BuildingArchetype.OfficeTower: return Math.min(b.floors, 4);
      case BuildingArchetype.ResidentialTower: return Math.min(b.floors, 3);
      case BuildingArchetype.MixedUse: return Math.min(b.floors, 3);
      case BuildingArchetype.MidRiseApartment: return b.floors > 6 && (b.styleSeed & 1) !== 0 ? Math.max(4, Math.ceil(b.floors * 0.58)) : b.floors;
      case BuildingArchetype.OfficeSlab: return b.floors > 7 && (b.styleSeed & 2) !== 0 ? Math.max(4, Math.ceil(b.floors * 0.65)) : b.floors;
      case BuildingArchetype.CommercialBlock: return b.floors > 5 && (b.styleSeed & 4) !== 0 ? Math.max(3, Math.ceil(b.floors * 0.6)) : b.floors;
      default: return b.floors;
    }
  }

  private dims(b: Building): [number, number] { return Math.abs(b.rotation) > 0.1 ? [b.depth, b.width] : [b.width, b.depth]; }

  private buildingColor(b: Building): THREE.Color {
    let p = this.retailPalettes;
    if (b.category === POICategory.Home) p = this.residentialPalettes;
    else if (b.category === POICategory.Work) p = this.officePalettes;
    else if (b.category === POICategory.Leisure) p = this.leisurePalettes;
    return new THREE.Color(p[b.palette % p.length]);
  }

  private addStatic(geometry: THREE.BufferGeometry, material: THREE.Material, parts: StaticPart[], colors = false): THREE.InstancedMesh | null {
    if (parts.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, parts.length);
    if (colors) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(parts.length * 3), 3);
    parts.forEach((p, i) => { mesh.setMatrixAt(i, p.matrix); if (colors && p.color) mesh.setColorAt(i, p.color); });
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true; this.sceneRef.add(mesh); return mesh;
  }

  private matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0): THREE.Matrix4 {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)), new THREE.Vector3(sx, sy, sz));
  }

  private pose(mesh: THREE.InstancedMesh, index: number, x: number, z: number, heading: number, localX: number, y: number, localZ: number, sx: number, sy: number, sz: number, roll: number): void {
    const ry = -heading, c = Math.cos(ry), s = Math.sin(ry);
    this.d.position.set(x + localX * c + localZ * s, y, z - localX * s + localZ * c);
    this.d.rotation.set(0, ry, roll); this.d.scale.set(sx, sy, sz); this.d.updateMatrix(); mesh.setMatrixAt(index, this.d.matrix);
  }
}
