import { makeRng } from '../core/math';

/**
 * 決定論的 value-noise + fBm。同一シードで必ず同じ地形になる(再現性)。
 * 用途:
 *   - 標高マップ(地形)
 *   - 都市化度マップ(どこを市街地区画にするか = 面積比率の制御に使う)
 * ライブラリ非依存で軽量。品質を上げたければ simplex 実装へ差し替え可能。
 */
export class ValueNoise2D {
  private perm: Uint16Array;
  private grad: Float32Array;
  private readonly size = 256;
  private readonly mask = 255;

  constructor(seed: number) {
    const rng = makeRng(seed);
    this.grad = new Float32Array(this.size);
    for (let i = 0; i < this.size; i++) this.grad[i] = rng() * 2 - 1;
    this.perm = new Uint16Array(this.size * 2);
    const p = new Uint16Array(this.size);
    for (let i = 0; i < this.size; i++) p[i] = i;
    for (let i = this.size - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < this.size * 2; i++) this.perm[i] = p[i & this.mask];
  }

  private valueAt(ix: number, iz: number): number {
    const h = this.perm[(this.perm[ix & this.mask] + iz) & this.mask];
    return this.grad[h];
  }

  /** 単一オクターブ。戻り値 -1..1 付近。 */
  noise(x: number, z: number): number {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = x - x0, fz = z - z0;
    const u = fx * fx * (3 - 2 * fx);
    const v = fz * fz * (3 - 2 * fz);
    const n00 = this.valueAt(x0, z0);
    const n10 = this.valueAt(x0 + 1, z0);
    const n01 = this.valueAt(x0, z0 + 1);
    const n11 = this.valueAt(x0 + 1, z0 + 1);
    const nx0 = n00 + (n10 - n00) * u;
    const nx1 = n01 + (n11 - n01) * u;
    return nx0 + (nx1 - nx0) * v;
  }

  /** フラクタルブラウン運動: 複数オクターブ合成。0..1 に正規化して返す。 */
  fbm(x: number, z: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return (sum / norm) * 0.5 + 0.5;
  }
}
