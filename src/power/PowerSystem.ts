import { BuildingArchetype, type Building, type CityGenerator } from '../generation/CityGenerator';
import { DistrictType } from '../generation/CityPlanning';
import { FacilityType } from '../generation/SpecialFacilityPlanner';
import { RoadClass, type RoadEdge, type RoadNetwork } from '../traffic/RoadNetwork';
import {
  BuildingPowerState, DEFAULT_POWER_CONFIG, GenerationType, PowerAssetState, PowerGridState, PowerLineState, PowerPriority,
  type BuildingPowerConnection, type BuildingPowerSnapshot, type ExternalGridConnection, type ExternalGridConnectionSnapshot,
  type GenerationFacility, type GenerationFacilitySnapshot, type PowerConfig, type PowerLineSegment, type PowerLineSegmentSnapshot,
  type PowerSnapshot, type Substation, type SubstationSnapshot, kwToMw, mwToKw,
} from './PowerTypes';

interface HeapItem { node: number; distance: number }
class MinHeap {
  private a: HeapItem[] = [];
  get size(): number { return this.a.length; }
  push(v: HeapItem): void { let i = this.a.length; this.a.push(v); while (i > 0) { const p = (i - 1) >> 1; if (this.a[p].distance <= v.distance) break; this.a[i] = this.a[p]; i = p; } this.a[i] = v; }
  pop(): HeapItem | undefined {
    if (!this.a.length) return undefined; const root = this.a[0], tail = this.a.pop()!; if (!this.a.length) return root; let i = 0;
    while (true) { const l = i * 2 + 1; if (l >= this.a.length) break; const r = l + 1, c = r < this.a.length && this.a[r].distance < this.a[l].distance ? r : l; if (this.a[c].distance >= tail.distance) break; this.a[i] = this.a[c]; i = c; }
    this.a[i] = tail; return root;
  }
}
interface Source { id: string; roadNodeId: number }
interface RouteResult { distance: Float64Array; previousEdge: Int32Array; sourceIndex: Int32Array }
interface DistributionResult { distance: Float64Array; substationIndex: Int32Array }
const EPS = 0.001;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export class PowerSystem {
  readonly config: PowerConfig;
  readonly generationFacilities: GenerationFacility[] = [];
  readonly externalConnections: ExternalGridConnection[] = [];
  readonly lineSegments: PowerLineSegment[] = [];
  readonly substations: Substation[] = [];
  readonly buildingConnections = new Map<number, BuildingPowerConnection>();
  private readonly net: RoadNetwork;
  private readonly roadEdgeToSegment: Int32Array;
  private updateAccumulatorSec = 0;
  private lastUpdateSimSeconds = 0;
  private gridState = PowerGridState.Normal;
  private topologyDirty = true;

  constructor(readonly city: CityGenerator, config?: Partial<PowerConfig>) {
    this.config = { ...DEFAULT_POWER_CONFIG, ...config }; this.net = city.net;
    this.roadEdgeToSegment = new Int32Array(this.net.edges.length); this.roadEdgeToSegment.fill(-1);
    if (!this.config.enabled) return;
    this.buildLineSegments(); this.buildGenerationFacilities(); this.buildExternalConnections(); this.buildSubstations(); this.buildBuildingConnections(); this.rebuildSourceTopology();
  }

  update(dtSec: number, totalSimSeconds: number, force = false): void {
    if (!this.config.enabled) return;
    this.updateAccumulatorSec += Math.max(0, Number.isFinite(dtSec) ? dtSec : 0);
    if (!force && this.updateAccumulatorSec + 1e-9 < this.config.updateIntervalSec) return;
    this.updateAccumulatorSec = 0; this.lastUpdateSimSeconds = Math.max(0, Number.isFinite(totalSimSeconds) ? totalSimSeconds : 0);
    if (this.topologyDirty) this.rebuildSourceTopology();
    this.updateAvailableGeneration(this.lastUpdateSimSeconds); this.distributePower();
  }

  setBuildingDemandKw(buildingId: number, demandKw: number): boolean { const c = this.buildingConnections.get(buildingId); if (!c) return false; c.demandKw = Math.max(0, Number.isFinite(demandKw) ? demandKw : 0); return true; }
  setBuildingDemands(entries: Iterable<readonly [number, number]>): void { for (const [id, kw] of entries) this.setBuildingDemandKw(id, kw); }
  setLineSegmentState(id: number, state: PowerLineState): boolean { const x = this.lineSegments[id]; if (!x) return false; if (x.state !== state) { x.state = state; x.currentLoadKw = 0; this.topologyDirty = true; } return true; }
  setGenerationFacilityState(id: string, state: PowerAssetState): boolean { const x = this.generationFacilities.find((v) => v.id === id); if (!x) return false; if (x.state !== state) { x.state = state; if (state !== PowerAssetState.Online) { x.availableOutputKw = x.currentOutputKw = x.utilization = 0; } this.topologyDirty = true; } return true; }
  setExternalConnectionState(id: string, state: PowerAssetState): boolean { const x = this.externalConnections.find((v) => v.id === id); if (!x) return false; if (x.state !== state) { x.state = state; if (state !== PowerAssetState.Online) { x.currentImportKw = x.utilization = 0; } this.topologyDirty = true; } return true; }
  setSubstationState(id: string, state: PowerAssetState): boolean { const x = this.substations.find((v) => v.id === id); if (!x) return false; x.state = state; return true; }
  rebuildTopology(): void { if (this.config.enabled) this.rebuildSourceTopology(); }

  snapshot(): PowerSnapshot {
    let demand = 0, supplied = 0, blackout = 0, limited = 0, disconnected = 0;
    for (const c of this.buildingConnections.values()) { demand += c.demandKw; supplied += c.suppliedKw; if (c.state === BuildingPowerState.Blackout) blackout++; else if (c.state === BuildingPowerState.Limited) limited++; else if (c.state === BuildingPowerState.Disconnected) disconnected++; }
    const cityGen = this.generationFacilities.reduce((s, x) => s + x.currentOutputKw, 0), external = this.externalConnections.reduce((s, x) => s + x.currentImportKw, 0), available = this.availableSystemCapacityKw(), reserve = available - demand;
    return {
      state: this.gridState, demandMw: kwToMw(demand), suppliedMw: kwToMw(supplied), cityGenerationMw: kwToMw(cityGen), externalImportMw: kwToMw(external), availableCapacityMw: kwToMw(available), reserveMw: kwToMw(reserve), reserveMarginRatio: demand > EPS ? reserve / demand : 1,
      generationFacilityCount: this.generationFacilities.length, externalConnectionCount: this.externalConnections.length, substationCount: this.substations.length,
      overloadedSubstationCount: this.substations.filter((x) => x.overload).length, lineSegmentCount: this.lineSegments.length,
      brokenLineSegmentCount: this.lineSegments.filter((x) => x.state === PowerLineState.Broken).length, overloadedLineSegmentCount: this.lineSegments.filter((x) => x.currentLoadKw > x.capacityKw + EPS).length,
      buildingCount: this.buildingConnections.size, blackoutBuildingCount: blackout, limitedBuildingCount: limited, disconnectedBuildingCount: disconnected, lastUpdateSimSeconds: this.lastUpdateSimSeconds,
    };
  }

  getGenerationFacilitySnapshot(id: string): GenerationFacilitySnapshot | null { const x = this.generationFacilities.find((v) => v.id === id); return x ? { id: x.id, type: x.type, state: x.state, x: x.x, z: x.z, roadNodeId: x.roadNodeId, maxOutputMw: kwToMw(x.maxOutputKw), availableOutputMw: kwToMw(x.availableOutputKw), currentOutputMw: kwToMw(x.currentOutputKw), utilization: x.utilization } : null; }
  getExternalConnectionSnapshot(id: string): ExternalGridConnectionSnapshot | null { const x = this.externalConnections.find((v) => v.id === id); return x ? { id: x.id, state: x.state, x: x.x, z: x.z, roadNodeId: x.roadNodeId, maxImportMw: kwToMw(x.maxImportKw), currentImportMw: kwToMw(x.currentImportKw), utilization: x.utilization } : null; }
  getSubstationSnapshot(id: string): SubstationSnapshot | null { const x = this.substations.find((v) => v.id === id); return x ? { id: x.id, state: x.state, x: x.x, z: x.z, roadNodeId: x.roadNodeId, capacityMw: kwToMw(x.capacityKw), demandMw: kwToMw(x.demandKw), suppliedMw: kwToMw(x.suppliedKw), utilization: x.utilization, overload: x.overload, sourceId: x.sourceId, sourcePathLength: x.sourcePathSegmentIds.length, sourcePathCapacityMw: kwToMw(x.sourcePathCapacityKw), assignedBuildingCount: x.assignedBuildingCount } : null; }
  getLineSegmentSnapshot(id: number): PowerLineSegmentSnapshot | null { const x = this.lineSegments[id]; return x ? { id: x.id, fromNodeId: x.fromNodeId, toNodeId: x.toNodeId, lengthMeters: x.lengthMeters, capacityMw: kwToMw(x.capacityKw), currentLoadMw: kwToMw(x.currentLoadKw), loadRatio: x.capacityKw > EPS ? x.currentLoadKw / x.capacityKw : 0, state: x.state } : null; }
  getBuildingSnapshot(id: number): BuildingPowerSnapshot | null { const x = this.buildingConnections.get(id); return x ? { ...x } : null; }

  private buildLineSegments(): void {
    const pairs = new Map<string, number>();
    for (const e of this.net.edges) {
      const lo = Math.min(e.from, e.to), hi = Math.max(e.from, e.to), key = `${lo}:${hi}`, cap = this.lineCapacityKw(e), old = pairs.get(key);
      if (old !== undefined) { const s = this.lineSegments[old]; s.roadEdgeIds.push(e.id); s.capacityKw = Math.max(s.capacityKw, cap); this.roadEdgeToSegment[e.id] = old; continue; }
      const id = this.lineSegments.length; this.lineSegments.push({ id, fromNodeId: lo, toNodeId: hi, roadEdgeIds: [e.id], lengthMeters: e.length, capacityKw: cap, currentLoadKw: 0, state: PowerLineState.Active }); pairs.set(key, id); this.roadEdgeToSegment[e.id] = id;
    }
  }
  private lineCapacityKw(e: RoadEdge): number {
    let mw = this.config.lineCapacityLocalMw;
    if (e.roadClass === RoadClass.Highway) mw = this.config.lineCapacityHighwayMw; else if (e.roadClass === RoadClass.Arterial) mw = this.config.lineCapacityArterialMw; else if (e.roadClass === RoadClass.Collector) mw = this.config.lineCapacityCollectorMw; else if (e.roadClass === RoadClass.Path) mw = this.config.lineCapacityPathMw;
    return mwToKw(mw * Math.max(1, Math.sqrt(Math.max(1, e.lanes))));
  }

  private buildGenerationFacilities(): void {
    const add = (type: GenerationType, i: number, count: number, anchor: { x: number; z: number }, radius: number, districts: ReadonlySet<DistrictType>, maxMw: number): void => {
      const a = (i / Math.max(1, count)) * Math.PI * 2 + (type === GenerationType.Thermal ? 0.45 : 1.2), x = this.clampCity(anchor.x + Math.cos(a) * radius), z = this.clampCity(anchor.z + Math.sin(a) * radius), roadNodeId = this.nearestNodeForDistrict(x, z, districts), node = roadNodeId >= 0 ? this.net.nodes[roadNodeId] : null, maxOutputKw = mwToKw(maxMw);
      this.generationFacilities.push({ id: `${type}-${i}`, type, x: node?.x ?? x, z: node?.z ?? z, roadNodeId, maxOutputKw, availableOutputKw: type === GenerationType.Thermal ? maxOutputKw : 0, currentOutputKw: 0, utilization: 0, state: PowerAssetState.Online });
    };
    const thermalCount = Math.max(0, Math.floor(this.config.thermalPlantCount)), solarCount = Math.max(0, Math.floor(this.config.solarPlantCount)), industrial = this.city.planning.industrialCenter, logistics = this.city.planning.logisticsCenter;
    for (let i = 0; i < thermalCount; i++) add(GenerationType.Thermal, i, thermalCount, i % 2 ? logistics : industrial, Math.max(160, this.city.sizeMeters * (0.012 + (i % 3) * 0.004)), new Set([DistrictType.Industrial, DistrictType.Logistics]), this.config.thermalPlantCapacityMw);
    for (let i = 0; i < solarCount; i++) add(GenerationType.Solar, i, solarCount, i % 2 ? industrial : logistics, Math.max(280, this.city.sizeMeters * (0.025 + (i % 4) * 0.006)), new Set([DistrictType.Industrial, DistrictType.Logistics, DistrictType.ResidentialLow]), this.config.solarPlantCapacityMw);
  }

  private buildExternalConnections(): void {
    const gates = this.city.gateNodes.filter((n) => n >= 0 && n < this.net.nodes.length), count = Math.min(Math.max(0, Math.floor(this.config.externalConnectionCount)), gates.length); if (!count) return;
    const each = mwToKw(this.config.externalGridCapacityMw) / count;
    for (let i = 0; i < count; i++) { const nodeId = gates[Math.floor(i * gates.length / count)], n = this.net.nodes[nodeId]; this.externalConnections.push({ id: `external-${i}`, x: n.x, z: n.z, roadNodeId: nodeId, maxImportKw: each, currentImportKw: 0, utilization: 0, state: PowerAssetState.Online }); }
  }

  private buildSubstations(): void {
    if (!this.net.nodes.length) return; const spacing = Math.max(300, this.config.substationSpacingMeters), minD2 = (spacing * 0.48) ** 2;
    const candidates = this.net.nodes.filter((n) => { const p = this.city.planning.sample(n.x, n.z); return p.district !== DistrictType.Park && (p.urbanScore >= this.city.urbanThreshold * 0.82 || p.district === DistrictType.Industrial || p.district === DistrictType.Logistics || p.district === DistrictType.Civic); }), pool = candidates.length ? candidates : this.net.nodes;
    const addNearest = (x: number, z: number): void => {
      if (this.substations.length >= 256) return; let best = -1, d = Infinity;
      for (const n of pool) { const q = (n.x - x) ** 2 + (n.z - z) ** 2; if (q < d) { d = q; best = n.id; } } if (best < 0) return; const n = this.net.nodes[best];
      if (this.substations.some((s) => (s.x - n.x) ** 2 + (s.z - n.z) ** 2 < minD2)) return;
      const p = this.city.planning.sample(n.x, n.z); let factor = 1; if (p.district === DistrictType.CBD) factor = 1.4; else if (p.district === DistrictType.Industrial || p.district === DistrictType.Logistics) factor = 1.3; else if (p.district === DistrictType.Commercial || p.district === DistrictType.MixedUse) factor = 1.15;
      this.substations.push({ id: `substation-${this.substations.length}`, x: n.x, z: n.z, roadNodeId: n.id, district: p.district, capacityKw: mwToKw(this.config.substationCapacityMw * factor), demandKw: 0, suppliedKw: 0, utilization: 0, overload: false, state: PowerAssetState.Online, sourceId: null, sourcePathSegmentIds: [], sourcePathCapacityKw: 0, assignedBuildingCount: 0 });
    };
    for (let z = spacing * 0.5; z < this.city.sizeMeters && this.substations.length < 256; z += spacing) for (let x = spacing * 0.5; x < this.city.sizeMeters && this.substations.length < 256; x += spacing) addNearest(x, z);
    addNearest(this.city.planning.industrialCenter.x, this.city.planning.industrialCenter.z); addNearest(this.city.planning.logisticsCenter.x, this.city.planning.logisticsCenter.z); addNearest(this.city.planning.cbd.x, this.city.planning.cbd.z); if (!this.substations.length) addNearest(this.city.sizeMeters * 0.5, this.city.sizeMeters * 0.5);
  }

  private buildBuildingConnections(): void {
    const distribution = this.substations.length ? this.multiSourceSubstationRouting() : null;
    for (const b of this.city.buildings) {
      const roadNodeId = this.frontageRoadNode(b), si = distribution && roadNodeId >= 0 ? distribution.substationIndex[roadNodeId] : -1, sub = si >= 0 ? this.substations[si] : null, distance = distribution && roadNodeId >= 0 ? distribution.distance[roadNodeId] : Infinity; if (sub) sub.assignedBuildingCount++;
      this.buildingConnections.set(b.id, { buildingId: b.id, roadNodeId, substationId: sub?.id ?? null, distributionDistanceMeters: distance, outsideServiceRadius: distance > this.config.substationServiceRadiusMeters, demandKw: 0, suppliedKw: 0, supplyRatio: sub ? 1 : 0, priority: this.priorityForBuilding(b), state: sub ? BuildingPowerState.Supplied : BuildingPowerState.Disconnected });
    }
  }
  private frontageRoadNode(b: Building): number { let x = b.x, z = b.z; if (b.frontage === 'north') z -= b.depth * 0.5; else if (b.frontage === 'south') z += b.depth * 0.5; else if (b.frontage === 'west') x -= b.width * 0.5; else x += b.width * 0.5; return this.net.nearestNode(x, z); }
  private priorityForBuilding(b: Building): PowerPriority {
    const f = this.city.facilities.find((x) => x.buildingId === b.id);
    if (f?.type === FacilityType.Hospital || f?.type === FacilityType.PoliceStation || f?.type === FacilityType.FireStation) return PowerPriority.Critical;
    if (f?.type === FacilityType.CityHall || f?.type === FacilityType.University || f?.type === FacilityType.School || b.district === DistrictType.Civic) return PowerPriority.High;
    if (f || b.archetype === BuildingArchetype.Factory || b.archetype === BuildingArchetype.Warehouse || b.archetype >= BuildingArchetype.SmallOffice) return PowerPriority.Medium;
    return PowerPriority.Low;
  }

  private rebuildSourceTopology(): void {
    this.topologyDirty = false; const sources = this.firmSources(); if (!sources.length) { for (const s of this.substations) { s.sourceId = null; s.sourcePathSegmentIds = []; s.sourcePathCapacityKw = 0; } return; }
    const routes = this.multiSourceRouting(sources);
    for (const s of this.substations) {
      const src = s.roadNodeId >= 0 ? routes.sourceIndex[s.roadNodeId] : -1; if (src < 0 || !Number.isFinite(routes.distance[s.roadNodeId])) { s.sourceId = null; s.sourcePathSegmentIds = []; s.sourcePathCapacityKw = 0; continue; }
      const path: number[] = []; let node = s.roadNodeId, cap = Infinity, guard = this.net.nodes.length + 1;
      while (guard-- > 0) { const edgeId = routes.previousEdge[node]; if (edgeId < 0) break; const seg = this.roadEdgeToSegment[edgeId]; if (seg < 0) break; path.push(seg); cap = Math.min(cap, this.lineSegments[seg].capacityKw); node = this.net.edges[edgeId].from; }
      s.sourceId = sources[src]?.id ?? null; s.sourcePathSegmentIds = path; s.sourcePathCapacityKw = path.length ? cap : s.capacityKw;
    }
  }
  private firmSources(): Source[] {
    const out: Source[] = [];
    for (const x of this.generationFacilities) if (x.type === GenerationType.Thermal && x.state === PowerAssetState.Online && x.roadNodeId >= 0) out.push({ id: x.id, roadNodeId: x.roadNodeId });
    for (const x of this.externalConnections) if (x.state === PowerAssetState.Online && x.roadNodeId >= 0) out.push({ id: x.id, roadNodeId: x.roadNodeId });
    if (!out.length) for (const x of this.generationFacilities) if (x.state === PowerAssetState.Online && x.roadNodeId >= 0) out.push({ id: x.id, roadNodeId: x.roadNodeId }); return out;
  }

  private multiSourceRouting(sources: Source[]): RouteResult {
    const n = this.net.nodes.length, distance = new Float64Array(n), previousEdge = new Int32Array(n), sourceIndex = new Int32Array(n), heap = new MinHeap(); distance.fill(Infinity); previousEdge.fill(-1); sourceIndex.fill(-1);
    sources.forEach((s, i) => { if (s.roadNodeId >= 0 && s.roadNodeId < n && distance[s.roadNodeId] > 0) { distance[s.roadNodeId] = 0; sourceIndex[s.roadNodeId] = i; heap.push({ node: s.roadNodeId, distance: 0 }); } });
    while (heap.size) { const cur = heap.pop()!; if (cur.distance !== distance[cur.node]) continue; for (const edgeId of this.net.nodes[cur.node].edges) { const e = this.net.edges[edgeId], seg = this.roadEdgeToSegment[edgeId]; if (seg < 0 || this.lineSegments[seg].state !== PowerLineState.Active) continue; const d = cur.distance + e.length; if (d >= distance[e.to]) continue; distance[e.to] = d; previousEdge[e.to] = edgeId; sourceIndex[e.to] = sourceIndex[cur.node]; heap.push({ node: e.to, distance: d }); } }
    return { distance, previousEdge, sourceIndex };
  }
  private multiSourceSubstationRouting(): DistributionResult {
    const n = this.net.nodes.length, distance = new Float64Array(n), substationIndex = new Int32Array(n), heap = new MinHeap(); distance.fill(Infinity); substationIndex.fill(-1);
    this.substations.forEach((s, i) => { if (s.roadNodeId >= 0 && s.roadNodeId < n && distance[s.roadNodeId] > 0) { distance[s.roadNodeId] = 0; substationIndex[s.roadNodeId] = i; heap.push({ node: s.roadNodeId, distance: 0 }); } });
    while (heap.size) { const cur = heap.pop()!; if (cur.distance !== distance[cur.node]) continue; for (const edgeId of this.net.nodes[cur.node].edges) { const e = this.net.edges[edgeId], seg = this.roadEdgeToSegment[edgeId]; if (seg < 0 || this.lineSegments[seg].state !== PowerLineState.Active) continue; const d = cur.distance + e.length; if (d >= distance[e.to]) continue; distance[e.to] = d; substationIndex[e.to] = substationIndex[cur.node]; heap.push({ node: e.to, distance: d }); } }
    return { distance, substationIndex };
  }

  private updateAvailableGeneration(total: number): void {
    const h = ((total / 3600) % 24 + 24) % 24, solar = h <= 6 || h >= 18 ? 0 : Math.sin((h - 6) / 12 * Math.PI) ** 1.35;
    for (const x of this.generationFacilities) { if (x.state !== PowerAssetState.Online) { x.availableOutputKw = x.currentOutputKw = x.utilization = 0; continue; } x.availableOutputKw = x.type === GenerationType.Solar ? x.maxOutputKw * solar : x.maxOutputKw; x.currentOutputKw = x.utilization = 0; }
    for (const x of this.externalConnections) x.currentImportKw = x.utilization = 0;
  }

  private distributePower(): void {
    for (const x of this.lineSegments) x.currentLoadKw = 0; for (const s of this.substations) { s.demandKw = s.suppliedKw = s.utilization = 0; s.overload = false; }
    const byId = new Map(this.substations.map((s, i) => [s.id, i] as const)); let demand = 0;
    for (const c of this.buildingConnections.values()) { demand += c.demandKw; c.suppliedKw = 0; if (!c.substationId || !byId.has(c.substationId)) { c.supplyRatio = 0; c.state = BuildingPowerState.Disconnected; } else this.substations[byId.get(c.substationId)!].demandKw += c.demandKw; }
    const sourceCapacity = this.availableSystemCapacityKw(), potential = new Float64Array(this.substations.length); let networkPotential = 0;
    this.substations.forEach((s, i) => { s.overload = s.demandKw > s.capacityKw + EPS; if (s.state !== PowerAssetState.Online || !s.sourceId) return; const cap = s.sourcePathCapacityKw > 0 ? s.sourcePathCapacityKw : s.capacityKw; potential[i] = Math.max(0, Math.min(s.demandKw, s.capacityKw, cap)); networkPotential += potential[i]; });
    const target = Math.min(demand, sourceCapacity, networkPotential), scale = networkPotential > EPS ? Math.min(1, target / networkPotential) : 0;
    this.substations.forEach((s, i) => { s.suppliedKw = potential[i] * scale; s.utilization = s.capacityKw > EPS ? s.suppliedKw / s.capacityKw : 0; for (const seg of s.sourcePathSegmentIds) if (this.lineSegments[seg]?.state === PowerLineState.Active) this.lineSegments[seg].currentLoadKw += s.suppliedKw; }); this.dispatchGeneration(target);
    for (const c of this.buildingConnections.values()) { if (!c.substationId || !byId.has(c.substationId)) continue; const s = this.substations[byId.get(c.substationId)!], ratio = s.demandKw > EPS ? clamp01(s.suppliedKw / s.demandKw) : 1; c.supplyRatio = ratio; c.suppliedKw = c.demandKw * ratio; if (s.state !== PowerAssetState.Online || !s.sourceId) { c.supplyRatio = c.suppliedKw = 0; c.state = BuildingPowerState.Blackout; } else if (c.demandKw <= EPS || ratio >= .999) c.state = BuildingPowerState.Supplied; else c.state = ratio <= this.config.blackoutSupplyRatio ? BuildingPowerState.Blackout : BuildingPowerState.Limited; }
    let supplied = 0; for (const c of this.buildingConnections.values()) supplied += c.suppliedKw;
    if (demand <= EPS) this.gridState = PowerGridState.Normal; else if (supplied / demand <= this.config.blackoutSupplyRatio) this.gridState = PowerGridState.Blackout; else if (supplied + EPS < demand) this.gridState = PowerGridState.LimitedSupply; else this.gridState = (sourceCapacity - demand) / demand < this.config.tightReserveMarginRatio ? PowerGridState.Tight : PowerGridState.Normal;
  }

  private dispatchGeneration(target: number): void {
    let remaining = Math.max(0, target); remaining -= this.dispatchGroup(this.generationFacilities.filter((x) => x.type === GenerationType.Solar && x.state === PowerAssetState.Online), remaining); remaining -= this.dispatchGroup(this.generationFacilities.filter((x) => x.type === GenerationType.Thermal && x.state === PowerAssetState.Online), remaining);
    const ext = this.externalConnections.filter((x) => x.state === PowerAssetState.Online), cap = ext.reduce((s, x) => s + x.maxImportKw, 0), use = Math.min(Math.max(0, remaining), cap); for (const x of ext) { x.currentImportKw = use * (cap > EPS ? x.maxImportKw / cap : 0); x.utilization = x.maxImportKw > EPS ? x.currentImportKw / x.maxImportKw : 0; }
  }
  private dispatchGroup(group: GenerationFacility[], requested: number): number { const cap = group.reduce((s, x) => s + x.availableOutputKw, 0), use = Math.min(Math.max(0, requested), cap); for (const x of group) { x.currentOutputKw = use * (cap > EPS ? x.availableOutputKw / cap : 0); x.utilization = x.maxOutputKw > EPS ? x.currentOutputKw / x.maxOutputKw : 0; } return use; }
  private availableSystemCapacityKw(): number { return this.generationFacilities.reduce((s, x) => s + (x.state === PowerAssetState.Online ? x.availableOutputKw : 0), 0) + this.externalConnections.reduce((s, x) => s + (x.state === PowerAssetState.Online ? x.maxImportKw : 0), 0); }
  private nearestNodeForDistrict(x: number, z: number, districts: ReadonlySet<DistrictType>): number { let best = -1, d = Infinity; for (const n of this.net.nodes) { if (!districts.has(this.city.planning.sample(n.x, n.z).district)) continue; const q = (n.x - x) ** 2 + (n.z - z) ** 2; if (q < d) { d = q; best = n.id; } } return best >= 0 ? best : this.net.nearestNode(x, z); }
  private clampCity(v: number): number { return Math.max(0, Math.min(this.city.sizeMeters, v)); }
}
