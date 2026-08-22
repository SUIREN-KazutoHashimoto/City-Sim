/**
 * シミュレーションは地表面(XZ平面)を2Dとして扱い、レンダリング時にYへ持ち上げる。
 * ホットループで大量に呼ぶため、オブジェクト生成を避けたスカラー関数中心にする。
 */

export type Vec2 = { x: number; z: number };

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const dist2 = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
};

export const dist = (ax: number, az: number, bx: number, bz: number): number =>
  Math.sqrt(dist2(ax, az, bx, bz));

/** 決定論的な擬似乱数 (mulberry32)。シード可能でマップ再現性を担保する。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TAU = Math.PI * 2;
