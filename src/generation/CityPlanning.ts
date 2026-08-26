import { ValueNoise2D } from './Noise';
import { clamp, makeRng } from '../core/math';
import { DEFAULT_RAIL_PLANNING, RailNetworkPlan, RailPlanningOptions } from './RailPlanning';

export enum DistrictType {
  CBD = 0,
  Commercial = 1,
  MixedUse = 2,
  ResidentialHigh = 3,
  ResidentialLow = 4,
  Industrial = 5,
  Logistics = 6,
  Civic = 7,
  Park = 8,
}

export interface CityPlanningOptions extends RailPlanningOptions {
  subCenters: number;
  arterialSpacing: number;
  collectorSpacing: number;
  industrialRatio: number;
  parkRatio: number;
}

export const DEFAULT_CITY_PLANNING: CityPlanningOptions = {
  subCenters: 3,
  arterialSpacing: 900,
  collectorSpacing: 360,
  industrialRatio: 0.08,
  parkRatio: 0.055,
  ...DEFAULT_RAIL_PLANNING,
};

export interface CityCenter {
  x: number;
  z: number;
  strength: number;
}

export interface PlanningSample {
  district: DistrictType;
  urbanScore: number;
  landValue: number;
  density: number;
  centerInfluence: number;
  /** Phase 4: 最寄り駅によるTOD影響。0=影響なし、1=中央駅直近。 */
  transitInfluence: number;
  nearestStationId: number;
}

/**
 * 道路・街区・建物より先に都市の意味を決める軽量プランナー。
 * 同じseedならCBD/副都心/工業・物流拠点・鉄道駅と地価場は決定論的に再生成できる。
 */
export class CityPlanning {
  readonly options: CityPlanningOptions;
  readonly cbd: CityCenter;
  readonly subCenters: CityCenter[] = [];
  readonly industrialCenter: CityCenter;
  readonly logisticsCenter: CityCenter;
  readonly rail: RailNetworkPlan;

  private readonly noise: ValueNoise2D;
  private readonly detailNoise: ValueNoise2D;

  constructor(readonly sizeMeters: number, seed: number, options?: Partial<CityPlanningOptions>) {
    this.options = { ...DEFAULT_CITY_PLANNING, ...options };
    this.noise = new ValueNoise2D(seed ^ 0x2a11ce);
    this.detailNoise = new ValueNoise2D(seed ^ 0x7f4a7c15);
    const rng = makeRng(seed ^ 0x41c64e6d);
    const c = sizeMeters * 0.5;

    // CBDは中心から大きく外し過ぎず、seedごとに少し位置を変える。
    this.cbd = {
      x: c + (rng() - 0.5) * sizeMeters * 0.08,
      z: c + (rng() - 0.5) * sizeMeters * 0.08,
      strength: 1,
    };

    const count = Math.max(0, Math.min(8, Math.round(this.options.subCenters)));
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2 + rng() * 0.8;
      const r = sizeMeters * (0.18 + rng() * 0.16);
      this.subCenters.push({
        x: clamp(this.cbd.x + Math.cos(a) * r, sizeMeters * 0.08, sizeMeters * 0.92),
        z: clamp(this.cbd.z + Math.sin(a) * r, sizeMeters * 0.08, sizeMeters * 0.92),
        strength: 0.58 + rng() * 0.18,
      });
    }

    // 工業地と物流地は市街地外縁へ寄せる。物流拠点は都市境界/Gateに近い側へ置く。
    const edge = Math.floor(rng() * 4);
    const along = sizeMeters * (0.22 + rng() * 0.56);
    const inset = sizeMeters * (0.10 + rng() * 0.06);
    const edgePoint = (which: number, inward: number): { x: number; z: number } => {
      if (which === 0) return { x: inward, z: along };
      if (which === 1) return { x: sizeMeters - inward, z: along };
      if (which === 2) return { x: along, z: inward };
      return { x: along, z: sizeMeters - inward };
    };
    const ind = edgePoint(edge, inset);
    this.industrialCenter = { ...ind, strength: 0.9 };
    const log = edgePoint(edge, sizeMeters * 0.045);
    this.logisticsCenter = { ...log, strength: 1 };

    // Phase 4: CBDを貫く幹線＋副都心支線を道路生成より先に計画し、駅勢圏を都市形成へ戻す。
    this.rail = new RailNetworkPlan(sizeMeters, seed, { cbd: this.cbd, subCenters: this.subCenters }, this.options);
  }

  sample(x: number, z: number): PlanningSample {
    const size = this.sizeMeters;
    const cbdD = this.normDist(x, z, this.cbd.x, this.cbd.z, size * 0.18);
    const cbdInf = this.falloff(cbdD);
    let subInf = 0;
    let nearestSub = Infinity;
    for (const s of this.subCenters) {
      const d = this.normDist(x, z, s.x, s.z, size * 0.14);
      nearestSub = Math.min(nearestSub, d);
      subInf = Math.max(subInf, this.falloff(d) * s.strength);
    }
    const indD = this.normDist(x, z, this.industrialCenter.x, this.industrialCenter.z, size * (0.13 + this.options.industrialRatio * 0.25));
    const logD = this.normDist(x, z, this.logisticsCenter.x, this.logisticsCenter.z, size * 0.105);
    const indInf = this.falloff(indD);
    const logInf = this.falloff(logD);
    const n = this.noise.fbm(x / 1500, z / 1500, 5);
    const detail = this.detailNoise.fbm(x / 620, z / 620, 3);
    const edgeD = Math.min(x, z, size - x, size - z) / Math.max(1, size * 0.22);
    const edgePenalty = clamp(1 - edgeD, 0, 1);
    const transit = this.rail.influenceAt(x, z);
    const transitInf = transit.influence;
    const centerInfluence = Math.max(cbdInf, subInf, transitInf * 0.82);

    // 市街化判定用。駅勢圏は既存中心から離れていても駅前市街地を形成できる。
    let urbanScore = clamp(
      0.33 * n + 0.18 * detail + Math.max(cbdInf, subInf) * 0.72 + indInf * 0.34 + logInf * 0.18
      + transitInf * 0.20 - edgePenalty * 0.18,
      0,
      1,
    );

    const parkCandidate = detail > 0.72 && centerInfluence < 0.74 && indInf < 0.35 && logInf < 0.35 && transitInf < 0.32;
    const civicCandidate = centerInfluence > 0.30 && centerInfluence < 0.74 && detail < 0.22 && indInf < 0.25 && logInf < 0.25;
    let district: DistrictType;
    if (logInf > 0.68) district = DistrictType.Logistics;
    else if (indInf > 0.55) district = DistrictType.Industrial;
    else if (parkCandidate && detail > 0.78 - this.options.parkRatio) district = DistrictType.Park;
    else if (civicCandidate && transitInf < 0.55) district = DistrictType.Civic;
    else if (cbdInf > 0.66) district = DistrictType.CBD;
    else if (cbdInf > 0.42 || subInf > 0.62) district = DistrictType.Commercial;
    else if (subInf > 0.38 || cbdInf > 0.28) district = DistrictType.MixedUse;
    else if (centerInfluence > 0.20 || nearestSub < 1.65) district = DistrictType.ResidentialHigh;
    else district = DistrictType.ResidentialLow;

    // TOD用途転換。工業・物流・公園は保護し、それ以外の駅前だけ段階的に高密度化する。
    if (district !== DistrictType.Industrial && district !== DistrictType.Logistics && district !== DistrictType.Park) {
      if (transitInf > 0.74 && district !== DistrictType.CBD) district = DistrictType.Commercial;
      else if (transitInf > 0.56 && district === DistrictType.ResidentialHigh) district = DistrictType.MixedUse;
      else if (transitInf > 0.34 && district === DistrictType.ResidentialLow) district = DistrictType.ResidentialHigh;
      else if (transitInf > 0.62 && district === DistrictType.Civic) district = DistrictType.MixedUse;
    }

    // 地価は市街化度とは別。駅アクセスを明示的に加点し、工業/物流は抑える。
    const amenityNoise = this.detailNoise.fbm(x / 900 + 11.3, z / 900 - 6.7, 3);
    let landValue = clamp(
      0.18 + cbdInf * 0.62 + subInf * 0.40 + urbanScore * 0.26 + amenityNoise * 0.12
      + transitInf * 0.27 - indInf * 0.28 - logInf * 0.20,
      0.05,
      1,
    );

    let districtDensity = 0.35;
    switch (district) {
      case DistrictType.CBD: districtDensity = 1; break;
      case DistrictType.Commercial: districtDensity = 0.83; break;
      case DistrictType.MixedUse: districtDensity = 0.76; break;
      case DistrictType.ResidentialHigh: districtDensity = 0.66; break;
      case DistrictType.ResidentialLow: districtDensity = 0.38; break;
      case DistrictType.Industrial: districtDensity = 0.34; break;
      case DistrictType.Logistics: districtDensity = 0.24; break;
      case DistrictType.Civic: districtDensity = 0.58; break;
      case DistrictType.Park: districtDensity = 0.06; break;
    }
    let density = clamp(districtDensity * (0.58 + landValue * 0.58) + transitInf * 0.16, 0.04, 1);

    // 低地価・低密度地点でも中央駅直近は最低限の開発強度を保証する。
    if (transitInf > 0.75 && district !== DistrictType.Industrial && district !== DistrictType.Logistics && district !== DistrictType.Park) {
      urbanScore = Math.max(urbanScore, 0.72);
      landValue = Math.max(landValue, 0.68);
      density = Math.max(density, 0.78);
    }

    return { district, urbanScore, landValue, density, centerInfluence, transitInfluence: transitInf, nearestStationId: transit.stationId };
  }

  /** Local道路の密度。1=基準Block、2=約2倍、3=約3倍の街区。 */
  localRoadStep(district: DistrictType): number {
    switch (district) {
      case DistrictType.CBD:
      case DistrictType.Commercial:
      case DistrictType.MixedUse:
      case DistrictType.ResidentialHigh:
        return 1;
      case DistrictType.ResidentialLow:
        return 2;
      case DistrictType.Industrial:
      case DistrictType.Logistics:
        return 3;
      case DistrictType.Civic:
        return 2;
      case DistrictType.Park:
        return 3;
    }
  }

  private falloff(normalizedDistance: number): number {
    const d = clamp(normalizedDistance, 0, 1.8);
    return clamp(1 - d * d, 0, 1);
  }

  private normDist(x: number, z: number, cx: number, cz: number, scale: number): number {
    return Math.hypot(x - cx, z - cz) / Math.max(1, scale);
  }
}
