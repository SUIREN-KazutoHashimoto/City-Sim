import { RoadClass, RoadNetwork, roadWidth } from '../traffic/RoadNetwork';

export type FrontageSide = 'north' | 'south' | 'west' | 'east';

export interface BlockFrontage {
  side: FrontageSide;
  roadClass: RoadClass;
  lanes: number;
  coverage: number;
}

export interface UrbanBlock {
  id: number;
  minI: number;
  minJ: number;
  maxI: number;
  maxJ: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  cellCount: number;
  frontages: BlockFrontage[];
}

export interface LandParcel {
  id: number;
  blockId: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  frontage: FrontageSide;
  roadClass: RoadClass;
  roadLanes: number;
}

const NONE = 255;
function roadRank(cls: number): number {
  if (cls === RoadClass.Highway) return 0;
  if (cls === RoadClass.Arterial) return 1;
  if (cls === RoadClass.Collector) return 2;
  if (cls === RoadClass.Local) return 3;
  if (cls === RoadClass.Path) return 4;
  return 99;
}

/**
 * Axis-aligned road network -> road-bounded blocks -> frontage parcels.
 * Phase 2 deliberately targets the current orthogonal road generator.
 * A later phase can replace this with a general polygon subdivision without changing CityGenerator's parcel consumer.
 */
export class BlockParcelLayout {
  private readonly verticalClass: Uint8Array;
  private readonly verticalLanes: Uint8Array;
  private readonly horizontalClass: Uint8Array;
  private readonly horizontalLanes: Uint8Array;

  constructor(
    private readonly net: RoadNetwork,
    private readonly blockSize: number,
    private readonly cols: number,
  ) {
    this.verticalClass = new Uint8Array((cols + 1) * cols).fill(NONE);
    this.verticalLanes = new Uint8Array((cols + 1) * cols);
    this.horizontalClass = new Uint8Array(cols * (cols + 1)).fill(NONE);
    this.horizontalLanes = new Uint8Array(cols * (cols + 1));
    this.rasterizeRoads();
  }

  extractBlocks(isBuildable: (x: number, z: number) => boolean): UrbanBlock[] {
    const eligible = new Uint8Array(this.cols * this.cols);
    for (let j = 0; j < this.cols; j++) for (let i = 0; i < this.cols; i++) {
      const x = (i + 0.5) * this.blockSize, z = (j + 0.5) * this.blockSize;
      if (isBuildable(x, z)) eligible[this.cellIndex(i, j)] = 1;
    }

    const component = new Int32Array(eligible.length).fill(-1);
    const components: number[][] = [];
    const queue = new Int32Array(eligible.length);

    for (let j = 0; j < this.cols; j++) for (let i = 0; i < this.cols; i++) {
      const start = this.cellIndex(i, j);
      if (!eligible[start] || component[start] >= 0) continue;
      const cid = components.length, cells: number[] = [];
      let head = 0, tail = 0; queue[tail++] = start; component[start] = cid;
      while (head < tail) {
        const cur = queue[head++], ci = cur % this.cols, cj = Math.floor(cur / this.cols);
        cells.push(cur);
        const visit = (ni: number, nj: number, blocked: boolean): void => {
          if (blocked || ni < 0 || nj < 0 || ni >= this.cols || nj >= this.cols) return;
          const next = this.cellIndex(ni, nj);
          if (!eligible[next] || component[next] >= 0) return;
          component[next] = cid; queue[tail++] = next;
        };
        visit(ci - 1, cj, this.verticalRoadClass(ci, cj) !== NONE);
        visit(ci + 1, cj, this.verticalRoadClass(ci + 1, cj) !== NONE);
        visit(ci, cj - 1, this.horizontalRoadClass(ci, cj) !== NONE);
        visit(ci, cj + 1, this.horizontalRoadClass(ci, cj + 1) !== NONE);
      }
      components.push(cells);
    }

    const blocks: UrbanBlock[] = [];
    for (const cells of components) this.decomposeComponent(cells, blocks);
    return blocks;
  }

  subdivide(
    block: UrbanBlock,
    targetFrontage: number,
    targetDepth: number,
    rng: () => number,
    nextParcelId: () => number,
  ): LandParcel[] {
    if (block.frontages.length === 0) return [];
    const frontageBySide = new Map<FrontageSide, BlockFrontage>();
    for (const f of block.frontages) frontageBySide.set(f.side, f);

    const minX = block.minI * this.blockSize, maxX = (block.maxI + 1) * this.blockSize;
    const minZ = block.minJ * this.blockSize, maxZ = (block.maxJ + 1) * this.blockSize;
    const edgeInset = (side: FrontageSide): number => {
      const f = frontageBySide.get(side);
      return f ? roadWidth(Math.max(1, f.lanes)) / 2 + 3.0 : 2.5;
    };
    const ix0 = minX + edgeInset('west'), ix1 = maxX - edgeInset('east');
    const iz0 = minZ + edgeInset('north'), iz1 = maxZ - edgeInset('south');
    const usableW = ix1 - ix0, usableD = iz1 - iz0;
    if (usableW < 10 || usableD < 10) return [];

    const hasN = frontageBySide.has('north'), hasS = frontageBySide.has('south');
    const hasW = frontageBySide.has('west'), hasE = frontageBySide.has('east');
    const northDepth = hasN ? this.stripDepth(targetDepth, usableD, rng) : 0;
    const southDepth = hasS ? this.stripDepth(targetDepth, usableD, rng) : 0;
    const westDepth = hasW ? this.stripDepth(targetDepth, usableW, rng) : 0;
    const eastDepth = hasE ? this.stripDepth(targetDepth, usableW, rng) : 0;
    const parcels: LandParcel[] = [];

    const splitHorizontal = (side: 'north' | 'south', depth: number): void => {
      if (depth <= 0) return;
      const f = frontageBySide.get(side); if (!f) return;
      const z = side === 'north' ? iz0 + depth / 2 : iz1 - depth / 2;
      this.splitRun(ix0, ix1, targetFrontage, rng, (x0, x1) => {
        parcels.push({
          id: nextParcelId(), blockId: block.id, x: (x0 + x1) / 2, z,
          width: x1 - x0, depth, frontage: side, roadClass: f.roadClass, roadLanes: f.lanes,
        });
      });
    };

    const splitVertical = (side: 'west' | 'east', depth: number): void => {
      if (depth <= 0) return;
      const f = frontageBySide.get(side); if (!f) return;
      const z0 = iz0 + northDepth, z1 = iz1 - southDepth;
      if (z1 - z0 < 10) return;
      const x = side === 'west' ? ix0 + depth / 2 : ix1 - depth / 2;
      this.splitRun(z0, z1, targetFrontage, rng, (a, b) => {
        parcels.push({
          id: nextParcelId(), blockId: block.id, x, z: (a + b) / 2,
          width: depth, depth: b - a, frontage: side, roadClass: f.roadClass, roadLanes: f.lanes,
        });
      });
    };

    splitHorizontal('north', northDepth);
    splitHorizontal('south', southDepth);
    splitVertical('west', westDepth);
    splitVertical('east', eastDepth);
    return parcels;
  }

  private rasterizeRoads(): void {
    const done = new Set<string>();
    for (const e of this.net.edges) {
      const key = e.from < e.to ? `${e.from}_${e.to}` : `${e.to}_${e.from}`;
      if (done.has(key)) continue; done.add(key);
      if (e.roadClass === RoadClass.Path) continue;
      const a = this.net.nodes[e.from], b = this.net.nodes[e.to];
      const dx = b.x - a.x, dz = b.z - a.z;
      if (Math.abs(dx) < 0.01 && Math.abs(dz) > 0.01) {
        const k = Math.round(a.x / this.blockSize);
        if (k < 0 || k > this.cols) continue;
        const j0 = Math.max(0, Math.floor(Math.min(a.z, b.z) / this.blockSize + 1e-4));
        const j1 = Math.min(this.cols, Math.ceil(Math.max(a.z, b.z) / this.blockSize - 1e-4));
        for (let j = j0; j < j1; j++) this.markVertical(k, j, e.roadClass, e.lanes);
      } else if (Math.abs(dz) < 0.01 && Math.abs(dx) > 0.01) {
        const k = Math.round(a.z / this.blockSize);
        if (k < 0 || k > this.cols) continue;
        const i0 = Math.max(0, Math.floor(Math.min(a.x, b.x) / this.blockSize + 1e-4));
        const i1 = Math.min(this.cols, Math.ceil(Math.max(a.x, b.x) / this.blockSize - 1e-4));
        for (let i = i0; i < i1; i++) this.markHorizontal(i, k, e.roadClass, e.lanes);
      }
    }
  }

  private decomposeComponent(cells: number[], blocks: UrbanBlock[]): void {
    const available = new Uint8Array(this.cols * this.cols);
    for (const c of cells) available[c] = 1;
    for (const c of cells) {
      if (!available[c]) continue;
      const i0 = c % this.cols, j0 = Math.floor(c / this.cols);
      let i1 = i0;
      while (i1 + 1 < this.cols && available[this.cellIndex(i1 + 1, j0)] && this.verticalRoadClass(i1 + 1, j0) === NONE) i1++;
      let j1 = j0;
      rowLoop: while (j1 + 1 < this.cols) {
        for (let i = i0; i <= i1; i++) {
          if (!available[this.cellIndex(i, j1 + 1)] || this.horizontalRoadClass(i, j1 + 1) !== NONE) break rowLoop;
        }
        for (let i = i0 + 1; i <= i1; i++) if (this.verticalRoadClass(i, j1 + 1) !== NONE) break rowLoop;
        j1++;
      }
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) available[this.cellIndex(i, j)] = 0;
      blocks.push(this.makeBlock(blocks.length, i0, j0, i1, j1));
    }
  }

  private makeBlock(id: number, minI: number, minJ: number, maxI: number, maxJ: number): UrbanBlock {
    const frontages: BlockFrontage[] = [];
    const collect = (side: FrontageSide, values: Array<[number, number]>): void => {
      let roadSegments = 0, strongest = NONE, lanes = 1;
      for (const [cls, lane] of values) {
        if (cls === NONE) continue;
        roadSegments++;
        if (strongest === NONE || roadRank(cls) < roadRank(strongest)) strongest = cls;
        lanes = Math.max(lanes, lane);
      }
      if (roadSegments > 0) frontages.push({
        side,
        roadClass: strongest as RoadClass,
        lanes,
        coverage: roadSegments / Math.max(1, values.length),
      });
    };
    const north: Array<[number, number]> = [], south: Array<[number, number]> = [];
    for (let i = minI; i <= maxI; i++) {
      north.push([this.horizontalRoadClass(i, minJ), this.horizontalRoadLanes(i, minJ)]);
      south.push([this.horizontalRoadClass(i, maxJ + 1), this.horizontalRoadLanes(i, maxJ + 1)]);
    }
    const west: Array<[number, number]> = [], east: Array<[number, number]> = [];
    for (let j = minJ; j <= maxJ; j++) {
      west.push([this.verticalRoadClass(minI, j), this.verticalRoadLanes(minI, j)]);
      east.push([this.verticalRoadClass(maxI + 1, j), this.verticalRoadLanes(maxI + 1, j)]);
    }
    collect('north', north); collect('south', south); collect('west', west); collect('east', east);
    const width = (maxI - minI + 1) * this.blockSize, depth = (maxJ - minJ + 1) * this.blockSize;
    return {
      id, minI, minJ, maxI, maxJ,
      x: (minI * this.blockSize + (maxI + 1) * this.blockSize) / 2,
      z: (minJ * this.blockSize + (maxJ + 1) * this.blockSize) / 2,
      width, depth, cellCount: (maxI - minI + 1) * (maxJ - minJ + 1), frontages,
    };
  }

  private stripDepth(target: number, available: number, rng: () => number): number {
    return Math.min(available * 0.46, Math.max(12, target * (0.88 + rng() * 0.22)));
  }

  private splitRun(start: number, end: number, target: number, rng: () => number, emit: (a: number, b: number) => void): void {
    const length = end - start; if (length < 10) return;
    const n = Math.max(1, Math.min(24, Math.round(length / Math.max(12, target))));
    const weights = new Float32Array(n); let sum = 0;
    for (let i = 0; i < n; i++) { weights[i] = 0.82 + rng() * 0.36; sum += weights[i]; }
    let p = start;
    for (let i = 0; i < n; i++) {
      const q = i === n - 1 ? end : p + length * (weights[i] / sum);
      if (q - p >= 8) emit(p, q);
      p = q;
    }
  }

  private markVertical(i: number, j: number, cls: RoadClass, lanes: number): void {
    if (j < 0 || j >= this.cols) return;
    const idx = i * this.cols + j, current = this.verticalClass[idx];
    if (current === NONE || roadRank(cls) < roadRank(current)) this.verticalClass[idx] = cls;
    this.verticalLanes[idx] = Math.max(this.verticalLanes[idx], lanes);
  }
  private markHorizontal(i: number, j: number, cls: RoadClass, lanes: number): void {
    if (i < 0 || i >= this.cols) return;
    const idx = j * this.cols + i, current = this.horizontalClass[idx];
    if (current === NONE || roadRank(cls) < roadRank(current)) this.horizontalClass[idx] = cls;
    this.horizontalLanes[idx] = Math.max(this.horizontalLanes[idx], lanes);
  }
  private verticalRoadClass(i: number, j: number): number {
    if (i < 0 || i > this.cols || j < 0 || j >= this.cols) return NONE;
    return this.verticalClass[i * this.cols + j];
  }
  private verticalRoadLanes(i: number, j: number): number {
    if (i < 0 || i > this.cols || j < 0 || j >= this.cols) return 0;
    return this.verticalLanes[i * this.cols + j];
  }
  private horizontalRoadClass(i: number, j: number): number {
    if (i < 0 || i >= this.cols || j < 0 || j > this.cols) return NONE;
    return this.horizontalClass[j * this.cols + i];
  }
  private horizontalRoadLanes(i: number, j: number): number {
    if (i < 0 || i >= this.cols || j < 0 || j > this.cols) return 0;
    return this.horizontalLanes[j * this.cols + i];
  }
  private cellIndex(i: number, j: number): number { return j * this.cols + i; }
}
