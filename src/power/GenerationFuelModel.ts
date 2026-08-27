import type { PowerSystem } from './PowerSystem';
import type { GenerationFacility } from './PowerTypes';

export type CriticalSupplyStatus = 'normal' | 'reorder' | 'critical' | 'empty';

export interface GenerationFuelInventorySnapshot {
  facilityId: string;
  material: 'thermal-fuel';
  stockUnits: number;
  capacityUnits: number;
  reservedInboundUnits: number;
  projectedUnits: number;
  reorderPointUnits: number;
  emergencyPointUnits: number;
  maxBurnUnitsPerHour: number;
  hoursRemainingAtFullLoad: number;
  status: CriticalSupplyStatus;
  lastConsumedUnits: number;
  totalReceivedUnits: number;
  totalInternalReceivedUnits: number;
  totalExternalReceivedUnits: number;
}

interface GenerationFuelInventory extends GenerationFuelInventorySnapshot {}

export interface GenerationFuelNeed {
  facilityId: string;
  neededUnits: number;
  hoursRemainingAtFullLoad: number;
  status: CriticalSupplyStatus;
}

const inventories = new WeakMap<PowerSystem, Map<string, GenerationFuelInventory>>();

function mapFor(system: PowerSystem): Map<string, GenerationFuelInventory> {
  let map = inventories.get(system);
  if (!map) { map = new Map(); inventories.set(system, map); }
  return map;
}

function statusFor(item: GenerationFuelInventory): CriticalSupplyStatus {
  if (item.stockUnits <= 1e-9) return 'empty';
  if (item.projectedUnits <= item.emergencyPointUnits) return 'critical';
  if (item.projectedUnits <= item.reorderPointUnits) return 'reorder';
  return 'normal';
}

function refresh(item: GenerationFuelInventory): void {
  item.stockUnits = Math.max(0, Math.min(item.capacityUnits, item.stockUnits));
  item.reservedInboundUnits = Math.max(0, item.reservedInboundUnits);
  item.projectedUnits = item.stockUnits + item.reservedInboundUnits;
  item.hoursRemainingAtFullLoad = item.maxBurnUnitsPerHour > 1e-9 ? item.stockUnits / item.maxBurnUnitsPerHour : Infinity;
  item.status = statusFor(item);
}

export function registerThermalFuelInventory(system: PowerSystem, facility: GenerationFacility): void {
  const map = mapFor(system);
  if (map.has(facility.id)) return;
  const maxOutputMw = Math.max(0, facility.maxOutputKw / 1000);
  const burnPerHour = maxOutputMw * system.config.thermalFuelUnitsPerMwh;
  const capacity = Math.max(1, burnPerHour * system.config.thermalFuelStorageHours);
  const item: GenerationFuelInventory = {
    facilityId: facility.id,
    material: 'thermal-fuel',
    stockUnits: capacity * 0.80,
    capacityUnits: capacity,
    reservedInboundUnits: 0,
    projectedUnits: capacity * 0.80,
    reorderPointUnits: burnPerHour * system.config.thermalFuelReorderHours,
    emergencyPointUnits: burnPerHour * system.config.thermalFuelEmergencyHours,
    maxBurnUnitsPerHour: burnPerHour,
    hoursRemainingAtFullLoad: system.config.thermalFuelStorageHours * 0.80,
    status: 'normal',
    lastConsumedUnits: 0,
    totalReceivedUnits: 0,
    totalInternalReceivedUnits: 0,
    totalExternalReceivedUnits: 0,
  };
  refresh(item);
  map.set(facility.id, item);
}

export function generationFuelAvailabilityFactor(system: PowerSystem, facilityId: string): number {
  const item = inventories.get(system)?.get(facilityId);
  if (!item) return 1;
  if (item.stockUnits <= 1e-9) return 0;
  const oneDispatchInterval = item.maxBurnUnitsPerHour * Math.max(0.25, system.config.updateIntervalSec) / 3600;
  if (oneDispatchInterval <= 1e-9) return 1;
  return Math.max(0, Math.min(1, item.stockUnits / oneDispatchInterval));
}

export function consumeGenerationFuel(system: PowerSystem, elapsedSec: number): void {
  if (!(elapsedSec > 0)) return;
  const map = inventories.get(system);
  if (!map) return;
  const elapsedHours = elapsedSec / 3600;
  for (const facility of system.generationFacilities) {
    const item = map.get(facility.id);
    if (!item) continue;
    const outputMw = Math.max(0, facility.currentOutputKw / 1000);
    const consumed = Math.min(item.stockUnits, outputMw * elapsedHours * system.config.thermalFuelUnitsPerMwh);
    item.stockUnits -= consumed;
    item.lastConsumedUnits = consumed;
    refresh(item);
  }
}

export function generationFuelNeeds(system: PowerSystem): GenerationFuelNeed[] {
  const map = inventories.get(system);
  if (!map) return [];
  const needs: GenerationFuelNeed[] = [];
  for (const item of map.values()) {
    refresh(item);
    if (item.projectedUnits > item.reorderPointUnits + 1e-9) continue;
    const target = item.capacityUnits * 0.90;
    const neededUnits = Math.max(0, target - item.projectedUnits);
    if (neededUnits <= 1e-9) continue;
    needs.push({
      facilityId: item.facilityId,
      neededUnits,
      hoursRemainingAtFullLoad: item.hoursRemainingAtFullLoad,
      status: item.status,
    });
  }
  const rank = (status: CriticalSupplyStatus): number => status === 'empty' ? 0 : status === 'critical' ? 1 : status === 'reorder' ? 2 : 3;
  needs.sort((a, b) => rank(a.status) - rank(b.status) || a.hoursRemainingAtFullLoad - b.hoursRemainingAtFullLoad || a.facilityId.localeCompare(b.facilityId));
  return needs;
}

export function reserveGenerationFuelInbound(system: PowerSystem, facilityId: string, amount: number): boolean {
  const item = inventories.get(system)?.get(facilityId);
  if (!item || !(amount > 0)) return false;
  const room = Math.max(0, item.capacityUnits - item.projectedUnits);
  if (room <= 1e-9) return false;
  item.reservedInboundUnits += Math.min(amount, room);
  refresh(item);
  return true;
}

export function cancelGenerationFuelInbound(system: PowerSystem, facilityId: string, amount: number): void {
  const item = inventories.get(system)?.get(facilityId);
  if (!item) return;
  item.reservedInboundUnits = Math.max(0, item.reservedInboundUnits - Math.max(0, amount));
  refresh(item);
}

export function receiveGenerationFuel(
  system: PowerSystem,
  facilityId: string,
  amount: number,
  source: 'internal' | 'external',
): number {
  const item = inventories.get(system)?.get(facilityId);
  if (!item || !(amount > 0)) return 0;
  const normalized = Math.max(0, amount);
  item.reservedInboundUnits = Math.max(0, item.reservedInboundUnits - normalized);
  const accepted = Math.min(normalized, Math.max(0, item.capacityUnits - item.stockUnits));
  item.stockUnits += accepted;
  item.totalReceivedUnits += accepted;
  if (source === 'internal') item.totalInternalReceivedUnits += accepted;
  else item.totalExternalReceivedUnits += accepted;
  refresh(item);
  return accepted;
}

export function generationFuelSnapshots(system: PowerSystem): GenerationFuelInventorySnapshot[] {
  const map = inventories.get(system);
  if (!map) return [];
  const out: GenerationFuelInventorySnapshot[] = [];
  for (const item of map.values()) {
    refresh(item);
    out.push({ ...item });
  }
  return out.sort((a, b) => a.facilityId.localeCompare(b.facilityId));
}
