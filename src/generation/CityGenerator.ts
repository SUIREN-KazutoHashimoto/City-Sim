import { ValueNoise2D } from './Noise';
import { RoadNetwork, RoadClass } from '../traffic/RoadNetwork';
import { POIRegistry, POICategory } from '../world/POI';
import { makeRng, clamp } from '../core/math';

export interface CityConfig {
  seed: number;
  /** ワールドの一辺(メートル)。10km² なら sqrt(10e6) ≈ 3162m。 */
  sizeMeters: number;
  /** 市街地区画にしたい面積比の目標(0..1)。閾値を自動調整して近づける。 */
  urbanRatioTarget: number;
  /** 街区(ブロック)の一辺のおおよそのメートル。 */
  blockSize: number;
}

export interface Building {
  id: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  floors: number;
  category: POICategory;
}

/**
 * ============================================================================
 *  都市生成パイプライン(粗いが拡張可能な骨格)
 * ============================================================================
 *  1. 都市化度マップ(fbm)を作り、目標面積比になる閾値を分位点で決定
 *  2. グリッド状に候補道路を敷き、都市化セルは密(Local多め)、郊外は疎に
 *  3. 街区を区画分割 → 各区画に建物を配置し、用途(POI)を登録
 *
 * 実務では「テンソル場によるストリートグラフ生成(CityEngine系)」へ発展させると
 * より自然な放射・環状道路になる。ここではまず動く基盤としてグリッド系で示す。
 */
export class CityGenerator {
  readonly net = new RoadNetwork();
  readonly poi = new POIRegistry();
  readonly buildings: Building[] = [];
  urbanThreshold = 0.5;

  private noise: ValueNoise2D;
  private rng: () => number;

  constructor(private cfg: CityConfig) {
    this.noise = new ValueNoise2D(cfg.seed);
    this.rng = makeRng(cfg.seed ^ 0x9e3779b9);
  }

  /** 都市化度 0..1。標高が高すぎる/水域は将来ここで抑制する。 */
  private urbanization(x: number, z: number): number {
    const s = 1 / 1400; // 都市の塊のスケール
    const core = this.noise.fbm(x * s, z * s, 5);
    // 中心に向かって都市化を強める(中心市街地バイアス)
    const cx = this.cfg.sizeMeters / 2;
    const dc = Math.hypot(x - cx, z - cx) / (this.cfg.sizeMeters * 0.75);
    return clamp(core * 1.15 - dc * 0.5, 0, 1);
  }

  /** 目標市街地比に合う閾値を、格子サンプリングの分位点から決める。 */
  private calibrateThreshold(): void {
    const N = 64;
    const samples: number[] = [];
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const x = (i / N) * this.cfg.sizeMeters;
        const z = (j / N) * this.cfg.sizeMeters;
        samples.push(this.urbanization(x, z));
      }
    samples.sort((a, b) => a - b);
    const idx = clamp(Math.floor((1 - this.cfg.urbanRatioTarget) * samples.length), 0, samples.length - 1);
    this.urbanThreshold = samples[idx];
  }

  generate(): void {
    this.calibrateThreshold();
    const size = this.cfg.sizeMeters;
    const bs = this.cfg.blockSize;
    const cols = Math.floor(size / bs);

    // --- 交差点ノードを格子状に生成(都市化セルのみ) ---
    // nodeGrid[i][j] = ノードID or -1
    const nodeGrid: number[][] = [];
    for (let i = 0; i <= cols; i++) {
      nodeGrid[i] = [];
      for (let j = 0; j <= cols; j++) {
        const x = i * bs, z = j * bs;
        const u = this.urbanization(x, z);
        // 郊外は幹線だけ通す(間引き)。都市部は全交差点を作る。
        const keep = u >= this.urbanThreshold || (i % 3 === 0 && j % 3 === 0);
        nodeGrid[i][j] = keep ? this.net.addNode(x, z, u >= this.urbanThreshold) : -1;
      }
    }

    // --- 隣接ノードを道路で接続 ---
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

    // --- 各街区(4隅が揃うセル)に建物とPOIを配置 ---
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < cols; j++) {
        const cx = (i + 0.5) * bs, cz = (j + 0.5) * bs;
        const u = this.urbanization(cx, cz);
        if (u < this.urbanThreshold) continue; // 市街地区画のみ建てる
        if (nodeGrid[i][j] < 0) continue;
        this.fillBlock(i * bs, j * bs, bs, u);
      }
  }

  /** 1街区を区画分割して建物を並べる。都市化度で用途と高さの分布を変える。 */
  private fillBlock(ox: number, oz: number, bs: number, urban: number): void {
    const margin = 6;      // 道路からのセットバック
    const parcel = 22 + this.rng() * 14;
    const perRow = Math.max(1, Math.floor((bs - margin * 2) / parcel));
    for (let a = 0; a < perRow; a++)
      for (let b = 0; b < perRow; b++) {
        if (this.rng() < 0.12) continue; // 空き地/広場
        const x = ox + margin + (a + 0.5) * ((bs - margin * 2) / perRow);
        const z = oz + margin + (b + 0.5) * ((bs - margin * 2) / perRow);
        const w = parcel * (0.55 + this.rng() * 0.3);
        const d = parcel * (0.55 + this.rng() * 0.3);
        // 都市化度が高いほど高層・商業/オフィス寄り、低いほど住宅
        const floors = Math.max(1, Math.round((urban ** 2) * 20 * (0.5 + this.rng())));
        const category = this.pickCategory(urban);
        const id = this.buildings.length;
        this.buildings.push({ id, x, z, width: w, depth: d, floors, category });
        this.registerPOIs(id, x, z, category, floors);
      }
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

  /** 建物の用途に応じてPOIを登録(1棟に複数POIが入りうる)。 */
  private registerPOIs(buildingId: number, x: number, z: number, cat: POICategory, floors: number): void {
    const priceTier = clamp(0.3 + this.rng() * 0.5, 0, 1);
    const capacity = Math.max(4, floors * 6);
    this.poi.add({ category: cat, x, z, priceTier, capacity, buildingId });
    // 住宅・オフィス街区にも飲食が混ざる現実性を軽く付与
    if (cat === POICategory.Home && this.rng() < 0.15)
      this.poi.add({ category: POICategory.Food, x, z, priceTier, capacity: 20, buildingId });
  }
}
