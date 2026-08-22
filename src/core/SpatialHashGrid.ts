/**
 * 一様グリッドによる空間ハッシュ。近接クエリ・最寄ノード検索の土台。
 */
export class SpatialHashGrid {
  private cells = new Map<number, number[]>();
  private readonly invCell: number;
  private readonly gridDim = 1 << 16;

  constructor(public readonly cellSize: number) {
    this.invCell = 1 / cellSize;
  }

  private key(cx: number, cz: number): number {
    return ((cx + (this.gridDim >> 1)) << 16) | (cz + (this.gridDim >> 1));
  }

  clear(): void { this.cells.clear(); }

  insert(id: number, x: number, z: number): void {
    const cx = Math.floor(x * this.invCell);
    const cz = Math.floor(z * this.invCell);
    const k = this.key(cx, cz);
    let bucket = this.cells.get(k);
    if (!bucket) { bucket = []; this.cells.set(k, bucket); }
    bucket.push(id);
  }

  queryNeighbors(x: number, z: number, radius: number, cb: (id: number) => void): void {
    const minCx = Math.floor((x - radius) * this.invCell);
    const maxCx = Math.floor((x + radius) * this.invCell);
    const minCz = Math.floor((z - radius) * this.invCell);
    const maxCz = Math.floor((z + radius) * this.invCell);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.cells.get(this.key(cx, cz));
        if (bucket) for (let i = 0; i < bucket.length; i++) cb(bucket[i]);
      }
    }
  }
}
