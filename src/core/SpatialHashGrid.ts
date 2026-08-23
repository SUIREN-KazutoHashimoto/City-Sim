export class SpatialHashGrid {
  private cells = new Map<number, number[]>();
  private readonly invCell: number;
  private readonly gridDim = 1 << 16;
  constructor(public readonly cellSize: number) { this.invCell = 1 / cellSize; }
  private key(cx: number, cz: number): number { return ((cx + (this.gridDim >> 1)) << 16) | (cz + (this.gridDim >> 1)); }
  clear(): void { this.cells.clear(); }
  insert(id: number, x: number, z: number): void {
    const cx = Math.floor(x * this.invCell), cz = Math.floor(z * this.invCell);
    const k = this.key(cx, cz);
    let b = this.cells.get(k); if (!b) { b = []; this.cells.set(k, b); } b.push(id);
  }
  queryNeighbors(x: number, z: number, radius: number, cb: (id: number) => void): void {
    const minCx = Math.floor((x - radius) * this.invCell), maxCx = Math.floor((x + radius) * this.invCell);
    const minCz = Math.floor((z - radius) * this.invCell), maxCz = Math.floor((z + radius) * this.invCell);
    for (let cx = minCx; cx <= maxCx; cx++) for (let cz = minCz; cz <= maxCz; cz++) { const b = this.cells.get(this.key(cx, cz)); if (b) for (let i = 0; i < b.length; i++) cb(b[i]); }
  }

  /**
   * 半径を段階的に広げる検索。前段で走査済みのセルは再走査しない。
   * POI検索の 300→800→2000m のような拡大検索で同じセルを何度も読むのを防ぐ。
   * callbackがtrueを返した段階で、その半径の走査完了後に検索を打ち切る。
   */
  queryExpanding(x: number, z: number, radii: readonly number[], cb: (id: number) => void, shouldStop: () => boolean): void {
    let prevMinCx = 1, prevMaxCx = 0, prevMinCz = 1, prevMaxCz = 0;
    for (const radius of radii) {
      const minCx = Math.floor((x - radius) * this.invCell), maxCx = Math.floor((x + radius) * this.invCell);
      const minCz = Math.floor((z - radius) * this.invCell), maxCz = Math.floor((z + radius) * this.invCell);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          if (cx >= prevMinCx && cx <= prevMaxCx && cz >= prevMinCz && cz <= prevMaxCz) continue;
          const b = this.cells.get(this.key(cx, cz));
          if (b) for (let i = 0; i < b.length; i++) cb(b[i]);
        }
      }
      prevMinCx = minCx; prevMaxCx = maxCx; prevMinCz = minCz; prevMaxCz = maxCz;
      if (shouldStop()) return;
    }
  }
}
