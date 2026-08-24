export class BootScreen {
  private readonly root = document.getElementById('boot-screen');
  private readonly stage = document.getElementById('boot-stage');
  private readonly detail = document.getElementById('boot-detail');
  private readonly fill = document.getElementById('boot-progress-fill') as HTMLDivElement | null;
  private readonly percent = document.getElementById('boot-progress-percent');

  update(stage: string, detail: string, progress: number): void {
    const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
    if (this.stage) this.stage.textContent = stage;
    if (this.detail) this.detail.textContent = detail;
    if (this.fill) this.fill.style.transform = `scaleX(${p})`;
    if (this.percent) this.percent.textContent = `${Math.round(p * 100)}%`;
  }

  async paint(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  finish(): void {
    this.update('起動完了', '08:00 の都市を表示します', 1);
    if (!this.root) return;
    this.root.classList.add('boot-screen--done');
    window.setTimeout(() => this.root?.remove(), 320);
  }

  fail(message: string): void {
    this.update('起動に失敗しました', message, 1);
    this.root?.classList.add('boot-screen--error');
  }
}
