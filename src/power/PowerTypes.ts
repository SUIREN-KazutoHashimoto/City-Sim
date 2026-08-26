export const KW_PER_MW = 1000;
export function mwToKw(valueMw: number): number { return valueMw * KW_PER_MW; }
export function kwToMw(valueKw: number): number { return valueKw / KW_PER_MW; }

export enum PowerGridState { Normal = 'normal', Tight = 'tight', LimitedSupply = 'limited-supply', Blackout = 'blackout' }
export enum GenerationType { Thermal = 'thermal', Solar = 'solar' }
export enum PowerAssetState { Online = 'online', Standby = 'standby', Offline = 'offline', Fault = 'fault' }
export enum PowerLineState { Active = 'active', Broken = 'broken' }
export enum BuildingPowerState { Supplied = 'supplied', Limited = 'limited', Blackout = 'blackout', Disconnected = 'disconnected' }
export enum PowerPriority { Critical = 0, High = 1, Medium = 2, Low = 3 }

export interface PowerConfig {
  enabled: boolean;
  updateIntervalSec: number;
  thermalPlantCount: number;
  thermalPlantCapacityMw: number;
  solarPlantCount: number;
  solarPlantCapacityMw: number;
  externalConnectionCount: number;
  externalGridCapacityMw: number;
  substationSpacingMeters: number;
  substationCapacityMw: number;
  substationServiceRadiusMeters: number;
  lineCapacityHighwayMw: number;
  lineCapacityArterialMw: number;
  lineCapacityCollectorMw: number;
  lineCapacityLocalMw: number;
  lineCapacityPathMw: number;
  tightReserveMarginRatio: number;
  blackoutSupplyRatio: number;
}

export const DEFAULT_POWER_CONFIG: PowerConfig = {
  enabled: true,
  updateIntervalSec: 5,
  thermalPlantCount: 2,
  thermalPlantCapacityMw: 350,
  solarPlantCount: 3,
  solarPlantCapacityMw: 90,
  externalConnectionCount: 2,
  externalGridCapacityMw: 600,
  substationSpacingMeters: 1800,
  substationCapacityMw: 75,
  substationServiceRadiusMeters: 2600,
  lineCapacityHighwayMw: 260,
  lineCapacityArterialMw: 180,
  lineCapacityCollectorMw: 110,
  lineCapacityLocalMw: 55,
  lineCapacityPathMw: 12,
  tightReserveMarginRatio: 0.15,
  blackoutSupplyRatio: 0.05,
};

export interface GenerationFacility {
  id: string;
  type: GenerationType;
  x: number;
  z: number;
  roadNodeId: number;
  maxOutputKw: number;
  availableOutputKw: number;
  currentOutputKw: number;
  utilization: number;
  state: PowerAssetState;
}

export interface ExternalGridConnection {
  id: string;
  x: number;
  z: number;
  roadNodeId: number;
  maxImportKw: number;
  currentImportKw: number;
  utilization: number;
  state: PowerAssetState;
}

export interface PowerLineSegment {
  id: number;
  fromNodeId: number;
  toNodeId: number;
  roadEdgeIds: number[];
  lengthMeters: number;
  capacityKw: number;
  currentLoadKw: number;
  state: PowerLineState;
}

export interface Substation {
  id: string;
  x: number;
  z: number;
  roadNodeId: number;
  district: number;
  capacityKw: number;
  demandKw: number;
  suppliedKw: number;
  utilization: number;
  overload: boolean;
  state: PowerAssetState;
  sourceId: string | null;
  sourcePathSegmentIds: number[];
  sourcePathCapacityKw: number;
  assignedBuildingCount: number;
}

export interface BuildingPowerConnection {
  buildingId: number;
  roadNodeId: number;
  substationId: string | null;
  distributionDistanceMeters: number;
  outsideServiceRadius: boolean;
  demandKw: number;
  suppliedKw: number;
  supplyRatio: number;
  priority: PowerPriority;
  state: BuildingPowerState;
}

export interface PowerSnapshot {
  state: PowerGridState;
  demandMw: number;
  suppliedMw: number;
  cityGenerationMw: number;
  externalImportMw: number;
  availableCapacityMw: number;
  reserveMw: number;
  reserveMarginRatio: number;
  generationFacilityCount: number;
  externalConnectionCount: number;
  substationCount: number;
  overloadedSubstationCount: number;
  lineSegmentCount: number;
  brokenLineSegmentCount: number;
  overloadedLineSegmentCount: number;
  buildingCount: number;
  blackoutBuildingCount: number;
  limitedBuildingCount: number;
  disconnectedBuildingCount: number;
  lastUpdateSimSeconds: number;
}

export interface GenerationFacilitySnapshot {
  id: string;
  type: GenerationType;
  state: PowerAssetState;
  x: number;
  z: number;
  roadNodeId: number;
  maxOutputMw: number;
  availableOutputMw: number;
  currentOutputMw: number;
  utilization: number;
}

export interface ExternalGridConnectionSnapshot {
  id: string;
  state: PowerAssetState;
  x: number;
  z: number;
  roadNodeId: number;
  maxImportMw: number;
  currentImportMw: number;
  utilization: number;
}

export interface SubstationSnapshot {
  id: string;
  state: PowerAssetState;
  x: number;
  z: number;
  roadNodeId: number;
  capacityMw: number;
  demandMw: number;
  suppliedMw: number;
  utilization: number;
  overload: boolean;
  sourceId: string | null;
  sourcePathLength: number;
  sourcePathCapacityMw: number;
  assignedBuildingCount: number;
}

export interface PowerLineSegmentSnapshot {
  id: number;
  fromNodeId: number;
  toNodeId: number;
  lengthMeters: number;
  capacityMw: number;
  currentLoadMw: number;
  loadRatio: number;
  state: PowerLineState;
}

export interface BuildingPowerSnapshot {
  buildingId: number;
  roadNodeId: number;
  substationId: string | null;
  distributionDistanceMeters: number;
  outsideServiceRadius: boolean;
  demandKw: number;
  suppliedKw: number;
  supplyRatio: number;
  priority: PowerPriority;
  state: BuildingPowerState;
}
