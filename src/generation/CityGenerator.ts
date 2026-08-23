import { RoadNetwork, RoadClass } from '../traffic/RoadNetwork';
import { POIRegistry, POICategory } from '../world/POI';
import { makeRng, clamp } from '../core/math';
import { CityPlanning, CityPlanningOptions, DistrictType, PlanningSample } from './CityPlanning';
import { BlockParcelLayout, FrontageSide, LandParcel, UrbanBlock } from './BlockParcelLayout';

export interface CityConfig {
  seed: number;
  sizeMeters: number;
  urbanRatioTarget: number;
  blockSize: number;
  planning?: Partial<CityPlanningOptions>;
}

export enum BuildingArchetype {
  DetachedHouse = 0,
  TownHouse = 1,
  LowRiseApartment = 2,
  MidRiseApartment = 3,
  ResidentialTower = 4,
  SmallOffice = 5,
  OfficeSlab = 6,
  OfficeTower = 7,
  SmallShop = 8,
  RetailBox = 9,
  CommercialBlock = 10,
  MixedUse = 11,
  LeisureHall = 12,
  Factory = 13,
  Warehouse = 14,
}

export enum RoofType { Flat = 0, Gable = 1, Hip = 2, Mechanical = 3 }

export interface Building {
  id: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  floors: number;
  category: POICategory;
  archetype: BuildingArchetype;
  roofType: RoofType;
  palette: number;
  styleSeed: number;
  rotation: number;
  urbanity: number;
  district: DistrictType;
  landValue: number;
  frontage: FrontageSide;
}

export interface ParkingLot {
  id: number; poiId: number; x: number; z: number; width: number; depth: number; capacity: number;
  slotX: Float32Array; slotZ: Float32Array; free: Uint8Array;
}

/**
 * City Generator v2.
 * Phase 1: city planning + road hierarchy.
 * Phase 2: road-bounded blocks + frontage-aware parcels + setback-aware buildings.
 */
export class CityGenerator {
  readonly net = new RoadNetwork(); readonly poi = new POIRegistry();
  readonly buildings: Building[] = []; readonly parkingLots: ParkingLot[] = [];
  readonly blocks: UrbanBlock[] = []; readonly parcels: LandParcel[] = [];
  readonly lotByPOI = new Map<number, number>();
  readonly gateNodes: number[] = [];
  readonly sizeMeters: number; readonly planning: CityPlanning; urbanThreshold = 0.5;
  private rng: () => number;
  private arterialEvery = 10; private collectorEvery = 4;
  private arterialOffsetX = 0; private arterialOffsetZ = 0;
  private collectorOffsetX = 0; private collectorOffsetZ = 0;
  private nextParcel = 0;

  constructor(private cfg: CityConfig) {
    this.rng = makeRng(cfg.seed ^ 0x9e3779b9);
    this.sizeMeters = cfg.sizeMeters;
    this.planning = new CityPlanning(cfg.sizeMeters, cfg.seed, cfg.planning);
  }

  private urbanization(x: number, z: number): number { return this.planning.sample(x, z).urbanScore; }

  private calibrateThreshold(): void {
    const N = 72; const samples: number[] = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      samples.push(this.urbanization(((i + 0.5) / N) * this.cfg.sizeMeters, ((j + 0.5) / N) * this.cfg.sizeMeters));
    }
    samples.sort((a, b) => a - b);
    const idx = clamp(Math.floor((1 - this.cfg.urbanRatioTarget) * samples.length), 0, samples.length - 1);
    this.urbanThreshold = samples[idx];
  }

  generate(): void {
    this.calibrateThreshold();
    const size = this.cfg.sizeMeters, bs = this.cfg.blockSize, cols = Math.floor(size / bs);
    this.arterialEvery = Math.max(4, Math.round(this.planning.options.arterialSpacing / bs));
    this.collectorEvery = Math.max(2, Math.round(this.planning.options.collectorSpacing / bs));
    this.arterialOffsetX = this.mod(Math.round(this.planning.cbd.x / bs), this.arterialEvery);
    this.arterialOffsetZ = this.mod(Math.round(this.planning.cbd.z / bs), this.arterialEvery);
    this.collectorOffsetX = this.mod(Math.round(this.planning.cbd.x / bs), this.collectorEvery);
    this.collectorOffsetZ = this.mod(Math.round(this.planning.cbd.z / bs), this.collectorEvery);

    const nodeGrid: number[][] = [];
    for (let i = 0; i <= cols; i++) {
      nodeGrid[i] = [];
      for (let j = 0; j <= cols; j++) {
        const x = i * bs, z = j * bs; const p = this.planning.sample(x, z);
        const urban = p.urbanScore >= this.urbanThreshold;
        const xClass = this.classForGridLine(i, 'x'), zClass = this.classForGridLine(j, 'z');
        const majorX = xClass !== RoadClass.Local, majorZ = zClass !== RoadClass.Local;
        const localStep = this.planning.localRoadStep(p.district);
        const localX = this.mod(i, localStep) === 0, localZ = this.mod(j, localStep) === 0;
        const keep = urban ? ((majorX || localX) && (majorZ || localZ)) : (majorX || majorZ);
        const signal = urban && this.shouldSignal(i, j, xClass, zClass, p.district);
        nodeGrid[i][j] = keep ? this.net.addNode(x, z, signal) : -1;
      }
    }

    const maxSpan = bs * 3.65;
    const connectSpan = (a: number, b: number, cls: RoadClass): void => {
      if (a < 0 || b < 0) return;
      const na = this.net.nodes[a], nb = this.net.nodes[b];
      if (Math.hypot(nb.x - na.x, nb.z - na.z) > maxSpan) return;
      const p = this.planning.sample((na.x + nb.x) / 2, (na.z + nb.z) / 2);
      const lanes = cls === RoadClass.Arterial
        ? (p.district === DistrictType.CBD || p.district === DistrictType.Commercial ? 3 : 2)
        : cls === RoadClass.Collector ? (p.density > 0.72 ? 2 : 1) : 1;
      this.net.connect(a, b, cls, lanes);
    };

    for (let j = 0; j <= cols; j++) {
      const cls = this.classForGridLine(j, 'z'); let prev = -1;
      for (let i = 0; i <= cols; i++) {
        const n = nodeGrid[i][j]; if (n < 0) continue;
        if (prev >= 0) connectSpan(prev, n, cls); prev = n;
      }
    }
    for (let i = 0; i <= cols; i++) {
      const cls = this.classForGridLine(i, 'x'); let prev = -1;
      for (let j = 0; j <= cols; j++) {
        const n = nodeGrid[i][j]; if (n < 0) continue;
        if (prev >= 0) connectSpan(prev, n, cls); prev = n;
      }
    }

    this.ensureConnected(nodeGrid, cols);
    this.generateBlocksAndParcels(bs, cols);
    this.buildGates(nodeGrid, cols, bs, size);
  }

  private generateBlocksAndParcels(bs: number, cols: number): void {
    const layout = new BlockParcelLayout(this.net, bs, cols);
    const extracted = layout.extractBlocks((x, z) => this.urbanization(x, z) >= this.urbanThreshold);
    this.blocks.push(...extracted);

    for (const block of this.blocks) {
      const centerPlan = this.planning.sample(block.x, block.z);
      const parcels = layout.subdivide(
        block,
        this.parcelFrontage(centerPlan.district),
        this.parcelDepth(centerPlan.district),
        this.rng,
        () => this.nextParcel++,
      );
      this.parcels.push(...parcels);
      this.fillBlockParcels(block, parcels);
    }
  }

  private fillBlockParcels(block: UrbanBlock, parcels: LandParcel[]): void {
    if (parcels.length === 0) return;
    let parkingPlaced = false;
    for (const parcel of parcels) {
      const plan = this.planning.sample(parcel.x, parcel.z);
      if (plan.urbanScore < this.urbanThreshold) continue;
      if (plan.district === DistrictType.Park && this.rng() > 0.10) continue;

      const parkingChance = this.parkingChance(plan.district);
      if (!parkingPlaced && plan.district !== DistrictType.CBD && plan.district !== DistrictType.Park && this.rng() < parkingChance) {
        const mx = Math.max(2, Math.min(5, parcel.width * 0.08));
        const mz = Math.max(2, Math.min(5, parcel.depth * 0.08));
        this.addParkingRect(parcel.x, parcel.z, Math.max(8, parcel.width - mx * 2), Math.max(8, parcel.depth - mz * 2));
        parkingPlaced = true;
        continue;
      }
      if (this.rng() < this.emptyChance(plan.district)) continue;
      this.placeParcelBuilding(parcel, plan);
    }

    const blockPlan = this.planning.sample(block.x, block.z);
    if (!parkingPlaced && parcels.length >= 3 && blockPlan.district !== DistrictType.CBD && blockPlan.district !== DistrictType.Park
      && this.rng() < this.parkingChance(blockPlan.district) * 0.9) {
      const p = parcels[parcels.length - 1];
      this.addParkingRect(p.x, p.z, Math.max(8, p.width * 0.84), Math.max(8, p.depth * 0.84));
    }
  }

  private placeParcelBuilding(parcel: LandParcel, plan: PlanningSample): void {
    const category = plan.district === DistrictType.Park ? POICategory.Leisure : this.pickCategory(plan, parcel.roadClass);
    let floors = this.baseFloorsForPlan(plan);
    const roughW = Math.max(6, parcel.width * 0.72), roughD = Math.max(6, parcel.depth * 0.72);
    const archetype = this.pickArchetype(category, plan, floors, roughW, roughD);
    floors = this.adjustFloors(archetype, floors);

    const footprint = this.buildingFootprint(parcel, plan.district, archetype);
    if (!footprint || footprint.width < 4 || footprint.depth < 4) return;

    const id = this.buildings.length;
    const roofType = this.pickRoofType(archetype);
    const palette = Math.floor(this.rng() * 4);
    const styleSeed = Math.floor(this.rng() * 0xffffffff) >>> 0;
    this.buildings.push({
      id, x: footprint.x, z: footprint.z, width: footprint.width, depth: footprint.depth, floors, category, archetype,
      roofType, palette, styleSeed, rotation: footprint.rotation,
      urbanity: plan.urbanScore, district: plan.district, landValue: plan.landValue, frontage: parcel.frontage,
    });
    this.registerPOIs(id, footprint.x, footprint.z, category, floors, archetype);
  }

  private buildingFootprint(
    parcel: LandParcel,
    district: DistrictType,
    archetype: BuildingArchetype,
  ): { x: number; z: number; width: number; depth: number; rotation: number } | null {
    const front = this.frontSetback(district, archetype);
    const rear = this.rearSetback(district, archetype);
    const side = this.sideSetback(district, archetype);
    const minX = parcel.x - parcel.width / 2, maxX = parcel.x + parcel.width / 2;
    const minZ = parcel.z - parcel.depth / 2, maxZ = parcel.z + parcel.depth / 2;

    let localWidth: number, localDepth: number, x = parcel.x, z = parcel.z, rotation = 0;
    if (parcel.frontage === 'north' || parcel.frontage === 'south') {
      const frontageAvail = parcel.width - side * 2, depthAvail = parcel.depth - front - rear;
      if (frontageAvail < 4 || depthAvail < 4) return null;
      localWidth = frontageAvail * this.frontageFill(archetype);
      localDepth = depthAvail * this.depthFill(archetype);
      const lateralSpare = Math.max(0, frontageAvail - localWidth);
      x += (this.rng() - 0.5) * lateralSpare * 0.55;
      z = parcel.frontage === 'north' ? minZ + front + localDepth / 2 : maxZ - front - localDepth / 2;
      rotation = 0;
    } else {
      const frontageAvail = parcel.depth - side * 2, depthAvail = parcel.width - front - rear;
      if (frontageAvail < 4 || depthAvail < 4) return null;
      localWidth = frontageAvail * this.frontageFill(archetype);
      localDepth = depthAvail * this.depthFill(archetype);
      const lateralSpare = Math.max(0, frontageAvail - localWidth);
      z += (this.rng() - 0.5) * lateralSpare * 0.55;
      x = parcel.frontage === 'west' ? minX + front + localDepth / 2 : maxX - front - localDepth / 2;
      rotation = Math.PI / 2;
    }
    return { x, z, width: localWidth, depth: localDepth, rotation };
  }

  private classForGridLine(index: number, axis: 'x' | 'z'): RoadClass {
    const artOff = axis === 'x' ? this.arterialOffsetX : this.arterialOffsetZ;
    const colOff = axis === 'x' ? this.collectorOffsetX : this.collectorOffsetZ;
    if (this.mod(index - artOff, this.arterialEvery) === 0) return RoadClass.Arterial;
    if (this.mod(index - colOff, this.collectorEvery) === 0) return RoadClass.Collector;
    return RoadClass.Local;
  }

  private shouldSignal(i: number, j: number, xClass: RoadClass, zClass: RoadClass, district: DistrictType): boolean {
    const majorX = xClass === RoadClass.Arterial || xClass === RoadClass.Collector;
    const majorZ = zClass === RoadClass.Arterial || zClass === RoadClass.Collector;
    if (majorX && majorZ) return true;
    if (district === DistrictType.CBD && (xClass === RoadClass.Arterial || zClass === RoadClass.Arterial)) return ((i + j) & 1) === 0;
    return false;
  }

  private ensureConnected(nodeGrid: number[][], cols: number): void {
    const N = this.net.nodes.length; if (N === 0) return;
    const parent = new Int32Array(N); for (let i = 0; i < N; i++) parent[i] = i;
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const e of this.net.edges) { const ra = find(e.from), rb = find(e.to); if (ra !== rb) parent[ra] = rb; }
    const comps = new Map<number, number[]>();
    for (let i = 0; i < N; i++) { const r = find(i); let a = comps.get(r); if (!a) { a = []; comps.set(r, a); } a.push(i); }
    const groups = [...comps.values()]; if (groups.length <= 1) return;
    groups.sort((a, b) => b.length - a.length);
    const nodeToGrid = new Map<number, { i: number; j: number }>();
    for (let i = 0; i <= cols; i++) for (let j = 0; j <= cols; j++) { const n = nodeGrid[i][j]; if (n >= 0) nodeToGrid.set(n, { i, j }); }
    const mainRoot = find(groups[0][0]);
    for (let g = 1; g < groups.length; g++) {
      const island = groups[g]; let best: { a: number; b: number; d: number } | null = null;
      for (const a of island) {
        const ga = nodeToGrid.get(a); if (!ga) continue;
        for (const m of groups[0]) {
          const gm = nodeToGrid.get(m); if (!gm) continue;
          if (gm.i !== ga.i && gm.j !== ga.j) continue;
          const d = Math.abs(gm.i - ga.i) + Math.abs(gm.j - ga.j);
          if (!best || d < best.d) best = { a, b: m, d };
        }
      }
      if (best) { this.net.connect(best.a, best.b, RoadClass.Arterial, 2); for (const n of island) parent[find(n)] = mainRoot; }
    }
  }

  private buildGates(nodeGrid: number[][], cols: number, bs: number, size: number): void {
    const ext = 120;
    const tryGate = (edgeNode: number, gx: number, gz: number): void => {
      if (edgeNode < 0) return; const g = this.net.addNode(gx, gz, false);
      this.net.connect(edgeNode, g, RoadClass.Highway, 2); this.gateNodes.push(g);
    };
    const midCol = Math.round(cols / 2);
    const findEdgeNode = (fixed: 'i' | 'j', fixedIdx: number, center: number): number => {
      for (let d = 0; d <= cols; d++) for (const s of [center - d, center + d]) {
        if (s < 0 || s > cols) continue;
        const n = fixed === 'i' ? nodeGrid[fixedIdx][s] : nodeGrid[s][fixedIdx]; if (n >= 0) return n;
      }
      return -1;
    };
    tryGate(findEdgeNode('i', 0, midCol), -ext, midCol * bs);
    tryGate(findEdgeNode('i', cols, midCol), size + ext, midCol * bs);
    tryGate(findEdgeNode('j', 0, midCol), midCol * bs, -ext);
    tryGate(findEdgeNode('j', cols, midCol), midCol * bs, size + ext);
  }

  private parcelFrontage(district: DistrictType): number {
    switch (district) {
      case DistrictType.CBD: return 21;
      case DistrictType.Commercial: return 25;
      case DistrictType.MixedUse: return 25;
      case DistrictType.ResidentialHigh: return 27;
      case DistrictType.ResidentialLow: return 36;
      case DistrictType.Industrial: return 68;
      case DistrictType.Logistics: return 92;
      case DistrictType.Civic: return 48;
      case DistrictType.Park: return 80;
    }
  }

  private parcelDepth(district: DistrictType): number {
    switch (district) {
      case DistrictType.CBD: return 34;
      case DistrictType.Commercial: return 38;
      case DistrictType.MixedUse: return 40;
      case DistrictType.ResidentialHigh: return 42;
      case DistrictType.ResidentialLow: return 48;
      case DistrictType.Industrial: return 72;
      case DistrictType.Logistics: return 88;
      case DistrictType.Civic: return 60;
      case DistrictType.Park: return 70;
    }
  }

  private frontSetback(district: DistrictType, type: BuildingArchetype): number {
    if (type === BuildingArchetype.Factory || type === BuildingArchetype.Warehouse) return district === DistrictType.Logistics ? 12 : 9;
    if (district === DistrictType.CBD || district === DistrictType.Commercial) return type === BuildingArchetype.SmallShop ? 0.8 : 1.5;
    if (district === DistrictType.MixedUse) return 2.0;
    if (district === DistrictType.ResidentialHigh) return 3.5;
    if (district === DistrictType.ResidentialLow) return type === BuildingArchetype.DetachedHouse ? 6 : 4.5;
    if (district === DistrictType.Civic) return 6;
    return 3;
  }

  private rearSetback(district: DistrictType, type: BuildingArchetype): number {
    if (type === BuildingArchetype.Factory || type === BuildingArchetype.Warehouse) return 8;
    if (district === DistrictType.CBD || district === DistrictType.Commercial) return 3;
    if (district === DistrictType.ResidentialLow) return 7;
    if (district === DistrictType.ResidentialHigh) return 5;
    return 4;
  }

  private sideSetback(district: DistrictType, type: BuildingArchetype): number {
    if (type === BuildingArchetype.Factory || type === BuildingArchetype.Warehouse) return 5;
    if (district === DistrictType.CBD) return 1.2;
    if (district === DistrictType.Commercial || district === DistrictType.MixedUse) return 1.8;
    if (district === DistrictType.ResidentialLow) return 3.5;
    return 2.5;
  }

  private frontageFill(type: BuildingArchetype): number {
    switch (type) {
      case BuildingArchetype.DetachedHouse: return 0.70;
      case BuildingArchetype.TownHouse: return 0.86;
      case BuildingArchetype.SmallShop: return 0.96;
      case BuildingArchetype.RetailBox: return 0.94;
      case BuildingArchetype.CommercialBlock: return 0.96;
      case BuildingArchetype.Factory: return 0.90;
      case BuildingArchetype.Warehouse: return 0.92;
      default: return 0.88;
    }
  }

  private depthFill(type: BuildingArchetype): number {
    switch (type) {
      case BuildingArchetype.DetachedHouse: return 0.72;
      case BuildingArchetype.TownHouse: return 0.82;
      case BuildingArchetype.SmallShop: return 0.90;
      case BuildingArchetype.Factory: return 0.86;
      case BuildingArchetype.Warehouse: return 0.88;
      default: return 0.84;
    }
  }

  private parkingChance(district: DistrictType): number {
    switch (district) {
      case DistrictType.CBD: return 0.05;
      case DistrictType.Commercial: return 0.13;
      case DistrictType.MixedUse: return 0.11;
      case DistrictType.ResidentialHigh: return 0.12;
      case DistrictType.ResidentialLow: return 0.22;
      case DistrictType.Industrial: return 0.30;
      case DistrictType.Logistics: return 0.38;
      case DistrictType.Civic: return 0.16;
      case DistrictType.Park: return 0;
    }
  }

  private emptyChance(district: DistrictType): number {
    switch (district) {
      case DistrictType.CBD: return 0.025;
      case DistrictType.Commercial: return 0.05;
      case DistrictType.MixedUse: return 0.06;
      case DistrictType.ResidentialHigh: return 0.07;
      case DistrictType.ResidentialLow: return 0.13;
      case DistrictType.Industrial: return 0.10;
      case DistrictType.Logistics: return 0.16;
      case DistrictType.Civic: return 0.12;
      case DistrictType.Park: return 0.84;
    }
  }

  private baseFloorsForPlan(plan: PlanningSample): number {
    if (plan.district === DistrictType.Industrial || plan.district === DistrictType.Logistics) return 1 + Math.floor(this.rng() * 3);
    if (plan.district === DistrictType.Park) return 1;
    const potential = clamp(plan.density * (0.55 + plan.landValue * 0.72), 0.08, 1.25);
    const cap = plan.district === DistrictType.CBD ? 34 : plan.district === DistrictType.Commercial ? 24 : 20;
    return Math.max(1, Math.round(1 + potential * cap * (0.56 + this.rng() * 0.58)));
  }

  private addParkingRect(x: number, z: number, width: number, depth: number): void {
    const safeW = Math.max(8, width), safeD = Math.max(8, depth), cellW = 3.0, cellD = 5.4;
    const usableW = Math.max(5, safeW - 2), usableD = Math.max(5, safeD - 2);
    const cols = Math.max(1, Math.floor(usableW / cellW)), rows = Math.max(1, Math.floor(usableD / cellD));
    const capacity = cols * rows; const slotX = new Float32Array(capacity), slotZ = new Float32Array(capacity), free = new Uint8Array(capacity).fill(1);
    let k = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      slotX[k] = x - usableW / 2 + (c + 0.5) * (usableW / cols);
      slotZ[k] = z - usableD / 2 + (r + 0.5) * (usableD / rows); k++;
    }
    const poiId = this.poi.add({ category: POICategory.Parking, x, z, priceTier: 0.3, capacity, buildingId: -1 });
    this.lotByPOI.set(poiId, this.parkingLots.length);
    this.parkingLots.push({ id: this.parkingLots.length, poiId, x, z, width: safeW, depth: safeD, capacity, slotX, slotZ, free });
  }

  takeSlot(poiId: number): number {
    const li = this.lotByPOI.get(poiId); if (li === undefined) return -1; const lot = this.parkingLots[li];
    for (let i = 0; i < lot.free.length; i++) if (lot.free[i]) { lot.free[i] = 0; return i; } return -1;
  }
  giveSlot(poiId: number, slot: number): void {
    const li = this.lotByPOI.get(poiId); if (li === undefined) return; const lot = this.parkingLots[li];
    if (slot >= 0 && slot < lot.free.length) lot.free[slot] = 1;
  }
  slotX(poiId: number, slot: number): number { const li = this.lotByPOI.get(poiId); return li === undefined ? 0 : this.parkingLots[li].slotX[slot]; }
  slotZ(poiId: number, slot: number): number { const li = this.lotByPOI.get(poiId); return li === undefined ? 0 : this.parkingLots[li].slotZ[slot]; }

  private pickCategory(plan: PlanningSample, frontage: RoadClass): POICategory {
    const r = this.rng();
    const arterial = frontage === RoadClass.Arterial, collector = frontage === RoadClass.Collector;
    switch (plan.district) {
      case DistrictType.CBD:
        if (r < 0.40) return POICategory.Work; if (r < 0.64) return POICategory.Retail; if (r < 0.79) return POICategory.Food; if (r < 0.90) return POICategory.Leisure; return POICategory.Home;
      case DistrictType.Commercial:
        if (r < 0.34) return POICategory.Retail; if (r < 0.56) return POICategory.Food; if (r < 0.77) return POICategory.Work; if (r < 0.90) return POICategory.Leisure; return POICategory.Home;
      case DistrictType.MixedUse:
        if (arterial && r < 0.28) return POICategory.Retail; if (arterial && r < 0.44) return POICategory.Food;
        if (r < 0.40) return POICategory.Home; if (r < 0.62) return POICategory.Work; if (r < 0.78) return POICategory.Retail; if (r < 0.90) return POICategory.Food; return POICategory.Leisure;
      case DistrictType.ResidentialHigh:
        if ((arterial || collector) && r < 0.18) return POICategory.Retail; if ((arterial || collector) && r < 0.30) return POICategory.Food;
        if (r < 0.72) return POICategory.Home; if (r < 0.82) return POICategory.Work; if (r < 0.91) return POICategory.Retail; return POICategory.Leisure;
      case DistrictType.ResidentialLow:
        if (arterial && r < 0.13) return POICategory.Retail; if ((arterial || collector) && r < 0.20) return POICategory.Food;
        if (r < 0.78) return POICategory.Home; if (r < 0.86) return POICategory.Work; if (r < 0.94) return POICategory.Retail; return POICategory.Leisure;
      case DistrictType.Industrial:
        if (arterial && r < 0.10) return POICategory.Food; if (r < 0.84) return POICategory.Work; return POICategory.Retail;
      case DistrictType.Logistics:
        if (arterial && r < 0.08) return POICategory.Food; return POICategory.Work;
      case DistrictType.Civic:
        if (r < 0.62) return POICategory.Work; if (r < 0.78) return POICategory.Leisure; if (r < 0.90) return POICategory.Food; return POICategory.Retail;
      case DistrictType.Park:
        return POICategory.Leisure;
    }
  }

  private pickArchetype(cat: POICategory, plan: PlanningSample, floors: number, w: number, d: number): BuildingArchetype {
    const r = this.rng(); const urban = Math.max(plan.density, plan.landValue * 0.8); const aspect = Math.max(w, d) / Math.max(1, Math.min(w, d));
    if (plan.district === DistrictType.Logistics) return r < 0.82 ? BuildingArchetype.Warehouse : BuildingArchetype.Factory;
    if (plan.district === DistrictType.Industrial) return r < 0.60 ? BuildingArchetype.Factory : r < 0.86 ? BuildingArchetype.Warehouse : BuildingArchetype.OfficeSlab;
    if (plan.district === DistrictType.Park) return BuildingArchetype.LeisureHall;
    if (cat === POICategory.Home) {
      if (plan.district === DistrictType.ResidentialLow && floors <= 4) return r < 0.72 ? BuildingArchetype.DetachedHouse : BuildingArchetype.TownHouse;
      if (urban < 0.58 && floors <= 4) return r < 0.62 ? BuildingArchetype.DetachedHouse : BuildingArchetype.TownHouse;
      if (urban < 0.70) return r < 0.65 ? BuildingArchetype.LowRiseApartment : BuildingArchetype.TownHouse;
      if (urban < 0.84) return r < 0.72 ? BuildingArchetype.MidRiseApartment : BuildingArchetype.LowRiseApartment;
      return r < 0.62 ? BuildingArchetype.ResidentialTower : BuildingArchetype.MixedUse;
    }
    if (cat === POICategory.Work) {
      if (plan.district === DistrictType.CBD && floors >= 8) return r < 0.72 ? BuildingArchetype.OfficeTower : BuildingArchetype.MixedUse;
      if (urban > 0.84 && floors >= 8) return r < 0.64 ? BuildingArchetype.OfficeTower : BuildingArchetype.MixedUse;
      if (urban > 0.66 || aspect > 1.35) return BuildingArchetype.OfficeSlab;
      return BuildingArchetype.SmallOffice;
    }
    if (cat === POICategory.Retail) {
      if ((plan.district === DistrictType.CBD || plan.district === DistrictType.MixedUse) && r < 0.48) return BuildingArchetype.MixedUse;
      if (urban > 0.66) return BuildingArchetype.CommercialBlock;
      return BuildingArchetype.RetailBox;
    }
    if (cat === POICategory.Food) {
      if ((plan.district === DistrictType.CBD || plan.district === DistrictType.MixedUse) && r < 0.40) return BuildingArchetype.MixedUse;
      return BuildingArchetype.SmallShop;
    }
    if (cat === POICategory.Leisure) return urban > 0.78 && r < 0.30 ? BuildingArchetype.MixedUse : BuildingArchetype.LeisureHall;
    return BuildingArchetype.CommercialBlock;
  }

  private adjustFloors(type: BuildingArchetype, floors: number): number {
    switch (type) {
      case BuildingArchetype.DetachedHouse: return Math.min(2, Math.max(1, floors));
      case BuildingArchetype.TownHouse: return Math.min(3, Math.max(2, floors));
      case BuildingArchetype.LowRiseApartment: return Math.min(5, Math.max(2, floors));
      case BuildingArchetype.MidRiseApartment: return Math.min(11, Math.max(5, floors));
      case BuildingArchetype.ResidentialTower: return Math.max(10, floors);
      case BuildingArchetype.SmallOffice: return Math.min(6, Math.max(2, floors));
      case BuildingArchetype.OfficeSlab: return Math.min(12, Math.max(4, floors));
      case BuildingArchetype.OfficeTower: return Math.max(10, floors);
      case BuildingArchetype.SmallShop: return Math.min(3, Math.max(1, floors));
      case BuildingArchetype.RetailBox: return Math.min(4, Math.max(1, floors));
      case BuildingArchetype.CommercialBlock: return Math.min(9, Math.max(3, floors));
      case BuildingArchetype.MixedUse: return Math.max(6, floors);
      case BuildingArchetype.LeisureHall: return Math.min(5, Math.max(1, floors));
      case BuildingArchetype.Factory: return Math.min(3, Math.max(1, floors));
      case BuildingArchetype.Warehouse: return Math.min(2, Math.max(1, floors));
      default: return floors;
    }
  }

  private pickRoofType(type: BuildingArchetype): RoofType {
    const r = this.rng();
    if (type === BuildingArchetype.DetachedHouse || type === BuildingArchetype.TownHouse) return r < 0.55 ? RoofType.Gable : r < 0.85 ? RoofType.Hip : RoofType.Flat;
    if (type === BuildingArchetype.OfficeTower || type === BuildingArchetype.ResidentialTower || type === BuildingArchetype.MixedUse) return r < 0.7 ? RoofType.Mechanical : RoofType.Flat;
    if (type === BuildingArchetype.Factory || type === BuildingArchetype.Warehouse) return r < 0.92 ? RoofType.Flat : RoofType.Mechanical;
    return r < 0.8 ? RoofType.Flat : RoofType.Mechanical;
  }

  private registerPOIs(buildingId: number, x: number, z: number, cat: POICategory, floors: number, archetype: BuildingArchetype): void {
    const priceTier = clamp(0.3 + this.rng() * 0.5, 0, 1);
    let capacity = cat === POICategory.Home ? Math.max(4, floors * 5)
      : cat === POICategory.Work ? Math.max(6, floors * 8)
        : cat === POICategory.Food ? Math.max(8, floors * 6) : Math.max(6, floors * 5);
    if (archetype === BuildingArchetype.Factory) capacity = Math.max(35, floors * 35);
    if (archetype === BuildingArchetype.Warehouse) capacity = Math.max(18, floors * 20);
    const stockFor = (c: POICategory): { stock: number; maxStock: number } => {
      if (c === POICategory.Retail) { const m = Math.max(60, floors * 30); return { stock: m, maxStock: m }; }
      if (c === POICategory.Food) { const m = Math.max(40, floors * 20); return { stock: m, maxStock: m }; }
      return { stock: 0, maxStock: 0 };
    };
    this.poi.add({ category: cat, x, z, priceTier, capacity, buildingId, ...stockFor(cat) });

    if (archetype === BuildingArchetype.MixedUse) {
      if (cat !== POICategory.Retail) this.poi.add({ category: POICategory.Retail, x, z, priceTier, capacity: Math.max(24, floors * 3), buildingId, ...stockFor(POICategory.Retail) });
      if (cat !== POICategory.Food && this.rng() < 0.65) this.poi.add({ category: POICategory.Food, x, z, priceTier, capacity: Math.max(16, floors * 2), buildingId, ...stockFor(POICategory.Food) });
      if (cat !== POICategory.Home && cat !== POICategory.Work) {
        const upper = this.rng() < 0.5 ? POICategory.Home : POICategory.Work;
        const upperCap = upper === POICategory.Home ? Math.max(12, floors * 4) : Math.max(16, floors * 6);
        this.poi.add({ category: upper, x, z, priceTier, capacity: upperCap, buildingId });
      }
      return;
    }

    if (cat === POICategory.Home && this.rng() < 0.15) this.poi.add({ category: POICategory.Food, x, z, priceTier, capacity: 20, buildingId, ...stockFor(POICategory.Food) });
    if ((cat === POICategory.Work || cat === POICategory.Leisure) && this.rng() < 0.3) this.poi.add({ category: POICategory.Retail, x, z, priceTier, capacity: 40, buildingId, ...stockFor(POICategory.Retail) });
  }

  private mod(value: number, base: number): number { return ((value % base) + base) % base; }
}
