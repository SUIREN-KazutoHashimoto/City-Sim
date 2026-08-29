export {};

const COPYRIGHT = '© 2026 Machi-Sim contributors';
const IDENTITY_PATTERN = /v\s*(\d+\.\d+\.\d+)/i;

function enforceIdentity(): void {
  const el = document.getElementById('app-version');
  if (!(el instanceof HTMLElement)) return;
  const match = (el.textContent ?? '').match(IDENTITY_PATTERN);
  if (!match) return;
  const desired = `Machi-Sim v${match[1]} · ${COPYRIGHT}`;
  if (el.textContent !== desired) el.textContent = desired;
}

function tuneUiDock(): void {
  const dock = document.querySelector<HTMLDivElement>('div[data-citysim-window-dock="true"]');
  if (!dock) return;
  dock.style.left = '8px';
  dock.style.right = 'auto';
  dock.style.bottom = '44px';
  dock.style.zIndex = '222';

  const trigger = Array.from(dock.children).find((el): el is HTMLButtonElement => el instanceof HTMLButtonElement);
  if (trigger) {
    trigger.textContent = 'UIメニュー';
    trigger.title = 'ウィンドウ表示/非表示';
    trigger.style.float = 'none';
  }

  const menu = Array.from(dock.children).find((el): el is HTMLDivElement => el instanceof HTMLDivElement);
  if (menu) {
    menu.style.left = '0';
    menu.style.right = 'auto';
    menu.style.bottom = '32px';
  }
}

function tuneBenchmarkDock(): void {
  let root = document.querySelector<HTMLDivElement>('div[data-citysim-benchmark-dock="true"]');
  let button: HTMLButtonElement | null = root?.querySelector('button') ?? null;

  if (!root) {
    for (const candidate of document.querySelectorAll<HTMLButtonElement>('button')) {
      const label = (candidate.textContent ?? '').trim();
      if (label !== 'BENCH' && label !== 'ベンチマーク') continue;
      const parent = candidate.parentElement;
      if (!(parent instanceof HTMLDivElement) || parent.style.position !== 'fixed') continue;
      root = parent;
      button = candidate;
      break;
    }
  }
  if (!root || !button) return;

  root.dataset.citysimBenchmarkDock = 'true';
  root.style.left = '8px';
  root.style.right = 'auto';
  root.style.bottom = '8px';
  root.style.zIndex = '221';
  button.textContent = 'ベンチマーク';
}

function tuneChrome(): void {
  enforceIdentity();
  tuneUiDock();
  tuneBenchmarkDock();
}

function install(): void {
  if (typeof document === 'undefined' || !document.body) return;

  const identity = document.getElementById('app-version');
  if (identity) {
    const identityObserver = new MutationObserver(enforceIdentity);
    identityObserver.observe(identity, { childList: true, characterData: true, subtree: true });
  }

  // Both the managed-window dock and benchmark controls are direct body children.
  // Watching only body child additions avoids observing the frequently-updated HUD.
  const bodyObserver = new MutationObserver(tuneChrome);
  bodyObserver.observe(document.body, { childList: true });

  window.addEventListener('citysim-ready', tuneChrome);
  window.setInterval(tuneChrome, 1000);
  tuneChrome();
}

install();
