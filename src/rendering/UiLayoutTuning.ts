const DIRECT_CHILD_DIVS = (): HTMLDivElement[] => Array.from(document.body.children).filter((el): el is HTMLDivElement => el instanceof HTMLDivElement);

let toggleInstalled = false;
let applying = false;

function findDashboard(): HTMLDivElement | null {
  return DIRECT_CHILD_DIVS().find((el) => el.style.position === 'fixed' && el.style.zIndex === '15' && (el.textContent ?? '').includes('速度')) ?? null;
}

function findPerformance(): HTMLDivElement | null {
  return DIRECT_CHILD_DIVS().find((el) => el.style.position === 'fixed' && el.style.zIndex === '16' && (el.textContent ?? '').includes('PERFORMANCE')) ?? null;
}

function findPinnedTracking(): HTMLDivElement | null {
  return DIRECT_CHILD_DIVS().find((el) =>
    !el.id
    && el.style.position === 'fixed'
    && el.style.zIndex === '20'
    && el.style.pointerEvents === 'none'
    && el.style.left === '8px'
    && (el.style.bottom === '8px' || (el.textContent ?? '').startsWith('追跡:')),
  ) ?? null;
}

function graphSection(dashboard: HTMLDivElement): HTMLDivElement | null {
  return Array.from(dashboard.children).find((el): el is HTMLDivElement => el instanceof HTMLDivElement && (el.textContent ?? '').includes('時間帯グラフ')) ?? null;
}

function installGraphToggle(dashboard: HTMLDivElement): void {
  if (toggleInstalled || document.getElementById('citysim-activity-graph-toggle')) return;
  const section = graphSection(dashboard);
  if (!section) return;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;margin:1px 0 5px';
  const button = document.createElement('button');
  button.id = 'citysim-activity-graph-toggle';
  button.textContent = '時間帯グラフ 表示/非表示 [G]';
  button.title = '時間帯グラフの表示を切り替えます';
  button.style.cssText = 'padding:2px 6px;font:10px ui-monospace,monospace;cursor:pointer;border-radius:4px;border:1px solid #3a4a5f;background:#1a2230;color:#aeb8c6';
  button.addEventListener('click', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g' }));
    window.setTimeout(applyLayout, 0);
  });
  row.appendChild(button);
  dashboard.insertBefore(row, section);
  toggleInstalled = true;
}

function tuneDashboard(dashboard: HTMLDivElement): void {
  dashboard.style.width = '292px';
  dashboard.style.padding = '7px';
  dashboard.style.fontSize = '10px';
  installGraphToggle(dashboard);
  const section = graphSection(dashboard);
  const canvas = section?.querySelector('canvas');
  if (canvas instanceof HTMLCanvasElement) {
    canvas.style.width = '276px';
    canvas.style.height = '78px';
  }
  if (section) {
    const legend = Array.from(section.children).find((el) => el instanceof HTMLDivElement && el !== section.firstElementChild);
    if (legend instanceof HTMLElement) {
      legend.style.gap = '5px';
      legend.style.marginTop = '3px';
      legend.style.fontSize = '9px';
    }
  }
}

function tunePerformance(performance: HTMLDivElement, dashboard: HTMLDivElement | null): void {
  performance.style.width = '360px';
  performance.style.padding = '6px';
  performance.style.fontSize = '9px';
  performance.style.lineHeight = '1.28';
  const top = dashboard ? Math.ceil(dashboard.getBoundingClientRect().bottom + 8) : 160;
  performance.style.top = `${top}px`;
  performance.style.right = '8px';
  performance.style.maxHeight = `calc(100vh - ${top + 8}px)`;
  for (const canvas of Array.from(performance.querySelectorAll('canvas'))) {
    const intrinsicH = Math.max(1, canvas.height);
    canvas.style.width = '344px';
    canvas.style.height = `${Math.max(56, Math.round(intrinsicH * 0.76))}px`;
  }
}

function tuneTracking(pin: HTMLDivElement): void {
  const hud = document.getElementById('hud');
  const top = Math.ceil((hud?.getBoundingClientRect().bottom ?? 82) + 8);
  pin.style.left = '8px';
  pin.style.top = `${top}px`;
  pin.style.bottom = 'auto';
  pin.style.maxWidth = '430px';
  pin.style.maxHeight = `calc(100vh - ${top + 16}px)`;
}

export function applyLayout(): void {
  if (applying) return;
  applying = true;
  try {
    const dashboard = findDashboard();
    if (dashboard) tuneDashboard(dashboard);
    const performance = findPerformance();
    if (performance) tunePerformance(performance, dashboard);
    const pin = findPinnedTracking();
    if (pin) tuneTracking(pin);
  } finally {
    applying = false;
  }
}

const observer = new MutationObserver(() => window.requestAnimationFrame(applyLayout));
observer.observe(document.body, { childList: true });
window.addEventListener('resize', applyLayout);
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyG' || event.code === 'KeyP') window.setTimeout(applyLayout, 0);
});
window.setInterval(applyLayout, 1200);
window.requestAnimationFrame(applyLayout);
