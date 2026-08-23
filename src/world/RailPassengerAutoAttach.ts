import { latestRailPassengerProvider } from '../rendering/RailPassengerBridge';
import { World } from './World';
import './RailPassengerIntegration';

type AnyWorld = World & Record<string, any>;
const proto = World.prototype as unknown as AnyWorld;
const originalBeginTrip = proto.beginTrip as (agent: number) => void;

proto.beginTrip = function autoAttachRailPassengerProvider(this: World, agent: number): void {
  const provider = latestRailPassengerProvider();
  if (provider) this.attachRailTransit(provider);
  originalBeginTrip.call(this, agent);
};
