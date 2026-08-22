export class SpatialHashGrid {
  private cells = new Map<number, number[]>();
  private readonly invCell: number;
  private readonly gridDim = 1 << 16;
  constructor(public readonly cellSize: number) { this.invCell = 1 / cellSize; }
  private key(cx: number, cz: number): number {
    return ((cx + (this.gridDim >> 1)) << 16) | (cz + (this.gridDim >> 1));
  }
  clear(): void { this.cells.clear(); }
  insert(id: number, x: number, z: number): void {
    const cx = Math.floor(x * this.invCell), cz = Math.floor(z * this.invCell);
    const k = this.key(cx, cz);
    let b = this.cells.get(k);
    if (!b) { b = []; this.cells.set(k, b); }
    b.push(id);
  }
  queryNeighbors(x: number, z: number, radius: number, cb: (id: number) => void): void {
    const minCx = Math.floor((x - radius) * this.invCell), maxCx = Math.floor((x + radius) * this.invCell);
    const minCz = Math.floor((z - radius) * this.invCell), maxCz = Math.floor((z + radius) * this.invCell);
    for (let cx = minCx; cx <= maxCx; cx++)
      for (let cz = minCz; cz <= maxCz; cz++) {
        const b = this.cells.get(this.key(cx, cz));
        if (b) for (let i = 0; i < b.length; i++) cb(b[i]);
      }
  }
}
