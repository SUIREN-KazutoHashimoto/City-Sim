export class BootScreen {
  private readonly root = document.getElementById('boot-screen');
  private readonly stage = document.getElementById('boot-stage');
  private readonly detail = document.getElementById('boot-detail');
  private readonly fill = document.getElementById('boot-progress-fill') as HTMLDivElement | null;
  private readonly percent = document.getElementById('boot-progress-percent');
  private readonly note = this.root?.querySelector('.boot-note') as HTMLDivElement | null;

  update(stage: string, detail: string, progress: number): void {
    const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
    if (this.stage) this.stage.textContent = stage;
    if (this.detail) this.detail.textContent = detail;
    if (this.fill) this.fill.style.transform = `scaleX(${p})`;
    if (this.percent) this.percent.textContent = `${Math.round(p * 100)}%`;
  }

  setNote(note: string): void {
    if (this.note) this.note.textContent = note;
  }

  show(stage: string, detail: string, progress = 0, note?: string): void {
    this.root?.classList.remove('boot-screen--done', 'boot-screen--error');
    this.root?.setAttribute('aria-hidden', 'false');
    if (note !== undefined) this.setNote(note);
    this.update(stage, detail, progress);
  }

  async paint(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  hide(): void {
    if (!this.root) return;
    this.root.classList.add('boot-screen--done');
    this.root.setAttribute('aria-hidden', 'true');
  }

  finish(): void {
    this.update('起動完了', '08:00 の都市を表示します', 1);
    this.hide();
  }

  fail(message: string): void {
    this.show('起動に失敗しました', message, 1);
    this.root?.classList.add('boot-screen--error');
  }
}
