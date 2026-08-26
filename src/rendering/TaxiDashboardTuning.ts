import { Dashboard } from './Dashboard';

type AnyDashboard = any;
type AnyMethod = (...args: any[]) => any;

const binsByDashboard = new WeakMap<object, Float32Array>();
const legendByDashboard = new WeakMap<object, HTMLElement>();
const BIN_COUNT = 288;
const BIN_SECONDS = 300;

function taxiSeries(dashboard: AnyDashboard): Float32Array {
  let series = binsByDashboard.get(dashboard);
  if (series) return series;
  series = new Float32Array(BIN_COUNT);
  series.fill(Number.NaN);
  binsByDashboard.set(dashboard, series);
  return series;
}

function ensureLegend(dashboard: AnyDashboard): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const existing = legendByDashboard.get(dashboard);
  if (existing) return existing;
  const root = dashboard.graphRoot as HTMLDivElement | undefined;
  if (!root) return null;
  const item = document.createElement('div');
  item.style.cssText = 'margin-top:4px;color:#65d7e8;font:10px/1.3 ui-monospace,monospace';
  item.textContent = 'タクシー 0';
  root.appendChild(item);
  legendByDashboard.set(dashboard, item);
  return item;
}

const proto = Dashboard.prototype as unknown as Record<string, any>;
if (!proto.__citySimTaxiDashboardV072) {
  const previousSample = proto.sample as AnyMethod;
  proto.sample = function sampleWithTaxi(this: AnyDashboard): void {
    previousSample.call(this);
    const snapshot = this.world.activitySnapshot() as Record<string, number>;
    const bin = Math.floor((this.clock.totalSeconds % 86400) / BIN_SECONDS) % BIN_COUNT;
    taxiSeries(this)[bin] = snapshot.ontaxi ?? 0;
    const label = ensureLegend(this);
    if (label) label.textContent = `タクシー ${snapshot.ontaxi ?? 0}`;
  };

  const previousDraw = proto.draw as AnyMethod;
  proto.draw = function drawWithTaxi(this: AnyDashboard): void {
    previousDraw.call(this);
    if (!this.graphVisible) return;
    const canvas = this.canvas as HTMLCanvasElement | undefined;
    const ctx = this.ctx as CanvasRenderingContext2D | undefined;
    if (!canvas || !ctx) return;
    const series = taxiSeries(this);
    const total = Math.max(1, this.world.store.count);
    ctx.save();
    ctx.strokeStyle = '#65d7e8';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    let started = false;
    for (let b = 0; b < BIN_COUNT; b++) {
      const value = series[b];
      if (Number.isNaN(value)) continue;
      const x = (b / (BIN_COUNT - 1)) * canvas.width;
      const y = canvas.height - Math.min(canvas.height, (value / total) * canvas.height * 7);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    if (started) ctx.stroke();
    ctx.restore();
  };

  proto.__citySimTaxiDashboardV072 = true;
}
