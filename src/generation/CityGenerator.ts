import { ValueNoise2D } from './Noise';
import { RoadNetwork, RoadClass } from '../traffic/RoadNetwork';
import { POIRegistry, POICategory } from '../world/POI';
import { makeRng, clamp } from '../core/math';

export interface CityConfig {
  seed: number; sizeMeters: number; urbanRatioTarget: number; blockSize: number;
}
export interface Building {
  id: number; x: number; z: number; width: number; depth: number;
  floors: number; category: POICategory;
}
/** 駐車場(街に静置され車が停まる)。描画のため矩形情報を持つ。 */
export interface ParkingLot {
  id: number; poiId: number; x: number; z: number; width: number; depth: number; capacity: number;
}

/** 手続き型都市生成: 都市化度→道路格子→街区分割→建物/POI/駐車場。決定論的。 */
export class CityGenerator {
  readonly net = new RoadNetwork();
  readonly poi = new POIRegistry();
  readonly buildings: Building[] = [];
  readonly parkingLots: ParkingLot[] = [];
  readonly sizeMeters: number;
  urbanThreshold = 0.5;
  private noise: ValueNoise2D;
  private rng: () => number;

  constructor(private cfg: CityConfig) {
    this.noise = new ValueNoise2D(cfg.seed);
    this.rng = makeRng(cfg.seed ^ 0x9e3779b9);
    this.sizeMeters = cfg.sizeMeters;
  }

  private urbanization(x: number, z: number): number {
    const s = 1 / 1400;
    const core = this.noise.fbm(x * s, z * s, 5);
    const cx = this.cfg.sizeMeters / 2;
    const dc = Math.hypot(x - cx, z - cx) / (this.cfg.sizeMeters * 0.75);
    return clamp(core * 1.15 - dc * 0.5, 0, 1);
  }
  private calibrateThreshold(): void {
    const N = 64; const samples: number[] = [];
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        samples.push(this.urbanization((i / N) * this.cfg.sizeMeters, (j / N) * this.cfg.sizeMeters));
    samples.sort((a, b) => a - b);
    const idx = clamp(Math.floor((1 - this.cfg.urbanRatioTarget) * samples.length), 0, samples.length - 1);
    this.urbanThreshold = samples[idx];
  }

  generate(): void {
    this.calibrateThreshold();
    const size = this.cfg.sizeMeters, bs = this.cfg.blockSize;
    const cols = Math.floor(size / bs);
    const nodeGrid: number[][] = [];
    for (let i = 0; i <= cols; i++) {
      nodeGrid[i] = [];
      for (let j = 0; j <= cols; j++) {
        const x = i * bs, z = j * bs;
        const u = this.urbanization(x, z);
        const keep = u >= this.urbanThreshold || (i % 3 === 0 && j % 3 === 0);
        nodeGrid[i][j] = keep ? this.net.addNode(x, z, u >= this.urbanThreshold) : -1;
      }
    }
    const connect = (a: number, b: number, u: number) => {
      if (a < 0 || b < 0) return;
      const cls = u >= this.urbanThreshold + 0.25 ? RoadClass.Arterial
        : u >= this.urbanThreshold ? RoadClass.Local : RoadClass.Arterial;
      const lanes = cls === RoadClass.Arterial ? 2 : 1;
      this.net.connect(a, b, cls, lanes);
    };
    for (let i = 0; i <= cols; i++)
      for (let j = 0; j <= cols; j++) {
        const u = this.urbanization(i * bs, j * bs);
        if (i < cols) connect(nodeGrid[i][j], nodeGrid[i + 1][j], u);
        if (j < cols) connect(nodeGrid[i][j], nodeGrid[i][j + 1], u);
      }
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < cols; j++) {
        const cx = (i + 0.5) * bs, cz = (j + 0.5) * bs;
        const u = this.urbanization(cx, cz);
        if (u < this.urbanThreshold || nodeGrid[i][j] < 0) continue;
        this.fillBlock(i * bs, j * bs, bs, u);
      }
  }

  private fillBlock(ox: number, oz: number, bs: number, urban: number): void {
    const margin = 6;
    const parcel = 22 + this.rng() * 14;
    const perRow = Math.max(1, Math.floor((bs - margin * 2) / parcel));
    let placedParking = false;
    for (let a = 0; a < perRow; a++)
      for (let b = 0; b < perRow; b++) {
        const x = ox + margin + (a + 0.5) * ((bs - margin * 2) / perRow);
        const z = oz + margin + (b + 0.5) * ((bs - margin * 2) / perRow);
        // 各街区に最低1つ駐車場を置く(残りは空き地/広場のマスを転用)
        if (!placedParking && this.rng() < 0.35) {
          this.addParking(x, z, 18 + this.rng() * 10);
          placedParking = true;
          continue;
        }
        if (this.rng() < 0.1) continue; // 空き地
        const w = parcel * (0.55 + this.rng() * 0.3);
        const d = parcel * (0.55 + this.rng() * 0.3);
        const floors = Math.max(1, Math.round((urban ** 2) * 20 * (0.5 + this.rng())));
        const category = this.pickCategory(urban);
        const id = this.buildings.length;
        this.buildings.push({ id, x, z, width: w, depth: d, floors, category });
        this.registerPOIs(id, x, z, category, floors);
      }
    // 駐車場が置けなかった街区には端に必ず1つ追加
    if (!placedParking) this.addParking(ox + bs - margin - 8, oz + bs - margin - 8, 16);
  }

  private addParking(x: number, z: number, size: number): void {
    const capacity = Math.max(6, Math.floor(size * size / 25));
    const poiId = this.poi.add({
      category: POICategory.Parking, x, z, priceTier: 0.3, capacity, buildingId: -1,
    });
    const id = this.parkingLots.length;
    this.parkingLots.push({ id, poiId, x, z, width: size, depth: size, capacity });
  }

  private pickCategory(urban: number): POICategory {
    const r = this.rng();
    if (urban > 0.8) {
      if (r < 0.4) return POICategory.Work;
      if (r < 0.6) return POICategory.Retail;
      if (r < 0.75) return POICategory.Food;
      if (r < 0.85) return POICategory.Leisure;
      return POICategory.Home;
    }
    if (r < 0.6) return POICategory.Home;
    if (r < 0.75) return POICategory.Retail;
    if (r < 0.85) return POICategory.Food;
    if (r < 0.92) return POICategory.Work;
    return POICategory.Leisure;
  }
  private registerPOIs(buildingId: number, x: number, z: number, cat: POICategory, floors: number): void {
    const priceTier = clamp(0.3 + this.rng() * 0.5, 0, 1);
    const capacity = Math.max(4, floors * 6);
    this.poi.add({ category: cat, x, z, priceTier, capacity, buildingId });
    if (cat === POICategory.Home && this.rng() < 0.15)
      this.poi.add({ category: POICategory.Food, x, z, priceTier, capacity: 20, buildingId });
    // 商業/オフィスにも小売を併設して日中の目的地を増やす
    if ((cat === POICategory.Work || cat === POICategory.Leisure) && this.rng() < 0.3)
      this.poi.add({ category: POICategory.Retail, x, z, priceTier, capacity: 30, buildingId });
  }
}
