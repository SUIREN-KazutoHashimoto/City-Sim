import { UniversalInspector } from './UniversalInspector';
import { vehicleLaneInfo } from '../traffic/MultiLaneTrafficTuning';

type AnyInspector = any;
type DescribeMethod = (this: AnyInspector, vehicle: number) => string;

const proto = UniversalInspector.prototype as unknown as Record<string, any>;
if (!proto.__citySimMultiLaneInspectorV073) {
  const previousDescribeVehicle = proto.describeVehicle as DescribeMethod;
  proto.describeVehicle = function describeVehicleWithLane(this: AnyInspector, vehicle: number): string {
    const text = previousDescribeVehicle.call(this, vehicle);
    if (!text) return text;
    const info = vehicleLaneInfo(this.world.vehicles, vehicle);
    if (!info) return text;
    return `${text}\n車線 ${info.lane + 1}/${info.lanes}${info.lanes > 1 ? ` / 中央線側=1` : ''}`;
  };
  proto.__citySimMultiLaneInspectorV073 = true;
}
