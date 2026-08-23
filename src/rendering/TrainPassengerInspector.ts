import { Inspector } from './Inspector';
import '../world/RailPassengerMetrics';

type AnyInspector = any;
const proto = Inspector.prototype as unknown as AnyInspector;
const originalDescribeTrain = proto.describeTrain as (id: number) => string;

proto.describeTrain = function describeTrainWithPassengers(this: AnyInspector, id: number): string {
  const base = originalDescribeTrain.call(this, id);
  const status = this.rail.trainStatus(id);
  if (!status) return base;
  const passengers = this.world.railTrainPassengerCount(id);
  const capacity = Math.max(80, status.carCount * 120);
  const load = capacity > 0 ? Math.round((passengers / capacity) * 100) : 0;
  const line = `乗客 ${passengers} / ${capacity}  混雑率 ${load}%`;
  return base.includes('\n[T]') ? base.replace('\n[T]', `\n${line}\n[T]`) : `${base}\n${line}`;
};
