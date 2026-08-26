import { latestRailPassengerProvider } from '../rendering/RailPassengerBridge';
import '../rendering/RailPassengerStairClearance';
import '../rendering/RailPassengerGroundStairs';
import { World } from './World';
import './RailPassengerIntegration';

type AnyWorld = any;
const proto: AnyWorld = World.prototype as any;
const originalBeginTrip = proto.beginTrip as (agent: number) => void;

proto.beginTrip = function autoAttachRailPassengerProvider(this: World, agent: number): void {
  const provider = latestRailPassengerProvider();
  if (provider) this.attachRailTransit(provider);
  originalBeginTrip.call(this, agent);
};
