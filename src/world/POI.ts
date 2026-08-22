import { dist2 } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';

/**
 * POI(Point of Interest) = 建物内の「用途を持つ場所」。
 * 歩行者の目的地検索の対象。住居・職場・飲食・娯楽・商業などのカテゴリを持つ。
 * CityGenerator が建物を生成する際に、用途に応じてPOIを登録していく。
 */
export enum POICategory {
  Home = 0,
  Work = 1,
  Food = 2,
  Retail = 3,
  Leisure = 4,
  Health = 5,
  Education = 6,
}

export interface POI {
  id: number;
  category: POICategory;
  x: number;
  z: number;
  /** 価格帯 0..1(wealthとのマッチングに使う) */
  priceTier: number;
  /** 収容容量。満員なら別候補を探す等の拡張点 */
  capacity: number;
  occupancy: number;
  buildingId: number;
}

export class POIRegistry {
  private list: POI[] = [];
  // カテゴリ別の空間インデックス(近傍検索用)
  private grids = new Map<POICategory, SpatialHashGrid>();

  constructor(private readonly cellSize = 200) {}

  add(p: Omit<POI, 'id' | 'occupancy'>): number {
    const id = this.list.length;
    const poi: POI = { ...p, id, occupancy: 0 };
    this.list.push(poi);
    let g = this.grids.get(p.category);
    if (!g) { g = new SpatialHashGrid(this.cellSize); this.grids.set(p.category, g); }
    g.insert(id, p.x, p.z);
    return id;
  }

  get(id: number): POI { return this.list[id]; }
  get size(): number { return this.list.length; }

  /**
   * カテゴリ内で「近くて価格帯が合う」POIを1つ選ぶ。
   * 探索半径を段階的に広げ、見つからなければ全域から最良を返す。
   */
  findBest(category: POICategory, x: number, z: number, wealth: number): number {
    const grid = this.grids.get(category);
    if (!grid) return -1;
    let bestId = -1;
    let bestCost = Infinity;
    const evaluate = (id: number) => {
      const p = this.list[id];
      if (p.occupancy >= p.capacity) return;
      const d2 = dist2(x, z, p.x, p.z);
      const priceMismatch = Math.abs(p.priceTier - wealth);
      // 距離(m²)と価格ミスマッチの重み付き合成
      const cost = d2 + priceMismatch * priceMismatch * 400 * 400;
      if (cost < bestCost) { bestCost = cost; bestId = id; }
    };
    for (const r of [300, 800, 2000]) {
      grid.queryNeighbors(x, z, r, evaluate);
      if (bestId >= 0) break;
    }
    return bestId;
  }
}
