import { registerLifelineWorkplace } from '../world/LifelineWorkforce';
import { registerThermalFuelInventory } from './GenerationFuelModel';
import {
  generationRosterTarget,
  powerFacilityBuildingBinding,
} from './PowerFacilityBuildingBinding';
import type { PowerSystem } from './PowerSystem';
import { GenerationType } from './PowerTypes';

const registered = new WeakSet<PowerSystem>();

function registerBoundWorkplace(
  system: PowerSystem,
  key: string,
  label: string,
  kind: 'power-generation' | 'grid-control',
  rosterTarget: number,
): void {
  const binding = powerFacilityBuildingBinding(system, key);
  if (!binding) return;
  registerLifelineWorkplace(system.city.poi, binding.workPoiId, {
    key: kind === 'power-generation' ? `power-generation:${key.slice('generation:'.length)}` : `grid-control:${key}`,
    label,
    kind,
    concurrentStaff: Math.max(1, Math.ceil(rosterTarget * system.config.lifelineOnDutyRatio)),
    rosterTarget,
    shiftsPerDay: 3,
    priority: 0,
  });
}

export function registerPowerLifelineFacilities(system: PowerSystem): void {
  if (registered.has(system)) return;
  registered.add(system);

  for (const facility of system.generationFacilities) {
    const rosterTarget = generationRosterTarget(system, facility.type, facility.maxOutputKw);
    registerBoundWorkplace(
      system,
      `generation:${facility.id}`,
      facility.type === GenerationType.Thermal ? `火力発電所 ${facility.id}` : `太陽光発電所 ${facility.id}`,
      'power-generation',
      rosterTarget,
    );
    if (facility.type === GenerationType.Thermal) registerThermalFuelInventory(system, facility);
  }

  for (const substation of system.substations) {
    registerBoundWorkplace(system, `substation:${substation.id}`, `変電所 ${substation.id}`, 'grid-control', 4);
  }

  for (const connection of system.externalConnections) {
    registerBoundWorkplace(system, `external:${connection.id}`, `外部受電所 ${connection.id}`, 'grid-control', 6);
  }
}
