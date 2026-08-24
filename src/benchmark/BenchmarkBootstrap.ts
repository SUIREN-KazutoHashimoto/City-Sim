const AUTO_PARAM = 'citysim-benchmark';

interface BenchmarkBootstrapWindow extends Window {
  __CITY_SIM_BENCH_HOLD__?: boolean;
}

const bootWindow = window as BenchmarkBootstrapWindow;
if (new URL(window.location.href).searchParams.get(AUTO_PARAM) === '1') {
  // CityConfigLoader uses this sentinel to accept the benchmark-only fixed seed before main.ts runs.
  bootWindow.__CITY_SIM_BENCH_HOLD__ = true;
}

let loaded = false;
async function loadHarness(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await import('./BenchmarkHarness');
}

// The benchmark harness only starts its readiness timeout after the expensive city boot/pre-roll has
// completed. This keeps fixed-seed BENCH launches compatible with a real loading phase.
window.addEventListener('citysim-ready', () => { void loadHarness(); }, { once: true });
