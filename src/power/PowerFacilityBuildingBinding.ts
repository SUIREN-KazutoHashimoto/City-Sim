import {
  plannedPowerFacilityByKey,
  plannedPowerFacilityBuildings,
  type PlannedPowerFacilityBuilding,
} from '../generation/PowerFacilityGeneration';
import type { PowerSystem } from './PowerSystem';
import { GenerationType } from './PowerTypes';

export type PowerFacilityBuildingKind = 'generation' | 'substation' | 'external';

export interface PowerFacilityBuildingBinding {
  key: string;
  kind: PowerFacilityBuildingKind;
  label: string;
  buildingId: number;
  workPoiId: number;
}

const bindingsBySystem = new WeakMap<PowerSystem, Map<string, PowerFacilityBuildingBinding>>();
const bindingsByBuilding = new WeakMap<PowerSystem, Map<number, PowerFacilityBuildingBinding>>();

export function generationRosterTarget(system: PowerSystem, type: GenerationType, maxOutputKw: number): number {
  const maxOutputMw = Math.max(0, maxOutputKw / 1000);
  const per100 = type === GenerationType.Thermal
    ? system.config.thermalPlantStaffPer100Mw
    : system.config.solarPlantStaffPer100Mw;
  const minimum = type === GenerationType.Thermal ? 8 : 2;
  return Math.max(minimum, Math.ceil(maxOutputMw / 100 * per100));
}

function toBinding(plan: PlannedPowerFacilityBuilding): PowerFacilityBuildingBinding {
  return {
    key: plan.key,
    kind: plan.kind,
    label: plan.label,
    buildingId: plan.buildingId,
    workPoiId: plan.workPoiId,
  };
}

function remember(system: PowerSystem, binding: PowerFacilityBuildingBinding): void {
  let byKey = bindingsBySystem.get(system);
  if (!byKey) { byKey = new Map(); bindingsBySystem.set(system, byKey); }
  let byBuilding = bindingsByBuilding.get(system);
  if (!byBuilding) { byBuilding = new Map(); bindingsByBuilding.set(system, byBuilding); }
  byKey.set(binding.key, binding);
  byBuilding.set(binding.buildingId, binding);
}

function applyPlan(system: PowerSystem, key: string): PlannedPowerFacilityBuilding | null {
  const plan = plannedPowerFacilityByKey(system.city, key);
  if (!plan) return null;
  remember(system, toBinding(plan));
  return plan;
}

export function bindPowerFacilitiesToBuildings(system: PowerSystem): void {
  if (bindingsBySystem.has(system)) return;
  bindingsBySystem.set(system, new Map());
  bindingsByBuilding.set(system, new Map());

  for (const facility of system.generationFacilities) {
    const plan = applyPlan(system, `generation:${facility.id}`);
    if (!plan) continue;
    facility.x = plan.x;
    facility.z = plan.z;
    facility.roadNodeId = plan.roadNodeId;
  }

  for (const connection of system.externalConnections) {
    const plan = applyPlan(system, `external:${connection.id}`);
    if (!plan) continue;
    connection.x = plan.x;
    connection.z = plan.z;
    connection.roadNodeId = plan.roadNodeId;
  }

  for (const substation of system.substations) {
    const plan = applyPlan(system, `substation:${substation.id}`);
    if (!plan) continue;
    substation.x = plan.x;
    substation.z = plan.z;
    substation.roadNodeId = plan.roadNodeId;
    substation.district = plan.district;
  }

  const planned = plannedPowerFacilityBuildings(system.city);
  const bound = bindingsBySystem.get(system)?.size ?? 0;
  if (planned.length !== bound) {
    console.warn('[City-Sim] some generated power facility buildings were not bound to logical assets', {
      planned: planned.length,
      bound,
    });
  }

  // Logical source/substation paths are rebuilt against the frontage road nodes of the already-generated buildings.
  system.rebuildTopology();
}

export function powerFacilityBuildingBinding(system: PowerSystem, key: string): PowerFacilityBuildingBinding | null {
  return bindingsBySystem.get(system)?.get(key) ?? null;
}

export function powerFacilityForBuilding(system: PowerSystem, buildingId: number): PowerFacilityBuildingBinding | null {
  return bindingsByBuilding.get(system)?.get(buildingId) ?? null;
}

export function powerFacilityBindings(system: PowerSystem): readonly PowerFacilityBuildingBinding[] {
  return [...(bindingsBySystem.get(system)?.values() ?? [])];
}
