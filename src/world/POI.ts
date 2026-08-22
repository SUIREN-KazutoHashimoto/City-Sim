import { dist2 } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';

export enum POICategory {
  Home = 0, Work = 1, Food = 2, Retail = 3, Leisure = 4, Health = 5, Education = 6,
}

export interface POI {
  id: number;
  category: POICategory;
  x: number;
  z: number;
  priceTier: number;
  capacity: number;
  occupancy: number;
  buildingId: number;
}

export class POIRegistry {
  private list: POI[] = [];
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

  poisInBuilding(buildingId: number): POI[] {
    return this.list.filter((p) => p.buildingId === buildingId);
  }

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
