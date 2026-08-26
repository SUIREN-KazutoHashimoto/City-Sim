import { BuildingArchetype, type Building, type CityGenerator } from '../generation/CityGenerator';
import { FacilityType, type FacilityRecord } from '../generation/SpecialFacilityPlanner';
import { POICategory, type POI } from '../world/POI';
import { BuildingPowerState, PowerLoadKind, PowerPriority, type InfrastructurePowerLoad } from './PowerTypes';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class PowerDemandModel {
  private readonly poisByBuilding = new Map<number, POI[]>();
  private readonly facilitiesByBuilding = new Map<number, FacilityRecord>();

  constructor(private readonly city: CityGenerator) {
    for (const poi of city.poi.all()) {
      if (poi.buildingId < 0) continue;
      const list = this.poisByBuilding.get(poi.buildingId);
      if (list) list.push(poi);
      else this.poisByBuilding.set(poi.buildingId, [poi]);
    }
    for (const facility of city.facilities) this.facilitiesByBuilding.set(facility.buildingId, facility);
  }

  buildingDemandKw(building: Building, totalSimSeconds: number): number {
    const hour = ((totalSimSeconds / 3600) % 24 + 24) % 24;
    const facility = this.facilitiesByBuilding.get(building.id);
    const floorUnits = Math.max(0.2, building.grossFloorArea / 100);
    const baseKwPer100m2 = this.baseKwPer100m2(building, facility);
    const operatingRatio = this.operatingRatio(building);
    const timeFactor = this.timeFactor(building, facility, hour);
    return Math.max(0.05, baseKwPer100m2 * floorUnits * operatingRatio * timeFactor);
  }

  buildingPriority(building: Building): PowerPriority {
    const facility = this.facilitiesByBuilding.get(building.id);
    if (facility?.type === FacilityType.Hospital || facility?.type === FacilityType.PoliceStation || facility?.type === FacilityType.FireStation) return PowerPriority.Critical;
    if (facility?.type === FacilityType.CityHall || facility?.type === FacilityType.University || facility?.type === FacilityType.School) return PowerPriority.High;
    if (facility?.type === FacilityType.Mall || facility?.type === FacilityType.Supermarket || facility?.type === FacilityType.Hotel) return PowerPriority.Medium;
    if (building.archetype === BuildingArchetype.Factory || building.archetype === BuildingArchetype.Warehouse) return PowerPriority.Medium;
    if (building.archetype === BuildingArchetype.SmallOffice || building.archetype === BuildingArchetype.OfficeSlab || building.archetype === BuildingArchetype.OfficeTower
      || building.archetype === BuildingArchetype.SmallShop || building.archetype === BuildingArchetype.RetailBox || building.archetype === BuildingArchetype.CommercialBlock
      || building.archetype === BuildingArchetype.MixedUse) return PowerPriority.Medium;
    return PowerPriority.Low;
  }

  createInfrastructureLoads(): InfrastructurePowerLoad[] {
    const loads: InfrastructurePowerLoad[] = [];
    for (const node of this.city.net.nodes) {
      if (!node.hasSignal) continue;
      loads.push(this.makeLoad(`road-signal-${node.id}`, PowerLoadKind.RoadSignal, node.id, PowerPriority.Critical));
    }

    const seenSegments = new Set<string>();
    for (const edge of this.city.net.edges) {
      const lo = Math.min(edge.from, edge.to), hi = Math.max(edge.from, edge.to), key = `${lo}:${hi}`;
      if (seenSegments.has(key)) continue;
      seenSegments.add(key);
      loads.push(this.makeLoad(`street-light-${lo}-${hi}`, PowerLoadKind.StreetLight, lo, PowerPriority.Low));
    }

    const rail = this.city.planning.rail;
    for (const station of rail.stations) {
      const roadNodeId = this.city.net.nearestNode(station.x, station.z);
      loads.push(this.makeLoad(`rail-station-${station.id}`, PowerLoadKind.RailStation, roadNodeId, PowerPriority.High));
    }
    for (const line of rail.lines) {
      if (!line.path.length) continue;
      const mid = line.path[Math.floor(line.path.length / 2)];
      const roadNodeId = this.city.net.nearestNode(mid.x, mid.z);
      loads.push(this.makeLoad(`rail-signal-${line.id}`, PowerLoadKind.RailSignal, roadNodeId, PowerPriority.Critical));
      loads.push(this.makeLoad(`rail-traction-${line.id}`, PowerLoadKind.RailTraction, roadNodeId, PowerPriority.High));
    }
    return loads;
  }

  updateInfrastructureDemand(load: InfrastructurePowerLoad, totalSimSeconds: number): void {
    const hour = ((totalSimSeconds / 3600) % 24 + 24) % 24;
    if (load.kind === PowerLoadKind.RoadSignal) load.demandKw = 1.2;
    else if (load.kind === PowerLoadKind.StreetLight) load.demandKw = hour >= 18 || hour < 6 ? 0.11 : 0;
    else if (load.kind === PowerLoadKind.RailSignal) load.demandKw = 85;
    else if (load.kind === PowerLoadKind.RailStation) load.demandKw = this.railServiceFactor(hour) * 220;
    else load.demandKw = this.railServiceFactor(hour) * 3500;
  }

  private makeLoad(id: string, kind: PowerLoadKind, roadNodeId: number, priority: PowerPriority): InfrastructurePowerLoad {
    return {
      id, kind, roadNodeId, substationId: null, distributionPathSegmentIds: [], demandKw: 0, suppliedKw: 0, gridSuppliedKw: 0, emergencySuppliedKw: 0,
      supplyRatio: 0, priority, state: BuildingPowerState.Disconnected, zoneId: -1,
    };
  }

  private baseKwPer100m2(building: Building, facility: FacilityRecord | undefined): number {
    if (facility?.type === FacilityType.Hospital) return 4.6;
    if (facility?.type === FacilityType.University) return 2.3;
    if (facility?.type === FacilityType.School) return 1.6;
    if (facility?.type === FacilityType.CityHall || facility?.type === FacilityType.PoliceStation || facility?.type === FacilityType.FireStation) return 2.0;
    if (facility?.type === FacilityType.Hotel) return 2.4;
    if (facility?.type === FacilityType.Mall || facility?.type === FacilityType.Supermarket) return 2.8;
    switch (building.archetype) {
      case BuildingArchetype.DetachedHouse: return 1.15;
      case BuildingArchetype.TownHouse: return 1.20;
      case BuildingArchetype.LowRiseApartment: return 1.05;
      case BuildingArchetype.MidRiseApartment: return 1.00;
      case BuildingArchetype.ResidentialTower: return 1.05;
      case BuildingArchetype.SmallOffice: return 1.85;
      case BuildingArchetype.OfficeSlab: return 1.75;
      case BuildingArchetype.OfficeTower: return 1.80;
      case BuildingArchetype.SmallShop: return 2.15;
      case BuildingArchetype.RetailBox: return 2.35;
      case BuildingArchetype.CommercialBlock: return 2.25;
      case BuildingArchetype.MixedUse: return 1.75;
      case BuildingArchetype.LeisureHall: return 2.15;
      case BuildingArchetype.Factory: return 3.30;
      case BuildingArchetype.Warehouse: return 0.85;
    }
  }

  private operatingRatio(building: Building): number {
    const pois = this.poisByBuilding.get(building.id);
    if (!pois?.length) return 0.72;
    let capacity = 0, occupancy = 0;
    for (const poi of pois) {
      if (poi.capacity <= 0) continue;
      capacity += poi.capacity;
      occupancy += Math.min(poi.capacity, Math.max(0, poi.occupancy));
    }
    if (capacity <= 0) return 0.72;
    const occupied = clamp01(occupancy / capacity);
    const hasHome = pois.some((poi) => poi.category === POICategory.Home);
    return hasHome ? 0.68 + occupied * 0.32 : 0.38 + occupied * 0.62;
  }

  private timeFactor(building: Building, facility: FacilityRecord | undefined, hour: number): number {
    if (facility?.type === FacilityType.Hospital || facility?.type === FacilityType.PoliceStation || facility?.type === FacilityType.FireStation) return 0.92 + this.eveningPeak(hour) * 0.08;
    if (facility?.type === FacilityType.Hotel) return hour >= 18 || hour < 9 ? 1.08 : 0.72;
    if (facility?.type === FacilityType.School || facility?.type === FacilityType.University) return hour >= 7 && hour < 19 ? 1.0 : 0.18;
    if (facility?.type === FacilityType.Mall || facility?.type === FacilityType.Supermarket) return hour >= 9 && hour < 22 ? 1.05 : 0.22;
    switch (building.archetype) {
      case BuildingArchetype.DetachedHouse:
      case BuildingArchetype.TownHouse:
      case BuildingArchetype.LowRiseApartment:
      case BuildingArchetype.MidRiseApartment:
      case BuildingArchetype.ResidentialTower:
        if (hour >= 17 && hour < 23) return 1.18;
        if (hour >= 6 && hour < 9) return 0.92;
        if (hour >= 9 && hour < 17) return 0.62;
        return 0.72;
      case BuildingArchetype.SmallOffice:
      case BuildingArchetype.OfficeSlab:
      case BuildingArchetype.OfficeTower:
        return hour >= 8 && hour < 20 ? 1.0 : 0.12;
      case BuildingArchetype.SmallShop:
      case BuildingArchetype.RetailBox:
      case BuildingArchetype.CommercialBlock:
      case BuildingArchetype.LeisureHall:
        return hour >= 9 && hour < 23 ? 1.02 : 0.18;
      case BuildingArchetype.MixedUse:
        return hour >= 7 && hour < 23 ? 0.96 : 0.48;
      case BuildingArchetype.Factory:
        return hour >= 6 && hour < 23 ? 1.0 : 0.72;
      case BuildingArchetype.Warehouse:
        return hour >= 5 && hour < 23 ? 0.88 : 0.42;
    }
  }

  private railServiceFactor(hour: number): number {
    if (hour >= 6 && hour < 10) return 1.18;
    if (hour >= 16 && hour < 20) return 1.12;
    if (hour >= 5 && hour < 24) return 0.82;
    return 0.30;
  }

  private eveningPeak(hour: number): number {
    return hour >= 17 && hour < 22 ? 1 : 0;
  }
}
