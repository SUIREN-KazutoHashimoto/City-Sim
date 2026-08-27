import type { Building } from '../generation/CityGenerator';
import { powerFacilityBuildingBinding } from '../power/PowerFacilityBuildingBinding';
import { World } from '../world/World';
import { FirstPersonController } from './FirstPersonController';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

let latestWorld: World | null = null;
let latestController: FirstPersonController | null = null;

function powerKeyFromRowTitle(title: string): string | null {
  if (title.startsWith('火力 ')) return `generation:${title.slice('火力 '.length).trim()}`;
  if (title.startsWith('太陽光 ')) return `generation:${title.slice('太陽光 '.length).trim()}`;
  if (title.startsWith('外部系統 ')) return `external:${title.slice('外部系統 '.length).trim()}`;
  if (title.startsWith('substation-')) return `substation:${title.trim()}`;
  return null;
}

function findMenuButton(): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'MENU  F10') ?? null;
}

function closeMenu(main: HTMLElement): void {
  const overlay = main.parentElement;
  const button = findMenuButton();
  if (!overlay || !button) return;
  if (overlay.style.display !== 'none') button.click();
}

function cameraTargetForBuilding(building: Building): {
  x: number;
  y: number;
  z: number;
  lookY: number;
} {
  const height = Math.max(3.2, building.floors * 3.2);
  const footprint = Math.max(building.width, building.depth);
  const distance = Math.max(24, footprint * 1.45);
  const lateral = Math.min(12, distance * 0.18);
  let x = building.x + lateral;
  let z = building.z + lateral;

  if (building.frontage === 'north') z = building.z - distance;
  else if (building.frontage === 'south') z = building.z + distance;
  else if (building.frontage === 'west') x = building.x - distance;
  else x = building.x + distance;

  return {
    x,
    y: Math.max(9, height * 0.72 + 7),
    z,
    lookY: Math.max(2.2, Math.min(height * 0.48, 12)),
  };
}

function showJumpToast(label: string): void {
  let toast = document.getElementById('citysim-power-facility-jump-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'citysim-power-facility-jump-toast';
    toast.style.cssText = [
      'position:fixed', 'left:50%', 'top:18px', 'transform:translateX(-50%)',
      'z-index:50', 'pointer-events:none', 'padding:8px 12px',
      'border:1px solid #607b98', 'border-radius:7px',
      'background:rgba(8,15,23,.90)', 'color:#edf5ff',
      'font:700 12px/1.3 ui-monospace,monospace', 'box-shadow:0 4px 18px rgba(0,0,0,.35)',
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = label;
  toast.style.display = 'block';
  window.setTimeout(() => {
    const current = document.getElementById('citysim-power-facility-jump-toast');
    if (current?.textContent === label) current.style.display = 'none';
  }, 2200);
}

function jumpToPowerBuilding(main: HTMLElement, key: string): boolean {
  const world = latestWorld;
  const controller = latestController as unknown as AnyHost | null;
  if (!world || !controller) return false;

  const binding = powerFacilityBuildingBinding(world.power, key);
  if (!binding) return false;
  const building = world.city.buildings.find((item) => item.id === binding.buildingId) ?? world.city.buildings[binding.buildingId];
  if (!building) return false;

  const camera = controller.camera as {
    position?: { set: (x: number, y: number, z: number) => void };
    lookAt?: (x: number, y: number, z: number) => void;
  } | undefined;
  if (!camera?.position || !camera.lookAt) return false;

  controller.setFollowTarget?.(null);
  closeMenu(main);

  const target = cameraTargetForBuilding(building);
  camera.position.set(target.x, target.y, target.z);
  camera.lookAt(building.x, target.lookY, building.z);
  controller.syncFreeAnglesFromCamera?.();
  controller.update?.(0);
  showJumpToast(binding.label);
  return true;
}

function handlePowerJump(event: Event): void {
  const element = event.target;
  const button = element instanceof HTMLElement ? element.closest('button') : null;
  if (!(button instanceof HTMLButtonElement) || button.textContent?.trim() !== 'ジャンプ') return;

  const main = button.closest('main') as HTMLElement | null;
  const overlay = main?.parentElement;
  const aside = overlay?.querySelector<HTMLElement>(':scope > aside');
  if (!main || !aside?.textContent?.includes('CITY SIM MENU')) return;
  if (main.querySelector('h1')?.textContent?.trim() !== '電力') return;

  const row = button.parentElement;
  const title = row?.firstElementChild?.textContent?.trim() ?? '';
  const key = powerKeyFromRowTitle(title);
  if (!key) return;

  if (jumpToPowerBuilding(main, key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

document.addEventListener('click', handlePowerJump, true);

const worldProto = World.prototype as unknown as AnyHost;
if (!worldProto.__citySimPowerFacilityJumpWorldV1027) {
  const previousPopulate = worldProto.populate as AnyMethod;
  worldProto.populate = function populateWithPowerFacilityJumpCapture(this: World, ...args: any[]): any {
    latestWorld = this;
    const result = previousPopulate.apply(this, args);
    latestWorld = this;
    return result;
  };
  worldProto.__citySimPowerFacilityJumpWorldV1027 = true;
}

const controllerProto = FirstPersonController.prototype as unknown as AnyHost;
if (!controllerProto.__citySimPowerFacilityJumpControllerV1027) {
  const previousSetPosition = controllerProto.setPosition as AnyMethod;
  controllerProto.setPosition = function setPositionWithPowerFacilityJumpCapture(this: FirstPersonController, ...args: any[]): any {
    latestController = this;
    return previousSetPosition.apply(this, args);
  };
  controllerProto.__citySimPowerFacilityJumpControllerV1027 = true;
}
