import { POICategory } from '../world/POI';
import { registerLifelineWorkplace } from '../world/LifelineWorkforce';
import type { PowerSystem } from './PowerSystem';
import { GenerationType } from './PowerTypes';
import { registerThermalFuelInventory } from './GenerationFuelModel';

const registered = new WeakSet<PowerSystem>();

function rosterStaffFor(system: PowerSystem, type: GenerationType, maxOutputKw: number): number {
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
    const rosterTarget = rosterStaffFor(system, facility.type, facility.maxOutputKw);
    const concurrentStaff = Math.max(1, Math.ceil(rosterTarget * system.config.lifelineOnDutyRatio));
    const shiftsPerDay = 3;
    const poiId = poi.add({
      category: POICategory.Work,
      x: facility.x,
      z: facility.z,
      priceTier: 0.48,
      // Workplace capacity is the total roster. Only lifelineOnDutyRatio needs to be on duty
      // for full operational efficiency; the three shifts divide this roster over the day.
      capacity: rosterTarget,
      buildingId: -1,
    });
    registerLifelineWorkplace(poi, poiId, {
      key: `power-generation:${facility.id}`,
      label: facility.type === GenerationType.Thermal ? `火力発電所 ${facility.id}` : `太陽光発電所 ${facility.id}`,
      kind: 'power-generation',
      concurrentStaff,
      rosterTarget,
      shiftsPerDay,
      priority: 0,
    });
    if (facility.type === GenerationType.Thermal) registerThermalFuelInventory(system, facility);
  }
}
