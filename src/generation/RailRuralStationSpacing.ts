import { clamp } from '../core/math';
import { RailNetworkPlan, RailStationKind } from './RailPlanning';

type AnyPlan = Record<string, any> & {
  sizeMeters: number;
  options: { railStationSpacing: number; railInfluenceRadius: number };
  stations: any[];
};
type RailCenter = { x: number; z: number; strength: number };

interface SpacingCenter { x: number; z: number; }

function centerOf(plan: AnyPlan): SpacingCenter {
  return plan.__citySimSpacingCenter ?? { x: plan.sizeMeters * 0.5, z: plan.sizeMeters * 0.5 };
}

/** CBD付近を1.0、都市外縁を2.0とする滑らかな駅間係数。 */
function localityFactor(plan: AnyPlan, x: number, z: number): number {
  const center = centerOf(plan);
  const radius = Math.max(1, plan.sizeMeters * 0.50);
  const radial = Math.hypot(x - center.x, z - center.z);
  const normalized = clamp(radial / radius, 0, 1);
  const rural = clamp((normalized - 0.15) / 0.85, 0, 1);
  const eased = rural * rural * (3 - 2 * rural);
  return 1 + eased;
}

function spacingAt(plan: AnyPlan, x: number, z: number, baseScale = 1): number {
  const base = Math.max(260, Number(plan.options.railStationSpacing) * baseScale);
  return base * localityFactor(plan, x, z);
}

function install(): void {
  const proto = RailNetworkPlan.prototype as unknown as Record<string, any>;
  if (proto.__citySimRuralStationSpacingV056) return;
  proto.__citySimRuralStationSpacingV056 = true;

  proto.buildTrunk = function buildTrunkWithRuralSpacing(
    this: AnyPlan,
    cx: number,
    cz: number,
    angle: number,
    index: number,
  ): void {
    this.__citySimSpacingCenter = { x: cx, z: cz } satisfies SpacingCenter;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const margin = Math.min(220, this.sizeMeters * 0.025);
    const pos = this.rayExtent(cx, cz, dx, dz, margin) as number;
    const neg = this.rayExtent(cx, cz, -dx, -dz, margin) as number;
    const ts: number[] = [0];

    const addDirection = (extent: number, sign: 1 | -1): void => {
      let distance = 0;
      for (let guard = 0; guard < 256; guard++) {
        const x = cx + dx * sign * distance;
        const z = cz + dz * sign * distance;
        const step = spacingAt(this, x, z);
        const next = distance + step;
        const nx = cx + dx * sign * next;
        const nz = cz + dz * sign * next;
        const nextSpacing = spacingAt(this, nx, nz);
        if (next >= extent - nextSpacing * 0.30) break;
        ts.push(sign * next);
        distance = next;
      }
    };

    addDirection(pos, 1);
    addDirection(neg, -1);
    const centerSpacing = spacingAt(this, cx, cz);
    if (pos > centerSpacing * 0.55) ts.push(pos * 0.965);
    if (neg > centerSpacing * 0.55) ts.push(-neg * 0.965);
    ts.sort((a, b) => a - b);

    const stationIds: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const endpoint = i === 0 || i === ts.length - 1;
      const kind = Math.abs(t) < 1
        ? RailStationKind.Central
        : endpoint
          ? RailStationKind.Terminal
          : RailStationKind.Local;
      const name = kind === RailStationKind.Central
        ? '中央駅'
        : kind === RailStationKind.Terminal
          ? `終端${this.stations.length + 1}駅`
          : '';
      const id = this.ensureStation(cx + dx * t, cz + dz * t, kind, name) as number;
      if (stationIds[stationIds.length - 1] !== id) stationIds.push(id);
    }
    if (stationIds.length >= 2) this.addLine(`都市幹線${index + 1}`, 'trunk', stationIds);
  };

  proto.buildSubCenterSpur = function buildSubCenterSpurWithRuralSpacing(
    this: AnyPlan,
    center: RailCenter,
    subIndex: number,
  ): void {
    if (this.stations.length === 0) return;
    let nearest = this.stations[0];
    let best = Infinity;
    for (const station of this.stations) {
      const d = Math.hypot(station.plannedX - center.x, station.plannedZ - center.z);
      if (d < best) { best = d; nearest = station; }
    }

    const localSpacing = spacingAt(this, center.x, center.z);
    if (best < Math.max(180, localSpacing * 0.34)) {
      if (nearest.kind !== RailStationKind.Central) nearest.kind = RailStationKind.SubCenter;
      if (nearest.kind === RailStationKind.SubCenter) nearest.name = `副都心${subIndex + 1}駅`;
      nearest.influenceRadius = Math.max(nearest.influenceRadius, this.options.railInfluenceRadius * 1.15);
      return;
    }

    const dx = center.x - nearest.plannedX;
    const dz = center.z - nearest.plannedZ;
    const length = Math.hypot(dx, dz);
    const ux = length > 1e-6 ? dx / length : 0;
    const uz = length > 1e-6 ? dz / length : 0;
    const stationIds: number[] = [nearest.id];
    let distance = 0;
    for (let guard = 0; guard < 128; guard++) {
      const x = nearest.plannedX + ux * distance;
      const z = nearest.plannedZ + uz * distance;
      const step = spacingAt(this, x, z, 0.90);
      const next = distance + step;
      if (next >= length - step * 0.35) break;
      distance = next;
      stationIds.push(this.ensureStation(
        nearest.plannedX + ux * distance,
        nearest.plannedZ + uz * distance,
        RailStationKind.Local,
        '',
      ));
    }
    stationIds.push(this.ensureStation(center.x, center.z, RailStationKind.SubCenter, `副都心${subIndex + 1}駅`));
    this.addLine(`副都心支線${subIndex + 1}`, 'spur', stationIds);
  };
}

install();
