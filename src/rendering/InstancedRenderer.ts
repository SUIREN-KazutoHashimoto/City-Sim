import * as THREE from 'three';
import { Building, ParkingLot } from '../generation/CityGenerator';
import { RoadNetwork, roadWidth, crosswalkSetback, CROSSWALK_DEPTH } from '../traffic/RoadNetwork';
import { SidewalkNetwork } from '../traffic/SidewalkNetwork';
import { AgentStore, AgentState } from '../agents/AgentStore';
import { VehicleStore, VehicleState } from '../traffic/VehicleStore';
import { SignalSystem, SignalMode } from '../traffic/SignalSystem';
import { POICategory } from '../world/POI';
export class InstancedRenderer {
  private buildingMesh!: THREE.InstancedMesh;
  private agentMesh!: THREE.InstancedMesh;
  private vehicleMesh!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private agentMap = new Int32Array(0);
  private vehicleMap = new Int32Array(0);
  private signalRefs: { node: number; axis: 0 | 1; edge: number }[] = [];
  private lampR!: THREE.InstancedMesh; private lampY!: THREE.InstancedMesh; private lampG!: THREE.InstancedMesh;
  private lampWalk!: THREE.InstancedMesh; private lampDont!: THREE.InstancedMesh;
  private onR = new THREE.Color(0xff4030); private offR = new THREE.Color(0x3a1512);
  private onY = new THREE.Color(0xffd24a); private offY = new THREE.Color(0x3a3416);
  private onG = new THREE.Color(0x40ff6a); private offG = new THREE.Color(0x123a1c);
  private onWalk = new THREE.Color(0x6ad8ff); private offWalk = new THREE.Color(0x123038);
  private onDont = new THREE.Color(0xff6a3a); private offDont = new THREE.Color(0x381810);
  private readonly categoryColor: Record<number, THREE.Color> = {
    [POICategory.Home]: new THREE.Color(0x8fa9c6), [POICategory.Work]: new THREE.Color(0x6f7f95),
    [POICategory.Food]: new THREE.Color(0xc98b5a), [POICategory.Retail]: new THREE.Color(0xb9a06a), [POICategory.Leisure]: new THREE.Color(0x7cba8f),
  };
  private readonly carColors = [0xd94f4f, 0x4f7fd9, 0xe0e0e0, 0x2b2b2b, 0xd9b64f, 0x54b07a, 0x8a6fd9].map((c) => new THREE.Color(c));
  private readonly busColor = new THREE.Color(0x2f9e44);
  private readonly truckColor = new THREE.Color(0xc26b2a);
  constructor(private scene: THREE.Scene) {}
  get buildings(): THREE.InstancedMesh { return this.buildingMesh; }
  get agents(): THREE.InstancedMesh { return this.agentMesh; }
  get vehicles(): THREE.InstancedMesh { return this.vehicleMesh; }
  agentIndexOf(id: number): number { return id >= 0 && id < this.agentMap.length ? this.agentMap[id] : -1; }
  vehicleIndexOf(id: number): number { return id >= 0 && id < this.vehicleMap.length ? this.vehicleMap[id] : -1; }
  buildStatic(buildings: Building[], net: RoadNetwork, sidewalk: SidewalkNetwork, lots: ParkingLot[]): void {
    this.buildGround(); this.buildRoads(net); this.buildSidewalks(sidewalk); this.buildParking(lots); this.buildBuildings(buildings);
  }
  private buildGround(): void { const g = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x1c3a24, roughness: 1 })); g.rotation.x = -Math.PI / 2; g.scale.set(1e5, 1e5, 1); g.position.set(0, -0.05, 0); g.receiveShadow = true; this.scene.add(g); }
  private buildRoads(net: RoadNetwork): void {
    const drawn = new Set<string>(); const boxes: THREE.Matrix4[] = [];
    for (const e of net.edges) { const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`; if (drawn.has(key)) continue; drawn.add(key); const a = net.nodes[e.from], b = net.nodes[e.to]; const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, angle = Math.atan2(b.z - a.z, b.x - a.x); const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(mx, 0.05, mz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)), new THREE.Vector3(e.length, 0.1, roadWidth(e.lanes))); boxes.push(m); }
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 1 }), boxes.length);
    boxes.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true; this.scene.add(mesh); this.buildCenterLines(net);
  }
  private buildCenterLines(net: RoadNetwork): void {
    const drawn = new Set<string>(); const boxes: THREE.Matrix4[] = [];
    for (const e of net.edges) { const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`; if (drawn.has(key)) continue; drawn.add(key); const a = net.nodes[e.from], b = net.nodes[e.to]; const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, angle = Math.atan2(b.z - a.z, b.x - a.x); const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(mx, 0.11, mz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)), new THREE.Vector3(Math.max(1, e.length - 12), 0.05, 0.3)); boxes.push(m); }
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd9c65a, roughness: 1, emissive: 0x2a2508, emissiveIntensity: 0.2 }), boxes.length);
    boxes.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true; this.scene.add(mesh);
  }
  private buildSidewalks(sw: SidewalkNetwork): void {
    const boxes: THREE.Matrix4[] = []; const drawn = new Set<number>();
    for (const e of sw.edges) { const key = e.from < e.to ? e.from * 1e6 + e.to : e.to * 1e6 + e.from; if (drawn.has(key)) continue; drawn.add(key); if (e.crossing) continue; const a = sw.nodes[e.from], b = sw.nodes[e.to]; const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, angle = Math.atan2(b.z - a.z, b.x - a.x); const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(mx, 0.09, mz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)), new THREE.Vector3(e.length + 3, 0.12, 3.0)); boxes.push(m); }
    if (boxes.length === 0) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xb0a58f, roughness: 1 }), boxes.length);
    boxes.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true; this.scene.add(mesh);
  }
  private buildParking(lots: ParkingLot[]): void {
    if (lots.length === 0) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 1 }), lots.length);
    lots.forEach((lot, i) => { this.dummy.position.set(lot.x, 0.07, lot.z); this.dummy.scale.set(lot.width, 0.1, lot.depth); this.dummy.rotation.set(0, 0, 0); this.dummy.updateMatrix(); mesh.setMatrixAt(i, this.dummy.matrix); });
    mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true; this.scene.add(mesh);
  }
  private buildBuildings(buildings: Building[]): void {
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 }), buildings.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(buildings.length * 3), 3); const fh = 3.2;
    for (let i = 0; i < buildings.length; i++) { const b = buildings[i]; this.dummy.position.set(b.x, 0, b.z); this.dummy.scale.set(b.width, b.floors * fh, b.depth); this.dummy.rotation.set(0, 0, 0); this.dummy.updateMatrix(); mesh.setMatrixAt(i, this.dummy.matrix); mesh.setColorAt(i, this.categoryColor[b.category] ?? new THREE.Color(0x9aa5b1)); }
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh); this.buildingMesh = mesh;
  }
  buildAgents(capacity: number): void {
    const geo = new THREE.CapsuleGeometry(0.25, 1.1, 4, 8); geo.translate(0, 0.8, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xe0d5c0, roughness: 0.7 }), capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; this.scene.add(mesh); this.agentMesh = mesh;
  }
  buildBusStops(stops: { x: number; z: number }[]): void {
    if (stops.length === 0) return;
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.09, 2.6, 6), new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.8, metalness: 0.4 }), stops.length);
    const sign = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.6, 0.12), new THREE.MeshStandardMaterial({ color: 0x2f6fd0, roughness: 0.6, emissive: 0x10233f, emissiveIntensity: 0.35 }), stops.length);
    pole.frustumCulled = false; sign.frustumCulled = false;
    stops.forEach((s, i) => { this.dummy.position.set(s.x, 1.3, s.z); this.dummy.scale.setScalar(1); this.dummy.rotation.set(0, 0, 0); this.dummy.updateMatrix(); pole.setMatrixAt(i, this.dummy.matrix); this.dummy.position.set(s.x, 2.5, s.z); this.dummy.updateMatrix(); sign.setMatrixAt(i, this.dummy.matrix); });
    pole.instanceMatrix.needsUpdate = true; sign.instanceMatrix.needsUpdate = true; this.scene.add(pole); this.scene.add(sign);
  }
  buildGates(gates: { x: number; z: number }[]): void {
    if (gates.length === 0) return;
    const post = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 5, 0.8), new THREE.MeshStandardMaterial({ color: 0x6b7078, roughness: 0.7, metalness: 0.4 }), gates.length * 2);
    const beam = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.8, 12), new THREE.MeshStandardMaterial({ color: 0xc26b2a, roughness: 0.6, emissive: 0x2a1508, emissiveIntensity: 0.3 }), gates.length);
    post.frustumCulled = false; beam.frustumCulled = false;
    gates.forEach((g, i) => { this.dummy.position.set(g.x, 2.5, g.z - 6); this.dummy.scale.setScalar(1); this.dummy.rotation.set(0, 0, 0); this.dummy.updateMatrix(); post.setMatrixAt(i * 2, this.dummy.matrix); this.dummy.position.set(g.x, 2.5, g.z + 6); this.dummy.updateMatrix(); post.setMatrixAt(i * 2 + 1, this.dummy.matrix); this.dummy.position.set(g.x, 5.2, g.z); this.dummy.updateMatrix(); beam.setMatrixAt(i, this.dummy.matrix); });
    post.instanceMatrix.needsUpdate = true; beam.instanceMatrix.needsUpdate = true; this.scene.add(post); this.scene.add(beam);
  }
  buildVehicles(capacity: number): void {
    const geo = new THREE.BoxGeometry(4.4, 1.5, 2.0); geo.translate(0, 0.75, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }), capacity);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; this.scene.add(mesh); this.vehicleMesh = mesh;
  }
  buildSignals(net: RoadNetwork, signals: SignalSystem): void {
    this.signalRefs = [];
    for (const nodeId of signals.nodeIds) {
      const node = net.nodes[nodeId];
      for (const edgeId of node.edges) this.signalRefs.push({ node: nodeId, axis: net.axisOf(node.id, net.edges[edgeId].to), edge: edgeId });
    }
    const count = Math.max(1, this.signalRefs.length);
    const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11, 0.13, 6, 6), new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.8, metalness: 0.3 }), count);
    const vehHousing = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 1.7, 0.55), new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.7 }), count);
    const pedHousing = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 1.05, 0.35), new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.7 }), count);
    for (const m of [poleMesh, vehHousing, pedHousing]) m.frustumCulled = false;
    const lampGeo = new THREE.SphereGeometry(0.2, 8, 8);
    const mkLamp = () => { const m = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial(), count); m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3); m.frustumCulled = false; return m; };
    const lampR = mkLamp(), lampY = mkLamp(), lampG = mkLamp();
    const pedLampGeo = new THREE.BoxGeometry(0.3, 0.3, 0.1);
    const mkPed = () => { const m = new THREE.InstancedMesh(pedLampGeo, new THREE.MeshBasicMaterial(), count); m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3); m.frustumCulled = false; return m; };
    const lampDont = mkPed(), lampWalk = mkPed();
    const q = new THREE.Quaternion();
    const setPR = (mesh: THREE.InstancedMesh, k: number, x: number, y: number, z: number, angle: number) => { this.dummy.position.set(x, y, z); this.dummy.scale.setScalar(1); q.setFromEuler(new THREE.Euler(0, angle, 0)); this.dummy.quaternion.copy(q); this.dummy.updateMatrix(); mesh.setMatrixAt(k, this.dummy.matrix); };
    for (let k = 0; k < this.signalRefs.length; k++) {
      const r = this.signalRefs[k], n = net.nodes[r.node], edge = net.edges[r.edge], nb = net.nodes[edge.to];
      let towardX = nb.x - n.x, towardZ = nb.z - n.z; const L = Math.hypot(towardX, towardZ) || 1; towardX /= L; towardZ /= L;
      const dx = -towardX, dz = -towardZ, rx = dz, rz = -dx;
      const rw = roadWidth(edge.lanes);
      const longitudinal = crosswalkSetback(rw) + CROSSWALK_DEPTH * 0.5 + 0.7;
      const lateral = rw * 0.5 + 1.2;
      const bx = n.x - dx * longitudinal + rx * lateral, bz = n.z - dz * longitudinal + rz * lateral;
      const hx = bx - rx * 1.1, hz = bz - rz * 1.1;
      const facing = Math.atan2(-dz, -dx); const ox = -dx * 0.3, oz = -dz * 0.3;
      setPR(poleMesh, k, bx, 3, bz, facing);
      setPR(vehHousing, k, hx, 5.6, hz, facing);
      setPR(lampR, k, hx + ox, 6.1, hz + oz, facing); setPR(lampY, k, hx + ox, 5.6, hz + oz, facing); setPR(lampG, k, hx + ox, 5.1, hz + oz, facing);
      setPR(pedHousing, k, bx, 2.7, bz, facing); setPR(lampDont, k, bx + ox, 2.95, bz + oz, facing); setPR(lampWalk, k, bx + ox, 2.45, bz + oz, facing);
    }
    for (const m of [poleMesh, vehHousing, pedHousing, lampR, lampY, lampG, lampDont, lampWalk]) { m.instanceMatrix.needsUpdate = true; this.scene.add(m); }
    this.lampR = lampR; this.lampY = lampY; this.lampG = lampG; this.lampWalk = lampWalk; this.lampDont = lampDont;
  }
  buildCrosswalks(net: RoadNetwork, signals: SignalSystem): void {
    const stripes: THREE.Matrix4[] = []; const y = 0.13, SW = 0.55, GAP = 0.55;
    const addBand = (cx: number, cz: number, dirX: number, dirZ: number, roadW: number) => { const L = Math.hypot(dirX, dirZ) || 1; const dx = dirX / L, dz = dirZ / L; const px = -dz, pz = dx, angle = Math.atan2(dz, dx); const half = roadW / 2 - 0.3, pitch = SW + GAP, n = Math.max(1, Math.floor((roadW - 0.6) / pitch)), start = -((n - 1) * pitch) / 2; for (let k = 0; k < n; k++) { const off = start + k * pitch; if (Math.abs(off) > half) continue; const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(cx + px * off, y, cz + pz * off), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)), new THREE.Vector3(CROSSWALK_DEPTH, 0.06, SW)); stripes.push(m); } };
    for (const nodeId of signals.nodeIds) { const node = net.nodes[nodeId]; const scramble = signals.modeOf(nodeId) === SignalMode.Scramble; for (const edgeId of node.edges) { const e = net.edges[edgeId], nb = net.nodes[e.to]; let dxx = nb.x - node.x, dzz = nb.z - node.z; const L = Math.hypot(dxx, dzz) || 1; dxx /= L; dzz /= L; const roadW = roadWidth(e.lanes), setback = crosswalkSetback(roadW); addBand(node.x + dxx * setback, node.z + dzz * setback, dxx, dzz, roadW); } if (scramble) { addBand(node.x, node.z, 0.707, 0.707, 10); addBand(node.x, node.z, 0.707, -0.707, 10); } }
    if (stripes.length === 0) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xdadfe6, roughness: 0.9, emissive: 0x2a2d33, emissiveIntensity: 0.3 }), stripes.length);
    stripes.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true; this.scene.add(mesh);
  }
  buildStopLines(net: RoadNetwork, signals: SignalSystem): void {
    const bars: THREE.Matrix4[] = [];
    for (const nodeId of signals.nodeIds) { const node = net.nodes[nodeId]; for (const edgeId of node.edges) { const e = net.edges[edgeId], nb = net.nodes[e.to]; let dxx = nb.x - node.x, dzz = nb.z - node.z; const L = Math.hypot(dxx, dzz) || 1; dxx /= L; dzz /= L; const roadW = roadWidth(e.lanes), setback = crosswalkSetback(roadW) + CROSSWALK_DEPTH * 0.5 + 0.8, angle = Math.atan2(dzz, dxx); const px = -dzz, pz = dxx, halfShift = roadW / 4; const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(node.x + dxx * setback + px * halfShift, 0.14, node.z + dzz * setback + pz * halfShift), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)), new THREE.Vector3(0.6, 0.06, roadW / 2 - 0.4)); bars.push(m); } }
    if (bars.length === 0) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xe6ebf0, roughness: 0.9, emissive: 0x2a2d33, emissiveIntensity: 0.25 }), bars.length);
    bars.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true; this.scene.add(mesh);
  }
  syncAgents(store: AgentStore): void {
    const mesh = this.agentMesh; if (this.agentMap.length < store.capacity) this.agentMap = new Int32Array(store.capacity); let n = 0;
    for (let i = 0; i < store.count; i++) { const st = store.state[i]; if (st === AgentState.Driving || st === AgentState.Engaged || st === AgentState.OnBus) continue; this.dummy.position.set(store.posX[i], 0, store.posZ[i]); this.dummy.rotation.set(0, -store.heading[i], 0); this.dummy.scale.setScalar(1); this.dummy.updateMatrix(); mesh.setMatrixAt(n, this.dummy.matrix); this.agentMap[n] = i; n++; }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
  }
  syncVehicles(vs: VehicleStore): void {
    const mesh = this.vehicleMesh; if (this.vehicleMap.length < vs.capacity) this.vehicleMap = new Int32Array(vs.capacity); let n = 0;
    for (let v = 0; v < vs.count; v++) {
      const st = vs.state[v]; const show = st === VehicleState.Driving || st === VehicleState.Parked || ((vs.isBus[v] || vs.isTruck[v]) && st === VehicleState.Arrived); if (!show) continue;
      this.dummy.position.set(vs.posX[v], 0, vs.posZ[v]); this.dummy.rotation.set(0, -vs.heading[v], 0);
      if (vs.isBus[v]) this.dummy.scale.set(2.6, 1.6, 1.15); else if (vs.isTruck[v]) this.dummy.scale.set(2.1, 1.9, 1.25); else this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix(); mesh.setMatrixAt(n, this.dummy.matrix);
      mesh.setColorAt(n, vs.isBus[v] ? this.busColor : vs.isTruck[v] ? this.truckColor : this.carColors[vs.colorIdx[v] % this.carColors.length]);
      this.vehicleMap[n] = v; n++;
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  syncSignals(signals: SignalSystem): void {
    if (!this.lampR) return;
    for (let k = 0; k < this.signalRefs.length; k++) { const { node, axis } = this.signalRefs[k]; const vc = signals.vehicleColor(node, axis); this.lampR.setColorAt(k, vc === 'red' ? this.onR : this.offR); this.lampY.setColorAt(k, vc === 'yellow' ? this.onY : this.offY); this.lampG.setColorAt(k, vc === 'green' ? this.onG : this.offG); const pc = signals.pedColor(node, axis); this.lampWalk.setColorAt(k, pc === 'walk' ? this.onWalk : this.offWalk); this.lampDont.setColorAt(k, pc === 'walk' ? this.offDont : this.onDont); }
    for (const m of [this.lampR, this.lampY, this.lampG, this.lampWalk, this.lampDont]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}
