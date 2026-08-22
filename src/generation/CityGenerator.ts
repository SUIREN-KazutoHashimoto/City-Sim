import { ValueNoise2D } from './Noise';
import { RoadNetwork, RoadClass } from '../traffic/RoadNetwork';
import { POIRegistry, POICategory } from '../world/POI';
import { makeRng, clamp } from '../core/math';
export interface CityConfig { seed: number; sizeMeters: number; urbanRatioTarget: number; blockSize: number; }
export interface Building { id: number; x: number; z: number; width: number; depth: number; floors: number; category: POICategory; }
export interface ParkingLot { id: number; poiId: number; x: number; z: number; width: number; depth: number; capacity: number; slotX: Float32Array; slotZ: Float32Array; free: Uint8Array; }
export class CityGenerator {
  readonly net = new RoadNetwork(); readonly poi = new POIRegistry();
  readonly buildings: Building[] = []; readonly parkingLots: ParkingLot[] = [];
  readonly lotByPOI = new Map<number, number>();
  readonly gateNodes: number[] = [];
  readonly sizeMeters: number; urbanThreshold = 0.5;
  private noise: ValueNoise2D; private rng: () => number;
  constructor(private cfg: CityConfig) { this.noise = new ValueNoise2D(cfg.seed); this.rng = makeRng(cfg.seed ^ 0x9e3779b9); this.sizeMeters = cfg.sizeMeters; }
  private urbanization(x: number, z: number): number {
    const s = 1 / 1400; const core = this.noise.fbm(x * s, z * s, 5);
    const cx = this.cfg.sizeMeters / 2; const dc = Math.hypot(x - cx, z - cx) / (this.cfg.sizeMeters * 0.75);
    return clamp(core * 1.15 - dc * 0.5, 0, 1);
  }
  private calibrateThreshold(): void {
    const N = 64; const samples: number[] = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) samples.push(this.urbanization((i / N) * this.cfg.sizeMeters, (j / N) * this.cfg.sizeMeters));
    samples.sort((a, b) => a - b); const idx = clamp(Math.floor((1 - this.cfg.urbanRatioTarget) * samples.length), 0, samples.length - 1); this.urbanThreshold = samples[idx];
  }
  generate(): void {
    this.calibrateThreshold();
    const size = this.cfg.sizeMeters, bs = this.cfg.blockSize, cols = Math.floor(size / bs);
    // ノード生成: 市街地は全格子点、郊外は3格子おきの疎な背景格子。
    const nodeGrid: number[][] = [];
    for (let i = 0; i <= cols; i++) { nodeGrid[i] = []; for (let j = 0; j <= cols; j++) { const x = i * bs, z = j * bs; const u = this.urbanization(x, z); const keep = u >= this.urbanThreshold || (i % 3 === 0 && j % 3 === 0); nodeGrid[i][j] = keep ? this.net.addNode(x, z, u >= this.urbanThreshold) : -1; } }
    // ★接続の要: 各行・各列で「連続する採用ノード」を順に結ぶ(欠損セルをまたいで格子線上に道路を張る)。
    // これで疎な背景格子も連結し、道路は必ず格子線上=建物を貫かない。孤立島が生じないためテレポートも消える。
    const maxSpan = bs * 3.5; // これ以上離れた採用ノードは直結しない(背景格子で連結を担保)
    const connectSpan = (a: number, b: number) => {
      if (a < 0 || b < 0) return;
      const na = this.net.nodes[a], nb = this.net.nodes[b];
      if (Math.hypot(nb.x - na.x, nb.z - na.z) > maxSpan) return; // 長すぎる郊外直結は張らない
      const ux = this.urbanization((na.x + nb.x) / 2, (na.z + nb.z) / 2);
      const cls = ux >= this.urbanThreshold ? RoadClass.Local : RoadClass.Arterial;
      this.net.connect(a, b, cls, cls === RoadClass.Arterial ? 2 : 1);
    };
    for (let j = 0; j <= cols; j++) { let prev = -1; for (let i = 0; i <= cols; i++) { const n = nodeGrid[i][j]; if (n < 0) continue; if (prev >= 0) connectSpan(prev, n); prev = n; } }
    for (let i = 0; i <= cols; i++) { let prev = -1; for (let j = 0; j <= cols; j++) { const n = nodeGrid[i][j]; if (n < 0) continue; if (prev >= 0) connectSpan(prev, n); prev = n; } }
    this.ensureConnected(nodeGrid, cols);
    // 建物・POI
    for (let i = 0; i < cols; i++) for (let j = 0; j < cols; j++) { const cx = (i + 0.5) * bs, cz = (j + 0.5) * bs; const u = this.urbanization(cx, cz); if (u < this.urbanThreshold || nodeGrid[i][j] < 0) continue; this.fillBlock(i * bs, j * bs, bs, u); }
    this.buildGates(nodeGrid, cols, bs, size);
  }
  /**
   * スパン上限で分断が残った場合の補修。連結成分を求め、小さい成分を本土へ
   * 「格子線に沿ったL字(横→縦)」で接続する。斜め直線を使わないので建物を貫かない。
   */
  private ensureConnected(nodeGrid: number[][], cols: number): void {
    const N = this.net.nodes.length; if (N === 0) return;
    const parent = new Int32Array(N); for (let i = 0; i < N; i++) parent[i] = i;
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const e of this.net.edges) { const ra = find(e.from), rb = find(e.to); if (ra !== rb) parent[ra] = rb; }
    const comps = new Map<number, number[]>(); for (let i = 0; i < N; i++) { const r = find(i); let a = comps.get(r); if (!a) { a = []; comps.set(r, a); } a.push(i); }
    const groups = [...comps.values()]; if (groups.length <= 1) return;
    groups.sort((a, b) => b.length - a.length);
    // ノード座標→グリッド添字の逆引き(格子ノードのみ)
    const nodeToGrid = new Map<number, { i: number; j: number }>();
    for (let i = 0; i <= cols; i++) for (let j = 0; j <= cols; j++) { const n = nodeGrid[i][j]; if (n >= 0) nodeToGrid.set(n, { i, j }); }
    const mainRoot = find(groups[0][0]);
    for (let g = 1; g < groups.length; g++) {
      const island = groups[g];
      // 島の各ノードから、本土ノードへ最短L字で繋げる候補を探す
      let best: { a: number; b: number; d: number } | null = null;
      for (const a of island) {
        const ga = nodeToGrid.get(a); if (!ga) continue;
        // 同じ行/列で最も近い本土格子ノードを探す
        for (const m of groups[0]) {
          const gm = nodeToGrid.get(m); if (!gm) continue;
          if (gm.i !== ga.i && gm.j !== ga.j) continue; // 同一行 or 同一列のみ(L字の一辺)
          const d = Math.abs(gm.i - ga.i) + Math.abs(gm.j - ga.j);
          if (!best || d < best.d) best = { a, b: m, d };
        }
      }
      if (best) {
        this.net.connect(best.a, best.b, RoadClass.Arterial, 2);
        for (const n of island) parent[find(n)] = mainRoot;
      }
    }
  }
  /** 外部接続道路(ゲート)。四辺の縁ノードから盤外へ短いハイウェイを1本ずつ伸ばす(地上)。 */
  private buildGates(nodeGrid: number[][], cols: number, bs: number, size: number): void {
    const ext = 120;
    const tryGate = (edgeNode: number, gx: number, gz: number) => { if (edgeNode < 0) return; const g = this.net.addNode(gx, gz, false); this.net.connect(edgeNode, g, RoadClass.Highway, 2); this.gateNodes.push(g); };
    const midCol = Math.round(cols / 2);
    const findEdgeNode = (fixed: 'i' | 'j', fixedIdx: number, center: number): number => { for (let d = 0; d <= cols; d++) for (const s of [center - d, center + d]) { if (s < 0 || s > cols) continue; const n = fixed === 'i' ? nodeGrid[fixedIdx][s] : nodeGrid[s][fixedIdx]; if (n >= 0) return n; } return -1; };
    tryGate(findEdgeNode('i', 0, midCol), -ext, midCol * bs);
    tryGate(findEdgeNode('i', cols, midCol), size + ext, midCol * bs);
    tryGate(findEdgeNode('j', 0, midCol), midCol * bs, -ext);
    tryGate(findEdgeNode('j', cols, midCol), midCol * bs, size + ext);
  }
  private fillBlock(ox: number, oz: number, bs: number, urban: number): void {
    const margin = 6, parcel = 22 + this.rng() * 14; const perRow = Math.max(1, Math.floor((bs - margin * 2) / parcel)); let placedParking = false;
    for (let a = 0; a < perRow; a++) for (let b = 0; b < perRow; b++) {
      const x = ox + margin + (a + 0.5) * ((bs - margin * 2) / perRow); const z = oz + margin + (b + 0.5) * ((bs - margin * 2) / perRow);
      if (!placedParking && this.rng() < 0.35) { this.addParking(x, z, 18 + this.rng() * 10); placedParking = true; continue; }
      if (this.rng() < 0.1) continue;
      const w = parcel * (0.55 + this.rng() * 0.3), d = parcel * (0.55 + this.rng() * 0.3);
      const floors = Math.max(1, Math.round((urban ** 2) * 20 * (0.5 + this.rng())));
      const category = this.pickCategory(urban); const id = this.buildings.length;
      this.buildings.push({ id, x, z, width: w, depth: d, floors, category }); this.registerPOIs(id, x, z, category, floors);
    }
    if (!placedParking) this.addParking(ox + bs - margin - 8, oz + bs - margin - 8, 16);
  }
  private addParking(x: number, z: number, size: number): void {
    const cell = 3.0, usable = size - 2; const cols = Math.max(1, Math.floor(usable / cell)), rows = Math.max(1, Math.floor(usable / cell));
    const capacity = cols * rows; const slotX = new Float32Array(capacity), slotZ = new Float32Array(capacity); const free = new Uint8Array(capacity).fill(1);
    let k = 0; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { slotX[k] = x - (usable / 2) + (c + 0.5) * (usable / cols); slotZ[k] = z - (usable / 2) + (r + 0.5) * (usable / rows); k++; }
    const poiId = this.poi.add({ category: POICategory.Parking, x, z, priceTier: 0.3, capacity, buildingId: -1 });
    this.lotByPOI.set(poiId, this.parkingLots.length);
    this.parkingLots.push({ id: this.parkingLots.length, poiId, x, z, width: size, depth: size, capacity, slotX, slotZ, free });
  }
  takeSlot(poiId: number): number { const li = this.lotByPOI.get(poiId); if (li === undefined) return -1; const lot = this.parkingLots[li]; for (let i = 0; i < lot.free.length; i++) if (lot.free[i]) { lot.free[i] = 0; return i; } return -1; }
  giveSlot(poiId: number, slot: number): void { const li = this.lotByPOI.get(poiId); if (li === undefined) return; const lot = this.parkingLots[li]; if (slot >= 0 && slot < lot.free.length) lot.free[slot] = 1; }
  slotX(poiId: number, slot: number): number { const li = this.lotByPOI.get(poiId); return li === undefined ? 0 : this.parkingLots[li].slotX[slot]; }
  slotZ(poiId: number, slot: number): number { const li = this.lotByPOI.get(poiId); return li === undefined ? 0 : this.parkingLots[li].slotZ[slot]; }
  private pickCategory(urban: number): POICategory {
    const r = this.rng();
    if (urban > 0.8) { if (r < 0.4) return POICategory.Work; if (r < 0.6) return POICategory.Retail; if (r < 0.75) return POICategory.Food; if (r < 0.85) return POICategory.Leisure; return POICategory.Home; }
    if (r < 0.6) return POICategory.Home; if (r < 0.75) return POICategory.Retail; if (r < 0.85) return POICategory.Food; if (r < 0.92) return POICategory.Work; return POICategory.Leisure;
  }
  private registerPOIs(buildingId: number, x: number, z: number, cat: POICategory, floors: number): void {
    const priceTier = clamp(0.3 + this.rng() * 0.5, 0, 1);
    const capacity = cat === POICategory.Home ? Math.max(4, floors * 5) : cat === POICategory.Work ? Math.max(6, floors * 8) : cat === POICategory.Food ? Math.max(8, floors * 6) : Math.max(6, floors * 5);
    const stockFor = (c: POICategory): { stock: number; maxStock: number } => { if (c === POICategory.Retail) { const m = Math.max(60, floors * 30); return { stock: m, maxStock: m }; } if (c === POICategory.Food) { const m = Math.max(40, floors * 20); return { stock: m, maxStock: m }; } return { stock: 0, maxStock: 0 }; };
    this.poi.add({ category: cat, x, z, priceTier, capacity, buildingId, ...stockFor(cat) });
    if (cat === POICategory.Home && this.rng() < 0.15) this.poi.add({ category: POICategory.Food, x, z, priceTier, capacity: 20, buildingId, ...stockFor(POICategory.Food) });
    if ((cat === POICategory.Work || cat === POICategory.Leisure) && this.rng() < 0.3) this.poi.add({ category: POICategory.Retail, x, z, priceTier, capacity: 40, buildingId, ...stockFor(POICategory.Retail) });
  }
}
