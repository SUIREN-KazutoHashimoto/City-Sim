import { World } from '../world/World';
import { SimulationClock } from '../core/SimulationClock';

/**
 * ============================================================================
 *  Dashboard: 時間帯グラフ + シミュレーション速度コントロール
 * ============================================================================
 * 画面右上に、1日(0-24時)の活動分布を積み上げエリアチャートで描く <canvas> と、
 * 時間経過スケール(timeScale)を切り替えるボタン群を表示する。
 *
 * データ収集:
 *   ゲーム内の一定間隔(既定5分刻み=288ビン/日)ごとに activitySnapshot() を
 *   サンプリングし、時刻ビンに格納する。翌日は同じビンを上書きして最新の1日を示す。
 */

type Snapshot = ReturnType<World['activitySnapshot']>;

const CATS: { key: keyof Snapshot; label: string; color: string }[] = [
  { key: 'home',      label: '在宅',   color: '#5b8cc7' },
  { key: 'work',      label: '勤務',   color: '#d0873f' },
  { key: 'food',      label: '飲食',   color: '#cf5b5b' },
  { key: 'leisure',   label: '娯楽',   color: '#5cb98a' },
  { key: 'traveling', label: '移動',   color: '#b0b7c3' },
  { key: 'idle',      label: '待機',   color: '#4a4f5a' },
];

/** 選択できる時間スケール(実秒あたりの倍率と表示ラベル)。 */
export const SPEED_PRESETS: { scale: number; label: string }[] = [
  { scale: 0.5, label: '0.5×' },   // 0.5 sim-sec / sec(スロー)
  { scale: 1,   label: '1×' },     // 等速
  { scale: 5,   label: '5×' },
  { scale: 30,  label: '30s/s' },  // 30 sim-sec / sec
  { scale: 60,  label: '1m/s' },   // 1 sim-min / sec
  { scale: 180, label: '3m/s' },
  { scale: 600, label: '10m/s' },  // 10 sim-min / sec(最速)
];

export class Dashboard {
  private readonly bins: number;
  private readonly binSeconds: number;
  private data: Float32Array[]; // data[catIndex][bin]
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private root: HTMLDivElement;
  private speedButtons: HTMLButtonElement[] = [];
  private speedIndex = 4; // 既定 1m/s

  constructor(private world: World, private clock: SimulationClock) {
    this.binSeconds = 300;                 // 5分刻み
    this.bins = Math.floor(86400 / this.binSeconds); // 288
    this.data = CATS.map(() => new Float32Array(this.bins).fill(NaN));

    // --- ルートパネル(右上) ---
    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:15',
      'font:11px/1.4 ui-monospace,monospace', 'color:#cdd7e5',
      'background:rgba(10,14,20,.82)', 'border:1px solid #2c3a4f',
      'border-radius:8px', 'padding:8px',
      'user-select:none', 'width:300px',
    ].join(';');
    document.body.appendChild(this.root);

    // --- 速度コントロール行 ---
    const speedRow = document.createElement('div');
    speedRow.style.cssText = 'display:flex;gap:3px;margin-bottom:6px;flex-wrap:wrap;align-items:center';
    const label = document.createElement('span');
    label.textContent = '速度 ';
    label.style.cssText = 'opacity:.7;margin-right:2px';
    speedRow.appendChild(label);
    SPEED_PRESETS.forEach((p, idx) => {
      const b = document.createElement('button');
      b.textContent = p.label;
      b.style.cssText = this.btnStyle(idx === this.speedIndex);
      b.onclick = () => this.setSpeedIndex(idx);
      this.speedButtons.push(b);
      speedRow.appendChild(b);
    });
    this.root.appendChild(speedRow);

    // --- グラフ見出し ---
    const title = document.createElement('div');
    title.textContent = '時間帯グラフ(市民の活動 / 24h)';
    title.style.cssText = 'opacity:.7;margin-bottom:3px';
    this.root.appendChild(title);

    // --- キャンバス ---
    this.canvas = document.createElement('canvas');
    this.canvas.width = 284; this.canvas.height = 96;
    this.canvas.style.cssText = 'width:284px;height:96px;display:block;border-radius:4px';
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    // --- 凡例 ---
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;gap:8px;margin-top:5px;flex-wrap:wrap';
    for (const c of CATS) {
      const item = document.createElement('span');
      item.style.cssText = 'display:inline-flex;align-items:center;gap:3px';
      const sw = document.createElement('span');
      sw.style.cssText = `width:9px;height:9px;border-radius:2px;background:${c.color};display:inline-block`;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(c.label));
      legend.appendChild(item);
    }
    this.root.appendChild(legend);

    // 初期スケールを反映
    this.clock.timeScale = SPEED_PRESETS[this.speedIndex].scale;

    // キーボード [ ] で速度段階を上下
    window.addEventListener('keydown', (e) => {
      if (e.code === 'BracketRight') this.setSpeedIndex(this.speedIndex + 1);
      if (e.code === 'BracketLeft') this.setSpeedIndex(this.speedIndex - 1);
    });
  }

  private btnStyle(active: boolean): string {
    return [
      'padding:2px 6px', 'font:11px ui-monospace,monospace', 'cursor:pointer',
      'border-radius:4px', 'border:1px solid #3a4a5f',
      active ? 'background:#3f6ea5' : 'background:#1a2230',
      active ? 'color:#fff' : 'color:#aeb8c6',
    ].join(';');
  }

  private setSpeedIndex(idx: number): void {
    this.speedIndex = Math.max(0, Math.min(SPEED_PRESETS.length - 1, idx));
    this.clock.timeScale = SPEED_PRESETS[this.speedIndex].scale;
    this.speedButtons.forEach((b, i) => (b.style.cssText = this.btnStyle(i === this.speedIndex)));
  }

  get speedLabel(): string { return SPEED_PRESETS[this.speedIndex].label; }

  /** 現在時刻のビンへ活動分布を記録する(呼び出しは低頻度でよい)。 */
  sample(): void {
    const bin = Math.floor((this.clock.totalSeconds % 86400) / this.binSeconds) % this.bins;
    const snap = this.world.activitySnapshot();
    CATS.forEach((c, ci) => { this.data[ci][bin] = snap[c.key]; });
  }

  /** グラフを再描画する。 */
  draw(): void {
    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1219';
    ctx.fillRect(0, 0, W, H);

    // 総人口を上限として正規化(積み上げが常に画面に収まる)
    const total = Math.max(1, this.world.store.count);

    // 3時間ごとの縦グリッド + 時刻ラベル
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.fillStyle = 'rgba(200,210,225,.35)';
    ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace,monospace';
    for (let h = 0; h <= 24; h += 3) {
      const x = (h / 24) * W;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      if (h < 24) ctx.fillText(String(h), x + 2, H - 2);
    }

    // 積み上げエリア(下から home→work→...→idle)
    // 各ビンの累積高さを保持しながらカテゴリ順に塗る
    const cum = new Float32Array(this.bins);
    for (let ci = 0; ci < CATS.length; ci++) {
      const series = this.data[ci];
      ctx.fillStyle = CATS[ci].color;
      ctx.beginPath();
      let started = false;
      // 上端(このカテゴリ加算後)を左→右
      for (let b = 0; b < this.bins; b++) {
        const v = series[b];
        if (Number.isNaN(v)) { continue; }
        const x = (b / (this.bins - 1)) * W;
        const yTop = H - ((cum[b] + v) / total) * H;
        if (!started) { ctx.moveTo(x, yTop); started = true; }
        else ctx.lineTo(x, yTop);
      }
      // 下端(このカテゴリ加算前)を右→左で閉じる
      for (let b = this.bins - 1; b >= 0; b--) {
        const v = series[b];
        if (Number.isNaN(v)) continue;
        const x = (b / (this.bins - 1)) * W;
        const yBot = H - (cum[b] / total) * H;
        ctx.lineTo(x, yBot);
      }
      if (started) { ctx.closePath(); ctx.fill(); }
      // 累積を更新
      for (let b = 0; b < this.bins; b++) {
        const v = series[b];
        if (!Number.isNaN(v)) cum[b] += v;
      }
    }

    // 現在時刻マーカー(縦の白線)
    const nowX = ((this.clock.totalSeconds % 86400) / 86400) * W;
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.beginPath(); ctx.moveTo(nowX, 0); ctx.lineTo(nowX, H); ctx.stroke();
  }
}
