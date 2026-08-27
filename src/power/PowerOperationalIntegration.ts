import { EnhancedRenderer } from '../rendering/EnhancedRenderer';
import { RailRenderer } from '../rendering/RailRenderer';
import {
  powerAverageBuildingFactorNear,
  powerAverageStreetLightFactorNear,
  powerRailStationFactor,
  powerRailTractionFactor,
} from './PowerRuntimeRegistry';

type AnyMethod = (...args: any[]) => any;
type AnyObject = Record<string, any>;

const rendererProto = EnhancedRenderer.prototype as unknown as AnyObject;
if (!rendererProto.__citySimPowerLightingImpactV109) {
  const previousNightLighting = rendererProto.updateNightLighting as AnyMethod;
  rendererProto.updateNightLighting = function updateNightLightingWithPower(this: AnyObject, hourF: number, cameraPos: { x: number; y: number; z: number }, vehicles: unknown): void {
    previousNightLighting.call(this, hourF, cameraPos, vehicles);
    const net = this.roadNet;
    if (!net) return;
    const buildingFactor = powerAverageBuildingFactorNear(net, cameraPos.x, cameraPos.z, 3200);
    const streetFactor = powerAverageStreetLightFactorNear(net, cameraPos.x, cameraPos.z, 2600);
    if (this.windowEarlyMat) this.windowEarlyMat.emissiveIntensity *= buildingFactor;
    if (this.windowLateMat) this.windowLateMat.emissiveIntensity *= buildingFactor;
    if (this.streetLampMat) this.streetLampMat.emissiveIntensity *= streetFactor;
    if (Array.isArray(this.streetLightPool)) for (const light of this.streetLightPool) light.intensity *= streetFactor;
  };
  rendererProto.__citySimPowerLightingImpactV109 = true;
}

const railBaseCruise = new WeakMap<object, number>();
const railProto = RailRenderer.prototype as unknown as AnyObject;
if (!railProto.__citySimPowerOperationsImpactV109) {
  const previousRailUpdate = railProto.update as AnyMethod;
  railProto.update = function updateRailWithPower(this: AnyObject, ...args: any[]): void {
    const traction = powerRailTractionFactor(this.rail);
    const speedFactor = traction >= 0.55 ? 1 : Math.max(0.35, 0.35 + traction * 1.18);
    if (Array.isArray(this.trainRuns)) {
      for (const run of this.trainRuns) {
        let base = railBaseCruise.get(run as object);
        if (base == null) { base = Math.max(0.1, Number(run.cruiseSpeed) || 0.1); railBaseCruise.set(run as object, base); }
        run.cruiseSpeed = base * speedFactor;
        if (Number.isFinite(run.currentSpeedLimit)) run.currentSpeedLimit = Math.min(run.currentSpeedLimit, run.cruiseSpeed);
        if (Number.isFinite(run.speed) && run.speed > run.cruiseSpeed * 1.08) run.speed = Math.max(run.cruiseSpeed, run.speed * 0.92);
      }
    }
    previousRailUpdate.apply(this, args);
    const stationFactor = powerRailStationFactor(this.rail);
    const lights = this.__citySimStationLightsV033;
    if (Array.isArray(lights)) for (const light of lights) light.intensity *= stationFactor;
  };
  railProto.__citySimPowerOperationsImpactV109 = true;
}
