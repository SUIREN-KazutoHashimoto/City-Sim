import { dist2 } from '../core/math';
import { SpatialHashGrid } from '../core/SpatialHashGrid';
import { powerCommercialCapacityFactor } from '../power/PowerRuntimeRegistry';
export enum POICategory { Home = 0, Work = 1, Food = 2, Retail = 3, Leisure = 4, Health = 5, Education = 6, Parking = 7 }
export interface POI {
  id: number; category: POICategory; x: number; z: number;
  priceTier: number; capacity: number; occupancy: number; buildingId: number;
  stock: number; maxStock: number;
}
export interface POISearchSnapshot {
  cellSize: number;
  x: Float32Array;
  z: Float32Array;
  priceTier: Float32Array;
  capacity: Int32Array;
  category: Uint8Array;
  occupancy: Int32Array;
}
export class POIRegistry {
  private list: POI[] = [];
  private grids = new Map<POICategory, SpatialHashGrid>();
  private occupancyMirror: Int32Array | null = null;
  private capacityMirror: Int32Array | null = null;
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
  poisInBuilding(buildingId: number): POI[] { return this.list.filter((p) => p.buildingId === buildingId && p.capacity > 0); }

  /** POI IDを維持したまま無効化し、Worker共有capacityにも即時反映する。 */
  disable(id: number): void {
    if (id < 0 || id >= this.list.length) return;
    const p = this.list[id]; p.capacity = 0; p.occupancy = 0; p.stock = 0; p.maxStock = 0;
    this.syncCapacity(id, 0); this.syncOccupancy(id, 0);
  }

  /**
   * 建物用途を特殊施設へ差し替える際、既存POI IDを詰め直さず無効化する。
   * Parking/Agent等が保持する既存IDを壊さないため、配列から削除はしない。
   */
  disableBuildingPOIs(buildingId: number): void {
    for (const p of this.list) if (p.buildingId === buildingId && p.capacity > 0) this.disable(p.id);
  }

  reserve(id: number): boolean {
    if (id < 0 || id >= this.list.length) return false;
    const p = this.list[id], effective = this.effectiveCapacity(p); if (effective <= 0 || p.occupancy >= effective) return false;
    p.occupancy++; this.syncOccupancy(id, p.occupancy); return true;
  }
  release(id: number): void {
    if (id < 0 || id >= this.list.length) return;
    const p = this.list[id]; p.occupancy = Math.max(0, p.occupancy - 1); this.syncOccupancy(id, p.occupancy);
  }
  hasRoom(id: number): boolean {
    if (id < 0 || id >= this.list.length) return false;
    const p = this.list[id], effective = this.effectiveCapacity(p);
    return effective > 0 && p.occupancy < effective;
  }
  findBest(category: POICategory, x: number, z: number, wealth: number): number {
    const grid = this.grids.get(category); if (!grid) return -1;
    let bestId = -1, bestCost = Infinity;
    const evaluate = (id: number) => {
      const p = this.list[id]; if (this.effectiveCapacity(p) <= p.occupancy) return;
      const d2 = dist2(x, z, p.x, p.z), pm = Math.abs(p.priceTier - wealth), cost = d2 + pm * pm * 400 * 400;
      if (cost < bestCost) { bestCost = cost; bestId = id; }
    };
    grid.queryExpanding(x, z, [300, 800, 2000, 5000], evaluate, () => bestId >= 0);
    return bestId;
  }
  findNearestFree(category: POICategory, x: number, z: number): number {
    const grid = this.grids.get(category); if (!grid) return -1;
    let bestId = -1, bestD = Infinity;
    const evaluate = (id: number) => {
      const p = this.list[id]; if (this.effectiveCapacity(p) <= p.occupancy) return;
      const d2 = dist2(x, z, p.x, p.z); if (d2 < bestD) { bestD = d2; bestId = id; }
    };
    grid.queryExpanding(x, z, [300, 800, 2000, 5000, 12000], evaluate, () => bestId >= 0);
    return bestId;
  }

  /** POI Worker用の静的検索データ＋共有capacity/occupancyを作る。 */
  createSearchSnapshot(): POISearchSnapshot {
    const n = this.list.length;
    const shared = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;
    const occBuffer: ArrayBufferLike = shared ? new SharedArrayBuffer(n * Int32Array.BYTES_PER_ELEMENT) : new ArrayBuffer(n * Int32Array.BYTES_PER_ELEMENT);
    const capBuffer: ArrayBufferLike = shared ? new SharedArrayBuffer(n * Int32Array.BYTES_PER_ELEMENT) : new ArrayBuffer(n * Int32Array.BYTES_PER_ELEMENT);
    const occupancy = new Int32Array(occBuffer), capacity = new Int32Array(capBuffer);
    const x = new Float32Array(n), z = new Float32Array(n), priceTier = new Float32Array(n), category = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.list[i]; x[i] = p.x; z[i] = p.z; priceTier[i] = p.priceTier; capacity[i] = p.capacity; category[i] = p.category; occupancy[i] = p.occupancy;
    }
    this.occupancyMirror = occupancy; this.capacityMirror = capacity;
    return { cellSize: this.cellSize, x, z, priceTier, capacity, category, occupancy };
  }

  private effectiveCapacity(p: POI): number {
    if (p.capacity <= 0) return 0;
    if (p.category !== POICategory.Food && p.category !== POICategory.Retail && p.category !== POICategory.Leisure) return p.capacity;
    return Math.max(0, Math.floor(p.capacity * powerCommercialCapacityFactor(this, p.buildingId)));
  }

  private syncOccupancy(id: number, value: number): void {
    const mirror = this.occupancyMirror; if (!mirror || id < 0 || id >= mirror.length) return;
    if (typeof SharedArrayBuffer !== 'undefined' && mirror.buffer instanceof SharedArrayBuffer) Atomics.store(mirror, id, value);
    else mirror[id] = value;
  }

  private syncCapacity(id: number, value: number): void {
    const mirror = this.capacityMirror; if (!mirror || id < 0 || id >= mirror.length) return;
    if (typeof SharedArrayBuffer !== 'undefined' && mirror.buffer instanceof SharedArrayBuffer) Atomics.store(mirror, id, value);
    else mirror[id] = value;
  }
}
