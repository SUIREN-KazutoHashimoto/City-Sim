let dashboardCollapsed = false;
let performanceCollapsed = false;
let renderFilterCollapsed = false;
let scheduled = false;

function directBodyDivs(): HTMLDivElement[] {
  return Array.from(document.body.children).filter((el): el is HTMLDivElement => el instanceof HTMLDivElement);
}

function dashboardRoot(): HTMLDivElement | null {
  return directBodyDivs().find((el) =>
    el.style.position === 'fixed'
    && el.style.zIndex === '15'
    && (el.textContent ?? '').includes('速度'),
  ) ?? null;
}

function performanceRoot(): HTMLDivElement | null {
  return directBodyDivs().find((el) =>
    el.style.position === 'fixed'
    && el.style.zIndex === '16'
    && (el.textContent ?? '').includes('PERFORMANCE'),
  ) ?? null;
}

function removeExternalHighSpeedStatus(): void {
  for (const el of directBodyDivs()) {
    const text = el.textContent ?? '';
    const fixedExternalPanel = el.style.position === 'fixed'
      && el.style.right === '8px'
      && el.style.width === '320px'
      && el.style.zIndex === '14';
    if (fixedExternalPanel && text.includes('外部高速線')) el.remove();
  }
}

function compactDashboard(root: HTMLDivElement): void {
  root.style.setProperty('width', '292px', 'important');
  root.style.setProperty('padding', '6px', 'important');
  root.style.setProperty('background', 'rgba(10,14,20,.76)', 'important');

  const graphToggle = document.getElementById('citysim-activity-graph-toggle');
  if (graphToggle?.parentElement instanceof HTMLElement) graphToggle.parentElement.style.display = 'none';
}

function collapseDefaults(): void {
  const dashboard = dashboardRoot();
  if (dashboard) {
    compactDashboard(dashboard);
    if (!dashboardCollapsed && (dashboard.textContent ?? '').includes('時間帯グラフ')) {
      dashboardCollapsed = true;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g' }));
    }
  }

  const performance = performanceRoot();
  if (performance && !performanceCollapsed) {
    performanceCollapsed = true;
    // Use the monitor's own shortcut so its internal visibility flag stays in sync.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p' }));
  }

  const filter = document.querySelector<HTMLDivElement>('div[data-render-filter="true"]');
  if (filter && !renderFilterCollapsed) {
    renderFilterCollapsed = true;
    filter.style.display = 'none';
  }

  removeExternalHighSpeedStatus();
}

function scheduleApply(): void {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(() => {
    scheduled = false;
    collapseDefaults();
  });
}

const observer = new MutationObserver(scheduleApply);
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
window.addEventListener('resize', scheduleApply);
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyG' || event.code === 'KeyP' || event.code === 'F9') window.setTimeout(scheduleApply, 0);
});
window.setInterval(removeExternalHighSpeedStatus, 2000);
window.requestAnimationFrame(collapseDefaults);
