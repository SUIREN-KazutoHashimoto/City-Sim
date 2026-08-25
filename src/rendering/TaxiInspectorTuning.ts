import { UniversalInspector } from './UniversalInspector';
import { taxiPassengerInfo, taxiVehicleInfo } from '../traffic/TaxiSystem';

type AnyInspector = any;
type DescribeMethod = (this: AnyInspector, id: number) => string;

function phaseLabel(phase: string): string {
  if (phase === 'idle') return '空車待機';
  if (phase === 'to-pickup') return '迎車中';
  return '実車';
}

const proto = UniversalInspector.prototype as unknown as Record<string, any>;
if (!proto.__citySimTaxiInspectorV071) {
  const previousAgent = proto.describeAgent as DescribeMethod;
  proto.describeAgent = function describeAgentWithTaxi(this: AnyInspector, agent: number): string {
    let text = previousAgent.call(this, agent);
    const world = this.world;
    const info = taxiPassengerInfo(world.store, agent);
    if (!info) return text;
    text = text.replace(/状態 WaitingBus[^\n]*/, `状態 タクシー待ち / Taxi #${info.taxiId}`);
    text = text.replace(/状態 OnBus[^\n]*/, `状態 タクシー乗車中 / Taxi #${info.taxiId}`);
    const wait = Math.max(0, world.clock.totalSeconds - info.requestedAt);
    return `${text}\nタクシー Vehicle #${info.vehicle} / ${info.phase === 'waiting' ? `待ち ${Math.round(wait)}s` : '乗車中'} / 移動予定 ${(info.tripDistance / 1000).toFixed(1)}km`;
  };

  const previousVehicle = proto.describeVehicle as DescribeMethod;
  proto.describeVehicle = function describeVehicleWithTaxi(this: AnyInspector, vehicle: number): string {
    const world = this.world;
    const info = taxiVehicleInfo(world.vehicles, vehicle);
    if (!info) return previousVehicle.call(this, vehicle);
    const vs = world.vehicles;
    const kmh = vs.speed[vehicle] * 3.6;
    const passenger = info.passenger >= 0 ? `市民#${info.passenger}` : 'なし';
    return `タクシー #${info.taxiId} / Vehicle #${vehicle}\n状態 ${phaseLabel(info.phase)}\n速度 ${kmh.toFixed(0)}km/h\n乗客 ${passenger}\n今回距離 ${(info.tripDistance / 1000).toFixed(1)}km\n位置 (${vs.posX[vehicle].toFixed(1)}, ${vs.posZ[vehicle].toFixed(1)})`;
  };

  proto.__citySimTaxiInspectorV071 = true;
}
