import type { POIRegistry } from './POI';

export type LifelineWorkplaceKind =
  | 'power-generation'
  | 'grid-control'
  | 'water'
  | 'sewage'
  | 'telecom'
  | 'gas'
  | 'emergency-service'
  | 'other-lifeline';

export interface LifelineWorkplaceSpec {
  poiId: number;
  key: string;
  label: string;
  kind: LifelineWorkplaceKind;
  concurrentStaff: number;
  rosterTarget: number;
  shiftsPerDay: number;
  priority: number;
}

export interface LifelineWorkplaceRegistration {
  key: string;
  label: string;
  kind: LifelineWorkplaceKind;
  concurrentStaff: number;
  rosterTarget: number;
  shiftsPerDay?: number;
  priority?: number;
}

const byPoi = new WeakMap<POIRegistry, Map<number, LifelineWorkplaceSpec>>();
const byKey = new WeakMap<POIRegistry, Map<string, LifelineWorkplaceSpec>>();

function poiMap(poi: POIRegistry): Map<number, LifelineWorkplaceSpec> {
  let map = byPoi.get(poi);
  if (!map) { map = new Map(); byPoi.set(poi, map); }
  return map;
}

function keyMap(poi: POIRegistry): Map<string, LifelineWorkplaceSpec> {
  let map = byKey.get(poi);
  if (!map) { map = new Map(); byKey.set(poi, map); }
  return map;
}

export function registerLifelineWorkplace(
  poi: POIRegistry,
  poiId: number,
  registration: LifelineWorkplaceRegistration,
): LifelineWorkplaceSpec {
  const shifts = Math.max(1, Math.floor(registration.shiftsPerDay ?? 3));
  const concurrentStaff = Math.max(1, Math.floor(registration.concurrentStaff));
  const rosterTarget = Math.max(concurrentStaff * shifts, Math.floor(registration.rosterTarget));
  const spec: LifelineWorkplaceSpec = {
    poiId,
    key: registration.key,
    label: registration.label,
    kind: registration.kind,
    concurrentStaff,
    rosterTarget,
    shiftsPerDay: shifts,
    priority: Math.max(0, Math.floor(registration.priority ?? 0)),
  };
  poiMap(poi).set(poiId, spec);
  keyMap(poi).set(spec.key, spec);
  return spec;
}

export function lifelineWorkplaceForPoi(poi: POIRegistry, poiId: number): LifelineWorkplaceSpec | null {
  return byPoi.get(poi)?.get(poiId) ?? null;
}

export function lifelineWorkplaceForKey(poi: POIRegistry, key: string): LifelineWorkplaceSpec | null {
  return byKey.get(poi)?.get(key) ?? null;
}

export function isLifelineWorkplace(poi: POIRegistry, poiId: number): boolean {
  return byPoi.get(poi)?.has(poiId) ?? false;
}

export function lifelineWorkplaces(poi: POIRegistry): readonly LifelineWorkplaceSpec[] {
  return [...(byPoi.get(poi)?.values() ?? [])];
}
