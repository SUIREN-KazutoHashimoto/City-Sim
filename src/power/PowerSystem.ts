import { type Building, type CityGenerator } from '../generation/CityGenerator';
import { DistrictType } from '../generation/CityPlanning';
import { RoadClass, type RoadEdge, type RoadNetwork } from '../traffic/RoadNetwork';
import { PowerDemandModel } from './PowerDemandModel';
import {
  BuildingPowerState, DEFAULT_POWER_CONFIG, GenerationType, PowerAssetState, PowerGridState, PowerLineState, PowerPriority,
  type BuildingPowerConnection, type BuildingPowerSnapshot, type ExternalGridConnection, type ExternalGridConnectionSnapshot,
  type GenerationFacility, type GenerationFacilitySnapshot, type InfrastructurePowerLoad, type InfrastructurePowerLoadSnapshot,
  type PowerConfig, type PowerLineSegment, type PowerLineSegmentSnapshot, type PowerSnapshot, type PowerZoneSnapshot,
  type Substation, type SubstationSnapshot, kwToMw, mwToKw,
} from './PowerTypes';

interface HeapItem { node: number; distance: number }
class MinHeap {
  private a: HeapItem[] = [];
  get size(): number { return this.a.length; }
  push(value: HeapItem): void {
    let i = this.a.length; this.a.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].distance <= value.distance) break;
      this.a[i] = this.a[p]; i = p;
    }
    this.a[i] = value;
  }
  pop(): HeapItem | undefined {
    if (!this.a.length) return undefined;
    const root = this.a[0], tail = this.a.pop()!;
    if (!this.a.length) return root;
    let i = 0;
    while (true) {
      const l = i * 2 + 1;
      if (l >= this.a.length) break;
      const r = l + 1, c = r < this.a.length && this.a[r].distance < this.a[l].distance ? r : l;
      if (this.a[c].distance >= tail.distance) break;
      this.a[i] = this.a[c]; i = c;
    }
    this.a[i] = tail;
    return root;
  }
}

interface Source { id: string; roadNodeId: number }
interface RouteResult { distance: Float64Array; previousEdge: Int32Array; sourceIndex: Int32Array }
interface DistributionResult { distance: Float64Array; previousEdge: Int32Array; substationIndex: Int32Array }
type PowerConsumer = BuildingPowerConnection | InfrastructurePowerLoad;

const EPS = 0.001;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class PowerSystem {
  readonly config: PowerConfig;
  readonly generationFacilities: GenerationFacility[] = [];
  readonly externalConnections: ExternalGridConnection[] = [];
  readonly lineSegments: PowerLineSegment[] = [];
  readonly substations: Substation[] = [];
  readonly buildingConnections = new Map<number, BuildingPowerConnection>();
  readonly infrastructureLoads: InfrastructurePowerLoad[] = [];

  private readonly net: RoadNetwork;
  private readonly roadEdgeToSegment: Int32Array;
  private readonly nodeZone: Int32Array;
  private readonly buildingsById = new Map<number, Building>();
  private readonly demandModel: PowerDemandModel;
  private readonly buildingDemandOverrides = new Map<number, number>();
  private updateAccumulatorSec = 0;
  private lastUpdateSimSeconds = 0;
  private gridState = PowerGridState.Normal;
  private topologyDirty = true;
  private zoneCount = 0;

  constructor(readonly city: CityGenerator, config?: Partial<PowerConfig>) {
    this.config = { ...DEFAULT_POWER_CONFIG, ...config };
    this.net = city.net;
    this.roadEdgeToSegment = new Int32Array(this.net.edges.length); this.roadEdgeToSegment.fill(-1);
    this.nodeZone = new Int32Array(this.net.nodes.length); this.nodeZone.fill(-1);
    this.demandModel = new PowerDemandModel(city);
    for (const building of city.buildings) this.buildingsById.set(building.id, building);
    if (!this.config.enabled) return;

    this.buildLineSegments();
    this.buildGenerationFacilities();
    this.buildExternalConnections();
    this.buildSubstations();
    this.buildBuildingConnections();
    this.infrastructureLoads.push(...this.demandModel.createInfrastructureLoads());
    this.rebuildTopology();
  }

  update(dtSec: number, totalSimSeconds: number, force = false): void {
    if (!this.config.enabled) return;
    this.updateAccumulatorSec += Math.max(0, Number.isFinite(dtSec) ? dtSec : 0);
    if (!force && this.updateAccumulatorSec + 1e-9 < this.config.updateIntervalSec) return;
    this.updateAccumulatorSec = 0;
    this.lastUpdateSimSeconds = Math.max(0, Number.isFinite(totalSimSeconds) ? totalSimSeconds : 0);
    if (this.topologyDirty) this.rebuildTopology();
    this.updateAvailableGeneration(this.lastUpdateSimSeconds);
    this.updateDemand(this.lastUpdateSimSeconds);
    this.distributePower();
  }

  setBuildingDemandKw(buildingId: number, demandKw: number): boolean {
    const connection = this.buildingConnections.get(buildingId);
    if (!connection) return false;
    const normalized = Math.max(0, Number.isFinite(demandKw) ? demandKw : 0);
    connection.demandKw = normalized;
    this.buildingDemandOverrides.set(buildingId, normalized);
    return true;
  }

  setBuildingDemands(entries: Iterable<readonly [number, number]>): void {
    for (const [id, kw] of entries) this.setBuildingDemandKw(id, kw);
  }

  setLineSegmentState(id: number, state: PowerLineState): boolean {
    const segment = this.lineSegments[id];
    if (!segment) return false;
    if (segment.state !== state) {
      segment.state = state;
      segment.currentLoadKw = 0;
      segment.overload = false;
      this.topologyDirty = true;
    }
    return true;
  }

  setGenerationFacilityState(id: string, state: PowerAssetState): boolean {
    const facility = this.generationFacilities.find((value) => value.id === id);
    if (!facility) return false;
    if (facility.state !== state) {
      facility.state = state;
      if (state !== PowerAssetState.Online) facility.availableOutputKw = facility.currentOutputKw = facility.utilization = 0;
      this.topologyDirty = true;
    }
    return true;
  }

  setExternalConnectionState(id: string, state: PowerAssetState): boolean {
    const connection = this.externalConnections.find((value) => value.id === id);
    if (!connection) return false;
    if (connection.state !== state) {
      connection.state = state;
      if (state !== PowerAssetState.Online) connection.currentImportKw = connection.utilization = 0;
      this.topologyDirty = true;
    }
    return true;
  }

  setSubstationState(id: string, state: PowerAssetState): boolean {
    const substation = this.substations.find((value) => value.id === id);
    if (!substation) return false;
    if (substation.state !== state) {
      substation.state = state;
      this.topologyDirty = true;
    }
    return true;
  }

  rebuildTopology(): void {
    if (!this.config.enabled) return;
    this.topologyDirty = false;
    this.rebuildZones();
    this.rebuildSourcePaths();
    this.rebuildDistributionAssignments();
  }

  snapshot(): PowerSnapshot {
    let demand = 0, supplied = 0, blackout = 0, limited = 0, disconnected = 0;
    for (const connection of this.buildingConnections.values()) {
      demand += connection.demandKw; supplied += connection.suppliedKw;
      if (connection.state === BuildingPowerState.Blackout) blackout++;
      else if (connection.state === BuildingPowerState.Limited) limited++;
      else if (connection.state === BuildingPowerState.Disconnected) disconnected++;
    }
    let infrastructureDemand = 0, infrastructureSupplied = 0, infrastructureBlackout = 0;
    for (const load of this.infrastructureLoads) {
      infrastructureDemand += load.demandKw; infrastructureSupplied += load.suppliedKw;
      if (load.state === BuildingPowerState.Blackout || load.state === BuildingPowerState.Disconnected) infrastructureBlackout++;
    }
    demand += infrastructureDemand; supplied += infrastructureSupplied;
    const cityGeneration = this.generationFacilities.reduce((sum, value) => sum + value.currentOutputKw, 0);
    const external = this.externalConnections.reduce((sum, value) => sum + value.currentImportKw, 0);
    const available = this.availableSystemCapacityKw(), reserve = available - demand;
    return {
      state: this.gridState,
      demandMw: kwToMw(demand),
      suppliedMw: kwToMw(supplied),
      cityGenerationMw: kwToMw(cityGeneration),
      externalImportMw: kwToMw(external),
      availableCapacityMw: kwToMw(available),
      reserveMw: kwToMw(reserve),
      reserveMarginRatio: demand > EPS ? reserve / demand : 1,
      generationFacilityCount: this.generationFacilities.length,
      externalConnectionCount: this.externalConnections.length,
      substationCount: this.substations.length,
      overloadedSubstationCount: this.substations.filter((value) => value.overload).length,
      lineSegmentCount: this.lineSegments.length,
      brokenLineSegmentCount: this.lineSegments.filter((value) => value.state === PowerLineState.Broken).length,
      overloadedLineSegmentCount: this.lineSegments.filter((value) => value.overload).length,
      buildingCount: this.buildingConnections.size,
      blackoutBuildingCount: blackout,
      limitedBuildingCount: limited,
      disconnectedBuildingCount: disconnected,
      infrastructureLoadCount: this.infrastructureLoads.length,
      blackoutInfrastructureLoadCount: infrastructureBlackout,
      zoneCount: this.zoneCount,
      lastUpdateSimSeconds: this.lastUpdateSimSeconds,
    };
  }

  getPowerZoneSnapshots(): PowerZoneSnapshot[] {
    const demand = new Float64Array(this.zoneCount), supplied = new Float64Array(this.zoneCount), available = new Float64Array(this.zoneCount);
    const sourceCount = new Int32Array(this.zoneCount), substationCount = new Int32Array(this.zoneCount), buildingCount = new Int32Array(this.zoneCount);
    const blackoutBuildingCount = new Int32Array(this.zoneCount), overloadedLineCount = new Int32Array(this.zoneCount);
    for (const facility of this.generationFacilities) if (facility.zoneId >= 0 && facility.zoneId < this.zoneCount && facility.state === PowerAssetState.Online) { available[facility.zoneId] += facility.availableOutputKw; sourceCount[facility.zoneId]++; }
    for (const connection of this.externalConnections) if (connection.zoneId >= 0 && connection.zoneId < this.zoneCount && connection.state === PowerAssetState.Online) { available[connection.zoneId] += connection.maxImportKw; sourceCount[connection.zoneId]++; }
    for (const substation of this.substations) if (substation.zoneId >= 0 && substation.zoneId < this.zoneCount) substationCount[substation.zoneId]++;
    for (const connection of this.buildingConnections.values()) {
      if (connection.zoneId < 0 || connection.zoneId >= this.zoneCount) continue;
      demand[connection.zoneId] += connection.demandKw; supplied[connection.zoneId] += connection.suppliedKw; buildingCount[connection.zoneId]++;
      if (connection.state === BuildingPowerState.Blackout || connection.state === BuildingPowerState.Disconnected) blackoutBuildingCount[connection.zoneId]++;
    }
    for (const load of this.infrastructureLoads) if (load.zoneId >= 0 && load.zoneId < this.zoneCount) { demand[load.zoneId] += load.demandKw; supplied[load.zoneId] += load.suppliedKw; }
    for (const segment of this.lineSegments) if (segment.zoneId >= 0 && segment.zoneId < this.zoneCount && segment.overload) overloadedLineCount[segment.zoneId]++;
    const snapshots: PowerZoneSnapshot[] = [];
    for (let id = 0; id < this.zoneCount; id++) {
      const reserve = available[id] - demand[id];
      snapshots.push({
        id, demandMw: kwToMw(demand[id]), suppliedMw: kwToMw(supplied[id]), availableCapacityMw: kwToMw(available[id]),
        reserveMw: kwToMw(reserve), reserveMarginRatio: demand[id] > EPS ? reserve / demand[id] : 1,
        sourceCount: sourceCount[id], substationCount: substationCount[id], buildingCount: buildingCount[id],
        blackoutBuildingCount: blackoutBuildingCount[id], overloadedLineCount: overloadedLineCount[id],
      });
    }
    return snapshots;
  }

  getGenerationFacilitySnapshot(id: string): GenerationFacilitySnapshot | null {
    const value = this.generationFacilities.find((entry) => entry.id === id);
    return value ? {
      id: value.id, type: value.type, state: value.state, x: value.x, z: value.z, roadNodeId: value.roadNodeId,
      maxOutputMw: kwToMw(value.maxOutputKw), availableOutputMw: kwToMw(value.availableOutputKw), currentOutputMw: kwToMw(value.currentOutputKw),
      utilization: value.utilization, zoneId: value.zoneId,
    } : null;
  }

  getExternalConnectionSnapshot(id: string): ExternalGridConnectionSnapshot | null {
    const value = this.externalConnections.find((entry) => entry.id === id);
    return value ? {
      id: value.id, state: value.state, x: value.x, z: value.z, roadNodeId: value.roadNodeId,
      maxImportMw: kwToMw(value.maxImportKw), currentImportMw: kwToMw(value.currentImportKw), utilization: value.utilization, zoneId: value.zoneId,
    } : null;
  }

  getSubstationSnapshot(id: string): SubstationSnapshot | null {
    const value = this.substations.find((entry) => entry.id === id);
    return value ? {
      id: value.id, state: value.state, x: value.x, z: value.z, roadNodeId: value.roadNodeId, capacityMw: kwToMw(value.capacityKw),
      demandMw: kwToMw(value.demandKw), suppliedMw: kwToMw(value.suppliedKw), utilization: value.utilization, overload: value.overload,
      sourceId: value.sourceId, sourcePathLength: value.sourcePathSegmentIds.length, sourcePathCapacityMw: kwToMw(value.sourcePathCapacityKw),
      assignedBuildingCount: value.assignedBuildingCount, zoneId: value.zoneId,
    } : null;
  }

  getLineSegmentSnapshot(id: number): PowerLineSegmentSnapshot | null {
    const value = this.lineSegments[id];
    return value ? {
      id: value.id, fromNodeId: value.fromNodeId, toNodeId: value.toNodeId, lengthMeters: value.lengthMeters,
      capacityMw: kwToMw(value.capacityKw), currentLoadMw: kwToMw(value.currentLoadKw),
      loadRatio: value.capacityKw > EPS ? value.currentLoadKw / value.capacityKw : 0,
      state: value.state, overload: value.overload, zoneId: value.zoneId,
    } : null;
  }

  getBuildingSnapshot(id: number): BuildingPowerSnapshot | null {
    const value = this.buildingConnections.get(id);
    return value ? {
      buildingId: value.buildingId, roadNodeId: value.roadNodeId, substationId: value.substationId,
      distributionDistanceMeters: value.distributionDistanceMeters, outsideServiceRadius: value.outsideServiceRadius,
      demandKw: value.demandKw, suppliedKw: value.suppliedKw, gridSuppliedKw: value.gridSuppliedKw,
      emergencySuppliedKw: value.emergencySuppliedKw, supplyRatio: value.supplyRatio, priority: value.priority,
      state: value.state, zoneId: value.zoneId,
    } : null;
  }

  getInfrastructureLoadSnapshot(id: string): InfrastructurePowerLoadSnapshot | null {
    const value = this.infrastructureLoads.find((entry) => entry.id === id);
    return value ? {
      id: value.id, kind: value.kind, roadNodeId: value.roadNodeId, substationId: value.substationId,
      demandKw: value.demandKw, suppliedKw: value.suppliedKw, gridSuppliedKw: value.gridSuppliedKw,
      emergencySuppliedKw: value.emergencySuppliedKw, supplyRatio: value.supplyRatio, priority: value.priority,
      state: value.state, zoneId: value.zoneId,
    } : null;
  }

  private buildLineSegments(): void {
    const pairs = new Map<string, number>();
    for (const edge of this.net.edges) {
      const lo = Math.min(edge.from, edge.to), hi = Math.max(edge.from, edge.to), key = `${lo}:${hi}`;
      const capacity = this.lineCapacityKw(edge), old = pairs.get(key);
      if (old !== undefined) {
        const segment = this.lineSegments[old];
        segment.roadEdgeIds.push(edge.id);
        segment.capacityKw = Math.max(segment.capacityKw, capacity);
        this.roadEdgeToSegment[edge.id] = old;
        continue;
      }
      const id = this.lineSegments.length;
      this.lineSegments.push({
        id, fromNodeId: lo, toNodeId: hi, roadEdgeIds: [edge.id], lengthMeters: edge.length,
        capacityKw: capacity, currentLoadKw: 0, state: PowerLineState.Active, overload: false, zoneId: -1,
      });
      pairs.set(key, id);
      this.roadEdgeToSegment[edge.id] = id;
    }
  }

  private lineCapacityKw(edge: RoadEdge): number {
    let mw = this.config.lineCapacityLocalMw;
    if (edge.roadClass === RoadClass.Highway) mw = this.config.lineCapacityHighwayMw;
    else if (edge.roadClass === RoadClass.Arterial) mw = this.config.lineCapacityArterialMw;
    else if (edge.roadClass === RoadClass.Collector) mw = this.config.lineCapacityCollectorMw;
    else if (edge.roadClass === RoadClass.Path) mw = this.config.lineCapacityPathMw;
    return mwToKw(mw * Math.max(1, Math.sqrt(Math.max(1, edge.lanes))));
  }

  private buildGenerationFacilities(): void {
    const add = (type: GenerationType, i: number, count: number, anchor: { x: number; z: number }, radius: number, districts: ReadonlySet<DistrictType>, maxMw: number): void => {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + (type === GenerationType.Thermal ? 0.45 : 1.2);
      const x = this.clampCity(anchor.x + Math.cos(angle) * radius), z = this.clampCity(anchor.z + Math.sin(angle) * radius);
      const roadNodeId = this.nearestNodeForDistrict(x, z, districts), node = roadNodeId >= 0 ? this.net.nodes[roadNodeId] : null, maxOutputKw = mwToKw(maxMw);
      this.generationFacilities.push({
        id: `${type}-${i}`, type, x: node?.x ?? x, z: node?.z ?? z, roadNodeId, maxOutputKw,
        availableOutputKw: type === GenerationType.Thermal ? maxOutputKw : 0, currentOutputKw: 0, utilization: 0,
        state: PowerAssetState.Online, zoneId: -1,
      });
    };
    const thermalCount = Math.max(0, Math.floor(this.config.thermalPlantCount)), solarCount = Math.max(0, Math.floor(this.config.solarPlantCount));
    const industrial = this.city.planning.industrialCenter, logistics = this.city.planning.logisticsCenter;
    for (let i = 0; i < thermalCount; i++) add(GenerationType.Thermal, i, thermalCount, i % 2 ? logistics : industrial, Math.max(160, this.city.sizeMeters * (0.012 + (i % 3) * 0.004)), new Set([DistrictType.Industrial, DistrictType.Logistics]), this.config.thermalPlantCapacityMw);
    for (let i = 0; i < solarCount; i++) add(GenerationType.Solar, i, solarCount, i % 2 ? industrial : logistics, Math.max(280, this.city.sizeMeters * (0.025 + (i % 4) * 0.006)), new Set([DistrictType.Industrial, DistrictType.Logistics, DistrictType.ResidentialLow]), this.config.solarPlantCapacityMw);
  }

  private buildExternalConnections(): void {
    const gates = this.city.gateNodes.filter((node) => node >= 0 && node < this.net.nodes.length);
    const count = Math.min(Math.max(0, Math.floor(this.config.externalConnectionCount)), gates.length);
    if (!count) return;
    const each = mwToKw(this.config.externalGridCapacityMw) / count;
    for (let i = 0; i < count; i++) {
      const nodeId = gates[Math.floor(i * gates.length / count)], node = this.net.nodes[nodeId];
      this.externalConnections.push({
        id: `external-${i}`, x: node.x, z: node.z, roadNodeId: nodeId, maxImportKw: each, currentImportKw: 0,
        utilization: 0, state: PowerAssetState.Online, zoneId: -1,
      });
    }
  }

  private buildSubstations(): void {
    if (!this.net.nodes.length) return;
    const spacing = Math.max(300, this.config.substationSpacingMeters), minD2 = (spacing * 0.48) ** 2;
    const candidates = this.net.nodes.filter((node) => {
      const plan = this.city.planning.sample(node.x, node.z);
      return plan.district !== DistrictType.Park
        && (plan.urbanScore >= this.city.urbanThreshold * 0.82 || plan.district === DistrictType.Industrial || plan.district === DistrictType.Logistics || plan.district === DistrictType.Civic);
    });
    const pool = candidates.length ? candidates : this.net.nodes;
    const addNearest = (x: number, z: number): void => {
      if (this.substations.length >= 256) return;
      let best = -1, distance = Infinity;
      for (const node of pool) {
        const d = (node.x - x) ** 2 + (node.z - z) ** 2;
        if (d < distance) { distance = d; best = node.id; }
      }
      if (best < 0) return;
      const node = this.net.nodes[best];
      if (this.substations.some((substation) => (substation.x - node.x) ** 2 + (substation.z - node.z) ** 2 < minD2)) return;
      const plan = this.city.planning.sample(node.x, node.z);
      let factor = 1;
      if (plan.district === DistrictType.CBD) factor = 1.4;
      else if (plan.district === DistrictType.Industrial || plan.district === DistrictType.Logistics) factor = 1.3;
      else if (plan.district === DistrictType.Commercial || plan.district === DistrictType.MixedUse) factor = 1.15;
      this.substations.push({
        id: `substation-${this.substations.length}`, x: node.x, z: node.z, roadNodeId: node.id, district: plan.district,
        capacityKw: mwToKw(this.config.substationCapacityMw * factor), demandKw: 0, suppliedKw: 0, utilization: 0,
        overload: false, state: PowerAssetState.Online, sourceId: null, sourcePathSegmentIds: [], sourcePathCapacityKw: 0,
        assignedBuildingCount: 0, zoneId: -1,
      });
    };
    for (let z = spacing * 0.5; z < this.city.sizeMeters && this.substations.length < 256; z += spacing) {
      for (let x = spacing * 0.5; x < this.city.sizeMeters && this.substations.length < 256; x += spacing) addNearest(x, z);
    }
    addNearest(this.city.planning.industrialCenter.x, this.city.planning.industrialCenter.z);
    addNearest(this.city.planning.logisticsCenter.x, this.city.planning.logisticsCenter.z);
    addNearest(this.city.planning.cbd.x, this.city.planning.cbd.z);
    if (!this.substations.length) addNearest(this.city.sizeMeters * 0.5, this.city.sizeMeters * 0.5);
  }

  private buildBuildingConnections(): void {
    for (const building of this.city.buildings) {
      const roadNodeId = this.frontageRoadNode(building);
      this.buildingConnections.set(building.id, {
        buildingId: building.id, roadNodeId, substationId: null, distributionDistanceMeters: Infinity, distributionPathSegmentIds: [],
        outsideServiceRadius: true, demandKw: 0, suppliedKw: 0, gridSuppliedKw: 0, emergencySuppliedKw: 0, supplyRatio: 0,
        priority: this.demandModel.buildingPriority(building), state: BuildingPowerState.Disconnected, zoneId: -1,
      });
    }
  }

  private frontageRoadNode(building: Building): number {
    let x = building.x, z = building.z;
    if (building.frontage === 'north') z -= building.depth * 0.5;
    else if (building.frontage === 'south') z += building.depth * 0.5;
    else if (building.frontage === 'west') x -= building.width * 0.5;
    else x += building.width * 0.5;
    return this.net.nearestNode(x, z);
  }

  private rebuildZones(): void {
    this.nodeZone.fill(-1);
    let zone = 0;
    const queue = new Int32Array(this.net.nodes.length);
    for (const start of this.net.nodes) {
      if (this.nodeZone[start.id] >= 0) continue;
      let head = 0, tail = 0;
      this.nodeZone[start.id] = zone; queue[tail++] = start.id;
      while (head < tail) {
        const nodeId = queue[head++];
        for (const edgeId of this.net.nodes[nodeId].edges) {
          const edge = this.net.edges[edgeId], segmentId = this.roadEdgeToSegment[edgeId];
          if (segmentId < 0 || this.lineSegments[segmentId].state !== PowerLineState.Active || this.nodeZone[edge.to] >= 0) continue;
          this.nodeZone[edge.to] = zone; queue[tail++] = edge.to;
        }
      }
      zone++;
    }
    this.zoneCount = zone;
    for (const segment of this.lineSegments) {
      const a = this.nodeZone[segment.fromNodeId], b = this.nodeZone[segment.toNodeId];
      segment.zoneId = segment.state === PowerLineState.Active && a === b ? a : -1;
    }
    for (const facility of this.generationFacilities) facility.zoneId = this.zoneForNode(facility.roadNodeId);
    for (const connection of this.externalConnections) connection.zoneId = this.zoneForNode(connection.roadNodeId);
    for (const substation of this.substations) substation.zoneId = this.zoneForNode(substation.roadNodeId);
  }

  private rebuildSourcePaths(): void {
    const sources = this.allOnlineSources();
    if (!sources.length) {
      for (const substation of this.substations) {
        substation.sourceId = null; substation.sourcePathSegmentIds = []; substation.sourcePathCapacityKw = 0;
      }
      return;
    }
    const routes = this.multiSourceRouting(sources);
    for (const substation of this.substations) {
      const sourceIndex = substation.roadNodeId >= 0 ? routes.sourceIndex[substation.roadNodeId] : -1;
      if (sourceIndex < 0 || !Number.isFinite(routes.distance[substation.roadNodeId])) {
        substation.sourceId = null; substation.sourcePathSegmentIds = []; substation.sourcePathCapacityKw = 0; continue;
      }
      const path = this.tracePath(substation.roadNodeId, routes.previousEdge);
      let capacity = substation.capacityKw;
      if (path.length) {
        capacity = Infinity;
        for (const segmentId of path) capacity = Math.min(capacity, this.lineSegments[segmentId].capacityKw);
      }
      substation.sourceId = sources[sourceIndex]?.id ?? null;
      substation.sourcePathSegmentIds = path;
      substation.sourcePathCapacityKw = Number.isFinite(capacity) ? capacity : substation.capacityKw;
    }
  }

  private rebuildDistributionAssignments(): void {
    for (const substation of this.substations) substation.assignedBuildingCount = 0;
    const active = this.substations.filter((substation) => substation.state === PowerAssetState.Online);
    const distribution = active.length ? this.multiSourceSubstationRouting(active) : null;
    const activeIndexById = new Map(active.map((substation, index) => [index, substation] as const));

    for (const connection of this.buildingConnections.values()) {
      const result = this.distributionForNode(connection.roadNodeId, distribution, activeIndexById);
      connection.substationId = result.substation?.id ?? null;
      connection.distributionDistanceMeters = result.distance;
      connection.distributionPathSegmentIds = result.path;
      connection.outsideServiceRadius = result.distance > this.config.substationServiceRadiusMeters;
      connection.zoneId = this.zoneForNode(connection.roadNodeId);
      if (result.substation) result.substation.assignedBuildingCount++;
    }

    for (const load of this.infrastructureLoads) {
      const result = this.distributionForNode(load.roadNodeId, distribution, activeIndexById);
      load.substationId = result.substation?.id ?? null;
      load.distributionPathSegmentIds = result.path;
      load.zoneId = this.zoneForNode(load.roadNodeId);
    }
  }

  private distributionForNode(
    roadNodeId: number,
    distribution: DistributionResult | null,
    activeIndexById: ReadonlyMap<number, Substation>,
  ): { substation: Substation | null; distance: number; path: number[] } {
    if (!distribution || roadNodeId < 0 || roadNodeId >= distribution.substationIndex.length) return { substation: null, distance: Infinity, path: [] };
    const index = distribution.substationIndex[roadNodeId], substation = index >= 0 ? activeIndexById.get(index) ?? null : null;
    if (!substation || !Number.isFinite(distribution.distance[roadNodeId])) return { substation: null, distance: Infinity, path: [] };
    return { substation, distance: distribution.distance[roadNodeId], path: this.tracePath(roadNodeId, distribution.previousEdge) };
  }

  private allOnlineSources(): Source[] {
    const sources: Source[] = [];
    for (const facility of this.generationFacilities) if (facility.state === PowerAssetState.Online && facility.roadNodeId >= 0) sources.push({ id: facility.id, roadNodeId: facility.roadNodeId });
    for (const connection of this.externalConnections) if (connection.state === PowerAssetState.Online && connection.roadNodeId >= 0) sources.push({ id: connection.id, roadNodeId: connection.roadNodeId });
    return sources;
  }

  private multiSourceRouting(sources: Source[]): RouteResult {
    const n = this.net.nodes.length, distance = new Float64Array(n), previousEdge = new Int32Array(n), sourceIndex = new Int32Array(n), heap = new MinHeap();
    distance.fill(Infinity); previousEdge.fill(-1); sourceIndex.fill(-1);
    sources.forEach((source, i) => {
      if (source.roadNodeId < 0 || source.roadNodeId >= n || distance[source.roadNodeId] <= 0) return;
      distance[source.roadNodeId] = 0; sourceIndex[source.roadNodeId] = i; heap.push({ node: source.roadNodeId, distance: 0 });
    });
    while (heap.size) {
      const current = heap.pop()!;
      if (current.distance !== distance[current.node]) continue;
      for (const edgeId of this.net.nodes[current.node].edges) {
        const edge = this.net.edges[edgeId], segmentId = this.roadEdgeToSegment[edgeId];
        if (segmentId < 0 || this.lineSegments[segmentId].state !== PowerLineState.Active) continue;
        const next = current.distance + edge.length;
        if (next >= distance[edge.to]) continue;
        distance[edge.to] = next; previousEdge[edge.to] = edgeId; sourceIndex[edge.to] = sourceIndex[current.node];
        heap.push({ node: edge.to, distance: next });
      }
    }
    return { distance, previousEdge, sourceIndex };
  }

  private multiSourceSubstationRouting(substations: Substation[]): DistributionResult {
    const n = this.net.nodes.length, distance = new Float64Array(n), previousEdge = new Int32Array(n), substationIndex = new Int32Array(n), heap = new MinHeap();
    distance.fill(Infinity); previousEdge.fill(-1); substationIndex.fill(-1);
    substations.forEach((substation, i) => {
      if (substation.roadNodeId < 0 || substation.roadNodeId >= n || distance[substation.roadNodeId] <= 0) return;
      distance[substation.roadNodeId] = 0; substationIndex[substation.roadNodeId] = i; heap.push({ node: substation.roadNodeId, distance: 0 });
    });
    while (heap.size) {
      const current = heap.pop()!;
      if (current.distance !== distance[current.node]) continue;
      for (const edgeId of this.net.nodes[current.node].edges) {
        const edge = this.net.edges[edgeId], segmentId = this.roadEdgeToSegment[edgeId];
        if (segmentId < 0 || this.lineSegments[segmentId].state !== PowerLineState.Active) continue;
        const next = current.distance + edge.length;
        if (next >= distance[edge.to]) continue;
        distance[edge.to] = next; previousEdge[edge.to] = edgeId; substationIndex[edge.to] = substationIndex[current.node];
        heap.push({ node: edge.to, distance: next });
      }
    }
    return { distance, previousEdge, substationIndex };
  }

  private tracePath(nodeId: number, previousEdge: Int32Array): number[] {
    const path: number[] = [];
    let node = nodeId, guard = this.net.nodes.length + 1;
    while (guard-- > 0) {
      const edgeId = previousEdge[node];
      if (edgeId < 0) break;
      const segmentId = this.roadEdgeToSegment[edgeId];
      if (segmentId < 0) break;
      path.push(segmentId);
      node = this.net.edges[edgeId].from;
    }
    return path;
  }

  private updateAvailableGeneration(totalSimSeconds: number): void {
    const hour = ((totalSimSeconds / 3600) % 24 + 24) % 24;
    const solar = hour <= 6 || hour >= 18 ? 0 : Math.sin((hour - 6) / 12 * Math.PI) ** 1.35;
    for (const facility of this.generationFacilities) {
      if (facility.state !== PowerAssetState.Online) {
        facility.availableOutputKw = facility.currentOutputKw = facility.utilization = 0;
        continue;
      }
      facility.availableOutputKw = facility.type === GenerationType.Solar ? facility.maxOutputKw * solar : facility.maxOutputKw;
      facility.currentOutputKw = facility.utilization = 0;
    }
    for (const connection of this.externalConnections) connection.currentImportKw = connection.utilization = 0;
  }

  private updateDemand(totalSimSeconds: number): void {
    for (const connection of this.buildingConnections.values()) {
      const building = this.buildingsById.get(connection.buildingId);
      if (!building) { connection.demandKw = 0; continue; }
      connection.demandKw = this.buildingDemandOverrides.get(connection.buildingId) ?? this.demandModel.buildingDemandKw(building, totalSimSeconds);
      connection.priority = this.demandModel.buildingPriority(building);
    }
    for (const load of this.infrastructureLoads) this.demandModel.updateInfrastructureDemand(load, totalSimSeconds);
  }

  private distributePower(): void {
    for (const segment of this.lineSegments) { segment.currentLoadKw = 0; segment.overload = false; }
    for (const substation of this.substations) { substation.demandKw = 0; substation.suppliedKw = 0; substation.utilization = 0; substation.overload = false; }
    for (const consumer of this.allConsumers()) this.resetConsumer(consumer);

    const substationsById = new Map(this.substations.map((substation) => [substation.id, substation] as const));
    for (const consumer of this.allConsumers()) {
      if (!consumer.substationId) continue;
      const substation = substationsById.get(consumer.substationId);
      if (substation) substation.demandKw += consumer.demandKw;
    }
    for (const substation of this.substations) substation.overload = substation.demandKw > substation.capacityKw + EPS;

    const zoneRemaining = this.zoneAvailableCapacityKw();
    const substationRemaining = new Map<string, number>();
    for (const substation of this.substations) substationRemaining.set(substation.id, substation.state === PowerAssetState.Online && substation.sourceId ? substation.capacityKw : 0);
    const lineRemaining = new Float64Array(this.lineSegments.length);
    for (const segment of this.lineSegments) lineRemaining[segment.id] = segment.state === PowerLineState.Active ? segment.capacityKw : 0;

    const consumers = this.allConsumers().sort((a, b) => a.priority - b.priority || a.zoneId - b.zoneId || this.consumerKey(a).localeCompare(this.consumerKey(b)));
    for (const priority of [PowerPriority.Critical, PowerPriority.High, PowerPriority.Medium, PowerPriority.Low]) {
      for (const consumer of consumers) {
        if (consumer.priority !== priority || consumer.demandKw <= EPS) continue;
        if (!consumer.substationId || consumer.zoneId < 0) {
          consumer.state = BuildingPowerState.Disconnected;
          continue;
        }
        const substation = substationsById.get(consumer.substationId);
        if (!substation || substation.state !== PowerAssetState.Online || !substation.sourceId || substation.zoneId !== consumer.zoneId) {
          consumer.state = BuildingPowerState.Blackout;
          continue;
        }

        const path = this.uniquePath(substation.sourcePathSegmentIds, consumer.distributionPathSegmentIds);
        let lineCapacity = Infinity;
        for (const segmentId of path) lineCapacity = Math.min(lineCapacity, lineRemaining[segmentId]);
        const zoneCapacity = zoneRemaining[consumer.zoneId] ?? 0;
        const stationCapacity = substationRemaining.get(substation.id) ?? 0;
        const deliverable = Math.max(0, Math.min(consumer.demandKw, zoneCapacity, stationCapacity, lineCapacity));

        if (deliverable + EPS < consumer.demandKw && Number.isFinite(lineCapacity)) {
          for (const segmentId of path) if (lineRemaining[segmentId] <= lineCapacity + EPS) this.lineSegments[segmentId].overload = true;
        }

        consumer.gridSuppliedKw = deliverable;
        if (deliverable > EPS) {
          zoneRemaining[consumer.zoneId] = Math.max(0, zoneCapacity - deliverable);
          substationRemaining.set(substation.id, Math.max(0, stationCapacity - deliverable));
          substation.suppliedKw += deliverable;
          for (const segmentId of path) {
            lineRemaining[segmentId] = Math.max(0, lineRemaining[segmentId] - deliverable);
            this.lineSegments[segmentId].currentLoadKw += deliverable;
          }
        }
      }
    }

    for (const substation of this.substations) substation.utilization = substation.capacityKw > EPS ? substation.suppliedKw / substation.capacityKw : 0;
    this.applyEmergencyPower();
    this.updateConsumerStates();
    const gridSupplied = this.allConsumers().reduce((sum, consumer) => sum + consumer.gridSuppliedKw, 0);
    this.dispatchGenerationByZone();
    const demand = this.allConsumers().reduce((sum, consumer) => sum + consumer.demandKw, 0);
    if (demand <= EPS) this.gridState = PowerGridState.Normal;
    else if (gridSupplied / demand <= this.config.blackoutSupplyRatio) this.gridState = PowerGridState.Blackout;
    else if (gridSupplied + EPS < demand) this.gridState = PowerGridState.LimitedSupply;
    else this.gridState = (this.availableSystemCapacityKw() - demand) / demand < this.config.tightReserveMarginRatio ? PowerGridState.Tight : PowerGridState.Normal;
  }

  private resetConsumer(consumer: PowerConsumer): void {
    consumer.suppliedKw = 0; consumer.gridSuppliedKw = 0; consumer.emergencySuppliedKw = 0; consumer.supplyRatio = 0;
    consumer.state = consumer.substationId ? BuildingPowerState.Blackout : BuildingPowerState.Disconnected;
  }

  private applyEmergencyPower(): void {
    for (const consumer of this.allConsumers()) {
      if (consumer.priority !== PowerPriority.Critical || consumer.demandKw <= EPS) continue;
      const remaining = Math.max(0, consumer.demandKw - consumer.gridSuppliedKw);
      let ratio = this.config.criticalEmergencySupplyRatio;
      if (!('buildingId' in consumer)) ratio = consumer.kind === 'road-signal' || consumer.kind === 'rail-signal' ? 1 : ratio;
      consumer.emergencySuppliedKw = Math.min(remaining, consumer.demandKw * clamp01(ratio));
    }
  }

  private updateConsumerStates(): void {
    for (const consumer of this.allConsumers()) {
      consumer.suppliedKw = consumer.gridSuppliedKw + consumer.emergencySuppliedKw;
      consumer.supplyRatio = consumer.demandKw > EPS ? clamp01(consumer.suppliedKw / consumer.demandKw) : 1;
      if (!consumer.substationId && consumer.emergencySuppliedKw <= EPS) consumer.state = BuildingPowerState.Disconnected;
      else if (consumer.demandKw <= EPS || consumer.supplyRatio >= 0.999) consumer.state = BuildingPowerState.Supplied;
      else if (consumer.supplyRatio <= this.config.blackoutSupplyRatio) consumer.state = BuildingPowerState.Blackout;
      else consumer.state = BuildingPowerState.Limited;
    }
  }

  private zoneAvailableCapacityKw(): Float64Array {
    const capacity = new Float64Array(this.zoneCount);
    for (const facility of this.generationFacilities) if (facility.state === PowerAssetState.Online && facility.zoneId >= 0 && facility.zoneId < capacity.length) capacity[facility.zoneId] += facility.availableOutputKw;
    for (const connection of this.externalConnections) if (connection.state === PowerAssetState.Online && connection.zoneId >= 0 && connection.zoneId < capacity.length) capacity[connection.zoneId] += connection.maxImportKw;
    return capacity;
  }

  private dispatchGenerationByZone(): void {
    for (const facility of this.generationFacilities) facility.currentOutputKw = facility.utilization = 0;
    for (const connection of this.externalConnections) connection.currentImportKw = connection.utilization = 0;
    const targetByZone = new Float64Array(this.zoneCount);
    for (const consumer of this.allConsumers()) if (consumer.zoneId >= 0 && consumer.zoneId < targetByZone.length) targetByZone[consumer.zoneId] += consumer.gridSuppliedKw;

    for (let zone = 0; zone < targetByZone.length; zone++) {
      let remaining = targetByZone[zone];
      remaining -= this.dispatchGenerationGroup(this.generationFacilities.filter((value) => value.zoneId === zone && value.type === GenerationType.Solar && value.state === PowerAssetState.Online), remaining);
      remaining -= this.dispatchGenerationGroup(this.generationFacilities.filter((value) => value.zoneId === zone && value.type === GenerationType.Thermal && value.state === PowerAssetState.Online), remaining);
      const external = this.externalConnections.filter((value) => value.zoneId === zone && value.state === PowerAssetState.Online);
      const capacity = external.reduce((sum, value) => sum + value.maxImportKw, 0), use = Math.min(Math.max(0, remaining), capacity);
      for (const connection of external) {
        connection.currentImportKw = use * (capacity > EPS ? connection.maxImportKw / capacity : 0);
        connection.utilization = connection.maxImportKw > EPS ? connection.currentImportKw / connection.maxImportKw : 0;
      }
    }
  }

  private dispatchGenerationGroup(group: GenerationFacility[], requested: number): number {
    const capacity = group.reduce((sum, value) => sum + value.availableOutputKw, 0), use = Math.min(Math.max(0, requested), capacity);
    for (const facility of group) {
      facility.currentOutputKw = use * (capacity > EPS ? facility.availableOutputKw / capacity : 0);
      facility.utilization = facility.maxOutputKw > EPS ? facility.currentOutputKw / facility.maxOutputKw : 0;
    }
    return use;
  }

  private availableSystemCapacityKw(): number {
    return this.generationFacilities.reduce((sum, value) => sum + (value.state === PowerAssetState.Online ? value.availableOutputKw : 0), 0)
      + this.externalConnections.reduce((sum, value) => sum + (value.state === PowerAssetState.Online ? value.maxImportKw : 0), 0);
  }

  private allConsumers(): PowerConsumer[] {
    return [...this.buildingConnections.values(), ...this.infrastructureLoads];
  }

  private consumerKey(consumer: PowerConsumer): string {
    return 'buildingId' in consumer ? `building-${consumer.buildingId}` : consumer.id;
  }

  private uniquePath(a: readonly number[], b: readonly number[]): number[] {
    const seen = new Set<number>(), path: number[] = [];
    for (const segment of a) if (!seen.has(segment)) { seen.add(segment); path.push(segment); }
    for (const segment of b) if (!seen.has(segment)) { seen.add(segment); path.push(segment); }
    return path;
  }

  private zoneForNode(nodeId: number): number {
    return nodeId >= 0 && nodeId < this.nodeZone.length ? this.nodeZone[nodeId] : -1;
  }

  private nearestNodeForDistrict(x: number, z: number, districts: ReadonlySet<DistrictType>): number {
    let best = -1, distance = Infinity;
    for (const node of this.net.nodes) {
      if (!districts.has(this.city.planning.sample(node.x, node.z).district)) continue;
      const d = (node.x - x) ** 2 + (node.z - z) ** 2;
      if (d < distance) { distance = d; best = node.id; }
    }
    return best >= 0 ? best : this.net.nearestNode(x, z);
  }

  private clampCity(value: number): number {
    return Math.max(0, Math.min(this.city.sizeMeters, value));
  }
}
