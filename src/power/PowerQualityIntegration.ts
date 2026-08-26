import { PowerSystem } from './PowerSystem';
import { PowerQualityModel, type ConsumerElectricalSnapshot, type PowerLineElectricalSnapshot, type PowerQualitySnapshot, type PowerZoneElectricalSnapshot } from './PowerQualityModel';

const models = new WeakMap<PowerSystem, PowerQualityModel>();

type AnyMethod = (...args: any[]) => any;

function ensureQuality(system: PowerSystem): PowerQualityModel {
  let model = models.get(system);
  if (!model) { model = new PowerQualityModel(system); models.set(system, model); }
  return model;
}

declare module './PowerSystem' {
  interface PowerSystem {
    powerQualitySnapshot(): PowerQualitySnapshot;
    powerZoneElectricalSnapshots(): PowerZoneElectricalSnapshot[];
    powerLineElectricalSnapshot(id: number): PowerLineElectricalSnapshot | null;
    buildingElectricalSnapshot(id: number): ConsumerElectricalSnapshot | null;
    infrastructureElectricalSnapshot(id: string): ConsumerElectricalSnapshot | null;
  }
}

const proto = PowerSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimPowerQualityV109) {
  const previousUpdate = proto.update as AnyMethod;
  proto.update = function updateWithPowerQuality(this: PowerSystem, ...args: any[]): void {
    previousUpdate.apply(this, args);
    const last = this.snapshot().lastUpdateSimSeconds;
    ensureQuality(this).update(last);
  };
  proto.powerQualitySnapshot = function powerQualitySnapshot(this: PowerSystem): PowerQualitySnapshot {
    const model = ensureQuality(this); model.update(this.snapshot().lastUpdateSimSeconds); return model.snapshot();
  };
  proto.powerZoneElectricalSnapshots = function powerZoneElectricalSnapshots(this: PowerSystem): PowerZoneElectricalSnapshot[] {
    const model = ensureQuality(this); model.update(this.snapshot().lastUpdateSimSeconds); return model.zoneSnapshots();
  };
  proto.powerLineElectricalSnapshot = function powerLineElectricalSnapshot(this: PowerSystem, id: number): PowerLineElectricalSnapshot | null {
    const model = ensureQuality(this); model.update(this.snapshot().lastUpdateSimSeconds); return model.lineSnapshot(id);
  };
  proto.buildingElectricalSnapshot = function buildingElectricalSnapshot(this: PowerSystem, id: number): ConsumerElectricalSnapshot | null {
    const model = ensureQuality(this); model.update(this.snapshot().lastUpdateSimSeconds); return model.buildingSnapshot(id);
  };
  proto.infrastructureElectricalSnapshot = function infrastructureElectricalSnapshot(this: PowerSystem, id: string): ConsumerElectricalSnapshot | null {
    const model = ensureQuality(this); model.update(this.snapshot().lastUpdateSimSeconds); return model.infrastructureSnapshot(id);
  };
  proto.__citySimPowerQualityV109 = true;
}
