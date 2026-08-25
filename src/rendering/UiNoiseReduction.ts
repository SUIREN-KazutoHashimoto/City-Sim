type WindowId = 'hud' | 'dashboard' | 'filter' | 'performance' | 'tracking';

interface WindowConfig {
  id: WindowId;
  title: string;
  defaultVisible: boolean;
  defaultWidth: number;
  defaultHeight: number;
  hotkey?: 'KeyP' | 'F9';
  nativeVisibility?: boolean;
}

interface SavedWindowState {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  visible?: boolean;
}

interface ManagedWindow {
  config: WindowConfig;
  root: HTMLDivElement;
  shell: HTMLDivElement;
  body: HTMLDivElement;
  desiredVisible: boolean;
  observer: MutationObserver;
}

const STORAGE_KEY = 'city-sim-window-layout-v2';
const configs: WindowConfig[] = [
  { id: 'hud', title: '統計 HUD', defaultVisible: true, defaultWidth: 620, defaultHeight: 210 },
  { id: 'dashboard', title: '時間・速度', defaultVisible: true, defaultWidth: 320, defaultHeight: 122 },
  { id: 'filter', title: '描画フィルター', defaultVisible: false, defaultWidth: 286, defaultHeight: 318, hotkey: 'F9', nativeVisibility: true },
  { id: 'performance', title: 'Performance', defaultVisible: false, defaultWidth: 430, defaultHeight: 520, hotkey: 'KeyP', nativeVisibility: true },
  { id: 'tracking', title: '追跡情報', defaultVisible: true, defaultWidth: 440, defaultHeight: 190, nativeVisibility: true },
];

const managed = new Map<WindowId, ManagedWindow>();
let saved = loadSaved();
let zCounter = 80;
let scheduled = false;
let internalHotkey = false;
let graphCollapsedOnce = false;
let dock: HTMLDivElement | null = null;
let dockMenu: HTMLDivElement | null = null;

function loadSaved(): Record<string, SavedWindowState> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, SavedWindowState> : {};
  } catch {
    return {};
  }
}

function saveAll(): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* storage may be disabled */ }
}

function directBodyDivs(): HTMLDivElement[] {
  return Array.from(document.body.children).filter((el): el is HTMLDivElement => el instanceof HTMLDivElement);
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

function candidate(id: WindowId): HTMLDivElement | null {
  if (id === 'hud') {
    const hud = document.getElementById('hud');
    return hud instanceof HTMLDivElement ? hud : null;
  }
  if (id === 'filter') return document.querySelector<HTMLDivElement>('div[data-render-filter="true"]');
  const divs = directBodyDivs().filter((el) => !el.dataset.citysimWindowShell && !el.dataset.citysimWindowManaged);
  if (id === 'dashboard') {
    return divs.find((el) => el.style.position === 'fixed' && el.style.zIndex === '15' && (el.textContent ?? '').includes('速度')) ?? null;
  }
  if (id === 'performance') {
    return divs.find((el) => el.style.position === 'fixed' && el.style.zIndex === '16' && (el.textContent ?? '').includes('PERFORMANCE')) ?? null;
  }
  return divs.find((el) =>
    el.style.position === 'fixed'
    && el.style.zIndex === '20'
    && el.style.pointerEvents === 'none'
    && el.style.left === '8px'
    && el.style.bottom === '8px',
  ) ?? null;
}

function defaultLeft(config: WindowConfig, width: number): number {
  if (config.id === 'dashboard' || config.id === 'filter' || config.id === 'performance') return Math.max(8, window.innerWidth - width - 8);
  return 8;
}

function defaultTop(config: WindowConfig): number {
  if (config.id === 'dashboard') return 8;
  if (config.id === 'filter') return 150;
  if (config.id === 'performance') return 260;
  if (config.id === 'tracking') return 250;
  return 8;
}

function clampWindow(shell: HTMLDivElement): void {
  const rect = shell.getBoundingClientRect();
  const width = rect.width > 1 ? rect.width : Math.max(1, Number.parseFloat(shell.style.width) || 1);
  const maxLeft = Math.max(0, window.innerWidth - Math.min(width, window.innerWidth));
  const maxTop = Math.max(0, window.innerHeight - 30);
  const parsedLeft = Number.parseFloat(shell.style.left);
  const parsedTop = Number.parseFloat(shell.style.top);
  const left = Math.min(maxLeft, Math.max(0, Number.isFinite(parsedLeft) ? parsedLeft : rect.left));
  const top = Math.min(maxTop, Math.max(0, Number.isFinite(parsedTop) ? parsedTop : rect.top));
  shell.style.left = `${left}px`;
  shell.style.top = `${top}px`;
}

function persistWindow(item: ManagedWindow): void {
  if (item.shell.style.display === 'none') {
    const existing = saved[item.config.id] ?? {};
    saved[item.config.id] = { ...existing, visible: item.desiredVisible };
    saveAll();
    return;
  }
  const rect = item.shell.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  saved[item.config.id] = {
    left: Number.parseFloat(item.shell.style.left) || rect.left,
    top: Number.parseFloat(item.shell.style.top) || rect.top,
    width: rect.width,
    height: rect.height,
    visible: item.desiredVisible,
  };
  saveAll();
}

function nativeDisplayed(item: ManagedWindow): boolean {
  return item.root.style.display !== 'none';
}

function syncVisibility(item: ManagedWindow): void {
  const nativeOk = item.config.nativeVisibility ? nativeDisplayed(item) : true;
  const display = item.desiredVisible && nativeOk ? 'flex' : 'none';
  if (item.shell.style.display !== display) item.shell.style.display = display;
  updateDock();
}

function dispatchHotkey(code: 'KeyP' | 'F9'): void {
  internalHotkey = true;
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'KeyP' ? 'p' : 'F9' }));
  internalHotkey = false;
}

function ensureNativeVisibility(item: ManagedWindow): void {
  if (!item.config.hotkey) {
    syncVisibility(item);
    return;
  }
  if (nativeDisplayed(item) !== item.desiredVisible) dispatchHotkey(item.config.hotkey);
  window.setTimeout(() => syncVisibility(item), 0);
}

function setDesired(id: WindowId, visible: boolean): void {
  const item = managed.get(id); if (!item) return;
  item.desiredVisible = visible;
  if (item.config.nativeVisibility && item.config.hotkey) ensureNativeVisibility(item);
  else syncVisibility(item);
  persistWindow(item);
  if (visible) {
    bringToFront(item.shell);
    clampWindow(item.shell);
  }
}

function toggleWindow(id: WindowId): void {
  const item = managed.get(id); if (!item) return;
  setDesired(id, !item.desiredVisible);
}

function bringToFront(shell: HTMLDivElement): void {
  zCounter++;
  shell.style.zIndex = String(zCounter);
}

function activityGraphSection(): HTMLDivElement | null {
  const dashboard = managed.get('dashboard')?.root;
  if (!dashboard) return null;
  return Array.from(dashboard.children).find((el): el is HTMLDivElement =>
    el instanceof HTMLDivElement && (el.textContent ?? '').includes('時間帯グラフ'),
  ) ?? null;
}

function activityGraphVisible(): boolean {
  const section = activityGraphSection();
  return !!section && section.style.display !== 'none';
}

function syncDashboardGraphSize(): void {
  const item = managed.get('dashboard');
  const section = activityGraphSection();
  if (!item || !section) return;

  if (section.style.display !== 'none') {
    const currentHeight = Number.parseFloat(item.shell.style.height) || item.config.defaultHeight;
    const available = Math.max(72, window.innerHeight - (Number.parseFloat(item.shell.style.top) || 0) - 8);
    const required = Math.min(available, Math.max(240, item.root.scrollHeight + 24));
    if (currentHeight + 1 < required) {
      if (item.shell.dataset.graphAutoExpanded !== 'true') item.shell.dataset.graphPreviousHeight = item.shell.style.height;
      item.shell.dataset.graphAutoExpanded = 'true';
      item.shell.style.height = `${required}px`;
    }
  } else if (item.shell.dataset.graphAutoExpanded === 'true') {
    const previous = Number.parseFloat(item.shell.dataset.graphPreviousHeight ?? '');
    item.shell.style.height = `${Number.isFinite(previous) && previous >= 72 ? previous : item.config.defaultHeight}px`;
    delete item.shell.dataset.graphAutoExpanded;
    delete item.shell.dataset.graphPreviousHeight;
  }
  clampWindow(item.shell);
  updateDock();
}

function toggleActivityGraph(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g' }));
  window.setTimeout(syncDashboardGraphSize, 0);
}

function installDrag(header: HTMLDivElement, item: ManagedWindow): void {
  header.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement | null)?.closest('button')) return;
    event.preventDefault();
    bringToFront(item.shell);
    const rect = item.shell.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY, startLeft = rect.left, startTop = rect.top;
    header.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      item.shell.style.left = `${startLeft + e.clientX - startX}px`;
      item.shell.style.top = `${startTop + e.clientY - startY}px`;
      clampWindow(item.shell);
    };
    const done = (e: PointerEvent): void => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', done);
      header.removeEventListener('pointercancel', done);
      if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId);
      persistWindow(item);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', done);
    header.addEventListener('pointercancel', done);
  });
}

function makeHeader(item: ManagedWindow): HTMLDivElement {
  const header = document.createElement('div');
  header.style.cssText = [
    'height:24px', 'flex:0 0 24px', 'display:flex', 'align-items:center', 'gap:6px', 'padding:0 5px 0 8px',
    'background:rgba(18,27,39,.96)', 'border:1px solid #42546a', 'border-bottom:none', 'border-radius:7px 7px 0 0',
    'color:#dce8f5', 'font:11px/1 ui-monospace,monospace', 'cursor:move', 'user-select:none', 'box-sizing:border-box',
  ].join(';');
  const title = document.createElement('span');
  title.textContent = item.config.title;
  title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = '×'; close.title = '非表示';
  close.style.cssText = 'width:19px;height:18px;padding:0;border:1px solid #53667b;border-radius:4px;background:#172230;color:#cdd8e6;cursor:pointer;font:13px/15px sans-serif';
  close.addEventListener('click', () => setDesired(item.config.id, false));
  header.append(title, close);
  return header;
}

function prepareRoot(root: HTMLDivElement): void {
  root.dataset.citysimWindowManaged = 'true';
  root.style.setProperty('position', 'relative', 'important');
  root.style.setProperty('left', 'auto', 'important');
  root.style.setProperty('right', 'auto', 'important');
  root.style.setProperty('top', 'auto', 'important');
  root.style.setProperty('bottom', 'auto', 'important');
  root.style.setProperty('transform', 'none', 'important');
  root.style.setProperty('width', '100%', 'important');
  root.style.setProperty('max-width', 'none', 'important');
  root.style.setProperty('max-height', 'none', 'important');
  root.style.setProperty('box-sizing', 'border-box', 'important');
  root.style.margin = '0';
}

function register(config: WindowConfig, root: HTMLDivElement): void {
  if (managed.has(config.id) || root.dataset.citysimWindowManaged) return;
  const previous = saved[config.id] ?? {};
  const rect = root.getBoundingClientRect();
  const width = Math.max(180, previous.width ?? (rect.width > 40 ? rect.width : config.defaultWidth));
  const height = Math.max(72, previous.height ?? config.defaultHeight);
  const desiredVisible = previous.visible ?? config.defaultVisible;

  const shell = document.createElement('div');
  shell.dataset.citysimWindowShell = config.id;
  shell.style.cssText = [
    'position:fixed', `left:${previous.left ?? defaultLeft(config, width)}px`, `top:${previous.top ?? defaultTop(config)}px`,
    `width:${width}px`, `height:${height}px`, `z-index:${++zCounter}`, 'display:flex', 'flex-direction:column',
    'min-width:180px', 'min-height:72px', 'max-width:calc(100vw - 4px)', 'max-height:calc(100vh - 4px)',
    'resize:both', 'overflow:hidden', 'box-sizing:border-box', 'pointer-events:auto',
  ].join(';');
  const body = document.createElement('div');
  body.style.cssText = 'flex:1 1 auto;min-height:0;overflow:auto;position:relative;box-sizing:border-box';

  const placeholder = document.createComment(`citysim-window-${config.id}`);
  root.parentNode?.insertBefore(placeholder, root);
  prepareRoot(root);
  body.appendChild(root);
  document.body.appendChild(shell);

  const item: ManagedWindow = { config, root, shell, body, desiredVisible, observer: new MutationObserver(() => {}) };
  const header = makeHeader(item);
  shell.append(header, body);
  installDrag(header, item);
  shell.addEventListener('pointerdown', () => bringToFront(shell));
  const resizeObserver = new ResizeObserver(() => {
    if (shell.style.display === 'none') return;
    const rectNow = shell.getBoundingClientRect();
    if (rectNow.width < 2 || rectNow.height < 2) return;
    clampWindow(shell);
    window.clearTimeout(Number(shell.dataset.persistTimer ?? '0'));
    const timer = window.setTimeout(() => persistWindow(item), 180);
    shell.dataset.persistTimer = String(timer);
  });
  resizeObserver.observe(shell);

  item.observer = new MutationObserver(() => syncVisibility(item));
  item.observer.observe(root, { attributes: true, attributeFilter: ['style'] });
  managed.set(config.id, item);

  if (config.id === 'dashboard') {
    root.style.setProperty('background', 'rgba(10,14,20,.78)', 'important');
    const graphToggle = document.getElementById('citysim-activity-graph-toggle');
    if (graphToggle?.parentElement instanceof HTMLElement) graphToggle.parentElement.style.display = 'none';
    if (!graphCollapsedOnce && (root.textContent ?? '').includes('時間帯グラフ')) {
      graphCollapsedOnce = true;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g' }));
      window.setTimeout(syncDashboardGraphSize, 0);
    }
  }

  if (config.nativeVisibility && config.hotkey) ensureNativeVisibility(item);
  else syncVisibility(item);
  clampWindow(shell);
  persistWindow(item);
}

function findAndRegister(): void {
  removeExternalHighSpeedStatus();
  const before = managed.size;
  for (const config of configs) {
    if (managed.has(config.id)) continue;
    const root = candidate(config.id);
    if (root) register(config, root);
  }
  const hadDock = !!dock;
  ensureDock();
  if (managed.size !== before || !hadDock) updateDock();
}

function resetLayouts(): void {
  saved = {};
  saveAll();
  for (const item of managed.values()) {
    const width = item.config.defaultWidth;
    item.shell.style.width = `${width}px`;
    item.shell.style.height = `${item.config.defaultHeight}px`;
    item.shell.style.left = `${defaultLeft(item.config, width)}px`;
    item.shell.style.top = `${defaultTop(item.config)}px`;
    item.desiredVisible = item.config.defaultVisible;
    if (item.config.nativeVisibility && item.config.hotkey) ensureNativeVisibility(item);
    else syncVisibility(item);
    persistWindow(item);
  }
  if (activityGraphVisible()) toggleActivityGraph();
  window.setTimeout(syncDashboardGraphSize, 0);
}

function dockButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = label;
  button.style.cssText = 'width:100%;text-align:left;padding:5px 7px;border:1px solid #40536a;border-radius:5px;background:#162230;color:#dce7f4;font:11px ui-monospace,monospace;cursor:pointer';
  button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
  return button;
}

function ensureDock(): void {
  if (dock || typeof document === 'undefined') return;
  dock = document.createElement('div');
  dock.dataset.citysimWindowDock = 'true';
  dock.style.cssText = 'position:fixed;left:8px;bottom:44px;z-index:222;font:11px ui-monospace,monospace;user-select:none';
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.textContent = 'UIメニュー'; trigger.title = 'ウィンドウ表示/非表示';
  trigger.style.cssText = 'padding:5px 9px;border:1px solid #536980;border-radius:6px;background:rgba(12,20,29,.94);color:#eef5ff;font:700 11px ui-monospace,monospace;cursor:pointer';
  dockMenu = document.createElement('div');
  dockMenu.style.cssText = 'display:none;position:absolute;left:0;bottom:32px;width:185px;padding:7px;border:1px solid #43566b;border-radius:7px;background:rgba(8,13,19,.96);box-shadow:0 8px 25px rgba(0,0,0,.4)';
  trigger.addEventListener('click', () => { if (dockMenu) dockMenu.style.display = dockMenu.style.display === 'none' ? 'block' : 'none'; });
  dock.append(dockMenu, trigger);
  document.body.appendChild(dock);
}

function updateDock(): void {
  if (!dockMenu) return;
  const wasOpen = dockMenu.style.display !== 'none';
  dockMenu.replaceChildren();
  dockMenu.style.display = wasOpen ? 'block' : 'none';
  const title = document.createElement('div');
  title.textContent = 'ウィンドウ';
  title.style.cssText = 'font-weight:700;color:#eef5ff;margin:1px 2px 6px';
  dockMenu.appendChild(title);
  for (const config of configs) {
    const item = managed.get(config.id);
    const active = item?.desiredVisible ?? false;
    const suffix = config.id === 'performance' ? ' [P]' : config.id === 'filter' ? ' [F9]' : '';
    const button = dockButton(`${active ? '✓' : '○'} ${config.title}${suffix}`, () => toggleWindow(config.id));
    if (!item) { button.disabled = true; button.style.opacity = '0.45'; }
    else if (active) button.style.background = '#284a6b';
    dockMenu.appendChild(button);
  }
  const graphActive = activityGraphVisible();
  const graph = dockButton(`${graphActive ? '✓' : '○'} 活動グラフ [G]`, toggleActivityGraph);
  graph.style.marginTop = '6px';
  dockMenu.appendChild(graph);
  const reset = dockButton('ウィンドウ配置をリセット', resetLayouts);
  reset.style.marginTop = '4px';
  dockMenu.appendChild(reset);
}

function scheduleScan(): void {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    findAndRegister();
  }, 0);
}

// Only watch direct body children. Watching the whole subtree caused updateDock()
// to observe its own replaceChildren() and continuously rebuild the menu DOM.
const observer = new MutationObserver(scheduleScan);
observer.observe(document.body, { childList: true });
window.addEventListener('resize', () => {
  for (const item of managed.values()) clampWindow(item.shell);
  syncDashboardGraphSize();
});
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyG') {
    window.setTimeout(syncDashboardGraphSize, 0);
    return;
  }
  if (internalHotkey) return;
  const id: WindowId | null = event.code === 'KeyP' ? 'performance' : event.code === 'F9' ? 'filter' : null;
  if (!id) return;
  window.setTimeout(() => {
    const item = managed.get(id); if (!item) return;
    item.desiredVisible = nativeDisplayed(item);
    syncVisibility(item);
    persistWindow(item);
  }, 0);
});
window.setInterval(removeExternalHighSpeedStatus, 2000);
window.setTimeout(findAndRegister, 0);
