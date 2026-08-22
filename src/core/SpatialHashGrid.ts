/**
 * 一様グリッドによる空間ハッシュ。
 * 「半径R内の他エージェント」「カメラ近傍のオブジェクト」を O(1) 近傍で引くための土台。
 * 数十万エージェントの近接判定・回避・LOD判定の要になる。
 *
 * 実装方針:
 *  - セルは Int32Array のバケットではなく Map<cellKey, number[]> で十分(挿入が単純)。
 *    大規模化する場合はカウントソート方式の詰め直し(パッキング)へ差し替える。
 */
export class SpatialHashGrid {
  private cells = new Map<number, number[]>();
  private readonly invCell: number;
  // ワールド座標を非負のセル座標へ寄せるためのオフセット(km単位のワールドを想定)
  private readonly gridDim = 1 << 16; // 65536 セル幅まで対応

  constructor(public readonly cellSize: number) {
    this.invCell = 1 / cellSize;
  }

  private key(cx: number, cz: number): number {
    // 16bit x 16bit を1つの数値キーへ
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

  /**
   * (x,z) を中心に半径 radius 内の候補IDへ callback を適用する。
   * グリッドは矩形近傍を返すため、厳密な距離判定は呼び出し側で行う。
   */
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
