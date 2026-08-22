import * as THREE from 'three';
import { InstancedRenderer } from './InstancedRenderer';
import { Building, BuildingArchetype, ParkingLot, RoofType } from '../generation/CityGenerator';
import { RoadClass, RoadNetwork, roadWidth } from '../traffic/RoadNetwork';
import { SidewalkNetwork } from '../traffic/SidewalkNetwork';
import { AgentState, AgentStore } from '../agents/AgentStore';
import { VehicleState, VehicleStore } from '../traffic/VehicleStore';
import { POICategory } from '../world/POI';

interface StaticPart { matrix: THREE.Matrix4; color?: THREE.Color; x?: number; z?: number; }
interface HeadlightRuntime { light: THREE.SpotLight; target: THREE.Object3D; }
interface BuildingChunk { cx: number; cz: number; ids: number[]; lod: 0 | 1 | 2 | 3; }

export interface RenderingLodStats {
  buildings: [number, number, number, number];
  agents: [number, number];
  vehicles: [number, number];
}

/**
 * 100km²級の都市向け描画。
 * 建物は500mチャンク単位で4段階LOD、Agent/Vehicleは距離カリングと2段階形状を使う。
 * LOD0: ～1km / LOD1: 1～3km / LOD2: 3～10km / LOD3: 10km～
 */
export class EnhancedRenderer extends InstancedRenderer {
  static readonly CHUNK_SIZE = 500;
  static readonly LOD0_DISTANCE = 1_000;
  static readonly LOD1_DISTANCE = 3_000;
  static readonly LOD2_DISTANCE = 10_000;
  static readonly LOD_HYSTERESIS = 150;

  private readonly sceneRef: THREE.Scene;
  private readonly d = new THREE.Object3D();
  private readonly lodCamera = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY);
  private readonly buildingChunks: BuildingChunk[] = [];
  private buildingData: Building[] = [];

  private agentTorso!: THREE.InstancedMesh;
  private agentHead!: THREE.InstancedMesh;
  private agentLegs!: THREE.InstancedMesh;
  private agentSimple!: THREE.InstancedMesh;
  private agentHitMap = new Int32Array(0);

  private vehicleCabin!: THREE.InstancedMesh;
  private vehicleWheels!: THREE.InstancedMesh;
  private vehicleFrontLamp!: THREE.InstancedMesh;
  private vehicleRearLamp!: THREE.InstancedMesh;
  private vehicleIndicator!: THREE.InstancedMesh;
  private vehicleHitMap = new Int32Array(0);

  private building0Base!: THREE.InstancedMesh;
  private building0Upper!: THREE.InstancedMesh;
  private building0WindowEarly!: THREE.InstancedMesh;
  private building0WindowLate!: THREE.InstancedMesh;
  private building0Roof!: THREE.InstancedMesh;
  private building0RoofEquipment!: THREE.InstancedMesh;
  private building0Awning!: THREE.InstancedMesh;
  private building1Base!: THREE.InstancedMesh;
  private building1Upper!: THREE.InstancedMesh;
  private building1WindowEarly!: THREE.InstancedMesh;
  private building1WindowLate!: THREE.InstancedMesh;
  private building2!: THREE.InstancedMesh;
  private building3!: THREE.InstancedMesh;

  private parkingMarkRecords: StaticPart[] = [];
  private parkingMarkMesh: THREE.InstancedMesh | null = null;
  private streetPoleRecords: StaticPart[] = [];
  private streetLampRecords: StaticPart[] = [];
  private treeTrunkRecords: StaticPart[] = [];
  private treeCrownRecords: StaticPart[] = [];
  private streetPoleMesh: THREE.InstancedMesh | null = null;
  private streetLampMesh: THREE.InstancedMesh | null = null;
  private treeTrunkMesh: THREE.InstancedMesh | null = null;
  private treeCrownMesh: THREE.InstancedMesh | null = null;

  private readonly headLampMat = new THREE.MeshStandardMaterial({ color: 0xd8d1ae, emissive: 0xffe6a3, emissiveIntensity: 0, roughness: 0.28 });
  private readonly rearLampMat = new THREE.MeshStandardMaterial({ color: 0x9d2525, emissive: 0xb50d0d, emissiveIntensity: 0.55, roughness: 0.35 });
  private readonly indicatorMat = new THREE.MeshStandardMaterial({ color: 0xff9f28, emissive: 0xff7400, emissiveIntensity: 4.5, roughness: 0.3 });
  private readonly streetLampMat = new THREE.MeshStandardMaterial({ color: 0x8d856b, emissive: 0xffcf78, emissiveIntensity: 0, roughness: 0.35 });
  private readonly windowEarlyMat = new THREE.MeshStandardMaterial({ color: 0x38444d, emissive: 0xffd27a, emissiveIntensity: 0, roughness: 0.28, metalness: 0.08 });
  private readonly windowLateMat = new THREE.MeshStandardMaterial({ color: 0x35434b, emissive: 0xffe0a0, emissiveIntensity: 0, roughness: 0.28, metalness: 0.08 });

  private readonly streetLampPositions: THREE.Vector3[] = [];
  private readonly streetLightPool: THREE.PointLight[] = [];
  private readonly headlightPool: HeadlightRuntime[] = [];
  private roadNet: RoadNetwork | null = null;

  private readonly residentialPalettes = [0xd8d0c2, 0xc7ced6, 0xe2ddd2, 0xb9b0a4];
  private readonly officePalettes = [0x8795a5, 0x6f7e91, 0xa4abb3, 0x737b82];
  private readonly retailPalettes = [0xc3a77d, 0xb7a58a, 0xd0b58b, 0xa99b87];
  private readonly leisurePalettes = [0x88aa93, 0x8499a9, 0x9b8fa7, 0x9ca77d];
  private readonly clothes = [0x315d89, 0x8a3f4c, 0x476f51, 0x7b5b91, 0xb07b3f, 0x52606e, 0x8a795a, 0x5d7b83].map((c) => new THREE.Color(c));
  private readonly vehicleColors = [0xd94f4f, 0x4f7fd9, 0xe0e0e0, 0x2b2b2b, 0xd9b64f, 0x54b07a, 0x8a6fd9].map((c) => new THREE.Color(c));
  private readonly busColor = new THREE.Color(0x2f9e44);
  private readonly truckColor = new THREE.Color(0xc26b2a);

  private lodStatsValue: RenderingLodStats = { buildings: [0, 0, 0, 0], agents: [0, 0], vehicles: [0, 0] };

  constructor(scene: THREE.Scene) {
    super(scene); this.sceneRef = scene;
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xffd58a, 0, 28, 2); l.visible = false; scene.add(l); this.streetLightPool.push(l);
    }
    for (let i = 0; i < 8; i++) {
      const target = new THREE.Object3D(); scene.add(target);
      const light = new THREE.SpotLight(0xffefc7, 0, 62, Math.PI / 9, 0.55, 2); light.visible = false; light.target = target; scene.add(light);
      this.headlightPool.push({ light, target });
    }
  }

  override agentIndexOf(instanceId: number): number {
    return instanceId >= 0 && instanceId < this.agents.count ? this.agentHitMap[instanceId] : -1;
  }

  override vehicleIndexOf(instanceId: number): number {
    return instanceId >= 0 && instanceId < this.vehicles.count ? this.vehicleHitMap[instanceId] : -1;
  }

  getLodStats(): RenderingLodStats {
    return {
      buildings: [...this.lodStatsValue.buildings] as [number, number, number, number],
      agents: [...this.lodStatsValue.agents] as [number, number],
      vehicles: [...this.lodStatsValue.vehicles] as [number, number],
    };
  }

  override buildStatic(buildings: Building[], net: RoadNetwork, sidewalk: SidewalkNetwork, lots: ParkingLot[]): void {
    this.roadNet = net;
    super.buildStatic(buildings, net, sidewalk, lots);
    // Inspector互換のRaycast proxyだけを残す。
    this.buildings.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    this.buildings.castShadow = false; this.buildings.receiveShadow = false;
    this.buildBuildingLod(buildings);
    this.buildRoadDetails(net);
    this.prepareParkingMarkings(lots);
    this.prepareStreetFurniture(net);
  }

  override buildAgents(capacity: number): void {
    super.buildAgents(capacity);
    this.agents.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    this.agents.castShadow = false;
    this.agentHitMap = new Int32Array(capacity);

    const torsoMat = new THREE.MeshStandardMaterial({ roughness: 0.82 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xd9b08c, roughness: 0.9 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.9 });
    this.agentTorso = this.dynamicMesh(new THREE.BoxGeometry(0.48, 0.76, 0.30), torsoMat, capacity, true);
    this.agentTorso.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.agentHead = this.dynamicMesh(new THREE.SphereGeometry(0.23, 7, 5), headMat, capacity);
    this.agentLegs = this.dynamicMesh(new THREE.BoxGeometry(0.17, 0.72, 0.18), legMat, capacity * 2);
    this.agentSimple = this.dynamicMesh(new THREE.BoxGeometry(0.42, 1.45, 0.28), new THREE.MeshStandardMaterial({ color: 0x7f8790, roughness: 0.9 }), capacity, false);
  }

  override syncAgents(store: AgentStore, simTime = 0, cameraPos?: THREE.Vector3): void {
    const camX = cameraPos?.x ?? 0, camZ = cameraPos?.z ?? 0, useDistance = !!cameraPos;
    let full = 0, simple = 0, legs = 0, proxy = 0;
    const proxyMesh = this.agents;
    for (let i = 0; i < store.count; i++) {
      const st = store.state[i];
      if (st === AgentState.Driving || st === AgentState.Engaged || st === AgentState.OnBus) continue;
      const x = store.posX[i], z = store.posZ[i];
      const dx = x - camX, dz = z - camZ, d2 = useDistance ? dx * dx + dz * dz : 0;
      if (useDistance && d2 > EnhancedRenderer.LOD1_DISTANCE ** 2) continue;
      const h = store.heading[i];

      // Inspector hit proxyも3km以内だけ更新する。
      this.pose(proxyMesh, proxy++, x, z, h, 0, 0, 0, 1, 1, 1, 0);
      this.agentHitMap[proxy - 1] = i;

      if (!useDistance || d2 <= EnhancedRenderer.LOD0_DISTANCE ** 2) {
        this.pose(this.agentTorso, full, x, z, h, 0, 1.14, 0, 1, 1, 1, 0);
        this.agentTorso.setColorAt(full, this.clothes[(i * 7 + store.occupation[i]) % this.clothes.length]);
        this.pose(this.agentHead, full, x, z, h, 0, 1.72, 0, 1, 1, 1, 0);
        const moving = Math.hypot(store.velX[i], store.velZ[i]);
        const swing = moving > 0.05 ? Math.sin(simTime * (5.0 + store.maxSpeed[i]) + i * 0.73) * 0.48 : 0;
        this.pose(this.agentLegs, legs++, x, z, h, 0, 0.52, -0.11, 1, 1, 1, swing);
        this.pose(this.agentLegs, legs++, x, z, h, 0, 0.52, 0.11, 1, 1, 1, -swing);
        full++;
      } else {
        this.pose(this.agentSimple, simple++, x, z, h, 0, 0.74, 0, 1, 1, 1, 0);
      }
    }
    proxyMesh.count = proxy; this.agentTorso.count = full; this.agentHead.count = full; this.agentLegs.count = legs; this.agentSimple.count = simple;
    for (const m of [proxyMesh, this.agentTorso, this.agentHead, this.agentLegs, this.agentSimple]) m.instanceMatrix.needsUpdate = true;
    if (this.agentTorso.instanceColor) this.agentTorso.instanceColor.needsUpdate = true;
    this.lodStatsValue.agents = [full, simple];
  }

  override buildVehicles(capacity: number): void {
    super.buildVehicles(capacity);
    this.vehicleHitMap = new Int32Array(capacity);
    this.vehicleCabin = this.dynamicMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x26313c, roughness: 0.3, metalness: 0.15 }), capacity);
    this.vehicleWheels = this.dynamicMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.95 }), capacity * 2);
    this.vehicleFrontLamp = this.dynamicMesh(new THREE.BoxGeometry(1, 1, 1), this.headLampMat, capacity * 2);
    this.vehicleRearLamp = this.dynamicMesh(new THREE.BoxGeometry(1, 1, 1), this.rearLampMat, capacity * 2);
    this.vehicleIndicator = this.dynamicMesh(new THREE.BoxGeometry(1, 1, 1), this.indicatorMat, capacity * 2);
  }

  override syncVehicles(vs: VehicleStore, _hourF = 12, blinkTime = 0, cameraPos?: THREE.Vector3): void {
    const camX = cameraPos?.x ?? 0, camZ = cameraPos?.z ?? 0, useDistance = !!cameraPos;
    const body = this.vehicles;
    let bodies = 0, full = 0, wheels = 0, front = 0, rear = 0, indicators = 0, simple = 0;
    const blinkOn = (Math.floor(blinkTime * 2.2) & 1) === 0;

    for (let v = 0; v < vs.count; v++) {
      const st = vs.state[v];
      const show = st === VehicleState.Driving || st === VehicleState.Parked || ((vs.isBus[v] || vs.isTruck[v]) && st === VehicleState.Arrived);
      if (!show) continue;
      const x = vs.posX[v], z = vs.posZ[v], dx = x - camX, dz = z - camZ, d2 = useDistance ? dx * dx + dz * dz : 0;
      if (useDistance && d2 > EnhancedRenderer.LOD1_DISTANCE ** 2) continue;

      let len = vs.length[v] || 4.5, width = 1.9, bodyScaleX = len / 4.4, bodyScaleY = 1, bodyScaleZ = width / 2.0;
      if (vs.isBus[v]) { len = 11; width = 2.45; bodyScaleX = 2.5; bodyScaleY = 1.65; bodyScaleZ = 1.23; }
      else if (vs.isTruck[v]) { len = 9; width = 2.4; bodyScaleX = 2.05; bodyScaleY = 1.85; bodyScaleZ = 1.2; }
      const h = vs.heading[v];
      this.pose(body, bodies, x, z, h, 0, 0, 0, bodyScaleX, bodyScaleY, bodyScaleZ, 0);
      body.setColorAt(bodies, vs.isBus[v] ? this.busColor : vs.isTruck[v] ? this.truckColor : this.vehicleColors[vs.colorIdx[v] % this.vehicleColors.length]);
      this.vehicleHitMap[bodies] = v; bodies++;

      if (useDistance && d2 > EnhancedRenderer.LOD0_DISTANCE ** 2) { simple++; continue; }

      let cabinLen = 2.2, cabinY = 1.35, cabinH = 0.72, cabinX = 0;
      if (vs.isBus[v]) { cabinLen = 9.4; cabinY = 1.85; cabinH = 1.05; }
      else if (vs.isTruck[v]) { cabinLen = 2.4; cabinY = 1.55; cabinH = 1.25; cabinX = len * 0.28; }
      else {
        const type = (v * 13 + vs.colorIdx[v]) & 3;
        if (type === 1) { cabinLen = 2.45; cabinH = 0.82; cabinY = 1.42; }
        else if (type === 2) { cabinLen = 2.25; cabinH = 0.98; cabinY = 1.55; width = 1.98; }
        else if (type === 3) { cabinLen = 2.75; cabinH = 1.0; cabinY = 1.56; width = 2.02; }
      }
      this.pose(this.vehicleCabin, full, x, z, h, cabinX, cabinY, 0, cabinLen, cabinH, width * 0.82, 0);
      const axle = Math.max(1.25, len * 0.29);
      this.pose(this.vehicleWheels, wheels++, x, z, h, -axle, 0.38, 0, 0.58, 0.55, width * 1.06, 0);
      this.pose(this.vehicleWheels, wheels++, x, z, h, axle, 0.38, 0, 0.58, 0.55, width * 1.06, 0);
      const headlightsOnVehicle = st === VehicleState.Driving || ((vs.isBus[v] || vs.isTruck[v]) && st === VehicleState.Arrived);
      for (const side of [-1, 1]) {
        if (headlightsOnVehicle) this.pose(this.vehicleFrontLamp, front++, x, z, h, len / 2 + 0.05, 0.72, side * width * 0.27, 0.10, 0.19, width * 0.16, 0);
        this.pose(this.vehicleRearLamp, rear++, x, z, h, -len / 2 - 0.05, 0.72, side * width * 0.29, 0.10, 0.19, width * 0.15, 0);
      }
      const turn = this.turnDirection(vs, v);
      if (turn !== 0 && blinkOn) {
        const sideZ = turn * width * 0.43;
        this.pose(this.vehicleIndicator, indicators++, x, z, h, len / 2 + 0.07, 0.78, sideZ, 0.11, 0.16, 0.15, 0);
        this.pose(this.vehicleIndicator, indicators++, x, z, h, -len / 2 - 0.07, 0.78, sideZ, 0.11, 0.16, 0.15, 0);
      }
      full++;
    }

    body.count = bodies; this.vehicleCabin.count = full; this.vehicleWheels.count = wheels;
    this.vehicleFrontLamp.count = front; this.vehicleRearLamp.count = rear; this.vehicleIndicator.count = indicators;
    for (const m of [body, this.vehicleCabin, this.vehicleWheels, this.vehicleFrontLamp, this.vehicleRearLamp, this.vehicleIndicator]) m.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    this.lodStatsValue.vehicles = [full, simple];
  }

  /** カメラ移動100mごとに静的LODを再分類する。 */
  updateLod(cameraPos: THREE.Vector3, force = false): void {
    const dx = cameraPos.x - this.lodCamera.x, dz = cameraPos.z - this.lodCamera.z;
    if (!force && Number.isFinite(this.lodCamera.x) && dx * dx + dz * dz < 100 * 100) return;
    this.lodCamera.copy(cameraPos);
    this.rebuildBuildingLod(cameraPos);
    this.rebuildNearStatic(cameraPos);
  }

  /** 夜間の発光材質と、カメラ近傍だけに割り当てる実Point/SpotLightを更新する。 */
  updateNightLighting(hourF: number, cameraPos: THREE.Vector3, vs: VehicleStore): void {
    const night = this.nightFactor(hourF);
    this.headLampMat.emissiveIntensity = night * 5.5;
    this.rearLampMat.emissiveIntensity = 0.5 + night * 1.5;
    this.streetLampMat.emissiveIntensity = night * 4.2;
    this.windowEarlyMat.emissiveIntensity = this.earlyWindowLevel(hourF) * night * 3.2;
    this.windowLateMat.emissiveIntensity = this.lateWindowLevel(hourF) * night * 3.6;
    this.updateStreetLightPool(cameraPos, night);
    this.updateHeadlightPool(cameraPos, night, vs);
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

  private buildBuildingLod(buildings: Building[]): void {
    this.buildingData = buildings;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const base0 = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.04 });
    const upper0 = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.06 });
    const base1 = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.03 });
    const simple2 = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 });
    const simple3 = new THREE.MeshLambertMaterial();
    const cap = Math.max(1, buildings.length), windows = Math.max(1, buildings.length * 4);

    this.building0Base = this.dynamicMesh(box, base0, cap, true, true);
    this.building0Upper = this.dynamicMesh(box, upper0, cap, true, true);
    this.building0WindowEarly = this.dynamicMesh(box, this.windowEarlyMat, windows, false);
    this.building0WindowLate = this.dynamicMesh(box, this.windowLateMat, windows, false);
    this.building0Roof = this.dynamicMesh(new THREE.ConeGeometry(1, 1, 4), new THREE.MeshStandardMaterial({ roughness: 0.9 }), cap, true, true);
    this.building0RoofEquipment = this.dynamicMesh(box, new THREE.MeshStandardMaterial({ color: 0x62686d, roughness: 0.8, metalness: 0.25 }), cap, false);
    this.building0Awning = this.dynamicMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.75 }), cap, true);
    this.building1Base = this.dynamicMesh(box, base1, cap, true, true);
    this.building1Upper = this.dynamicMesh(box, base1.clone(), cap, true, true);
    this.building1WindowEarly = this.dynamicMesh(box, this.windowEarlyMat, Math.max(1, buildings.length * 2), false);
    this.building1WindowLate = this.dynamicMesh(box, this.windowLateMat, Math.max(1, buildings.length * 2), false);
    this.building2 = this.dynamicMesh(box, simple2, cap, true, false);
    this.building3 = this.dynamicMesh(box, simple3, cap, true, false);
    this.building3.castShadow = false; this.building3.receiveShadow = false;

    const map = new Map<string, BuildingChunk>();
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i], cx = Math.floor(b.x / EnhancedRenderer.CHUNK_SIZE), cz = Math.floor(b.z / EnhancedRenderer.CHUNK_SIZE), key = `${cx}:${cz}`;
      let chunk = map.get(key);
      if (!chunk) {
        chunk = { cx: (cx + 0.5) * EnhancedRenderer.CHUNK_SIZE, cz: (cz + 0.5) * EnhancedRenderer.CHUNK_SIZE, ids: [], lod: 3 };
        map.set(key, chunk);
      }
      chunk.ids.push(i);
    }
    this.buildingChunks.length = 0; this.buildingChunks.push(...map.values());
  }

  private rebuildBuildingLod(camera: THREE.Vector3): void {
    const c0 = { base: 0, upper: 0, early: 0, late: 0, roof: 0, eq: 0, awning: 0 };
    const c1 = { base: 0, upper: 0, early: 0, late: 0 };
    let c2 = 0, c3 = 0;
    const stats: [number, number, number, number] = [0, 0, 0, 0];

    for (const chunk of this.buildingChunks) {
      const d = Math.hypot(chunk.cx - camera.x, chunk.cz - camera.z);
      chunk.lod = this.lodForDistance(d, chunk.lod);
      stats[chunk.lod] += chunk.ids.length;
      for (const id of chunk.ids) {
        const b = this.buildingData[id];
        if (chunk.lod === 0) this.writeBuilding0(b, c0);
        else if (chunk.lod === 1) this.writeBuilding1(b, c1);
        else if (chunk.lod === 2) this.writeSimpleBuilding(this.building2, c2++, b, true);
        else this.writeSimpleBuilding(this.building3, c3++, b, false);
      }
    }

    this.building0Base.count = c0.base; this.building0Upper.count = c0.upper;
    this.building0WindowEarly.count = c0.early; this.building0WindowLate.count = c0.late;
    this.building0Roof.count = c0.roof; this.building0RoofEquipment.count = c0.eq; this.building0Awning.count = c0.awning;
    this.building1Base.count = c1.base; this.building1Upper.count = c1.upper;
    this.building1WindowEarly.count = c1.early; this.building1WindowLate.count = c1.late;
    this.building2.count = c2; this.building3.count = c3;
    const all = [this.building0Base, this.building0Upper, this.building0WindowEarly, this.building0WindowLate, this.building0Roof, this.building0RoofEquipment, this.building0Awning,
      this.building1Base, this.building1Upper, this.building1WindowEarly, this.building1WindowLate, this.building2, this.building3];
    for (const mesh of all) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    this.lodStatsValue.buildings = stats;
  }

  private writeBuilding0(b: Building, c: { base: number; upper: number; early: number; late: number; roof: number; eq: number; awning: number }): void {
    const FH = 3.2, [w, dep] = this.dims(b), baseF = this.baseFloors(b), baseH = baseF * FH, totalH = b.floors * FH;
    const main = this.buildingColor(b), accent = main.clone().offsetHSL(0, -0.05, -0.12);
    this.setPart(this.building0Base, c.base++, this.matrix(b.x, baseH / 2 + 0.02, b.z, w + 0.08, baseH + 0.04, dep + 0.08), main);
    const tower = b.archetype === BuildingArchetype.ResidentialTower || b.archetype === BuildingArchetype.OfficeTower || b.archetype === BuildingArchetype.MixedUse;
    const stepped = b.floors > baseF;
    let fw = w, fd = dep, visibleBase = 0, visibleHeight = baseH;
    if (stepped) {
      const shrink = tower ? (b.archetype === BuildingArchetype.MixedUse ? 0.74 : 0.7 + ((b.styleSeed >>> 3) & 7) * 0.015) : 0.82 + ((b.styleSeed >>> 5) & 3) * 0.025;
      fw = w * shrink; fd = dep * shrink; const upperH = totalH - baseH;
      this.setPart(this.building0Upper, c.upper++, this.matrix(b.x, baseH + upperH / 2, b.z, fw, upperH, fd), main.clone().offsetHSL(0, 0, 0.035));
      visibleBase = baseH; visibleHeight = upperH;
    }
    const bands = Math.min(2, Math.max(1, Math.floor((stepped ? Math.max(1, b.floors - baseF) : b.floors) / 3)));
    for (let q = 0; q < bands; q++) {
      const y = visibleBase + visibleHeight * ((q + 1) / (bands + 1));
      const late = ((b.styleSeed >>> (q % 12)) & 3) === 0;
      const mesh = late ? this.building0WindowLate : this.building0WindowEarly;
      const idx = late ? c.late++ : c.early++;
      this.setPart(mesh, idx, this.matrix(b.x, y, b.z + fd / 2 + 0.115, fw * 0.62, 0.34, 0.055));
      if (fd > 7) {
        const idx2 = late ? c.late++ : c.early++;
        this.setPart(mesh, idx2, this.matrix(b.x + fw / 2 + 0.115, y, b.z, 0.055, 0.34, fd * 0.60));
      }
    }
    if (b.roofType === RoofType.Gable || b.roofType === RoofType.Hip) {
      this.setPart(this.building0Roof, c.roof++, this.matrix(b.x, totalH + 0.85, b.z, fw * 0.55, 1.7, fd * 0.55, Math.PI / 4), accent);
    } else if (b.roofType === RoofType.Mechanical || (b.styleSeed & 3) === 0) {
      this.setPart(this.building0RoofEquipment, c.eq++, this.matrix(b.x + fw * 0.12, totalH + 0.4, b.z - fd * 0.1, fw * 0.28, 0.8, fd * 0.24));
    }
    if (b.archetype === BuildingArchetype.SmallShop || b.archetype === BuildingArchetype.RetailBox || b.archetype === BuildingArchetype.CommercialBlock || b.archetype === BuildingArchetype.MixedUse) {
      this.setPart(this.building0Awning, c.awning++, this.matrix(b.x, Math.min(baseH - 0.5, 2.7), b.z + dep / 2 + 0.6, w * 0.58, 0.18, 1.1), accent);
    }
  }

  private writeBuilding1(b: Building, c: { base: number; upper: number; early: number; late: number }): void {
    const FH = 3.2, [w, dep] = this.dims(b), baseF = this.baseFloors(b), baseH = baseF * FH, totalH = b.floors * FH, main = this.buildingColor(b);
    this.setPart(this.building1Base, c.base++, this.matrix(b.x, baseH / 2, b.z, w, baseH, dep), main);
    const stepped = b.floors > baseF;
    let fw = w, fd = dep, y = totalH * 0.55;
    if (stepped) {
      fw = w * 0.76; fd = dep * 0.76; const upperH = totalH - baseH;
      this.setPart(this.building1Upper, c.upper++, this.matrix(b.x, baseH + upperH / 2, b.z, fw, upperH, fd), main.clone().offsetHSL(0, 0, 0.025));
      y = baseH + upperH * 0.55;
    }
    const late = (b.styleSeed & 3) === 0, mesh = late ? this.building1WindowLate : this.building1WindowEarly;
    const idx = late ? c.late++ : c.early++;
    this.setPart(mesh, idx, this.matrix(b.x, y, b.z + fd / 2 + 0.08, fw * 0.55, 0.28, 0.04));
  }

  private writeSimpleBuilding(mesh: THREE.InstancedMesh, index: number, b: Building, shadow: boolean): void {
    const [w, d] = this.dims(b), h = Math.max(3.2, b.floors * 3.2);
    this.setPart(mesh, index, this.matrix(b.x, h / 2, b.z, w, h, d), this.buildingColor(b));
    mesh.castShadow = shadow;
  }

  private lodForDistance(distance: number, current: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 {
    const h = EnhancedRenderer.LOD_HYSTERESIS;
    if (current === 0 && distance <= EnhancedRenderer.LOD0_DISTANCE + h) return 0;
    if (current === 1 && distance >= EnhancedRenderer.LOD0_DISTANCE - h && distance <= EnhancedRenderer.LOD1_DISTANCE + h) return 1;
    if (current === 2 && distance >= EnhancedRenderer.LOD1_DISTANCE - h && distance <= EnhancedRenderer.LOD2_DISTANCE + h) return 2;
    if (current === 3 && distance >= EnhancedRenderer.LOD2_DISTANCE - h) return 3;
    if (distance <= EnhancedRenderer.LOD0_DISTANCE) return 0;
    if (distance <= EnhancedRenderer.LOD1_DISTANCE) return 1;
    if (distance <= EnhancedRenderer.LOD2_DISTANCE) return 2;
    return 3;
  }

  private buildRoadDetails(net: RoadNetwork): void {
    const curbs: StaticPart[] = [], medians: StaticPart[] = [], rails: StaticPart[] = []; const done = new Set<string>();
    for (const e of net.edges) {
      const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`; if (done.has(key)) continue; done.add(key);
      if (e.roadClass === RoadClass.Path) continue;
      const a = net.nodes[e.from], b = net.nodes[e.to], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      const px = -dz / L, pz = dx / L, angle = -Math.atan2(dz, dx), rw = roadWidth(e.lanes), mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if (e.roadClass !== RoadClass.Highway) for (const side of [-1, 1]) curbs.push({ matrix: this.matrix(mx + px * (rw / 2 + 0.18) * side, 0.19, mz + pz * (rw / 2 + 0.18) * side, e.length, 0.22, 0.26, angle) });
      if (e.roadClass === RoadClass.Arterial && e.lanes >= 2) medians.push({ matrix: this.matrix(mx, 0.18, mz, e.length * 0.9, 0.28, 0.65, angle) });
      if (e.roadClass === RoadClass.Highway) for (const side of [-1, 1]) rails.push({ matrix: this.matrix(mx + px * (rw / 2 + 0.55) * side, 0.68, mz + pz * (rw / 2 + 0.55) * side, e.length, 0.16, 0.14, angle) });
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x9a958d, roughness: 0.95 }), curbs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777a72, roughness: 0.95 }), medians);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.65, metalness: 0.45 }), rails);
  }

  private prepareParkingMarkings(lots: ParkingLot[]): void {
    const records: StaticPart[] = [], MAX = 30_000;
    for (const lot of lots) {
      for (let i = 0; i < lot.capacity && records.length + 2 <= MAX; i++) {
        records.push({ x: lot.slotX[i] - 1.25, z: lot.slotZ[i], matrix: this.matrix(lot.slotX[i] - 1.25, 0.135, lot.slotZ[i], 0.07, 0.035, 2.45) });
        records.push({ x: lot.slotX[i] + 1.25, z: lot.slotZ[i], matrix: this.matrix(lot.slotX[i] + 1.25, 0.135, lot.slotZ[i], 0.07, 0.035, 2.45) });
      }
      if (records.length >= MAX) break;
    }
    this.parkingMarkRecords = records;
    if (records.length) this.parkingMarkMesh = this.dynamicMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xd7d7d2 }), records.length, false);
  }

  /** 街路設備は道路中心線・道路幅から道路外側へ配置し、LOD更新時に近傍のみInstanceへ載せる。 */
  private prepareStreetFurniture(net: RoadNetwork): void {
    const poles: StaticPart[] = [], lamps: StaticPart[] = [], trunks: StaticPart[] = [], crowns: StaticPart[] = [];
    const done = new Set<string>(); this.streetLampPositions.length = 0; let seq = 0;
    for (const e of net.edges) {
      const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`; if (done.has(key)) continue; done.add(key);
      if (e.roadClass === RoadClass.Highway || e.roadClass === RoadClass.Path || e.length < 28) continue;
      const a = net.nodes[e.from], b = net.nodes[e.to], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      const ux = dx / L, uz = dz / L, px = -uz, pz = ux, rw = roadWidth(e.lanes), inset = Math.min(14, L * 0.22), usable = L - inset * 2;
      if (usable <= 4) continue;
      const lampSpacing = e.roadClass === RoadClass.Arterial ? 44 : 58, lampCount = Math.max(1, Math.floor(usable / lampSpacing));
      for (let j = 0; j < lampCount && poles.length < 4_000; j++) {
        const along = inset + usable * ((j + 1) / (lampCount + 1));
        for (const side of [-1, 1]) {
          if (poles.length >= 4_000) break;
          const off = rw / 2 + 2.35, x = a.x + ux * along + px * off * side, z = a.z + uz * along + pz * off * side;
          poles.push({ x, z, matrix: this.matrix(x, 2.4, z, 0.13, 4.8, 0.13) });
          lamps.push({ x, z, matrix: this.matrix(x, 4.82, z, 0.65, 0.18, 0.32) });
          this.streetLampPositions.push(new THREE.Vector3(x, 4.65, z));
        }
      }
      if (e.roadClass === RoadClass.Local && seq % 2 === 0 && trunks.length < 2_000) {
        const treeCount = Math.max(1, Math.floor(usable / 80));
        for (let j = 0; j < treeCount && trunks.length < 2_000; j++) {
          const along = inset + usable * ((j + 1) / (treeCount + 1)), side = ((seq + j) & 1) === 0 ? 1 : -1, off = rw / 2 + 2.55;
          const x = a.x + ux * along + px * off * side, z = a.z + uz * along + pz * off * side;
          trunks.push({ x, z, matrix: this.matrix(x, 1.05, z, 0.28, 2.1, 0.28) });
          crowns.push({ x, z, matrix: this.matrix(x, 2.75, z, 1.35, 1.55, 1.35) });
        }
      }
      seq++;
    }
    this.streetPoleRecords = poles; this.streetLampRecords = lamps; this.treeTrunkRecords = trunks; this.treeCrownRecords = crowns;
    if (poles.length) this.streetPoleMesh = this.dynamicMesh(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0x4f555c, roughness: 0.7, metalness: 0.35 }), poles.length);
    if (lamps.length) this.streetLampMesh = this.dynamicMesh(new THREE.BoxGeometry(1, 1, 1), this.streetLampMat, lamps.length);
    if (trunks.length) this.treeTrunkMesh = this.dynamicMesh(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0x66503a, roughness: 1 }), trunks.length);
    if (crowns.length) this.treeCrownMesh = this.dynamicMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x416d46, roughness: 1 }), crowns.length);
  }

  private rebuildNearStatic(camera: THREE.Vector3): void {
    // 駐車区画はLOD0のみ、街灯と樹冠はLOD1まで、木の幹はLOD0のみ。
    if (this.parkingMarkMesh) this.fillStaticByDistance(this.parkingMarkMesh, this.parkingMarkRecords, camera, EnhancedRenderer.LOD0_DISTANCE);
    if (this.streetPoleMesh) this.fillStaticByDistance(this.streetPoleMesh, this.streetPoleRecords, camera, EnhancedRenderer.LOD1_DISTANCE);
    if (this.streetLampMesh) this.fillStaticByDistance(this.streetLampMesh, this.streetLampRecords, camera, EnhancedRenderer.LOD1_DISTANCE);
    if (this.treeTrunkMesh) this.fillStaticByDistance(this.treeTrunkMesh, this.treeTrunkRecords, camera, EnhancedRenderer.LOD0_DISTANCE);
    if (this.treeCrownMesh) this.fillStaticByDistance(this.treeCrownMesh, this.treeCrownRecords, camera, EnhancedRenderer.LOD1_DISTANCE);
  }

  private fillStaticByDistance(mesh: THREE.InstancedMesh, records: StaticPart[], camera: THREE.Vector3, maxDistance: number): void {
    const maxD2 = maxDistance * maxDistance; let n = 0;
    for (const r of records) {
      if (r.x === undefined || r.z === undefined) continue;
      const dx = r.x - camera.x, dz = r.z - camera.z;
      if (dx * dx + dz * dz > maxD2) continue;
      mesh.setMatrixAt(n++, r.matrix);
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
  }

  private turnDirection(vs: VehicleStore, v: number): -1 | 0 | 1 {
    if (vs.state[v] !== VehicleState.Driving) return 0;
    const path = vs.paths[v], c = vs.pathCursor[v]; if (c < 1 || c + 1 >= path.length || !this.roadNet) return 0;
    const remain = (1 - vs.segT[v]) * vs.segLen[v]; if (remain > 42) return 0;
    const a = this.roadNet.nodes[path[c - 1]], b = this.roadNet.nodes[path[c]], d = this.roadNet.nodes[path[c + 1]]; if (!a || !b || !d) return 0;
    const x1 = b.x - a.x, z1 = b.z - a.z, x2 = d.x - b.x, z2 = d.z - b.z;
    const l1 = Math.hypot(x1, z1), l2 = Math.hypot(x2, z2); if (l1 < 0.1 || l2 < 0.1) return 0;
    const cross = (x1 * z2 - z1 * x2) / (l1 * l2); if (Math.abs(cross) < 0.22) return 0;
    return cross > 0 ? 1 : -1;
  }

  private updateStreetLightPool(cameraPos: THREE.Vector3, night: number): void {
    const best = this.nearestStatic(this.streetLampPositions, cameraPos, this.streetLightPool.length, 170 * 170);
    for (let i = 0; i < this.streetLightPool.length; i++) {
      const l = this.streetLightPool[i], p = best[i];
      if (!p || night < 0.03) { l.visible = false; l.intensity = 0; continue; }
      l.visible = true; l.position.copy(p); l.intensity = 70 * night;
    }
  }

  private updateHeadlightPool(cameraPos: THREE.Vector3, night: number, vs: VehicleStore): void {
    const best: { v: number; d2: number }[] = [];
    if (night >= 0.03) for (let v = 0; v < vs.count; v++) {
      if (vs.state[v] !== VehicleState.Driving && !((vs.isBus[v] || vs.isTruck[v]) && vs.state[v] === VehicleState.Arrived)) continue;
      const dx = vs.posX[v] - cameraPos.x, dz = vs.posZ[v] - cameraPos.z, d2 = dx * dx + dz * dz; if (d2 > 180 * 180) continue;
      this.insertNearest(best, { v, d2 }, this.headlightPool.length);
    }
    for (let i = 0; i < this.headlightPool.length; i++) {
      const r = this.headlightPool[i], item = best[i];
      if (!item || night < 0.03) { r.light.visible = false; r.light.intensity = 0; continue; }
      const v = item.v, h = vs.heading[v], len = vs.length[v] || 4.5, fx = Math.cos(h), fz = Math.sin(h);
      const y = vs.isBus[v] || vs.isTruck[v] ? 1.05 : 0.72;
      r.light.visible = true; r.light.intensity = 95 * night;
      r.light.position.set(vs.posX[v] + fx * (len * 0.48), y, vs.posZ[v] + fz * (len * 0.48));
      r.target.position.set(vs.posX[v] + fx * 28, 0.25, vs.posZ[v] + fz * 28); r.target.updateMatrixWorld();
    }
  }

  private nearestStatic(points: THREE.Vector3[], camera: THREE.Vector3, limit: number, maxD2: number): THREE.Vector3[] {
    const best: { p: THREE.Vector3; d2: number }[] = [];
    for (const p of points) {
      const dx = p.x - camera.x, dz = p.z - camera.z, d2 = dx * dx + dz * dz; if (d2 > maxD2) continue;
      this.insertNearest(best, { p, d2 }, limit);
    }
    return best.map((x) => x.p);
  }

  private insertNearest<T extends { d2: number }>(arr: T[], item: T, limit: number): void {
    let i = 0; while (i < arr.length && arr[i].d2 <= item.d2) i++; arr.splice(i, 0, item); if (arr.length > limit) arr.pop();
  }

  private nightFactor(hourF: number): number {
    const phase = hourF / 24, solar = Math.sin((phase - 0.25) * Math.PI * 2);
    return THREE.MathUtils.clamp((-solar + 0.10) / 0.75, 0, 1);
  }

  private earlyWindowLevel(h: number): number {
    if (h >= 17.5 && h < 22.5) return 1;
    if (h >= 22.5) return THREE.MathUtils.clamp((24.5 - h) / 2.0, 0.08, 1);
    if (h < 0.5) return 0.08;
    return 0;
  }

  private lateWindowLevel(h: number): number {
    if (h >= 17.5) return 1;
    if (h < 1.5) return 0.9;
    if (h < 3.5) return 0.38;
    if (h < 5.2) return 0.12;
    return 0;
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

  private dynamicMesh(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, colors = false, shadow = true): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = 0; mesh.frustumCulled = false;
    if (colors) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3), 3);
    mesh.castShadow = shadow; mesh.receiveShadow = shadow; this.sceneRef.add(mesh); return mesh;
  }

  private addStatic(geometry: THREE.BufferGeometry, material: THREE.Material, parts: StaticPart[], colors = false): THREE.InstancedMesh | null {
    if (parts.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, parts.length);
    if (colors) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(parts.length * 3), 3);
    parts.forEach((p, i) => { mesh.setMatrixAt(i, p.matrix); if (colors && p.color) mesh.setColorAt(i, p.color); });
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true; this.sceneRef.add(mesh); return mesh;
  }

  private setPart(mesh: THREE.InstancedMesh, index: number, matrix: THREE.Matrix4, color?: THREE.Color): void {
    mesh.setMatrixAt(index, matrix); if (color && mesh.instanceColor) mesh.setColorAt(index, color);
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
