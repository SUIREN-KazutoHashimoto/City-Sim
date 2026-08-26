import { getLoadedPowerConfig } from '../config/CityConfigLoader';
import { World } from '../world/World';
import { PowerSystem } from './PowerSystem';
import type { PowerSnapshot } from './PowerTypes';

type AnyWorld = World & Record<string, unknown>;
type AnyMethod = (...args: any[]) => any;

const systems = new WeakMap<World, PowerSystem>();

function ensurePower(world: World): PowerSystem {
  let system = systems.get(world);
  if (system) return system;
  system = new PowerSystem(world.city, getLoadedPowerConfig());
  system.update(0, world.clock.totalSeconds, true);
  systems.set(world, system);
  return system;
}

declare module '../world/World' {
  interface World {
    readonly power: PowerSystem;
    powerSnapshot(): PowerSnapshot;
  }
}

const proto = World.prototype as unknown as Record<string, any>;
if (!proto.__citySimPowerSystemP1P5) {
  Object.defineProperty(proto, 'power', {
    configurable: true,
    enumerable: false,
    get(this: World): PowerSystem { return ensurePower(this); },
  });

  const previousPopulate = proto.populate as AnyMethod;
  proto.populate = function populateWithPower(this: AnyWorld, count: number): void {
    ensurePower(this);
    previousPopulate.call(this, count);
  };

  const previousStepAfterPed = proto.stepAfterPed as AnyMethod;
  proto.stepAfterPed = function stepAfterPedWithPower(
    this: AnyWorld,
    now: number,
    updateActivities: boolean,
    dtSec: number,
  ): void {
    previousStepAfterPed.call(this, now, updateActivities, dtSec);
    ensurePower(this).update(dtSec, this.clock.totalSeconds);
  };

  proto.powerSnapshot = function powerSnapshot(this: AnyWorld): PowerSnapshot {
    return ensurePower(this).snapshot();
  };

  proto.__citySimPowerSystemP1P5 = true;
}
