import { RailRenderer } from './RailRenderer';

interface RailPointLike { x: number; z: number; }
interface RailLineLike { path: RailPointLike[]; }
interface SmoothLineLike { path: RailPointLike[]; length: number; }

interface CurveRuntime {
  makeSmoothLine: (line: RailLineLike) => SmoothLineLike;
}

interface CurvePrototype extends Partial<CurveRuntime> {
  __citySimCurveV027?: boolean;
}

const MAX_SINGLE_TURN = Math.PI / 2;

function wrapAngle(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }

/**
 * Replace any source vertex sharper than 90 degrees with several smaller curve control points.
 * The base RailRenderer still performs its normal smoothing afterwards, so interlocking/station
 * distance logic continues to consume one ordinary SmoothLine; only the input polyline is softened.
 */
function splitSharpCorners(src: RailPointLike[]): RailPointLike[] {
  if (src.length < 3) return src.map((p) => ({ x: p.x, z: p.z }));
  const out: RailPointLike[] = [{ x: src[0].x, z: src[0].z }];

  for (let i = 1; i < src.length - 1; i++) {
    const prev = src[i - 1], p = src[i], next = src[i + 1];
    const ax = p.x - prev.x, az = p.z - prev.z;
    const bx = next.x - p.x, bz = next.z - p.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1 || lb < 1) { out.push({ x: p.x, z: p.z }); continue; }

    const h1 = Math.atan2(az, ax), h2 = Math.atan2(bz, bx);
    const turn = Math.abs(wrapAngle(h2 - h1));
    if (turn <= MAX_SINGLE_TURN + 1e-6) { out.push({ x: p.x, z: p.z }); continue; }

    const uaX = ax / la, uaZ = az / la, ubX = bx / lb, ubZ = bz / lb;
    const radius = Math.min(42, la * 0.30, lb * 0.30);
    if (radius < 3) { out.push({ x: p.x, z: p.z }); continue; }

    const entry = { x: p.x - uaX * radius, z: p.z - uaZ * radius };
    const exit = { x: p.x + ubX * radius, z: p.z + ubZ * radius };
    const curveCount = Math.max(2, Math.ceil(turn / MAX_SINGLE_TURN));
    const samples = curveCount * 5;
    out.push(entry);
    for (let k = 1; k < samples; k++) {
      const t = k / samples, u = 1 - t;
      out.push({
        x: u * u * entry.x + 2 * u * t * p.x + t * t * exit.x,
        z: u * u * entry.z + 2 * u * t * p.z + t * t * exit.z,
      });
    }
    out.push(exit);
  }

  out.push({ x: src[src.length - 1].x, z: src[src.length - 1].z });
  return out;
}

export function prepareRailCurveTuning(): void {
  const proto = RailRenderer.prototype as unknown as CurvePrototype;
  if (proto.__citySimCurveV027) return;
  const baseMakeSmoothLine = proto.makeSmoothLine;
  if (!baseMakeSmoothLine) return;
  proto.__citySimCurveV027 = true;

  proto.makeSmoothLine = function (this: CurveRuntime, line: RailLineLike): SmoothLineLike {
    const original = line.path;
    line.path = splitSharpCorners(original);
    try {
      return baseMakeSmoothLine.call(this, line);
    } finally {
      line.path = original;
    }
  };
}
