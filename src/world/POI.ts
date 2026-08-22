import { dist2 } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
export enum POICategory { Home = 0, Work = 1, Food = 2, Retail = 3, Leisure = 4, Health = 5, Education = 6, Parking = 7 }
export interface POI {
  id: number; category: POICategory; x: number; z: number;
  priceTier: number; capacity: number; occupancy: number; buildingId: number;
  stock: number; maxStock: number;
}
export class POIRegistry {
  private list: POI[] = [];
  private grids = new Map<POICategory, SpatialHashGrid>();
  constructor(private readonly cellSize = 200) {}
  add(p: Omit<POI, 'id' | 'occupancy' | 'stock' | 'maxStock'> & Partial<Pick<POI, 'stock' | 'maxStock'>>): number {
    const id = this.list.length;
    this.list.push({ ...p, id, occupancy: 0, stock: p.stock ?? 0, maxStock: p.maxStock ?? 0 });
    let g = this.grids.get(p.category); if (!g) { g = new SpatialHashGrid(this.cellSize); this.grids.set(p.category, g); }
    g.insert(id, p.x, p.z);
    return id;
  }
  get(id: number): POI { return this.list[id]; }
  get size(): number { return this.list.length; }
  all(): POI[] { return this.list; }
  poisInBuilding(buildingId: number): POI[] { return this.list.filter((p) => p.buildingId === buildingId); }
  reserve(id: number): boolean { if (id < 0 || id >= this.list.length) return false; const p = this.list[id]; if (p.occupancy >= p.capacity) return false; p.occupancy++; return true; }
  release(id: number): void { if (id < 0 || id >= this.list.length) return; const p = this.list[id]; p.occupancy = Math.max(0, p.occupancy - 1); }
  hasRoom(id: number): boolean { return id >= 0 && id < this.list.length && this.list[id].occupancy < this.list[id].capacity; }
  findBest(category: POICategory, x: number, z: number, wealth: number): number {
    const grid = this.grids.get(category); if (!grid) return -1;
    let bestId = -1, bestCost = Infinity;
    const evaluate = (id: number) => { const p = this.list[id]; if (p.occupancy >= p.capacity) return; const d2 = dist2(x, z, p.x, p.z); const pm = Math.abs(p.priceTier - wealth); const cost = d2 + pm * pm * 400 * 400; if (cost < bestCost) { bestCost = cost; bestId = id; } };
    for (const r of [300, 800, 2000, 5000]) { grid.queryNeighbors(x, z, r, evaluate); if (bestId >= 0) break; }
    return bestId;
  }
  findNearestFree(category: POICategory, x: number, z: number): number {
    const grid = this.grids.get(category); if (!grid) return -1;
    let bestId = -1, bestD = Infinity;
    const evaluate = (id: number) => { const p = this.list[id]; if (p.occupancy >= p.capacity) return; const d2 = dist2(x, z, p.x, p.z); if (d2 < bestD) { bestD = d2; bestId = id; } };
    for (const r of [300, 800, 2000, 5000, 12000]) { grid.queryNeighbors(x, z, r, evaluate); if (bestId >= 0) break; }
    return bestId;
  }
}
