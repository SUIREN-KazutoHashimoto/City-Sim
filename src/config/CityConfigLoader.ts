import { DEFAULT_CITY_PLANNING, type CityPlanningOptions } from '../generation/CityPlanning';

export type CitySeedSetting = number | 'random';

export interface RuntimeCityConfig {
  seed: CitySeedSetting;
  areaKm2: number;
  urbanRatioTarget: number;
  blockSize: number;
  population: number;
  agentCapacity: number;
  vehicleCapacity: number;
  planning: CityPlanningOptions;
}

const DEFAULT_CONFIG: RuntimeCityConfig = {
  seed: 'random',
  areaKm2: 100,
  urbanRatioTarget: 0.4,
  blockSize: 90,
  population: 50_000,
  agentCapacity: 60_000,
  vehicleCapacity: 30_000,
  planning: { ...DEFAULT_CITY_PLANNING },
};

const BENCHMARK_SEED_PARAM = 'citysim-seed';

interface BenchmarkSeedGlobal {
  __CITY_SIM_BENCH_HOLD__?: boolean;
}

function requireFinite(name: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}. actual=${value}`);
  }
  return value;
}

export async function loadCityConfig(url = '/config/city.json'): Promise<RuntimeCityConfig> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load city config: ${response.status} ${response.statusText}`);

  const raw = await response.json() as Partial<RuntimeCityConfig>;
  const rawPlanning = raw.planning ?? {};
  const cfg: RuntimeCityConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    planning: { ...DEFAULT_CITY_PLANNING, ...rawPlanning },
  };

  if (cfg.seed !== 'random' && (!Number.isFinite(cfg.seed) || typeof cfg.seed !== 'number')) {
    throw new Error(`seed must be a number or "random". actual=${String(cfg.seed)}`);
  }

  cfg.areaKm2 = requireFinite('areaKm2', cfg.areaKm2, 0.1, 10_000);
  cfg.urbanRatioTarget = requireFinite('urbanRatioTarget', cfg.urbanRatioTarget, 0.01, 0.95);
  cfg.blockSize = requireFinite('blockSize', cfg.blockSize, 20, 500);
  cfg.population = Math.floor(requireFinite('population', cfg.population, 1, 1_000_000));
  cfg.agentCapacity = Math.floor(requireFinite('agentCapacity', cfg.agentCapacity, cfg.population, 1_500_000));
  cfg.vehicleCapacity = Math.floor(requireFinite('vehicleCapacity', cfg.vehicleCapacity, 1, 1_000_000));

  cfg.planning.subCenters = Math.floor(requireFinite('planning.subCenters', cfg.planning.subCenters, 0, 8));
  cfg.planning.arterialSpacing = requireFinite('planning.arterialSpacing', cfg.planning.arterialSpacing, cfg.blockSize * 3, 5000);
  cfg.planning.collectorSpacing = requireFinite('planning.collectorSpacing', cfg.planning.collectorSpacing, cfg.blockSize * 2, cfg.planning.arterialSpacing);
  cfg.planning.industrialRatio = requireFinite('planning.industrialRatio', cfg.planning.industrialRatio, 0, 0.35);
  cfg.planning.parkRatio = requireFinite('planning.parkRatio', cfg.planning.parkRatio, 0, 0.25);
  cfg.planning.railEnabled = cfg.planning.railEnabled !== false;
  cfg.planning.railTrunkLines = Math.floor(requireFinite('planning.railTrunkLines', cfg.planning.railTrunkLines, 1, 3));
  cfg.planning.railStationSpacing = requireFinite('planning.railStationSpacing', cfg.planning.railStationSpacing, 260, 3000);
  cfg.planning.railInfluenceRadius = requireFinite('planning.railInfluenceRadius', cfg.planning.railInfluenceRadius, 300, 1800);
  cfg.planning.railSubCenterSpurs = cfg.planning.railSubCenterSpurs !== false;

  return cfg;
}

function benchmarkSeedOverrideEnabled(): boolean {
  return (globalThis as typeof globalThis & BenchmarkSeedGlobal).__CITY_SIM_BENCH_HOLD__ === true;
}

function removeStaleBenchmarkSeedParam(): void {
  if (typeof globalThis.location === 'undefined' || typeof globalThis.history === 'undefined') return;
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has(BENCHMARK_SEED_PARAM)) return;
  url.searchParams.delete(BENCHMARK_SEED_PARAM);
  globalThis.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function querySeedOverride(): number | null {
  if (typeof globalThis.location === 'undefined') return null;
  const raw = new URLSearchParams(globalThis.location.search).get(BENCHMARK_SEED_PARAM);
  if (raw === null) return null;

  // citysim-seed is benchmark-only. BenchmarkHarness sets this sentinel before main.ts runs.
  // A stale seed left in the URL after a benchmark must never affect a normal city launch.
  if (!benchmarkSeedOverrideEnabled()) {
    removeStaleBenchmarkSeedParam();
    return null;
  }

  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff ? value >>> 0 : null;
}

export function resolveCitySeed(setting: CitySeedSetting): number {
  const override = querySeedOverride();
  if (override !== null) return override;
  if (setting !== 'random') return Math.trunc(setting) >>> 0;

  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] >>> 0;
  }

  return (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
}
