import { BuildingArchetype, type Building } from '../generation/CityGenerator';
import { PowerLoadKind, type BuildingPowerConnection, type InfrastructurePowerLoad } from './PowerTypes';
import type { PowerSystem } from './PowerSystem';
import { registerPowerQualityAccessor, type PowerQualityAccessor } from './PowerRuntimeRegistry';

export type PowerPhase = 'A' | 'B' | 'C' | 'ABC';
export interface ThreePhaseValues { a: number; b: number; c: number }

export interface PowerQualitySnapshot {
  nominalFrequencyHz: number;
  frequencyHz: number;
  nominalGridVoltageKv: number;
  averageGridVoltageKv: number;
  averageVoltagePu: number;
  activePowerMw: number;
  reactivePowerMvar: number;
  apparentPowerMva: number;
  powerFactor: number;
  phaseAnglesDeg: ThreePhaseValues;
  phaseCurrentA: ThreePhaseValues;
  phaseImbalanceRatio: number;
  underVoltageZoneCount: number;
  frequencyDeviationZoneCount: number;
  phaseImbalanceZoneCount: number;
  zoneCount: number;
  lastUpdateSimSeconds: number;
}

export interface PowerZoneElectricalSnapshot {
  zoneId: number;
  voltagePu: number;
  lineLineVoltageKv: number;
  frequencyHz: number;
  activePowerMw: number;
  reactivePowerMvar: number;
  apparentPowerMva: number;
  powerFactor: number;
  phaseActivePowerMw: ThreePhaseValues;
  phaseReactivePowerMvar: ThreePhaseValues;
  phaseCurrentA: ThreePhaseValues;
  phaseVoltagePu: ThreePhaseValues;
  phaseAnglesDeg: ThreePhaseValues;
  phaseImbalanceRatio: number;
}

export interface PowerLineElectricalSnapshot {
  lineSegmentId: number;
  activePowerMw: number;
  reactivePowerMvar: number;
  apparentPowerMva: number;
  currentA: number;
  phaseCurrentA: ThreePhaseValues;
  fromVoltagePu: number;
  toVoltagePu: number;
  voltageDropPu: number;
  phaseAngleDropDeg: number;
  resistanceOhm: number;
  reactanceOhm: number;
}

export interface ConsumerElectricalSnapshot {
  id: string;
  phase: PowerPhase;
  activePowerKw: number;
  reactivePowerKvar: number;
  apparentPowerKva: number;
  powerFactor: number;
  serviceVoltageV: number;
  voltagePu: number;
  frequencyHz: number;
  phaseVoltagePu: ThreePhaseValues;
  phaseAnglesDeg: ThreePhaseValues;
  phaseCurrentA: ThreePhaseValues;
  phaseImbalanceRatio: number;
  operationalFactor: number;
}

interface PhaseAccumulator { p: ThreePhaseValues; q: ThreePhaseValues }
const EPS = 1e-6;
const SQRT3 = Math.sqrt(3);
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
const clamp01 = (value: number): number => clamp(value, 0, 1);
const phases = (): ThreePhaseValues => ({ a: 0, b: 0, c: 0 });
const values = (a: number, b: number, c: number): ThreePhaseValues => ({ a, b, c });

export class PowerQualityModel implements PowerQualityAccessor {
  private readonly buildings = new Map<number, Building>();
  private readonly zones = new Map<number, PowerZoneElectricalSnapshot>();
  private readonly lines = new Map<number, PowerLineElectricalSnapshot>();
  private readonly buildingsElectrical = new Map<number, ConsumerElectricalSnapshot>();
  private readonly infrastructureElectrical = new Map<string, ConsumerElectricalSnapshot>();
  private lastUpdateSimSeconds = -1;
  private aggregate: PowerQualitySnapshot;

  constructor(private readonly system: PowerSystem) {
    for (const building of system.city.buildings) this.buildings.set(building.id, building);
    this.aggregate = this.emptySnapshot(0);
    registerPowerQualityAccessor(system, this);
  }

  update(totalSimSeconds: number): void {
    if (totalSimSeconds === this.lastUpdateSimSeconds) return;
    this.lastUpdateSimSeconds = totalSimSeconds;
    this.zones.clear(); this.lines.clear(); this.buildingsElectrical.clear(); this.infrastructureElectrical.clear();

    const zoneSnapshots = this.system.getPowerZoneSnapshots();
    const zonePhase = new Map<number, PhaseAccumulator>();
    for (const zone of zoneSnapshots) zonePhase.set(zone.id, { p: phases(), q: phases() });

    for (const connection of this.system.buildingConnections.values()) {
      const building = this.buildings.get(connection.buildingId);
      if (!building || connection.zoneId < 0) continue;
      const pf = this.buildingPowerFactor(building);
      this.addPhaseLoad(zonePhase.get(connection.zoneId), this.phaseForBuilding(building, connection), connection.gridSuppliedKw, this.reactiveFor(connection.gridSuppliedKw, pf));
    }
    for (const load of this.system.infrastructureLoads) {
      if (load.zoneId < 0) continue;
      const pf = this.infrastructurePowerFactor(load);
      this.addPhaseLoad(zonePhase.get(load.zoneId), this.phaseForInfrastructure(load), load.gridSuppliedKw, this.reactiveFor(load.gridSuppliedKw, pf));
    }

    for (const zone of zoneSnapshots) {
      const acc = zonePhase.get(zone.id) ?? { p: phases(), q: phases() };
      const pKw = acc.p.a + acc.p.b + acc.p.c, qKvar = acc.q.a + acc.q.b + acc.q.c;
      const sKva = Math.hypot(pKw, qKvar), pf = sKva > EPS ? pKw / sKva : 1;
      const demandMw = Math.max(EPS, zone.demandMw), generationDeficit = Math.max(0, zone.demandMw - zone.availableCapacityMw) / demandMw;
      const frequencyHz = zone.availableCapacityMw <= EPS && zone.demandMw > EPS
        ? 0
        : this.system.config.nominalFrequencyHz * (1 - this.system.config.frequencyDroopRatio * clamp01(generationDeficit));
      const utilization = zone.availableCapacityMw > EPS ? clamp(zone.suppliedMw / zone.availableCapacityMw, 0, 2) : (zone.demandMw > EPS ? 2 : 0);
      const reactiveRatio = pKw > EPS ? Math.abs(qKvar / pKw) : 0;
      const baseVoltagePu = clamp(1 - this.system.config.voltageLoadDropPu * utilization - this.system.config.reactiveVoltageDropPu * reactiveRatio, 0.65, 1.08);
      const phaseCurrentA = this.phaseCurrents(acc.p, acc.q, this.system.config.nominalGridVoltageKv * 1000, baseVoltagePu);
      const imbalance = this.imbalanceRatio(phaseCurrentA);
      const phaseVoltagePu = this.phaseVoltageFromImbalance(baseVoltagePu, acc.p, imbalance);
      const angleShift = -this.system.config.maxZonePhaseShiftDeg * clamp(utilization, 0, 1.5);
      const phaseAnglesDeg = values(angleShift, -120 + angleShift, 120 + angleShift);
      this.zones.set(zone.id, {
        zoneId: zone.id, voltagePu: baseVoltagePu, lineLineVoltageKv: this.system.config.nominalGridVoltageKv * baseVoltagePu,
        frequencyHz, activePowerMw: pKw / 1000, reactivePowerMvar: qKvar / 1000, apparentPowerMva: sKva / 1000, powerFactor: pf,
        phaseActivePowerMw: values(acc.p.a / 1000, acc.p.b / 1000, acc.p.c / 1000),
        phaseReactivePowerMvar: values(acc.q.a / 1000, acc.q.b / 1000, acc.q.c / 1000), phaseCurrentA, phaseVoltagePu, phaseAnglesDeg,
        phaseImbalanceRatio: imbalance,
      });
    }

    for (const segment of this.system.lineSegments) this.updateLine(segment.id);
    for (const connection of this.system.buildingConnections.values()) this.updateBuildingConsumer(connection);
    for (const load of this.system.infrastructureLoads) this.updateInfrastructureConsumer(load);
    this.aggregate = this.buildAggregate(totalSimSeconds);
  }

  snapshot(): PowerQualitySnapshot { return { ...this.aggregate, phaseAnglesDeg: { ...this.aggregate.phaseAnglesDeg }, phaseCurrentA: { ...this.aggregate.phaseCurrentA } }; }
  zoneSnapshots(): PowerZoneElectricalSnapshot[] { return [...this.zones.values()].map((value) => ({ ...value, phaseActivePowerMw: { ...value.phaseActivePowerMw }, phaseReactivePowerMvar: { ...value.phaseReactivePowerMvar }, phaseCurrentA: { ...value.phaseCurrentA }, phaseVoltagePu: { ...value.phaseVoltagePu }, phaseAnglesDeg: { ...value.phaseAnglesDeg } })); }
  lineSnapshot(id: number): PowerLineElectricalSnapshot | null { const value = this.lines.get(id); return value ? { ...value, phaseCurrentA: { ...value.phaseCurrentA } } : null; }
  buildingSnapshot(id: number): ConsumerElectricalSnapshot | null { const value = this.buildingsElectrical.get(id); return value ? this.cloneConsumer(value) : null; }
  infrastructureSnapshot(id: string): ConsumerElectricalSnapshot | null { const value = this.infrastructureElectrical.get(id); return value ? this.cloneConsumer(value) : null; }

  operationalFactorForBuilding(buildingId: number): number { return this.buildingsElectrical.get(buildingId)?.operationalFactor ?? (this.system.buildingConnections.get(buildingId)?.supplyRatio ?? 1); }
  operationalFactorForInfrastructure(id: string): number { return this.infrastructureElectrical.get(id)?.operationalFactor ?? (this.system.infrastructureLoads.find((value) => value.id === id)?.supplyRatio ?? 1); }

  private updateLine(id: number): void {
    const segment = this.system.lineSegments[id]; if (!segment) return;
    const zone = this.zones.get(segment.zoneId);
    const voltageV = Math.max(1, this.system.config.nominalGridVoltageKv * 1000 * (zone?.voltagePu ?? 1));
    const pKw = segment.currentLoadKw;
    const zoneRatio = zone && zone.activePowerMw > EPS ? zone.reactivePowerMvar / zone.activePowerMw : 0;
    const qKvar = pKw * zoneRatio, sKva = Math.hypot(pKw, qKvar);
    const km = Math.max(0, segment.lengthMeters) / 1000;
    const resistance = this.system.config.lineResistanceOhmPerKm * km, reactance = this.system.config.lineReactanceOhmPerKm * km;
    const pW = pKw * 1000, qVar = qKvar * 1000;
    const voltageDropPu = clamp((resistance * pW + reactance * qVar) / (voltageV * voltageV), 0, 0.25);
    const phaseAngleDropDeg = clamp((reactance * pW - resistance * qVar) / (voltageV * voltageV) * 180 / Math.PI, -25, 25);
    const currentA = sKva * 1000 / (SQRT3 * voltageV);
    const shares = zone ? this.phaseShares(zone.phaseActivePowerMw) : values(1 / 3, 1 / 3, 1 / 3);
    const phaseCurrentA = values(currentA * shares.a * 3, currentA * shares.b * 3, currentA * shares.c * 3);
    const fromVoltagePu = zone?.voltagePu ?? 1;
    this.lines.set(id, { lineSegmentId: id, activePowerMw: pKw / 1000, reactivePowerMvar: qKvar / 1000, apparentPowerMva: sKva / 1000,
      currentA, phaseCurrentA, fromVoltagePu, toVoltagePu: clamp(fromVoltagePu - voltageDropPu, 0, 1.15), voltageDropPu, phaseAngleDropDeg,
      resistanceOhm: resistance, reactanceOhm: reactance });
  }

  private updateBuildingConsumer(connection: BuildingPowerConnection): void {
    const building = this.buildings.get(connection.buildingId); if (!building) return;
    const phase = this.phaseForBuilding(building, connection), pf = this.buildingPowerFactor(building);
    const snapshot = this.consumerSnapshot(`building-${connection.buildingId}`, phase, connection, pf, this.pathForBuilding(connection));
    this.buildingsElectrical.set(connection.buildingId, snapshot);
  }

  private updateInfrastructureConsumer(load: InfrastructurePowerLoad): void {
    const phase = this.phaseForInfrastructure(load), pf = this.infrastructurePowerFactor(load);
    this.infrastructureElectrical.set(load.id, this.consumerSnapshot(load.id, phase, load, pf, this.pathForInfrastructure(load)));
  }

  private consumerSnapshot(id: string, phase: PowerPhase, consumer: BuildingPowerConnection | InfrastructurePowerLoad, pf: number, path: number[]): ConsumerElectricalSnapshot {
    const zone = this.zones.get(consumer.zoneId);
    let voltagePu = zone?.voltagePu ?? (consumer.gridSuppliedKw > EPS ? 1 : 0), angleDrop = 0;
    for (const segmentId of path) { const line = this.lines.get(segmentId); if (!line) continue; voltagePu -= line.voltageDropPu; angleDrop += line.phaseAngleDropDeg; }
    voltagePu = clamp(voltagePu, 0, 1.15);
    const frequencyHz = zone?.frequencyHz ?? 0;
    const phaseVoltagePu = zone ? { ...zone.phaseVoltagePu } : values(voltagePu, voltagePu, voltagePu);
    const pathDelta = (zone?.voltagePu ?? voltagePu) - voltagePu;
    phaseVoltagePu.a = clamp(phaseVoltagePu.a - pathDelta, 0, 1.2); phaseVoltagePu.b = clamp(phaseVoltagePu.b - pathDelta, 0, 1.2); phaseVoltagePu.c = clamp(phaseVoltagePu.c - pathDelta, 0, 1.2);
    const phaseAnglesDeg = values(-angleDrop, -120 - angleDrop, 120 - angleDrop);
    const pKw = consumer.suppliedKw, qKvar = this.reactiveFor(pKw, pf), sKva = Math.hypot(pKw, qKvar);
    const phaseCurrentA = this.consumerPhaseCurrent(phase, sKva, voltagePu);
    const serviceVoltageV = this.system.config.serviceVoltageV * voltagePu;
    const quality = this.qualityFactor(voltagePu, frequencyHz, zone?.phaseImbalanceRatio ?? 0);
    const demand = Math.max(EPS, consumer.demandKw), gridRatio = clamp01(consumer.gridSuppliedKw / demand), emergencyRatio = clamp01(consumer.emergencySuppliedKw / demand);
    const operationalFactor = clamp01(gridRatio * quality + emergencyRatio);
    return { id, phase, activePowerKw: pKw, reactivePowerKvar: qKvar, apparentPowerKva: sKva, powerFactor: pf, serviceVoltageV, voltagePu,
      frequencyHz, phaseVoltagePu, phaseAnglesDeg, phaseCurrentA, phaseImbalanceRatio: zone?.phaseImbalanceRatio ?? 0, operationalFactor };
  }

  private pathForBuilding(connection: BuildingPowerConnection): number[] {
    const substation = connection.substationId ? this.system.substations.find((value) => value.id === connection.substationId) : null;
    return this.uniquePath(substation?.sourcePathSegmentIds ?? [], connection.distributionPathSegmentIds);
  }
  private pathForInfrastructure(load: InfrastructurePowerLoad): number[] {
    const substation = load.substationId ? this.system.substations.find((value) => value.id === load.substationId) : null;
    return this.uniquePath(substation?.sourcePathSegmentIds ?? [], load.distributionPathSegmentIds);
  }
  private uniquePath(a: readonly number[], b: readonly number[]): number[] { const seen = new Set<number>(), out: number[] = []; for (const id of a) if (!seen.has(id)) { seen.add(id); out.push(id); } for (const id of b) if (!seen.has(id)) { seen.add(id); out.push(id); } return out; }

  private buildingPowerFactor(building: Building): number {
    if (building.archetype === BuildingArchetype.Factory) return 0.88;
    if (building.archetype === BuildingArchetype.Warehouse) return 0.91;
    if (building.archetype === BuildingArchetype.OfficeTower || building.archetype === BuildingArchetype.OfficeSlab || building.archetype === BuildingArchetype.SmallOffice) return 0.94;
    if (building.archetype === BuildingArchetype.SmallShop || building.archetype === BuildingArchetype.RetailBox || building.archetype === BuildingArchetype.CommercialBlock || building.archetype === BuildingArchetype.LeisureHall) return 0.92;
    if (building.archetype === BuildingArchetype.MixedUse) return 0.93;
    return 0.97;
  }
  private infrastructurePowerFactor(load: InfrastructurePowerLoad): number {
    if (load.kind === PowerLoadKind.RailTraction) return 0.90;
    if (load.kind === PowerLoadKind.RailStation) return 0.93;
    if (load.kind === PowerLoadKind.StreetLight) return 0.95;
    return 0.98;
  }
  private phaseForBuilding(building: Building, connection: BuildingPowerConnection): PowerPhase {
    if (connection.demandKw >= 120 || building.floors >= 8 || building.archetype === BuildingArchetype.Factory || building.archetype === BuildingArchetype.Warehouse
      || building.archetype === BuildingArchetype.OfficeTower || building.archetype === BuildingArchetype.CommercialBlock) return 'ABC';
    return (building.id % 3 === 0 ? 'A' : building.id % 3 === 1 ? 'B' : 'C');
  }
  private phaseForInfrastructure(load: InfrastructurePowerLoad): PowerPhase {
    if (load.kind === PowerLoadKind.RailTraction || load.kind === PowerLoadKind.RailStation) return 'ABC';
    const hash = this.hash(load.id) % 3; return hash === 0 ? 'A' : hash === 1 ? 'B' : 'C';
  }

  private addPhaseLoad(acc: PhaseAccumulator | undefined, phase: PowerPhase, pKw: number, qKvar: number): void {
    if (!acc) return;
    if (phase === 'ABC') { acc.p.a += pKw / 3; acc.p.b += pKw / 3; acc.p.c += pKw / 3; acc.q.a += qKvar / 3; acc.q.b += qKvar / 3; acc.q.c += qKvar / 3; return; }
    const key = phase.toLowerCase() as 'a' | 'b' | 'c'; acc.p[key] += pKw; acc.q[key] += qKvar;
  }
  private reactiveFor(pKw: number, pf: number): number { const normalized = clamp(pf, 0.5, 1); return pKw * Math.tan(Math.acos(normalized)); }
  private phaseCurrents(p: ThreePhaseValues, q: ThreePhaseValues, lineVoltageV: number, voltagePu: number): ThreePhaseValues {
    const phaseVoltage = Math.max(1, lineVoltageV * voltagePu / SQRT3);
    return values(Math.hypot(p.a, q.a) * 1000 / phaseVoltage, Math.hypot(p.b, q.b) * 1000 / phaseVoltage, Math.hypot(p.c, q.c) * 1000 / phaseVoltage);
  }
  private consumerPhaseCurrent(phase: PowerPhase, apparentKva: number, voltagePu: number): ThreePhaseValues {
    const phaseVoltage = Math.max(1, this.system.config.serviceVoltageV * voltagePu / SQRT3);
    if (phase === 'ABC') { const current = apparentKva * 1000 / (3 * phaseVoltage); return values(current, current, current); }
    const current = apparentKva * 1000 / phaseVoltage; return phase === 'A' ? values(current, 0, 0) : phase === 'B' ? values(0, current, 0) : values(0, 0, current);
  }
  private imbalanceRatio(current: ThreePhaseValues): number { const avg = (current.a + current.b + current.c) / 3; if (avg <= EPS) return 0; return Math.max(Math.abs(current.a - avg), Math.abs(current.b - avg), Math.abs(current.c - avg)) / avg; }
  private phaseVoltageFromImbalance(base: number, p: ThreePhaseValues, imbalance: number): ThreePhaseValues {
    const avg = (p.a + p.b + p.c) / 3; if (avg <= EPS) return values(base, base, base);
    const k = this.system.config.phaseImbalanceVoltageDropPu * clamp(imbalance, 0, 1.5);
    return values(clamp(base - k * (p.a - avg) / avg, 0.6, 1.2), clamp(base - k * (p.b - avg) / avg, 0.6, 1.2), clamp(base - k * (p.c - avg) / avg, 0.6, 1.2));
  }
  private phaseShares(p: ThreePhaseValues): ThreePhaseValues { const total = p.a + p.b + p.c; return total > EPS ? values(p.a / total, p.b / total, p.c / total) : values(1 / 3, 1 / 3, 1 / 3); }
  private qualityFactor(voltagePu: number, frequencyHz: number, imbalance: number): number {
    const voltage = voltagePu >= 0.95 && voltagePu <= 1.05 ? 1 : voltagePu < 0.95 ? clamp01((voltagePu - 0.72) / 0.23) : clamp01((1.16 - voltagePu) / 0.11);
    const fDelta = Math.abs(frequencyHz - this.system.config.nominalFrequencyHz);
    const frequency = frequencyHz <= 0 ? 0 : fDelta <= 0.5 ? 1 : clamp01(1 - (fDelta - 0.5) / 2.5);
    const balance = imbalance <= 0.03 ? 1 : clamp(1 - (imbalance - 0.03) * 2.5, 0.55, 1);
    return clamp01(voltage * frequency * balance);
  }

  private buildAggregate(totalSimSeconds: number): PowerQualitySnapshot {
    let p = 0, q = 0, voltageWeighted = 0, frequencyWeighted = 0, weight = 0;
    const currents = phases(); let underVoltage = 0, frequencyDeviation = 0, imbalanceZones = 0, imbalanceWeighted = 0;
    for (const zone of this.zones.values()) {
      p += zone.activePowerMw; q += zone.reactivePowerMvar;
      const w = Math.max(EPS, zone.activePowerMw + Math.abs(zone.reactivePowerMvar));
      voltageWeighted += zone.voltagePu * w; frequencyWeighted += zone.frequencyHz * w; imbalanceWeighted += zone.phaseImbalanceRatio * w; weight += w;
      currents.a += zone.phaseCurrentA.a; currents.b += zone.phaseCurrentA.b; currents.c += zone.phaseCurrentA.c;
      if (zone.voltagePu < 0.90) underVoltage++;
      if (zone.frequencyHz <= 0 || Math.abs(zone.frequencyHz - this.system.config.nominalFrequencyHz) > 0.5) frequencyDeviation++;
      if (zone.phaseImbalanceRatio > 0.05) imbalanceZones++;
    }
    const voltagePu = weight > EPS ? voltageWeighted / weight : 1, frequencyHz = weight > EPS ? frequencyWeighted / weight : this.system.config.nominalFrequencyHz;
    const apparent = Math.hypot(p, q), pf = apparent > EPS ? p / apparent : 1;
    return { nominalFrequencyHz: this.system.config.nominalFrequencyHz, frequencyHz, nominalGridVoltageKv: this.system.config.nominalGridVoltageKv,
      averageGridVoltageKv: this.system.config.nominalGridVoltageKv * voltagePu, averageVoltagePu: voltagePu, activePowerMw: p, reactivePowerMvar: q,
      apparentPowerMva: apparent, powerFactor: pf, phaseAnglesDeg: values(0, -120, 120), phaseCurrentA: currents,
      phaseImbalanceRatio: weight > EPS ? imbalanceWeighted / weight : 0, underVoltageZoneCount: underVoltage, frequencyDeviationZoneCount: frequencyDeviation,
      phaseImbalanceZoneCount: imbalanceZones, zoneCount: this.zones.size, lastUpdateSimSeconds: totalSimSeconds };
  }
  private emptySnapshot(total: number): PowerQualitySnapshot { return { nominalFrequencyHz: this.system.config.nominalFrequencyHz, frequencyHz: this.system.config.nominalFrequencyHz,
    nominalGridVoltageKv: this.system.config.nominalGridVoltageKv, averageGridVoltageKv: this.system.config.nominalGridVoltageKv, averageVoltagePu: 1,
    activePowerMw: 0, reactivePowerMvar: 0, apparentPowerMva: 0, powerFactor: 1, phaseAnglesDeg: values(0, -120, 120), phaseCurrentA: phases(), phaseImbalanceRatio: 0,
    underVoltageZoneCount: 0, frequencyDeviationZoneCount: 0, phaseImbalanceZoneCount: 0, zoneCount: 0, lastUpdateSimSeconds: total }; }
  private cloneConsumer(value: ConsumerElectricalSnapshot): ConsumerElectricalSnapshot { return { ...value, phaseVoltagePu: { ...value.phaseVoltagePu }, phaseAnglesDeg: { ...value.phaseAnglesDeg }, phaseCurrentA: { ...value.phaseCurrentA } }; }
  private hash(value: string): number { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return h >>> 0; }
}
