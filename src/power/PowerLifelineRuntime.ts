import { POICategory } from '../world/POI';
import { registerLifelineWorkplace } from '../world/LifelineWorkforce';
import type { PowerSystem } from './PowerSystem';
import { GenerationType } from './PowerTypes';
import { registerThermalFuelInventory } from './GenerationFuelModel';

const registered = new WeakSet<PowerSystem>();

function concurrentStaffFor(system: PowerSystem, type: GenerationType, maxOutputKw: number): number {
  const maxOutputMw = Math.max(0, maxOutputKw / 1000);
  const per100 = type === GenerationType.Thermal
    ? system.config.thermalPlantStaffPer100Mw
    : system.config.solarPlantStaffPer100Mw;
  const minimum = type === GenerationType.Thermal ? 8 : 2;
  return Math.max(minimum, Math.ceil(maxOutputMw / 100 * per100));
}

export function registerPowerLifelineFacilities(system: PowerSystem): void {
  if (registered.has(system)) return;
  registered.add(system);
  const poi = system.city.poi;
  for (const facility of system.generationFacilities) {
    const concurrentStaff = concurrentStaffFor(system, facility.type, facility.maxOutputKw);
    const rosterTarget = Math.max(
      concurrentStaff * 3,
      Math.ceil(concurrentStaff * 3 * system.config.lifelineRosterReliefRatio),
    );
    const poiId = poi.add({
      category: POICategory.Work,
      x: facility.x,
      z: facility.z,
      priceTier: 0.48,
      capacity: rosterTarget,
      buildingId: -1,
    });
    registerLifelineWorkplace(poi, poiId, {
      key: `power-generation:${facility.id}`,
      label: facility.type === GenerationType.Thermal ? `火力発電所 ${facility.id}` : `太陽光発電所 ${facility.id}`,
      kind: 'power-generation',
      concurrentStaff,
      rosterTarget,
      shiftsPerDay: 3,
      priority: 0,
    });
    if (facility.type === GenerationType.Thermal) registerThermalFuelInventory(system, facility);
  }
}
